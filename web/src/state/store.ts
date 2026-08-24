import { create } from 'zustand';
import type { Scope, ScopePlot, ScopeTrigger, ScopeValue } from '../engine/simulator';
import { measurementsFromScope } from '../engine/simulator';
import { scopeSpeed, DEFAULT_SCOPE_WIDTH } from '../scope/geometry';
import { positionToOffset } from '../scope/scale';
import {
  allocateId,
  parseCircuit,
  serializeCircuit,
  type CompositeModel,
  type ScopeConfig,
} from '../io/netlist';
import { overlayLiveState } from '../io/liveState';
import { decodeScopeLine, encodeScopeLine, scopeLineMatches } from '../io/scopeLine';
import {
  buildModelFromSelection,
  clearSessionModels,
  compositeModelLine,
  describeBuildFailure,
  getModel,
  modelToEngineSpec,
  parseCompositeModelLine,
  registerSessionModel,
  renameCompositeModelLine,
  renameModel,
  sameCompositeModel,
  saveModel,
  syncSessionModels,
} from '../io/subcircuits';
import {
  compositeFromDocument,
  describeMissingComponents,
  documentFromComposite,
  modelHasNestedSubcircuit,
} from '../io/compositeDocument';
import { leadPostAt, pointOnWireInterior, splitWire } from '../render/geometry';
import { convertWires } from '../render/wireConverter';
import { lShapeRoute, routeWire, routingObstacles } from '../render/wireRouter';
import { postDotPoints, shouldDrawDot } from '../render/junction';
import {
  canMirror,
  canRotate,
  canSwap,
  mirrorElement,
  rotateElement,
  selectionMirrorCentre,
  selectionTurnPivot,
  swapTerminalOrder,
  switch2PosCount,
} from '../model/transform';
import { LOGIC_INPUT_TERNARY, SWITCH2_CENTER_OFF, VOLTAGE_PULSE_DUTY } from '../model/registry/flags';
import { defFor, postsOf } from '../model/registry';
import { chipPinsOf } from '../model/registry/chips';
import { CS_INPUT_COUNT_KINDS } from '../model/registry/elements/vcvs';
import { GATE_INPUT_COUNT_KINDS } from '../model/registry/elements/gate';
import { normalizeMuxBits } from '../model/registry/elements/multiplexer';
import { normalizeDemuxBits } from '../model/registry/elements/deMultiplexer';
import { normalizeAdcBits } from '../model/registry/elements/adc';
import { normalizeDacBits } from '../model/registry/elements/dac';
import { normalizeDecimalBits } from '../model/registry/elements/decimalDisplay';
import { normalizeLatchBits } from '../model/registry/elements/latch';
import { normalizeCounterBits } from '../model/registry/elements/counter';
import { normalizeCounter2Bits } from '../model/registry/elements/counter2';
import { FULL_ADDER_BITS, normalizeFullAdderBits } from '../model/registry/elements/fullAdder';
import { normalizePisoBits } from '../model/registry/elements/pisoShift';
import { normalizeBusSplitterBits } from '../model/registry/elements/busSplitter';
import { normalizeBusLogicInputWidth } from '../model/registry/elements/busLogicInput';
import { normalizeTransceiverBits } from '../model/registry/elements/busTransceiver';
import { memoryPairs, normalizeSramBits } from '../model/registry/elements/sram';
import { normalizeAnalogMuxSelects } from '../model/registry/elements/analogMux';
import { normalizeSipoBits } from '../model/registry/elements/sipoShift';
import { normalizeRingBits } from '../model/registry/elements/ringCounter';
import { normalizePoleCount } from '../model/registry/elements/dpdtSwitch';
import { normalizeInputCount } from '../model/registry/shared';
import { duplicatesColinearElement, interiorPostHits } from '../model/wirePlacement';
import { DEFAULT_MODEL_NAME } from '../model/registry/elements/customComposite';
import { createTestHarness, selectHarnessChip } from '../model/testHarness';
import {
  nextFileNum,
  setAudioSamples,
  setDataSamples,
  clearSampleCache,
  snapshotSampleCache,
  restoreSampleCache,
} from '../model/sampleCache';
import { paramScale, resolveParam } from '../model/sliders';
import {
  clearUserModels,
  deleteUserModel,
  modelFamilyFor,
  pruneUnreferencedModels,
  putUserModel,
  registerFileModels,
  resolveModelParams,
  restorePrunedModels,
  restoreUserModels,
  seedModelEntry,
  snapshotUserModels,
  userModel,
} from '../model/deviceModels';
import {
  DEFAULT_SETTINGS,
  GRID_SIZE,
  UNMODELLED_HEADER,
  type CircuitElement,
  type Point,
  type SimSettings,
} from '../model/types';
import type { AppState, Slider, Snapshot, ViewTransform } from './types';
import { loadAppPrefs, saveAppPrefs, touchesAppPrefs } from './appPrefs';
import { loadScopeDefaults } from './scopeDefaults';
import { readRecovery } from './recovery';
import { loadShortcutOverlay, normalizeKey, saveShortcutOverlay } from '../input/shortcuts';
import {
  hasUnsavedChanges,
  makeElement,
  makeGhostElement,
  makeToolElement,
  RECOVERED_UNSAVED,
  resolveCompositeModel,
  snap,
} from './helpers';
import { ZOOM_FACTOR, circuitBounds, fitView, zoomAbout } from './view';
import {
  attachUndockedWindow,
  detachUndockedWindow,
  undockedWindow,
  undockedWindowOuterSize,
} from '../undocked/opener';
import { clampInteger } from '../ui/elementFields';

/** The element kinds whose `inputCount` `setParam` normalises on edit: the
 *  controlled sources and the six basic gates, all of whose engines truncate
 *  the value to an integer post count. */
const INPUT_COUNT_KINDS: ReadonlySet<string> = new Set([
  ...CS_INPUT_COUNT_KINDS,
  ...GATE_INPUT_COUNT_KINDS,
]);

/**
 * The bit-width chips whose `setParam` writes the engine-derived integer back
 * on edit, keyed by `kind:paramName`. The multiplexer truncates, the
 * demultiplexer rounds, and the six `(x as usize)` chips truncate and clamp to
 * their engine's floor/ceiling, so the geometry and the rebuild read one post
 * count and a rebuild never trips the post-count guard (circuit.rs:261-269).
 */
const BITS_NORMALIZERS: Readonly<Record<string, (value: number) => number>> = {
  'multiplexer:bits': normalizeMuxBits,
  'deMultiplexer:selectBits': normalizeDemuxBits,
  'adc:bits': normalizeAdcBits,
  'dac:bits': normalizeDacBits,
  'decimalDisplay:bits': normalizeDecimalBits,
  'latch:bits': normalizeLatchBits,
  'counter:bits': normalizeCounterBits,
  'counter2:bits': normalizeCounter2Bits,
  'fullAdder:bits': normalizeFullAdderBits,
  'pisoShift:bits': normalizePisoBits,
  'sipoShift:bits': normalizeSipoBits,
  'ringCounter:bits': normalizeRingBits,
  'busSplitter:bits': normalizeBusSplitterBits,
  'busLogicInput:busWidth': normalizeBusLogicInputWidth,
  'busTransceiver:bits': normalizeTransceiverBits,
  'sram:addressBits': normalizeSramBits,
  'sram:dataBits': normalizeSramBits,
  'rom:addressBits': normalizeSramBits,
  'rom:dataBits': normalizeSramBits,
  'analogMux:selectBitCount': normalizeAnalogMuxSelects,
  'dpdtSwitch:poleCount': normalizePoleCount,
};

const clone = (s: Snapshot): Snapshot => ({
  elements: s.elements.map((e) => {
    const copy = { ...e, params: { ...e.params } };
    // A route is a nested array; without this a future in-place route mutator
    // would silently corrupt the undo snapshot.
    if (e.route) copy.route = e.route.map((r) => [...r]);
    // The embedded-scope interpretation nests a plot list and per-plot display
    // fields; clone them so a snapshot never aliases the live element, the
    // same rule the route and model payloads follow.
    if (e.embedded) {
      copy.embedded = {
        ...e.embedded,
        tokens: [...e.embedded.tokens],
        plots: e.embedded.plots.map((p) => ({ ...p })),
        display: {
          ...e.embedded.display,
          perPlot: e.embedded.display.perPlot.map((d) => ({ ...d })),
        },
      };
    }
    // A resolved device model is a nested object, and the custom-logic rules
    // vectors inside it are arrays; clone them so a snapshot can never alias
    // the live element. The OTA's model is the same carrier holding a string
    // array (the composite child-dump tokens), which clones as a plain copy.
    // The composite's own engine spec is the third payload shape: its external
    // and dump vectors are arrays too, and the `external` key is what tells the
    // two object payloads apart (a custom-logic model never carries one). The
    // battery's table is a plain string, immutable, so it passes through, while
    // the string-array child dumps still clone so a snapshot never aliases them.
    if (e.model !== undefined) {
      copy.model =
        typeof e.model === 'string'
          ? e.model
          : Array.isArray(e.model)
            ? [...e.model]
            : 'external' in e.model
              ? { ...e.model, external: [...e.model.external], dumps: [...e.model.dumps] }
              : {
                  ...e.model,
                  inputs: [...e.model.inputs],
                  outputs: [...e.model.outputs],
                  rulesLeft: [...e.model.rulesLeft],
                  rulesRight: [...e.model.rulesRight],
                };
    }
    return copy;
  }),
  // Plots and triggers are nested objects, so a shallow spread would alias the
  // live state into the undo snapshot. raw is an array of line tokens with the
  // same aliasing risk, so it is cloned like the sliders' raw.
  scopes: s.scopes.map((x) => ({
    ...x,
    raw: x.raw ? [...x.raw] : null,
    trigger: { ...x.trigger },
    // The measurement mask is a nested object like the trigger: clone it so a
    // snapshot can never alias the live plot's override.
    plots: x.plots.map((p) => ({
      ...p,
      measurements: p.measurements ? { ...p.measurements } : null,
    })),
  })),
  sliders: s.sliders.map((x) => ({ ...x, raw: [...x.raw] })),
  settings: { ...s.settings },
  view: { ...s.view },
  // The document's lines. A shallow copy is enough because the entries are
  // strings and small immutable records that the one mutator (the subcircuit
  // rename) replaces rather than edits in place.
  passthrough: [...s.passthrough],
  order: [...s.order],
  // Unreadable o lines carry the same nested shape as a resolved scope's raw
  // tokens and plot list, so they need the same deep copy or a future
  // in-place edit would alias the live state into the undo snapshot.
  unmatchedScopes: s.unmatchedScopes.map((x) => ({
    ...x,
    raw: [...x.raw],
    plots: x.plots.map((p) => ({ ...p })),
  })),
});

/** Canonical fingerprint of the snapshot state, mirroring upstream's dump
 *  comparison (UndoManager.java:50-53). The top-level object is built in a
 *  fixed property order so equal content always stringifies equally; the inner
 *  objects carry the insertion order they were constructed with, which is
 *  stable because every mutator spreads rather than reordering. */
const snapshotKey = (s: Snapshot): string =>
  JSON.stringify({
    elements: s.elements,
    scopes: s.scopes,
    sliders: s.sliders,
    settings: s.settings,
    view: s.view,
    // The document's lines belong in the fingerprint too: a subcircuit rename
    // changes nothing else, so without them a second rename would dedup
    // against the first commit, the entry would never be pushed and undo would
    // skip a step.
    passthrough: s.passthrough,
    order: s.order,
    // Without this an unmatched-scope-only edit (recovering a file whose
    // unreadable o lines differ from the previous one) would dedup against
    // the top of the stack and undo would skip the step.
    unmatchedScopes: s.unmatchedScopes,
  });

const UNDO_LIMIT = 100;

/** The one serialization body shared by `toNetlist` (the non-live document)
 *  and `saveNetlist` (the live overlay). Building the scope configs, the
 *  passthrough walk and the header is the same either way; only the element
 *  array differs. Reading the rest of the store here keeps `toNetlist`
 *  byte-identical after the extraction. */
function serializeDocument(elements: CircuitElement[]): string {
  const s = useStore.getState();
  const indexById = new Map(elements.map((e, i) => [e.id, i]));
  const kindById = new Map(s.elements.map((e) => [e.id, e.kind]));
  const scopeConfigs: ScopeConfig[] = s.scopes.map((x) => {
    const first = x.plots[0];
    const speedToken = String(x.speed);
    const kinds = x.plots.map((p) =>
      p.elementId === null ? null : (kindById.get(p.elementId) ?? null),
    );
    // An unedited loaded line saves byte-for-byte: only the speed token
    // tracks the live zoom. Any display edit flips scopeLineMatches and the
    // encoder regenerates the whole line from state, so UI edits persist. The
    // scope's index in the store array reproduces the load-time position
    // fallback for lines without a position token.
    const raw =
      x.raw !== null && scopeLineMatches(x, x.raw, kinds, s.scopes.indexOf(x))
        ? x.raw[0] === speedToken
          ? x.raw
          : [speedToken, ...x.raw.slice(1)]
        : encodeScopeLine(x, (id) => indexById.get(id), kinds);
    return {
      id: x.id,
      // Recomputed by the writer from where the element lands in the file;
      // this is only the fallback for a plot with no element left.
      elementIndex: indexById.get(first.elementId ?? -1) ?? -1,
      elementId: first.elementId ?? undefined,
      raw,
      plots: x.plots.map((p) => ({
        id: p.id,
        elementIndex: indexById.get(p.elementId ?? -1) ?? -1,
        elementId: p.elementId ?? undefined,
        value: p.value,
      })),
    };
  });
  return serializeCircuit(
    elements,
    s.settings,
    [...scopeConfigs, ...s.unmatchedScopes],
    s.passthrough,
    s.order,
    s.sliders,
  );
}

/**
 * Joins a load-time message with what the engine reported on the last build,
 *  so neither can wipe the other. Used for both channels: the frame loop
 *  recomputes each from its two sources on every build, so a message is never
 *  reported twice and a stale one (cleared by a fresh load) stays dead. */
export function mergeProblem(unsupported: string | null, engineWarnings: string[]): string | null {
  const parts: string[] = [];
  if (unsupported !== null && unsupported !== '') parts.push(unsupported);
  if (engineWarnings.length > 0) parts.push(engineWarnings.join(' '));
  return parts.length > 0 ? parts.join(' ') : null;
}

/** Diode/zener model parameters: editing one invalidates the stored model name. */
const DIODE_MODEL_PARAMS = [
  'forwardVoltage',
  'seriesResistance',
  'emissionCoefficient',
  'saturationCurrent',
  'breakdownVoltage',
];

/** Element kinds a scope current companion is not created for, matching
 *  upstream's exclusion list (Scope.addValue, Scope.java:360-367). */
const OUTPUT_LIKE = new Set(['output', 'logicOutput', 'audioOutput', 'testPoint', 'probe']);

function makePlot(id: number, elementId: number | null, value: ScopeValue | null): ScopePlot {
  // Power, charge and resistance plots start at the bottom of the manual-mode
  // screen, the port of ScopePlot's constructor (ScopePlot.java:62-66): ohms
  // can only be positive, watts and coulombs sit low for backward
  // compatibility.
  const manVPosition =
    value === 'power' || value === 'charge' || value === 'resistance' ? -100 : 0;
  return {
    id,
    elementId,
    value,
    manScale: null,
    manVPosition,
    acCoupled: false,
    measurements: null,
  };
}

/** The horizontal zoom a scope created in the UI starts at, before any stored
 *  default overrides it. Upstream's Scope constructor speed (Scope.java:270). */
const UI_SCOPE_SPEED = 64;

/** The settings the Other Options dialog owns, and therefore the ones its
 *  Reset to Defaults button puts back. Listed rather than derived from
 *  `DEFAULT_SETTINGS` so a new setting has to be opted in: a key the dialog
 *  does not show must not be reset from behind it. */
const RESETTABLE_SETTINGS = [
  'timeStep',
  'stepsPerFrame',
  'voltageRange',
  'powerRange',
  'currentSpeed',
  'minTimeStep',
  'adaptiveTimeStep',
  'autoDC',
  'showCurrent',
  'showValues',
  'showVoltageColor',
  'showPowerColor',
  'showGrid',
  'conventional',
  'showCrosshair',
  'positiveColor',
  'negativeColor',
  'neutralColor',
  'selectionColor',
  'currentColor',
  'valueFontSize',
  'shortDecimalDigits',
  'decimalDigits',
  'wheelSensitivity',
] as const satisfies readonly (keyof SimSettings)[];

function defaultTrigger(): ScopeTrigger {
  return { mode: 'freeRun', edge: 'rising', level: 0 };
}

/** A scope panel with the full field set. Position defaults to its own column,
 *  which is what a fresh UI scope gets. showV/showI mirror upstream's
 *  initialize(), which turns both on when the scope carries the matching plots
 *  (Scope.java:276-285); the port's one default cannot know the plot units, so
 *  it opts into showing them, and the scale tokens use the values the UI line
 *  has always written. Stored scope defaults (flags, speed, trigger level)
 *  seed a fresh scope on top, upstream's `loadDefaults` in the Scope
 *  constructor (Scope.java:276); the identity stays the caller's, and the
 *  loadNetlist path re-asserts the file's speed token afterwards, exactly as
 *  undump reads it after initialize() (ScopeSerializer.java:195). */
function makeScope(
  id: number,
  raw: string[] | null,
  plots: ScopePlot[],
  speed: number,
  position: number,
): Scope {
  const defaults = loadScopeDefaults();
  return {
    ...{
      id,
      raw,
      plots,
      position,
      speed,
      manualScale: false,
      maxScale: false,
      label: '',
      manDivisions: 8,
      showScale: false,
      // Upstream's default: showMax is on, everything else off (Scope.java:272-275).
      showMax: true,
      showMin: false,
      showP2P: false,
      showFreq: false,
      showRMS: false,
      showAverage: false,
      showDutyCycle: false,
      fftPlot: false,
      logSpectrum: false,
      plotXY: false,
      // Upstream's ScopePlot2d defaults: X axis on plot 0, Y axis on plot 1,
      // no brightness or colour modulator (ScopePlot2d.java:22-26).
      plotX: 0,
      plotY: 1,
      plotBrightness: -1,
      plotColorR: -1,
      plotColorG: -1,
      plotColorB: -1,
      showPhaseAngle: false,
      trailPersistence: 0,
      showElmInfo: false,
      showI: true,
      showV: true,
      scaleV: 20,
      scaleA: 0.05,
      trigger: defaultTrigger(),
    },
    // The stored defaults override the display fields and speed, but never the
    // caller's identity; the trigger merges only its stored level into the
    // freeRun default.
    ...(defaults ?? {}),
    id,
    raw,
    plots,
    position,
    trigger: { ...defaultTrigger(), ...defaults?.trigger },
  };
}

/** The global slot that holds the one store instance across dev reloads.
 *  store.ts imports the element registry, so a Vite HMR edit of any registry
 *  module re-evaluates this file. A fresh `create` would spawn a second store
 *  and strand the frame loop: useStoreRef subscribes to the instance it saw at
 *  mount and never re-binds, so it would keep reading the old, now-frozen
 *  store and a paused sim could never restart from the button. Caching the
 *  instance here makes the re-evaluation hand back the existing store, so
 *  every consumer, old and new, reads and writes one instance. */
const STORE_INSTANCE_KEY = '__falstadCirquitStore';

type AppStore = ReturnType<typeof createAppStore>;

/** The revision bump that makes the frame loop rebuild the engine, which
 *  renumbers the circuit nodes. A shift-highlighted net index from the
 *  previous build would then light the wrong net, so the bump clears it: the
 *  hover re-sets it on the next shift-hover. Every rebuild path goes through
 *  this helper, so no revision bump can leave a stale highlight. */
const bumpRevision = (s: Pick<AppState, 'revision'>): { revision: number; highlightedNode: null } => ({
  revision: s.revision + 1,
  highlightedNode: null,
});

/** True when applying `patch` to `e` would actually change it, the guard the
 *  drag paths lean on so a pointer event that stays inside one grid cell does
 *  not bump `revision` and rebuild the whole engine (each bump is a full
 *  setCircuit). Geometry is compared after the same rounding the writer
 *  applies, so a sub-grid jitter that rounds back onto the stored coordinate
 *  counts as no change. `updateElement` spreads the patch wholesale, so
 *  `params` replaces the object and the comparison is a value compare of the
 *  two maps; `model` stays a reference compare because the patch never carries
 *  a fresh blob. */
function patchChangesElement(e: CircuitElement, patch: Partial<CircuitElement>): boolean {
  for (const [k, raw] of Object.entries(patch)) {
    if (k === 'x1' || k === 'y1' || k === 'x2' || k === 'y2') {
      const v = raw as number;
      if (v !== undefined && Math.round(v) !== e[k]) return true;
    } else if (k === 'params') {
      const p = raw as Record<string, number>;
      const cur = e.params;
      if (Object.keys(p).length !== Object.keys(cur).length) return true;
      for (const [pk, pv] of Object.entries(p)) if (cur[pk] !== pv) return true;
    } else if (k === 'route') {
      const r = raw as [number, number][] | undefined;
      if (r === undefined) continue;
      const cur = e.route;
      if (cur === undefined || r.length !== cur.length) return true;
      for (let i = 0; i < r.length; i++) {
        if (r[i][0] !== cur[i][0] || r[i][1] !== cur[i][1]) return true;
      }
    } else if (e[k as keyof CircuitElement] !== raw) {
      return true;
    }
  }
  return false;
}

/**
 * The pass a freshly drawn wire run owes the junction posts it crossed,
 * upstream's WireElm.draggingDone run from endDrag after the element lands
 * (MouseManager.java:1281-1283, WireElm.java:286-316): each new plain wire
 * splits at every junction-dot post on its interior, so drawing through a
 * T-junction connects there instead of only looking connected. A sub-segment
 * whose ends some existing two-terminal part already joins directly is
 * dropped rather than laid parallel on it.
 *
 * The dot scan reads `scene`, the element list minus every id in `madeIds`,
 * the equivalent of upstream running off its pre-gesture analysis: only then
 * does a quiet pass-through coordinate stay unsplit. The same made set rides
 * into the twin search as `duplicatesColinearElement`'s skip list, so neither
 * a replaced wire nor its own replacement pieces can count as the existing
 * connection a piece would lie parallel on. Routed wires are exempt,
 * mirroring upstream's draggingDone override (they route around posts).
 *
 * Pure over the snapshot: returns the made ids to drop and their replacement
 * pieces, or null when nothing hit and the run stands as drawn.
 */
function connectNewWiresAcrossPosts(
  elements: readonly CircuitElement[],
  madeIds: readonly number[],
): { gone: Set<number>; added: CircuitElement[] } | null {
  const made = new Set(madeIds);
  const scene = elements.filter((e) => !made.has(e.id));
  const dots: Point[] = [];
  for (const [key, count] of postDotPoints(scene)) {
    if (!shouldDrawDot(count)) continue;
    const [x, y] = key.split(',').map(Number);
    dots.push({ x, y });
  }
  const gone = new Set<number>();
  const added: CircuitElement[] = [];
  let touched = false;
  for (const id of madeIds) {
    const w = elements.find((e) => e.id === id);
    if (!w || w.kind !== 'wire') continue;
    // Routed wires route around posts instead of crossing them, upstream's
    // RoutedWireElm draggingDone override. Untestable through the only
    // caller: the wire tool's helpers never set a route, so this guard stays
    // defence against a future caller that does.
    if (w.route && w.route.length >= 2) continue;
    const hits = interiorPostHits({ x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 }, dots);
    if (hits.length === 0) continue;
    touched = true;
    gone.add(id);
    // Walk the span splitting off one piece per hit with the same splitWire
    // the other edit paths use; the trailing remainder closes the walk. An
    // interior grid point always splits, so the null case cannot fire.
    let head: CircuitElement = w;
    const pieces: CircuitElement[] = [];
    for (const p of hits) {
      const pair = splitWire(head, p, allocateId);
      if (!pair) break;
      pieces.push(pair[0]);
      head = pair[1];
    }
    pieces.push(head);
    // The first surviving piece inherits the drawn wire's id, like upstream
    // mutating the dragged element into its first segment, so a selection
    // taken during the gesture still points at real geometry.
    let reused = false;
    for (const pc of pieces) {
      if (
        duplicatesColinearElement(scene, made, { x: pc.x1, y: pc.y1 }, { x: pc.x2, y: pc.y2 })
      ) {
        continue;
      }
      added.push(reused ? pc : { ...pc, id });
      reused = true;
    }
  }
  return touched ? { gone, added } : null;
}

/** The parts sidebar defaults open on a wide (desktop) screen, where it is
 *  the always-visible toolbox, and closed on narrow screens, where it is a
 *  drawer the Parts button opens. The Toolbar Options row and the Parts
 *  button share this same state. */
function defaultPartsOpen(): boolean {
  return !isNarrow();
}

/** True on the narrow (mobile) layout where the side panels stop being flex
 *  siblings and become edge-anchored overlays, so only one can be shown at a
 *  time without stacking two popovers over the canvas. */
function isNarrow(): boolean {
  return typeof window !== 'undefined' && window.innerWidth <= 768;
}

function createAppStore() {
  return create<AppState>((set, get) => ({
  elements: [],
  selectedIds: [],
  scopes: [],
  sliders: [],
  // App prefs (colours, digits, font size, wheel sensitivity, crosshair, the
  // European-resistor symbol) are merged over the defaults at startup so they
  // survive a page reload; the header-borne and plain settings stay at their
  // defaults. The user-assigned shortcut overlay loads the same way, via the
  // Shortcuts dialog.
  settings: { ...DEFAULT_SETTINGS, ...loadAppPrefs() },
  shortcuts: loadShortcutOverlay(),
  // The recovery flag mirrors readRecovery() at startup, so the Recover
  // Auto-Save row is enabled exactly when a previous session left a dump
  // behind (UIManager.java:170). Read once, like the shortcut overlay.
  hasRecovery: readRecovery() !== null,
  passthrough: [],
  unmatchedScopes: [],
  order: [],
  running: true,
  tool: null,
  dark: true,
  view: { x: 0, y: 0, scale: 1 },
  viewSize: { w: 800, h: 600 },
  centerRequest: 0,
  dialog: null,
  subcircuitDraft: null,
  subcircuitError: null,
  status: '',
  problem: null,
  unsupportedProblem: null,
  notice: null,
  hoveredId: null,
  highlightedNode: null,
  undoStack: [],
  redoStack: [],
  scopeGesture: false,
  elementGesture: null,
  toolTurns: 0,
  revision: 0,
  scopeRevision: 0,
  paramRevision: 0,
  pendingParams: new Map(),
  pendingStates: new Map(),
  contextMenu: null,
  scopeMenu: null,
  scopeProperties: null,
  partsOpen: defaultPartsOpen(),
  panelOpen: false,
  elementProperties: null,
  deviceModelEditor: null,
  sliderElementId: null,
  clipboard: null,
  lastSaved: null,
  liveStateProvider: null,
  document: 0,
  subcircuitStack: [],
  undocked: null,

  setRunning: (running) => set({ running }),
  toggleRunning: () => set((s) => ({ running: !s.running })),
  // Arming a tool always starts the ghost flat: a turn belongs to the part the
  // user just picked, never to the next one.
  setTool: (tool) => set({ tool, toolTurns: 0 }),
  turnTool: () => {
    const { tool, toolTurns } = get();
    if (tool === null) return;
    // The same guard the settled command uses, so Space over a ghost the menu
    // greys out banks nothing and the keyboard cannot drift from the menu.
    if (!canRotate({ ...makeGhostElement(tool, 0, 0, 0), id: -1 })) return;
    set({ toolTurns: (toolTurns + 1) % 4 });
  },
  setView: (view) => {
    // Reject a poisoned view outright: a NaN view written once would be
    // rewritten by every later zoomAbout, which derives x/y from the stored
    // view, until a reload. The canvas paths route through setView, so this is
    // their last line; the store's own zoom and center actions never reach it
    // because they build on the guarded zoomAbout and the floored fitView.
    // Scale must be positive too, not just finite: a stored 0 makes zoomReset's
    // 1 / scale Infinity and Infinity * 0 re-poisons the view outside this
    // guard's reach.
    if (
      !Number.isFinite(view.x) ||
      !Number.isFinite(view.y) ||
      !(view.scale > 0)
    ) {
      return;
    }
    set({ view });
  },
  setViewSize: (w, h) => {
    // A non-finite size (a broken ResizeObserver report) would push fitView's
    // division and the keyboard centre both to NaN. Refuse the write.
    if (!Number.isFinite(w) || !Number.isFinite(h)) return;
    set({ viewSize: { w, h } });
  },
  setStatus: (status) => set({ status }),
  setProblem: (problem) => set({ problem }),
  setNotice: (notice) => set({ notice }),
  setDark: (dark) => set({ dark }),
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),

  setShortcuts: (overlay) => {
    // The overlay is an app setting, not a circuit edit: persist it (with the
    // same injected-storage/quiet-failure pattern as the app prefs) and update
    // state, no undo entry and no engine revision.
    saveShortcutOverlay(overlay);
    return set({ shortcuts: overlay });
  },

  updateSettings: (patch) => {
    // A change to an app-pref key (a colour, the digit counts, the font size,
    // wheel sensitivity, the crosshair, the European-resistor symbol)
    // persists to localStorage so it survives a reload; circuit and plain
    // settings do not.
    if (touchesAppPrefs(patch)) {
      saveAppPrefs({ ...get().settings, ...patch });
    }
    return set((s) => {
      const merged = { ...s.settings, ...patch };
      // The two colour modes are mutually exclusive, mirroring upstream's
      // menu toggles (Menus.java:190-197): turning one on turns the other off.
      if (patch.showPowerColor !== undefined) merged.showVoltageColor = !patch.showPowerColor;
      if (patch.showVoltageColor !== undefined) merged.showPowerColor = !patch.showVoltageColor;
      // The timestep, the adaptive floor/budget and the DC operating point
      // change every companion model's conductance or the solve itself, so
      // only those force a rebuild. Everything else is a per-frame argument
      // or display-only and must not restart the simulation.
      const reload =
        patch.timeStep !== undefined ||
        patch.minTimeStep !== undefined ||
        patch.adaptiveTimeStep !== undefined ||
        patch.autoDC !== undefined;
      return { settings: merged, ...(reload ? bumpRevision(s) : {}) };
    });
  },

  resetSettings: () => {
    // Only what the Other Options dialog shows. `editable`, `mouseWheelEdit`,
    // the symbol standards and `showHitboxes` live behind other menus, and a
    // reset here must not silently re-enable editing on a circuit someone
    // published read-only.
    const patch = Object.fromEntries(
      RESETTABLE_SETTINGS.map((k) => [k, DEFAULT_SETTINGS[k]]),
    ) as Partial<SimSettings>;
    get().updateSettings(patch);
  },

  select: (ids) => set({ selectedIds: ids }),

  setHovered: (id) => set({ hoveredId: id }),
  setHighlightedNode: (node) => set({ highlightedNode: node }),

  requestEdit: (id) =>
    set((s) => ({
      // The edited element must lead the selection because the options panel
      // reads selectedIds[0], while the rest of an existing selection stays
      // selected: editing one member of a group must not deselect the others
      // (upstream's doEdit leaves the selection alone).
      selectedIds: s.selectedIds.includes(id)
        ? [id, ...s.selectedIds.filter((x) => x !== id)]
        : [id],
      // The dialog is the edit surface, like upstream's EditDialog; the options
      // panel opens behind it so it still shows the element once it closes. On
      // the narrow layout the panels are overlays and only one may show, so the
      // parts drawer closes to avoid two popovers; on the wide layout they are
      // side-by-side siblings with room for both, so the toolbox stays put.
      elementProperties: id,
      panelOpen: true,
      partsOpen: isNarrow() ? false : s.partsOpen,
      contextMenu: null,
    })),

  closeElementProperties: () => set({ elementProperties: null }),

  openDeviceModelEditor: (kind, elementId, action) => {
    const s = get();
    const family = modelFamilyFor(kind);
    const element = s.elements.find((e) => e.id === elementId);
    if (family === undefined || element === undefined) return;
    if (action === 'edit') {
      // The readOnly-gated Edit Model row (DiodeElm.java:221-227): only a
      // writable entry is editable, so a name that resolves to a built-in or
      // to nothing never opens here.
      const name = element.modelName;
      if (name === undefined) return;
      const entry = userModel(family, name);
      if (entry === undefined) return;
      set({ deviceModelEditor: { family, initial: entry, prevName: name } });
      return;
    }
    // A create copies the element's current model under an empty name, exactly
    // as upstream's `new DiodeModel(model)` copy leaves the name to pickName
    // (DiodeElm.java:246-249); the dialog applies the real name on OK.
    const name = element.modelName ?? '';
    const source = name === '' ? undefined : userModel(family, name);
    const initial = seedModelEntry(family, element.params, source, action);
    if (initial === undefined) return;
    set({ deviceModelEditor: { family, initial, attachedElementId: elementId } });
  },

  closeDeviceModelEditor: () => set({ deviceModelEditor: null }),

  applyDeviceModelEdit: (family, entry, attachedElementId, prevName) => {
    const s = get();
    // One undo step for the whole dialog OK; the writable store is module
    // state, so an undo of the element half below never rolls the model back
    // (upstream's models live outside its undo stack too).
    s.commit();
    putUserModel(family, entry);
    if (prevName !== undefined && prevName !== entry.name) deleteUserModel(family, prevName);
    if (attachedElementId !== undefined) {
      // The create-from-element path: the fresh model is already in the
      // writable store, so `setModelName`'s resolution sees it and rebinds the
      // element, bumping `revision` for the rebuild.
      s.setModelName(attachedElementId, entry.name);
      return;
    }
    // An in-place edit: re-resolve every element that names the model against
    // the new entry, so a shared model's edit reaches all of them in one step,
    // and bump `revision` so the engine rebuild reads the new params. A rename
    // also moves those elements to the new name.
    set((st) => {
      const names =
        prevName === undefined || prevName === entry.name
          ? [entry.name]
          : [prevName, entry.name];
      let changed = false;
      const elements = st.elements.map((e) => {
        if (e.modelName === undefined || !names.includes(e.modelName)) return e;
        if (modelFamilyFor(e.kind) !== family) return e;
        const next = { ...e };
        if (e.modelName !== entry.name) next.modelName = entry.name;
        const params = resolveModelParams(family, entry.name, undefined);
        if (params !== undefined) next.params = { ...e.params, ...params };
        if (next.modelName === e.modelName && next.params === e.params) return e;
        changed = true;
        return next;
      });
      if (!changed) return st;
      return { elements, ...bumpRevision(st) };
    });
  },

  setPartsOpen: (open) =>
    set((s) => ({
      partsOpen: open,
      // One drawer at a time: opening the toolbox closes the options panel.
      panelOpen: open ? false : s.panelOpen,
    })),

  setPanelOpen: (open) =>
    set((s) => ({
      panelOpen: open,
      // One drawer at a time: opening the options panel closes the toolbox.
      partsOpen: open ? false : s.partsOpen,
    })),

  movePoint: (id, post, dx, dy) => {
    const s = get();
    const e = s.elements.find((q) => q.id === id);
    if (!e) return;
    // A row or column sweep shifts only one stored endpoint; updateElement
    // rounds the new coordinate so geometry stays integral.
    const patch = post === 0 ? { x1: e.x1 + dx, y1: e.y1 + dy } : { x2: e.x2 + dx, y2: e.y2 + dy };
    s.updateElement(id, patch);
  },

  commit: () =>
    set((s) => {
      // A commit whose serialised state matches the top of the stack is a no-op
      // (a repeat click, or a field focus that changed nothing) and must not
      // grow the stack. The redo stack is still cleared, exactly as upstream's
      // pushUndo clears it before its own dedup check.
      const key = snapshotKey(s);
      const top = s.undoStack[s.undoStack.length - 1];
      if (top && key === snapshotKey(top)) return { redoStack: [] };
      return {
        undoStack: [...s.undoStack, clone(s)].slice(-UNDO_LIMIT),
        redoStack: [],
      };
    }),

  // The pre-gesture state is already the top of the undo stack (nothing has
  // mutated since the last commit), so this commit dedups against it and the
  // real baseline is left in place; raising the flag then lets the setters
  // mutate freely until the gesture ends. If the stack was empty, this pushes
  // the baseline so the gesture has something to undo back to.
  beginScopeGesture: () => {
    get().commit();
    set({ scopeGesture: true });
  },

  // No commit here: the post-gesture state is the live one and the baseline is
  // already on the stack, so undo restores the whole gesture in a single step.
  endScopeGesture: () => set({ scopeGesture: false }),

  // No commit here, unlike beginScopeGesture: both callers (the placement arm
  // and the move arm in pointerDown) have already pushed the gesture's undo
  // baseline, and a second commit would split one drag across two undo steps.
  beginElementGesture: (kind) => set({ elementGesture: { kind, placeTurns: 0 } }),

  endElementGesture: () => set({ elementGesture: null }),

  beginEdit: () => get().commit(),

  addElement: (e) => {
    const id = allocateId();
    get().commit();
    set((s) => ({
      // Geometry must stay integral regardless of caller (see the invariant on
      // makeElement), so a stray fractional coordinate is rounded at the door
      // the same way updateElement does.
      elements: [
        ...s.elements,
        {
          ...e,
          id,
          x1: Math.round(e.x1),
          y1: Math.round(e.y1),
          x2: Math.round(e.x2),
          y2: Math.round(e.y2),
        },
      ],
      ...bumpRevision(s),
    }));
    return id;
  },

  updateElement: (id, patch) =>
    set((s) => {
      const target = s.elements.find((e) => e.id === id);
      // A no-op update (a pointer event that stayed inside one grid cell) must
      // not bump `revision`: the frame loop rebuilds the whole engine per bump,
      // so the drag would otherwise pay a full setCircuit every pointer event.
      // Returning the same state also makes zustand skip the notify.
      if (target === undefined || !patchChangesElement(target, patch)) return s;
      const geometry =
        patch.x1 !== undefined ||
        patch.y1 !== undefined ||
        patch.x2 !== undefined ||
        patch.y2 !== undefined;
      // A routed wire's polyline is valid only for its exact endpoints. When a
      // post moves, re-run the router against the current obstacle set so the
      // polyline follows the post and keeps avoiding the other elements'
      // bodies, upstream's setPoints re-route (RoutedWireElm.java:86-123). A
      // fully blocked re-route falls back to the L-shape upstream uses.
      let reroute: [number, number][] | null = null;
      if (geometry && target.route && target.route.length >= 2) {
        const routed = routeWire(
          { x: Math.round(patch.x1 ?? target.x1), y: Math.round(patch.y1 ?? target.y1) },
          { x: Math.round(patch.x2 ?? target.x2), y: Math.round(patch.y2 ?? target.y2) },
          routingObstacles(s.elements, id),
          GRID_SIZE,
        );
        reroute =
          routed.length >= 2
            ? routed.map((p) => [p.x, p.y])
            : lShapeRoute(
                Math.round(patch.x1 ?? target.x1),
                Math.round(patch.y1 ?? target.y1),
                Math.round(patch.x2 ?? target.x2),
                Math.round(patch.y2 ?? target.y2),
              );
      }
      return {
        elements: s.elements.map((e) => {
          if (e.id !== id) return e;
          // Geometry must stay integral: the engine's post type is `[i32; 2]`
          // and node merging keys on exact coordinate equality, so any
          // coordinate the patch carries is rounded. Non-geometry patches pass
          // through untouched.
          const next = {
            ...e,
            ...patch,
            ...(patch.x1 !== undefined ? { x1: Math.round(patch.x1) } : {}),
            ...(patch.y1 !== undefined ? { y1: Math.round(patch.y1) } : {}),
            ...(patch.x2 !== undefined ? { x2: Math.round(patch.x2) } : {}),
            ...(patch.y2 !== undefined ? { y2: Math.round(patch.y2) } : {}),
          };
          if (reroute !== null) next.route = reroute;
          return next;
        }),
        ...bumpRevision(s),
      };
    }),

  addWires: (segments) => {
    if (segments.length === 0) return [];
    // One commit for the whole run: the two segments of an L are one gesture,
    // so one Ctrl+Z must take both back. The splits below deliberately do not
    // commit again, for the same reason (see placeWireEnd).
    get().commit();
    const made = segments.map((seg) => ({
      ...makeElement('wire', seg.x1, seg.y1, seg.x2, seg.y2),
      id: allocateId(),
    }));
    set((s) => ({ elements: [...s.elements, ...made], ...bumpRevision(s) }));
    // The run's two free ends connect to what they landed on, exactly as a
    // dragged single wire does (finishPlacement, pointerDown.ts). The corner
    // between two segments is skipped: it is this gesture's own junction, and
    // splitting there would have the second segment split the first.
    const first = made[0];
    const last = made[made.length - 1];
    get().placeWireEnd(last.id, last.x2, last.y2);
    get().autoSplitAt({ x: first.x1, y: first.y1 }, first.id);
    get().autoSplitAt({ x: last.x2, y: last.y2 }, last.id);
    // Last, like upstream's endDrag runs draggingDone after the endpoint
    // splits: the run breaks at every junction post its segments crossed, so
    // drawing through a T-junction connects there. Still the gesture's single
    // undo entry, owned by the commit above.
    const madeIds = made.map((e) => e.id);
    const pass = connectNewWiresAcrossPosts(get().elements, madeIds);
    if (pass) {
      set((st) => ({
        elements: st.elements.filter((e) => !pass.gone.has(e.id)).concat(pass.added),
        ...bumpRevision(st),
      }));
    }
    // A leg whose every piece dropped as a parallel duplicate left nothing in
    // the store behind it: only ids that still hold an element may reach
    // finishWireDrag's select.
    const surviving = new Set(get().elements.map((e) => e.id));
    return madeIds.filter((id) => surviving.has(id));
  },

  placeWireEnd: (id, x, y) => {
    // The placement's undo baseline is the commit `addElement` took at
    // pointer-down, so the whole gesture (drop and split) is one undo step.
    // Committing again here would split it into two.
    const s = get();
    const placed = s.elements.find((e) => e.id === id);
    if (!placed || placed.kind !== 'wire') return;
    const px = Math.round(x);
    const py = Math.round(y);
    const end = { x: px, y: py };
    // The crossed wire is the one whose interior the snapped end lands on, and
    // not the wire being placed. Endpoints are excluded by the interior check,
    // so an end-on-end drop stays an ordinary connection.
    const crossed = s.elements.find(
      (e) => e.id !== id && e.kind === 'wire' && pointOnWireInterior(end, e),
    );
    if (!crossed) {
      // The move handler already wrote the snapped end; nothing to do.
      if (placed.x2 === px && placed.y2 === py) return;
      set((st) => ({
        elements: st.elements.map((e) => (e.id === id ? { ...e, x2: px, y2: py } : e)),
        ...bumpRevision(st),
      }));
      return;
    }
    // Splitting the crossed wire puts a terminal at the drop point, which the
    // engine merges with the placed end into one node: the two now connect.
    const halves = splitWire(crossed, end, allocateId);
    if (!halves) return;
    set((st) => ({
      elements: st.elements
        .filter((e) => e.id !== crossed.id)
        .map((e) => (e.id === id ? { ...e, x2: px, y2: py } : e))
        .concat(halves),
      ...bumpRevision(st),
    }));
  },

  autoSplitAt: (point, exceptId) => {
    // Upstream splits every wire under the dropped post, not just the first:
    // two wires crossing at the point both get a terminal there, so the drop
    // joins all of them (splitWireAt, MouseManager.java:597-613). The dragged
    // element is skipped so a routed wire cannot split itself on its own bend.
    const s = get();
    const p = { x: Math.round(point.x), y: Math.round(point.y) };
    const crossed = s.elements.filter(
      (e) => e.id !== exceptId && e.kind === 'wire' && pointOnWireInterior(p, e),
    );
    const halves: CircuitElement[] = [];
    const gone = new Set<number>();
    for (const w of crossed) {
      // A wire that refuses the split (splitWire returns null) has to survive
      // it, so only the ones actually replaced go on the removal list.
      const pair = splitWire(w, p, allocateId);
      if (!pair) continue;
      halves.push(...pair);
      gone.add(w.id);
    }
    // The other half of upstream's `splitAt`: a post dropped on the bare lead
    // between another part's terminal and its drawn body (splitLeadsAt,
    // MouseManager.java:615-636). The lead is pulled in to the drop point and
    // a wire fills what it gave up, so the picture is unchanged and the drop
    // point becomes a real terminal instead of a bad connection.
    const stubs = new Map<number, 0 | 1>();
    for (const e of s.elements) {
      if (e.id === exceptId) continue;
      const post = leadPostAt(p, e);
      if (post !== null) stubs.set(e.id, post);
    }
    for (const [id, post] of stubs) {
      const e = s.elements.find((x) => x.id === id)!;
      const old = post === 0 ? { x: e.x1, y: e.y1 } : { x: e.x2, y: e.y2 };
      halves.push({
        ...makeElement('wire', p.x, p.y, old.x, old.y),
        id: allocateId(),
      });
    }
    if (halves.length === 0) return;
    set((st) => ({
      elements: st.elements
        .filter((e) => !gone.has(e.id))
        .map((e) => {
          const post = stubs.get(e.id);
          if (post === undefined) return e;
          return post === 0 ? { ...e, x1: p.x, y1: p.y } : { ...e, x2: p.x, y2: p.y };
        })
        .concat(halves),
      ...bumpRevision(st),
    }));
  },

  splitWireAt: (id, point) => {
    const s = get();
    const target = s.elements.find((e) => e.id === id);
    if (!target || target.kind !== 'wire') return;
    // Snap each axis to the grid like upstream's doSplit (MouseManager.java:
    // 586-593); the wire's stored coordinates are grid aligned, so a snapped
    // point on the span stays on it. splitWire rejects endpoints and off-span
    // points for a plain wire; a routed wire instead projects the point onto
    // its nearest segment, refusing only its own endpoints (geometry.ts
    // splitRoutedWire).
    const p = { x: snap(point.x), y: snap(point.y) };
    const halves = splitWire(target, p, allocateId);
    if (!halves) return;
    s.commit();
    set((st) => ({
      elements: st.elements.filter((e) => e.id !== id).concat(halves),
      ...bumpRevision(st),
    }));
  },

  moveElements: (ids, dx, dy) => {
    // Round the delta, not each endpoint: a fractional pointer jitter must not
    // corrupt integral coordinates, and one shared delta keeps the selection's
    // internal spacing whatever the snap state. When the caller already
    // snapped to the grid this is identity.
    const rdx = Math.round(dx);
    const rdy = Math.round(dy);
    return set((s) => {
      // A zero delta moves nothing: the frame loop rebuilds the whole engine
      // per revision bump, so an in-cell pointer event must not pay it.
      // Returning the same state also makes zustand skip the notify.
      if (rdx === 0 && rdy === 0) return s;
      return {
        elements: s.elements.map((e) => {
          if (!ids.includes(e.id)) return e;
          // A routed wire's polyline moves with it, so the route stays valid
          // under a group move (RoutedWireElm.move, RoutedWireElm.java:76-82).
          const route = e.route
            ? e.route.map(([x, y]): [number, number] => [x + rdx, y + rdy])
            : undefined;
          return {
            ...e,
            x1: e.x1 + rdx,
            y1: e.y1 + rdy,
            x2: e.x2 + rdx,
            y2: e.y2 + rdy,
            ...(route ? { route } : {}),
          };
        }),
        ...bumpRevision(s),
      };
    });
  },

  nudgeSelection: (dx, dy) => {
    const { selectedIds } = get();
    if (selectedIds.length === 0) return;
    // Commit before the move so one arrow press is exactly one undo step,
    // matching upstream's nudge (UIManager.java:1163); the move itself never
    // pushes.
    get().commit();
    get().moveElements(selectedIds, dx, dy);
  },

  zoomIn: () => set((s) => ({ view: zoomAroundCentre(s, ZOOM_FACTOR) })),
  zoomOut: () => set((s) => ({ view: zoomAroundCentre(s, 1 / ZOOM_FACTOR) })),
  zoomReset: () =>
    set((s) => {
      // The 1/scale factor lands on 0.9999999999999999 for 1.12-power scales,
      // but zoom100 must report exactly 100% (MouseManager.java:1338-1349), so
      // the final scale is pinned outright.
      const view = zoomAroundCentre(s, 1 / s.view.scale);
      return { view: { ...view, scale: 1 } };
    }),

  centerCircuit: () => {
    const s = get();
    const bounds = circuitBounds(s.elements);
    if (!bounds) return;
    // No undo push: a view fit is not a circuit edit, and upstream's push for
    // it (CommandManager.java:129-132) would make the first undo a no-op.
    set({ view: fitView(bounds, s.viewSize.w, s.viewSize.h) });
  },

  requestCenter: () => set((s) => ({ centerRequest: s.centerRequest + 1 })),

  zoomToFit: () => {
    const s = get();
    const bounds = circuitBounds(s.elements);
    if (!bounds) return;
    set({ view: fitView(bounds, s.viewSize.w, s.viewSize.h, Infinity) });
  },

  deleteSelected: (skipCommit) => {
    const { selectedIds } = get();
    if (selectedIds.length === 0) return;
    // skipCommit is the placement-cancel path's escape hatch: the element
    // being deleted was created by the same gesture's addElement commit, so
    // that commit is already the whole gesture's undo baseline. Committing
    // again here would push a second entry holding the about-to-be-deleted
    // element, and the first Ctrl+Z would resurrect it instead of undoing the
    // placement outright. Every other caller deletes real, pre-existing
    // state and still needs its own commit.
    if (!skipCommit) get().commit();
    set((s) => ({
      // One pass over the survivors of the delete: an embedded window whose
      // traced element just went degrades to its placeholder frame, its
      // plots' targets nulled the way a docked scope's whole line goes below.
      // The window element and its raw config token stay, so undo puts the
      // traces back.
      elements: s.elements
        .filter((e) => !selectedIds.includes(e.id))
        .map((e) => {
          if (e.kind !== 'scope' || !e.embedded) return e;
          if (
            !e.embedded.plots.some(
              (p) => p.elementId !== null && selectedIds.includes(p.elementId),
            )
          ) {
            return e;
          }
          return {
            ...e,
            embedded: {
              ...e.embedded,
              plots: e.embedded.plots.map((p) =>
                p.elementId !== null && selectedIds.includes(p.elementId)
                  ? { ...p, elementId: null }
                  : p,
              ),
            },
          };
        }),
      // A scope goes when any of its plots names a deleted element, matching
      // upstream's cleanup of scopes whose element is gone.
      scopes: s.scopes.filter(
        (x) => !x.plots.some((p) => p.elementId !== null && selectedIds.includes(p.elementId)),
      ),
      // A slider bound to a deleted element goes with it, matching upstream's
      // deleteSliders (CirSim.java:523-531). Its order slot stays, exactly like
      // a dropped scope's: the line stops serialising because no config
      // resolves it, and an undo restores both and puts the line back in
      // place.
      sliders: s.sliders.filter(
        (x) => x.elementId === undefined || !selectedIds.includes(x.elementId),
      ),
      selectedIds: [],
      ...bumpRevision(s),
    }));
    // A writable model whose last referencing element just went leaves the
    // session namespace with it. A file model's `34`/`32` line is never
    // touched, so it survives in passthrough and re-registers on the next
    // load.
    pruneUnreferencedModels(useStore.getState().elements);
  },

  rotateSelection: () => {
    const { elementGesture: gesture, tool } = get();
    // An armed tool with nothing grabbed turns its ghost, ahead of the
    // selection: arming a tool does not clear the selection, so after a
    // click-place the part just dropped is still selected while the next
    // shortcut arms a fresh ghost, and turning that selection would turn the
    // wrong thing.
    if (gesture === null && tool !== null) {
      get().turnTool();
      return;
    }
    // Nothing grabbed: the settled-selection command, one undo entry.
    if (gesture === null) {
      // One pivot for the whole selection: upstream walks the bounding box
      // once and turns every part about it (CommandManager.prepareFlip,
      // CommandManager.java:385-405, rotate :419-431), so a multi-select
      // comes out rigid. A lone element keeps upstreamTurn: its grid-snapped
      // axis is what holds odd-defaultLength kinds to the grid.
      const pivot = selectionTurnPivot(selectedElements());
      transformSelected(canRotate, pivot ? (e) => rotateElement(e, pivot) : rotateElement);
      return;
    }
    if (gesture.kind === 'move') {
      // The pointer-down commit is this drag's whole baseline, so the turn
      // rides along with it: one Ctrl+Z undoes the move and the turns together.
      transformSelected(canRotate, rotateElement, true);
      return;
    }
    // A placement turns about its own (x1,y1), which is the press anchor: the
    // place branch only ever writes (x2,y2), so the anchor stays under the
    // point the user pressed. The turn is banked so the next pointer-move
    // re-applies it to the cursor-derived endpoint instead of erasing it.
    const turned = transformSelected(canRotate, (e) => rotateElement(e, { x: e.x1, y: e.y1 }), true);
    if (turned) set({ elementGesture: { ...gesture, placeTurns: (gesture.placeTurns + 1) % 4 } });
  },
  mirrorSelection: () => {
    // The analogous shared axis: upstream reflects every selected part across
    // the one bbox centre (CommandManager.java:408-417), so the group mirrors
    // as a body instead of each part folding about its own centre.
    const centre = selectionMirrorCentre(selectedElements());
    transformSelected(
      canMirror,
      centre === undefined ? mirrorElement : (e) => mirrorElement(e, centre),
    );
  },
  swapTerminals: () => transformSelected(canSwap, swapTerminalOrder),

  convertWiresToRouted: () => {
    const s = get();
    const converted = convertWires(s.elements, s.selectedIds);
    // Nothing to convert: the returned list is the same elements, so no undo
    // entry and no revision bump (a repeated click on a converted circuit is
    // a no-op, matching the menu's disabled state).
    if (converted.length === s.elements.length && converted.every((e, i) => e === s.elements[i])) {
      return;
    }
    // One commit for the whole command, so the merge is one undo step, exactly
    // as upstream pushes once before WireConverter.convertWires
    // (CommandManager.java:141-145). The merged wires are electrically
    // identical to the chain they replace: the engine merges wires into nodes
    // by coordinate, so a reload sees the same node voltages.
    s.commit();
    set({ elements: converted, ...bumpRevision(s) });
  },

  createTest: () => {
    // The command aborts (with a browser alert from the caller) when no
    // single chip is selected, the same guard as upstream
    // (TestCreator.java:27-30). The alert is a UI concern, so the action
    // reports the outcome and the menubar shows it.
    const chip = selectHarnessChip(get().elements, get().selectedIds);
    if (!chip) return false;
    // selectHarnessChip already proved the chip's pin table exists, so this
    // lookup cannot miss; the pins and the posts share index order because
    // chipPosts maps the same table (ChipElm.getPost).
    const pins = chipPinsOf(chip)!;
    const posts = postsOf(chip);
    const placements = createTestHarness(
      pins.map((p, i) => ({
        side: p.side,
        output: p.output ?? false,
        post: posts[i],
        busWidth: p.busWidth,
        busZ: p.busZ,
      })),
      GRID_SIZE,
      chip.flags,
    );
    if (placements.length === 0) return false;
    // One commit for the whole harness, so Create Test is one undo step,
    // exactly as upstream pushes once before TestCreator.createTest
    // (CommandManager.java:146-149).
    get().commit();
    const added = placements.map((p) => ({
      ...makeElement(p.kind, p.x1, p.y1, p.x2, p.y2),
      id: allocateId(),
    }));
    set((st) => ({
      elements: [...st.elements, ...added],
      ...bumpRevision(st),
    }));
    return true;
  },

  createSubcircuit: () => {
    // Builds the model from the selection and parks it in `subcircuitDraft`
    // for the naming dialog, mirroring upstream's doCreateSubcircuit, which
    // derives the model and then asks for a name (CommandManager.java:69-70,
    // EditCompositeModelDialog.createModel). Every refusal carries its own
    // text (an unsupported kind, a labeled node on ground or on an unused net,
    // no labeled nodes at all), left in `subcircuitError` for the caller's
    // alert instead of the one fixed string every failure used to share.
    const built = buildModelFromSelection(get().elements, get().selectedIds);
    if (built.model === null) {
      set({ subcircuitError: describeBuildFailure(built) });
      return false;
    }
    set({ subcircuitDraft: built.model, subcircuitError: null, dialog: 'createSubcircuit' });
    return true;
  },

  saveSubcircuitDraft: (name) => {
    const draft = get().subcircuitDraft;
    if (draft === null) return;
    const model = { ...draft, name };
    saveModel(model);
    set({ subcircuitDraft: null, dialog: null });
    get().setStatus(`Subcircuit "${name}" created`);
  },

  cancelSubcircuitDraft: () => {
    if (get().subcircuitDraft === null) return;
    set({ subcircuitDraft: null, dialog: null });
  },

  renameSubcircuit: (oldName, newName) => {
    // The model about to move has to be captured before `renameModel` re-keys
    // it, because the document write-back matches a line by body as well as by
    // name. The session map wins the lookup, exactly as it wins the Manager's
    // list, so a file's copy is matched against itself even while a saved
    // model of the same name sits behind it.
    const model = getModel(oldName);
    const outcome = renameModel(oldName, newName);
    // Everything else is a refusal or a no-op: the library did not move, so
    // neither does the file.
    if (outcome !== 'renamed' && outcome !== 'uncovered') return outcome;
    // `renameModel` answers `missing` when the lookup missed, so the capture
    // above cannot have come back empty here.
    if (model === undefined) return outcome;
    const s = get();
    // Both copies of the line: `passthrough` is what a subset save writes, and
    // `order` is what a loaded file writes, so a rename that missed either
    // would come back on the next save. Every line that IS this model moves,
    // since a file holding the same model twice must not be left half renamed;
    // a line that is a different model under the same name (a saved model, a
    // paste) is preserved, which is what keeps a saved model's rename from
    // editing an unrelated open file.
    const rename = (line: string) => {
      const parsed = parseCompositeModelLine(line.trim());
      if (parsed === null || !sameCompositeModel(parsed, model)) return null;
      return renameCompositeModelLine(line, oldName, newName);
    };
    const passthrough = s.passthrough.map((line) => rename(line) ?? line);
    const order = s.order.map((entry) => {
      if (entry.kind !== 'other') return entry;
      const renamed = rename(entry.line);
      return renamed === null ? entry : { ...entry, line: renamed };
    });
    // A 410 element embeds its model name in `text` and serializes only that
    // text (customComposite.ts dump), so the element has to move with the
    // model or the next save writes a `410 ... oldName` whose `.` line no
    // longer exists and a reload drops the part to its fallback body. The
    // match is `text === oldName` against the capture above, not a fresh
    // `getModel`: `renameModel` has already re-keyed a session-backed model
    // out of the old name, and in the `uncovered` case the old name would
    // resolve to the stored copy of a different model, which must not move.
    // The engine payload is name-independent, so it is left alone and the
    // revision-bump rebuild re-reads it, the same re-resolution `setText`
    // relies on. Undo restores the element text and any `.` line through the
    // snapshot, but it cannot revert the storage half of a saved-model
    // rename: `renameModel` already wrote the new key and dropped the old
    // one, and `undo` only re-syncs the session map from `.` lines.
    const elements = s.elements.map((e) =>
      // The guard is redundant: the return above already proved the capture
      // non-undefined, so kind and name are all that decide here.
      e.kind === 'customComposite' && e.text === oldName && model !== undefined
        ? { ...e, text: newName }
        : e,
    );
    // A rename that matched no `.` line and no 410 (a purely saved model, or
    // a session model with nothing behind it) is a library-only rename:
    // nothing to commit. Unchanged lines and elements come back by identity,
    // so this compares references.
    const untouched =
      order.every((entry, i) => entry === s.order[i]) &&
      passthrough.every((line, i) => line === s.passthrough[i]) &&
      elements.every((e, i) => e === s.elements[i]);
    if (untouched) return outcome;
    // The document changed, so this is an edit like any other: one commit
    // before it makes the rename one undo step. The revision bump is the
    // engine's cue to reread a netlist that now names the model differently.
    get().commit();
    set((st) => ({ elements, passthrough, order, ...bumpRevision(st) }));
    return outcome;
  },

  setParam: (id, name, value) => {
    // A non-finite value would serialize as JSON null, which serde rejects
    // for an `f64` param and which would break the engine the same way a
    // fractional post does. Reject it at the door: no state change, no queued
    // edit. The property panel's number field guards first, this is the store
    // choke point for any other input path.
    if (!Number.isFinite(value)) return;
    return set((s) => {
      // The "# of Inputs" slider can hand this a fraction. The engine
      // truncates it to a post count (`(x as i64)` in the controlled-source
      // and gate constructors); write the integer back into
      // `params.inputCount` so the renderer and the engine agree and a rebuild
      // never trips the post-count guard (circuit.rs:261-269). Truncation
      // matches upstream's `(int) ei.value` (VCCSElm.java:202-205,
      // GateElm.java:59), the same clamp the parsers apply on load.
      let pending = value;
      const target = s.elements.find((e) => e.id === id);
      if (name === 'inputCount' && target !== undefined && INPUT_COUNT_KINDS.has(target.kind)) {
        pending = normalizeInputCount(value);
      } else if (target !== undefined) {
        // The bit-width chips truncate or round their count to a post count
        // (`(x as usize)` in each chip's Rust constructor, or `.round()` for
        // the demultiplexer), each clamped to its own range. Write that same
        // integer back so the geometry and the rebuild read one channel count
        // and a rebuild never trips the post-count guard (circuit.rs:261-269).
        const normalize = BITS_NORMALIZERS[`${target.kind}:${name}`];
        if (normalize !== undefined) pending = normalize(value);
        else {
          // The catch-all for every other counting field: the def says the
          // value is a whole number (FieldDef.integer), so no path may store a
          // fraction in it. The two rules above are the kinds whose engine
          // needs a specific truncate-or-round with its own range; this covers
          // the rest, and in particular a slider bound to one of them, which
          // reaches setParam without passing the edit dialog's own guard and
          // would otherwise write 7.34 into a saved netlist token.
          const field = defFor(target.kind)?.fields?.find((f) => f.name === name);
          if (field?.integer) pending = clampInteger(pending, field);
        }
      }
      return {
        elements: s.elements.map((e) => {
          if (e.id !== id) return e;
          const next = { ...e, params: { ...e.params, [name]: pending } };
          // Editing a diode-family model value makes the stored model name
          // stale; drop it so the next save writes the value form, not the
          // dead name. The varactor and LED share the diode machinery
          // upstream, so a stale name there re-applies the model on the next
          // reload and silently discards the edit.
          if (
            (e.kind === 'diode' ||
              e.kind === 'zener' ||
              e.kind === 'varactor' ||
              e.kind === 'led') &&
            DIODE_MODEL_PARAMS.includes(name)
          ) {
            delete next.modelName;
          }
          // A source's stored flags record whether its pulse duty is
          // authoritative (bit 4), so a later rebuild does not re-apply the
          // legacy 1/(2*pi) normalisation to an edited duty. The engine reads
          // the bit only at build time, so keeping it in step here is free: no
          // rebuild is forced and the live set_param path stays live.
          if (name === 'waveform' && (e.kind === 'voltage' || e.kind === 'rail')) {
            next.flags = e.flags & ~VOLTAGE_PULSE_DUTY;
            if (value === 5) next.flags |= VOLTAGE_PULSE_DUTY;
          }
          // A flagless full adder loaded from a file reads its width from the
          // flag, not the token; setting FLAG_BITS on edit makes the width
          // take effect and the next save write the `bits` token, exactly what
          // upstream's setChipEditValue does (FullAdderElm.java:82-90).
          if (e.kind === 'fullAdder' && name === 'bits') next.flags |= FULL_ADDER_BITS;
          return next;
        }),
        // Queue the edit for the engine's set_param fast path rather than
        // bumping `revision` (which would trigger a full rebuild and rewind the
        // clock). A Map keyed by id and name coalesces slider drags to the last
        // value.
        pendingParams: new Map(s.pendingParams).set(`${id}:${name}`, { id, name, value: pending }),
        paramRevision: s.paramRevision + 1,
      };
    });
  },

  setMemoryContents: (id, pairs) => {
    const s = get();
    const target = s.elements.find((e) => e.id === id);
    if (!target) return;
    // A re-commit of the same pairs (a blur with nothing changed) must not
    // rebuild the engine or grow the undo stack.
    const current = memoryPairs(target);
    if (
      current.length === pairs.length &&
      current.every(([addr, val], i) => addr === pairs[i][0] && val === pairs[i][1])
    ) {
      return;
    }
    // Baseline at the apply point, the loadAudioFile/loadDataFile pattern: the
    // textarea's onFocus already committed, so this dedups against it, and a
    // direct call without a focus still gets its own undo entry.
    s.commit();
    set((st) => ({
      elements: st.elements.map((e) => {
        if (e.id !== id) return e;
        const params = { ...e.params };
        // Clear the whole addr/val family first, or a shrink leaves a stale
        // trailing pair that memoryDump writes back out.
        let k = 0;
        while (params[`addr${k}`] !== undefined) {
          delete params[`addr${k}`];
          delete params[`val${k}`];
          k++;
        }
        pairs.forEach(([addr, val], i) => {
          params[`addr${i}`] = addr;
          params[`val${i}`] = val;
        });
        return { ...e, params };
      }),
      // The contents live in params but the engine reads them only at build
      // time (sram.rs load_contents), so the change must reload; bumping
      // `paramRevision` keeps the fast-path bookkeeping in step even though
      // nothing is queued for it.
      ...bumpRevision(st),
      paramRevision: st.paramRevision + 1,
    }));
  },

  setModelName: (id, name) =>
    set((s) => ({
      elements: s.elements.map((e) => {
        if (e.id !== id) return e;
        const next = { ...e };
        // The name-free value form: deleting the name makes the next save
        // write the element's derived forward drop (or the value-form tokens
        // the element family carries).
        if (name === '') {
          delete next.modelName;
          return next;
        }
        next.modelName = name;
        // Re-run the built-in resolution into params, like the load-time
        // second pass. File/session `34`/`32` lines are not in scope for a
        // live edit, so this is the built-in table only; an unresolvable name
        // keeps the current params, exactly like a load miss. The revision
        // bump forces a full engine rebuild because model params are read at
        // build time and several change the stamp or the node count (a
        // diode's series resistance), the same rule the seriesResistance
        // set_param decline uses.
        const family = modelFamilyFor(e.kind);
        if (family !== undefined) {
          const params = resolveModelParams(family, name, undefined);
          if (params !== undefined) next.params = { ...e.params, ...params };
        }
        return next;
      }),
      ...bumpRevision(s),
    })),

  setSliderValue: (id, value) => {
    const s = get();
    const slider = s.sliders.find((x) => x.id === id);
    if (!slider || slider.elementId === undefined) return;
    const kind = s.elements.find((e) => e.id === slider.elementId)?.kind;
    if (!kind) return;
    const resolved = resolveParam(kind, slider.editItem, slider.text);
    if (!resolved) return;
    // The value arrives in the slider's file range (percent for a duty-cycle
    // slider); a param whose unit differs is scaled into its own unit after
    // the panel's min..max position conversion. The scale lives next to the
    // resolution in sliders.ts so a caption and its param's unit stay in one
    // table. The engine's live set_param fast path keeps the clock and
    // reactive state alive; a drag coalesces to its last value in
    // pendingParams.
    s.setParam(slider.elementId, resolved.name, value * paramScale(resolved.name));
  },

  addSlider: (elementId, editItem, caption) => {
    const s = get();
    const element = s.elements.find((e) => e.id === elementId);
    if (!element) return;
    // One slider per (element, resolved field), the dialog's checkbox: the
    // resolution prefers the caption over the index (sliders.ts resolveParam),
    // so a corpus slider whose editItem drifted from its caption still shares
    // the field with a dialog-created one, and a repeat click on an
    // already-checked row is a no-op, matching upstream's per-edit-item
    // Adjustable (Adjustable.java:33-44). A caption that resolves to no field
    // keeps the index-only match, the only key it has.
    const resolved = resolveParam(element.kind, editItem, caption ?? '');
    // A caption/index that resolves to no parameter (a disabled kind such as a
    // controlled source, or a drifted corpus line) never becomes a live slider:
    // the dialog only offers resolvable fields, and an inert entry would drive
    // nothing yet persist. Loaded inert lines are preserved by the parser, not
    // here.
    if (!resolved) return;
    const dup = s.sliders.some(
      (x) =>
        x.elementId === elementId &&
        resolveParam(element.kind, x.editItem, x.text)?.name === resolved.name,
    );
    if (dup) return;
    s.commit();
    set((st) => ({
      // raw stays empty so the writer emits the port's canonical fresh line
      // (`e F0 editItem min max text step`, no `ano` since this slider is
      // unshared; serialize.ts sliderLineFor);
      // the min/max are upstream's Adjustable defaults (Adjustable.java:34-35).
      sliders: [
        ...st.sliders,
        {
          id: allocateId(),
          elementId,
          editItem,
          min: 1,
          max: 1000,
          step: 0,
          text: caption ?? '',
          logarithmic: false,
          shared: null,
          raw: [],
        },
      ],
    }));
  },

  removeSlider: (id) => {
    if (!get().sliders.some((x) => x.id === id)) return;
    get().commit();
    set((st) => ({ sliders: st.sliders.filter((x) => x.id !== id) }));
  },

  setSliderElement: (id) => set({ sliderElementId: id }),

  setText: (id, text) =>
    set((s) => {
      const target = s.elements.find((e) => e.id === id);
      if (!target) return s;
      // The netlist format is line-based, so a raw newline would split the
      // element in two on the next save. Strip CR and LF at the door.
      const clean = text.replace(/[\r\n]/g, '');
      // A labeled node's text is structural, not display-only: the engine
      // merges nodes that share a label, so it must reload to learn the
      // change. A custom-logic or custom-composite model name is structural
      // too: the model fixes the post count, which only a rebuild can
      // reallocate. Every other text-bearing element is display-only and can
      // take the fast path without restarting the simulation.
      const reload =
        target.kind === 'labeledNode' ||
        target.kind === 'customLogic' ||
        target.kind === 'customComposite' ||
        // The controlled sources' Output Function rides in `e.text` and the
        // engine only parses it at build time, so an edit must rebuild rather
        // than take the display-only fast path (controlled_source.rs).
        CS_INPUT_COUNT_KINDS.has(target.kind);
      return {
        elements: s.elements.map((e) => {
          if (e.id !== id) return e;
          const next = { ...e, text: clean };
          // A composite rename changes which model the engine builds, so the
          // resolved payload has to follow the name the way placement resolves
          // it; leaving the old model would simulate the previous subcircuit
          // under the new geometry. An unresolvable name clears the payload
          // and the part falls back to its stub body.
          if (target.kind === 'customComposite') {
            const model = clean === '' ? undefined : getModel(clean);
            if (model === undefined) delete next.model;
            else next.model = modelToEngineSpec(model);
          }
          return next;
        }),
        ...(reload ? bumpRevision(s) : {}),
        // A text edit never queues an engine param: the reload kinds rebuild
        // through `revision`, and the display-only kinds carry no engine
        // state at all. Bumping `paramRevision` would run the frame loop's
        // param-apply branch over an empty queue on every annotation edit.
        paramRevision: s.paramRevision,
      };
    }),

  setElementState: (id, state) =>
    set((s) => ({
      elements: s.elements.map((e) => (e.id === id ? { ...e, state } : e)),
      pendingStates: new Map(s.pendingStates).set(id, state),
      paramRevision: s.paramRevision + 1,
    })),

  toggleSwitch: (id) => {
    const s = get();
    const target = s.elements.find((e) => e.id === id);
    if (!target) return;
    const next = nextSwitchState(target);
    // A linked make-before-break switch carries every MBB in the same nonzero
    // Switch Group to the same position in one set, the elmList scan upstream
    // runs inside toggle() (MBBSwitchElm.java:182-195).
    const link = target.kind === 'mbbSwitch' ? (target.params.link ?? 0) : 0;
    const linked = new Set(
      link !== 0
        ? s.elements
            .filter(
              (e) => e.kind === 'mbbSwitch' && e.id !== id && (e.params.link ?? 0) === link,
            )
            .map((e) => e.id)
        : [],
    );
    // A linked SPDT throws every switch2 in the same nonzero Group Number with
    // the target: the twin takes the target's new position, mirrored when the
    // twin's runtime flip parity differs (Switch2Elm.java:158-170), so a
    // mirrored twin of a ganged pair holds the opposite index forever.
    const switch2Positions = new Map<number, number>();
    const s2link = target.kind === 'switch2' ? (target.params.link ?? 0) : 0;
    if (s2link !== 0) {
      const targetPosCount = switch2PosCount(target);
      const targetParity = target.params.flipParity ?? 0;
      switch2Positions.set(id, next);
      for (const twin of s.elements) {
        if (twin.id === id || twin.kind !== 'switch2' || (twin.params.link ?? 0) !== s2link)
          continue;
        let pos = next;
        if ((twin.params.flipParity ?? 0) !== targetParity) pos = targetPosCount - 1 - next;
        // A twin only takes a position it owns: a 3-stop twin linked to a
        // 2-stop twin keeps its throw when the position does not fit, upstream's
        // `if (pos < s2.posCount)` guard (Switch2Elm.java:167-168).
        if (pos < switch2PosCount(twin)) switch2Positions.set(twin.id, pos);
      }
    }
    set((st) => ({
      elements: st.elements.map((e) => {
        if (e.id === id || linked.has(e.id)) return { ...e, state: next };
        const s2pos = switch2Positions.get(e.id);
        return s2pos !== undefined ? { ...e, state: s2pos } : e;
      }),
      pendingStates: (() => {
        const m = new Map(st.pendingStates);
        m.set(id, next);
        for (const lid of linked) m.set(lid, next);
        for (const [sid, s2pos] of switch2Positions) m.set(sid, s2pos);
        return m;
      })(),
      paramRevision: st.paramRevision + 1,
    }));
  },

  loadAudioFile: (id, samples, samplingRate, fileName) => {
    const s = get();
    const target = s.elements.find((e) => e.id === id);
    if (!target) return;
    // The decode lands asynchronously, so the undo baseline is taken here, at
    // the apply point, not on the file input's onFocus (OptionsPanel
    // loadFileInto): an edit the user makes between starting the decode and
    // its landing commits its own entry first, and this commit separates the
    // file load from it, so the two never share one undo step. A decode that
    // fails in the caller never reaches this action, so it leaves no entry.
    s.commit();
    // A fresh number, never reused, so an undo of this load restores the
    // element's previous fileNum whose cache entry still holds the old file.
    const fileNum = nextFileNum();
    setAudioSamples(fileNum, samples, samplingRate);
    // One set: the fileNum and the rail label travel together, so the undo
    // snapshot restores both. The old cache entry is deliberately kept.
    s.updateElement(id, { params: { ...target.params, fileNum }, text: fileName });
  },

  loadDataFile: (id, samples, fileName) => {
    const s = get();
    const target = s.elements.find((e) => e.id === id);
    if (!target) return;
    // Same as loadAudioFile: the baseline is this commit at the apply point,
    // never the file input's onFocus, so an unrelated edit that lands while
    // the decode is in flight keeps its own undo step.
    s.commit();
    const fileNum = nextFileNum();
    setDataSamples(fileNum, samples);
    s.updateElement(id, { params: { ...target.params, fileNum }, text: fileName });
  },

  unblowFuses: () =>
    set((s) => {
      const fuseIds = new Set(s.elements.filter((e) => e.kind === 'fuse').map((e) => e.id));
      if (fuseIds.size === 0) return s;
      // A reset un-blows every fuse in the engine; clear the store's live
      // copies and any queued pop-confirm, or the next frame's pendingStates
      // drain would re-apply `blown true` to a just-reset fuse. An already
      // intact fuse keeps its element object, so the reset is a no-op for it.
      const pendingStates = new Map(s.pendingStates);
      let pendingChanged = false;
      for (const id of [...pendingStates.keys()]) {
        if (fuseIds.has(id)) {
          pendingStates.delete(id);
          pendingChanged = true;
        }
      }
      let stateChanged = false;
      const elements = s.elements.map((e) => {
        if (e.kind === 'fuse' && (e.state ?? 0) !== 0) {
          stateChanged = true;
          return { ...e, state: 0 };
        }
        return e;
      });
      if (!stateChanged && !pendingChanged) return s;
      return {
        ...(stateChanged ? { elements } : {}),
        ...(pendingChanged ? { pendingStates } : {}),
      };
    }),

  setKeyShortcut: (id, key) =>
    set((s) => ({
      elements: s.elements.map((e) => {
        if (e.id !== id) return e;
        // Upstream takes only the first character, lowercased, and clears on
        // empty (SwitchElm.java:277-283). Session-only: it never enters the
        // netlist (SwitchElm.java:79-90 stores it in XML only), so nothing
        // here forces an engine reload or a redraw.
        const k = key.trim();
        const next = { ...e };
        if (k.length === 0) delete next.keyShortcut;
        else next.keyShortcut = k.charAt(0).toLowerCase();
        return next;
      }),
    })),

  toggleSwitchByKey: (key) => {
    const s = get();
    // A switch assigned this key beats every command binding, upstream's
    // keypress branch that runs before the shortcut map (UIManager.java:
    // 1248-1268). Every matching switch throws, exactly as upstream loops the
    // whole element list (UIManager.java:1256-1268); a single find() would
    // leave a second shared-key switch untoggled, so a keyup releasing all
    // momentary ones would close a momentary that the keydown never opened.
    // No undo entry: a keyboard toggle is a run-mode action, and upstream's
    // toggle pushes none (doSwitch returns before pushUndo). The pressed key
    // folds to lowercase like the stored assignment, so Shift+k and k both
    // throw it.
    const k = normalizeKey(key);
    let toggled = false;
    for (const e of s.elements) {
      if (
        (e.kind === 'switch' || e.kind === 'switch2' || e.kind === 'mbbSwitch' || e.kind === 'dpdtSwitch') &&
        e.keyShortcut === k
      ) {
        s.toggleSwitch(e.id);
        toggled = true;
      }
    }
    return toggled;
  },

  releaseMomentaryByKey: (key) => {
    const s = get();
    // A momentary switch returns to rest when its shortcut key is let go
    // (UIManager.java:1113-1131), the keyboard mirror of the pointer-up
    // releaseHeldMomentary path.
    const k = normalizeKey(key);
    for (const e of s.elements) {
      if (
        (e.kind === 'switch' || e.kind === 'switch2' || e.kind === 'mbbSwitch' || e.kind === 'dpdtSwitch') &&
        (e.params.momentary ?? 0) !== 0 &&
        e.keyShortcut === k
      ) {
        s.toggleSwitch(e.id);
      }
    }
  },

  clearPending: () =>
    set((s) =>
      s.pendingParams.size === 0 && s.pendingStates.size === 0
        ? s
        : { pendingParams: new Map(), pendingStates: new Map() },
    ),

  addScope: (elementId, value) => {
    // One trace per element and quantity is plenty; adding the same one twice
    // is almost always a misclick. Compare plot-by-plot so a two-plot line
    // already showing this quantity is not duplicated, while a scope on a
    // different quantity of the same element still is.
    if (
      get().scopes.some((x) => x.plots.some((p) => p.elementId === elementId && p.value === value))
    ) {
      return;
    }
    get().commit();
    set((s) => {
      const id = allocateId();
      const plots: ScopePlot[] = [makePlot(id, elementId, value)];
      // A voltage scope gets a current companion for most elements, mirroring
      // upstream's addValue (Scope.java:355-367); output-like elements are
      // excluded, and the current companion follows the show-dots setting.
      const kind = s.elements.find((e) => e.id === elementId)?.kind;
      if (
        value === 'voltage' &&
        s.settings.showCurrent &&
        kind !== undefined &&
        !OUTPUT_LIKE.has(kind)
      ) {
        plots.push(makePlot(allocateId(), elementId, 'current'));
      }
      return {
        scopes: [...s.scopes, makeScope(id, null, plots, UI_SCOPE_SPEED, s.scopes.length)],
        ...bumpRevision(s),
      };
    });
  },

  addToScope: (elementId, scopeId, value) => {
    const s = get();
    const scope = s.scopes.find((x) => x.id === scopeId);
    if (!scope) return;
    // Dedup is scope-local, unlike addScope's global one: the command's point
    // is reaching a specific panel, and showing the same quantity twice there
    // is the misclick addScope guards against. Another scope may already show
    // it and that is fine.
    if (scope.plots.some((p) => p.elementId === elementId && p.value === value)) return;
    s.commit();
    set((st) => {
      const target = st.scopes.find((x) => x.id === scopeId);
      if (!target) return st;
      const plots = [...target.plots, makePlot(allocateId(), elementId, value)];
      // The voltage plot drags its current companion along like addScope and
      // upstream's addValue (Scope.java:360-367), unless this scope already
      // shows the current.
      const kind = st.elements.find((e) => e.id === elementId)?.kind;
      if (
        value === 'voltage' &&
        st.settings.showCurrent &&
        kind !== undefined &&
        !OUTPUT_LIKE.has(kind) &&
        !plots.some((p) => p.elementId === elementId && p.value === 'current')
      ) {
        plots.push(makePlot(allocateId(), elementId, 'current'));
      }
      return {
        scopes: st.scopes.map((x) => (x.id === scopeId ? { ...x, plots } : x)),
        ...bumpRevision(st),
      };
    });
  },

  removeScope: (id) => {
    if (!get().scopes.some((x) => x.id === id)) return;
    get().commit();
    set((s) => ({
      scopes: s.scopes.filter((x) => x.id !== id),
      ...bumpRevision(s),
    }));
  },

  resetScope: (id) => {
    if (!get().scopes.some((x) => x.id === id)) return;
    // The Reset command clears the capture buffer and the sticky scale, which
    // a rebuild does for the buffer; the menu drops the scale state itself.
    set((s) => bumpRevision(s));
  },

  setScopeSpeed: (id, speed) => {
    const s = get();
    const clamped = scopeSpeed(speed);
    const scope = s.scopes.find((x) => x.id === id);
    // A no-op must not touch scopeRevision, or a wheel tick with nothing to
    // do would still patch the engine; committing it would also push a
    // spurious undo entry.
    if (!scope || scope.speed === clamped) return;
    if (!s.scopeGesture) s.commit();
    set((st) => ({
      scopes: st.scopes.map((x) => (x.id === id ? { ...x, speed: clamped } : x)),
      scopeRevision: st.scopeRevision + 1,
    }));
  },

  setScopeTrigger: (id, patch) => {
    const s = get();
    const scope = s.scopes.find((x) => x.id === id);
    if (!scope) return;
    const trigger = { ...scope.trigger, ...patch };
    // A patch that changes nothing must not reload the engine or push an undo
    // entry; the three fields are the whole ScopeTrigger.
    if (
      trigger.mode === scope.trigger.mode &&
      trigger.edge === scope.trigger.edge &&
      trigger.level === scope.trigger.level
    ) {
      return;
    }
    if (!s.scopeGesture) s.commit();
    set((st) => ({
      scopes: st.scopes.map((x) => (x.id === id ? { ...x, trigger } : x)),
      // The trigger is part of the engine spec, so it must reload.
      ...bumpRevision(st),
    }));
  },

  setScopeFlags: (id, patch) => {
    const s = get();
    const scope = s.scopes.find((x) => x.id === id);
    if (!scope) return;
    // A patch whose keys already hold their values changes nothing; skipping
    // it avoids both the notify and a spurious undo entry.
    if (Object.entries(patch).every(([k, v]) => scope[k as keyof Scope] === v)) return;
    if (!s.scopeGesture) s.commit();
    set((st) => ({
      scopes: st.scopes.map((x) => (x.id === id ? { ...x, ...patch } : x)),
    }));
  },

  resetScopeToDefaults: (id) => {
    const s = get();
    const scope = s.scopes.find((x) => x.id === id);
    if (!scope) return;
    s.commit();
    // The traces stay: a reset is about how the panel is drawn, not about what
    // it watches. Only the per-plot state the dialog can set by hand (manual
    // scale, vertical position, coupling) goes back to automatic, and
    // `makePlot`'s rule that a power, charge or resistance trace starts at the
    // bottom of the manual screen is reapplied rather than zeroed.
    const plots = scope.plots.map((p) => ({
      ...p,
      manScale: null,
      manVPosition: makePlot(p.id, p.elementId, p.value).manVPosition,
      acCoupled: false,
      // Reset to Default is about how the panel draws: the per-trace
      // measurement overrides go back to inheriting the scope word too.
      measurements: null,
    }));
    // `makeScope` is what a fresh panel goes through, stored defaults and all,
    // so "default" here means the same thing the Save as Default button writes:
    // the two buttons sit side by side and must agree.
    const fresh = makeScope(scope.id, scope.raw, plots, UI_SCOPE_SPEED, scope.position);
    set((st) => ({
      scopes: st.scopes.map((x) => (x.id === id ? fresh : x)),
      // The trigger and the plot set are part of the engine spec, and the speed
      // is part of the scope patch, so both revisions move.
      scopeRevision: st.scopeRevision + 1,
      ...bumpRevision(st),
    }));
  },

  setScopeShowValue: (scopeId, value, show) =>
    set((s) => {
      const scope = s.scopes.find((x) => x.id === scopeId);
      if (!scope) return s;
      const key = value === 'voltage' ? 'showV' : 'showI';
      const first = scope.plots.find((p) => p.elementId !== null)?.elementId ?? null;
      // Turning a value on with no plot of it present adds one for the
      // scope's first element, upstream's showVoltage/showCurrent
      // (Scope.java:115-134). A plot is a netlist change, so adding one
      // bumps revision; the visibility flag alone is display-only and must
      // not rewind the simulation.
      const addPlot = show && first !== null && !scope.plots.some((p) => p.value === value);
      if (!addPlot && scope[key] === show) return s;
      return {
        scopes: s.scopes.map((x) =>
          x.id === scopeId
            ? {
                ...x,
                [key]: show,
                plots: addPlot ? [...x.plots, makePlot(allocateId(), first, value)] : x.plots,
              }
            : x,
        ),
        ...(addPlot ? bumpRevision(s) : {}),
      };
    }),

  setPlotCoupling: (scopeId, plotId, acCoupled) => {
    const s = get();
    const scope = s.scopes.find((x) => x.id === scopeId);
    if (!scope) return;
    const plot = scope.plots.find((p) => p.id === plotId);
    // The effective flag is what a voltage plot can carry (canAcCouple); a
    // repeat of the same state changes nothing and must not push an undo
    // entry.
    if (!plot || plot.acCoupled === (acCoupled && plot.value === 'voltage')) return;
    if (!s.scopeGesture) s.commit();
    set((st) => ({
      scopes: st.scopes.map((x) =>
        x.id === scopeId
          ? {
              ...x,
              plots: x.plots.map((p) =>
                p.id === plotId ? { ...p, acCoupled: acCoupled && p.value === 'voltage' } : p,
              ),
            }
          : x,
      ),
      // AC coupling is a scope-capture flag, applied through the engine's
      // scope fast path (applyScopeParams), so toggling it must not rewind
      // the simulation. The trigger path has no fast path yet and still
      // reloads; see setScopeTrigger.
    }));
  },

  /** One plot's per-trace measurement readout, the properties dialog's
   *  per-channel checkbox path. The mask is seeded from the scope word so a
   *  first override carries the inherited values for every other readout;
   *  display-only, like setScopeFlags. */
  setPlotMeasurementFlag: (plotId, key, on) => {
    const s = get();
    const scope = s.scopes.find((x) => x.plots.some((p) => p.id === plotId));
    if (!scope) return;
    const plot = scope.plots.find((p) => p.id === plotId);
    // A mask already holding the value is a repeat click: no change and no
    // undo entry. Without a mask the checkbox shows the inherited value, so
    // a click always flips something.
    if (!plot || (plot.measurements !== null && plot.measurements[key] === on)) return;
    if (!s.scopeGesture) s.commit();
    set((st) => ({
      scopes: st.scopes.map((x) =>
        x.id === scope.id
          ? {
              ...x,
              plots: x.plots.map((p) =>
                p.id === plotId
                  ? {
                      ...p,
                      measurements: { ...measurementsFromScope(x), ...p.measurements, [key]: on },
                    }
                  : p,
              ),
            }
          : x,
      ),
    }));
  },

  /** Drops every plot's measurement mask in one scope so all traces inherit
   *  the scope word again: the "Apply to all traces" toggle's switch-on path,
   *  so no stale per-trace override hides behind the scope checkboxes. */
  clearPlotMeasurementOverrides: (scopeId) => {
    const s = get();
    const scope = s.scopes.find((x) => x.id === scopeId);
    // A scope without overrides has nothing to clear and must not push an
    // undo entry.
    if (!scope || !scope.plots.some((p) => p.measurements !== null)) return;
    if (!s.scopeGesture) s.commit();
    set((st) => ({
      scopes: st.scopes.map((x) =>
        x.id === scopeId
          ? {
              ...x,
              plots: x.plots.map((p) => (p.measurements === null ? p : { ...p, measurements: null })),
            }
          : x,
      ),
    }));
  },

  setPlotManScale: (plotId, manScale) => {
    const s = get();
    const scope = s.scopes.find((x) => x.plots.some((p) => p.id === plotId));
    if (!scope) return;
    const plot = scope.plots.find((p) => p.id === plotId)!;
    // A repeat of the current scale changes nothing and must not push an undo
    // entry.
    if (plot.manScale === manScale) return;
    if (!s.scopeGesture) s.commit();
    set((st) => ({
      scopes: st.scopes.map((x) => ({
        ...x,
        plots: x.plots.map((p) => (p.id === plotId ? { ...p, manScale } : p)),
      })),
    }));
  },

  setPlotManPosition: (plotId, manVPosition) => {
    const s = get();
    const scope = s.scopes.find((x) => x.plots.some((p) => p.id === plotId));
    if (!scope) return;
    const clamped = positionToOffset(manVPosition);
    const plot = scope.plots.find((p) => p.id === plotId)!;
    // A repeat of the current position (a drag frame that clamped to the same
    // value) changes nothing and must not push an undo entry.
    if (plot.manVPosition === clamped) return;
    if (!s.scopeGesture) s.commit();
    set((st) => ({
      scopes: st.scopes.map((x) => ({
        ...x,
        plots: x.plots.map((p) =>
          // Upstream's +-V_POSITION_STEPS span (Scope.java:1227-1228); the
          // draw divides by the same 200, so a 200 parks a plot at the very
          // top of the screen.
          p.id === plotId ? { ...p, manVPosition: clamped } : p,
        ),
      })),
    }));
  },

  togglePlot: (scopeId, value) => {
    const scope = get().scopes.find((x) => x.id === scopeId);
    if (!scope) return;
    const has = scope.plots.some((p) => p.value === value && p.elementId !== null);
    if (has && scope.plots.length <= 1) return;
    get().commit();
    set((s) => {
      const target = s.scopes.find((x) => x.id === scopeId);
      if (!target) return s;
      if (target.plots.some((p) => p.value === value && p.elementId !== null)) {
        // Removing must never empty the panel; the guard above already
        // refused the single-plot scope.
        return {
          scopes: s.scopes.map((x) =>
            x.id === scopeId
              ? { ...x, plots: x.plots.filter((p) => !(p.value === value && p.elementId !== null)) }
              : x,
          ),
          ...bumpRevision(s),
        };
      }
      const elementId = target.plots.find((p) => p.elementId !== null)?.elementId ?? null;
      if (elementId === null) return s;
      return {
        scopes: s.scopes.map((x) =>
          x.id === scopeId
            ? { ...x, plots: [...x.plots, makePlot(allocateId(), elementId, value)] }
            : x,
        ),
        ...bumpRevision(s),
      };
    });
  },

  /** The properties dialog's Show Vce vs Ic row, upstream's showvcevsic menu
   *  command (Scope.java:1312-1317): replace the plot list with exactly the
   *  VCE/IC pair on the scope's element and turn the 2D plot on, resetting the
   *  axes and modulators the way upstream's plotxy branch does. Unchecking is
   *  the dialog's setScopeFlags({plotXY:false}); upstream ignores its state
   *  bit entirely (the branch re-applies either way), so the port takes the
   *  reversible reading. */
  setScopeVceIc: (scopeId) => {
    const s = get();
    const scope = s.scopes.find((x) => x.id === scopeId);
    if (!scope) return;
    const elementId = scope.plots.find((p) => p.elementId !== null)?.elementId ?? null;
    if (elementId === null) return;
    const pair =
      scope.plotXY &&
      scope.plotX === 0 &&
      scope.plotY === 1 &&
      scope.plotBrightness === -1 &&
      scope.plotColorR === -1 &&
      scope.plotColorG === -1 &&
      scope.plotColorB === -1 &&
      scope.plots.length === 2 &&
      scope.plots[0].elementId === elementId &&
      scope.plots[0].value === 'vce' &&
      scope.plots[1].elementId === elementId &&
      scope.plots[1].value === 'ic';
    // Already the arrangement: a repeat click must not push an undo entry.
    if (pair) return;
    s.commit();
    set((st) => ({
      scopes: st.scopes.map((x) =>
        x.id === scopeId
          ? {
              ...x,
              plotXY: true,
              plotX: 0,
              plotY: 1,
              plotBrightness: -1,
              plotColorR: -1,
              plotColorG: -1,
              plotColorB: -1,
              plots: [
                makePlot(allocateId(), elementId, 'vce'),
                makePlot(allocateId(), elementId, 'ic'),
              ],
            }
          : x,
      ),
      ...bumpRevision(st),
    }));
  },

  combineScopes: (aId, bId) => {
    if (aId === bId) return;
    const s = get();
    if (!s.scopes.some((x) => x.id === aId) || !s.scopes.some((x) => x.id === bId)) return;
    s.commit();
    set((st) => {
      const a = st.scopes.find((x) => x.id === aId);
      const b = st.scopes.find((x) => x.id === bId);
      if (!a || !b) return st;
      return {
        scopes: st.scopes
          .filter((x) => x.id !== bId)
          .map((x) => (x.id === aId ? { ...x, plots: [...x.plots, ...b.plots] } : x)),
        ...bumpRevision(st),
      };
    });
  },

  separateScope: (id) => {
    const s = get();
    if (!s.scopes.some((x) => x.id === id)) return;
    s.commit();
    set((st) => {
      const scope = st.scopes.find((x) => x.id === id);
      if (!scope) return st;
      const others = st.scopes.filter((x) => x.id !== id);
      const base = others.reduce((m, x) => Math.max(m, x.position), -1) + 1;
      const out: Scope[] = [];
      let last: ScopePlot | null = null;
      // A voltage plot and the current plot of the same element stay together
      // (Scope.separate, Scope.java:453-471); anything else splits off.
      for (const p of scope.plots) {
        const prev = out[out.length - 1];
        if (
          last &&
          last.elementId === p.elementId &&
          last.value === 'voltage' &&
          p.value === 'current'
        ) {
          out[out.length - 1] = { ...prev, plots: [...prev.plots, p] };
          last = p;
          continue;
        }
        out.push({
          // A split scope inherits the parent's speed over the stored scope
          // defaults, exactly as Scope.separate calls setSpeed after the new
          // Scope's initialize() ran loadDefaults (Scope.java:459-468).
          ...makeScope(allocateId(), null, [p], scope.speed, base + out.length),
          speed: scope.speed,
        });
        last = p;
      }
      return { scopes: [...others, ...out], ...bumpRevision(st) };
    });
  },

  stackScope: (id) => {
    const s = get();
    const i = s.scopes.findIndex((x) => x.id === id);
    if (i <= 0 || s.scopes[i].position === s.scopes[i - 1].position) return;
    s.commit();
    set((st) => {
      const target = st.scopes[i - 1].position;
      // Move the scope into the previous column and close the gap it left
      // (ScopeManager.stackScope, ScopeManager.java:253-262).
      return {
        scopes: st.scopes.map((x, j) => {
          if (j === i) return { ...x, position: target };
          if (j > i) return { ...x, position: Math.max(0, x.position - 1) };
          return x;
        }),
        ...bumpRevision(st),
      };
    });
  },

  unstackScope: (id) => {
    const s = get();
    let i = s.scopes.findIndex((x) => x.id === id);
    if (i <= 0) return;
    // Selecting the top scope of a stack still un-stacks it
    // (ScopeManager.unstackScope, ScopeManager.java:264-274).
    if (s.scopes[i].position !== s.scopes[i - 1].position) i += 1;
    s.commit();
    set((st) => ({
      scopes: st.scopes.map((x, j) => (j >= i ? { ...x, position: x.position + 1 } : x)),
      ...bumpRevision(st),
    }));
  },

  stackAllScopes: () => {
    if (get().scopes.length === 0) return;
    // One commit for the whole batch, so the menu command is one undo step.
    get().commit();
    set((s) => ({
      scopes: s.scopes.map((x) => ({ ...x, position: 0, showMax: false, showMin: false })),
      ...bumpRevision(s),
    }));
  },

  unstackAllScopes: () => {
    if (get().scopes.length === 0) return;
    get().commit();
    set((s) => ({
      scopes: s.scopes.map((x, i) => ({ ...x, position: i, showMax: true })),
      ...bumpRevision(s),
    }));
  },

  combineAllScopes: () => {
    const s = get();
    if (s.scopes.length < 2) return;
    s.commit();
    set((st) => {
      const first = st.scopes[0];
      // Everything folds into the first scope, plot order preserved, matching
      // the reverse combine loop of ScopeManager.combineAll.
      return {
        scopes: [{ ...first, plots: st.scopes.flatMap((x) => x.plots) }],
        ...bumpRevision(st),
      };
    });
  },

  separateAllScopes: () => {
    const s = get();
    if (s.scopes.length === 0) return;
    s.commit();
    set((st) => {
      let position = 0;
      const out: Scope[] = [];
      for (const scope of st.scopes) {
        // Reuses the per-scope pairing rule: a V+I pair of the same element
        // stays together, everything else splits off (Scope.separate).
        let last: ScopePlot | null = null;
        for (const p of scope.plots) {
          const prev = out[out.length - 1];
          if (
            last &&
            last.elementId === p.elementId &&
            last.value === 'voltage' &&
            p.value === 'current'
          ) {
            out[out.length - 1] = { ...prev, plots: [...prev.plots, p] };
            last = p;
            continue;
          }
          out.push({
            // A split scope inherits the parent's speed over the stored scope
            // defaults, exactly as Scope.separate calls setSpeed after the new
            // Scope's initialize() ran loadDefaults (Scope.java:459-468).
            ...makeScope(allocateId(), null, [p], scope.speed, position++),
            speed: scope.speed,
          });
          last = p;
        }
      }
      return { scopes: out, ...bumpRevision(st) };
    });
  },

  openUndockedScope: (elementId) => {
    const s = get();
    // One undocked window at a time: the mirror pushes a copied snapshot per
    // frame, and two windows would double that for little gain. The menu row
    // greys out for the same rule; this is the backstop for races.
    if (s.undocked) {
      s.setNotice('An undocked scope window is already open');
      return;
    }
    // The open must happen inside the click's user gesture or the browser's
    // popup blocker refuses it, so nothing may await before this call. The
    // canvas starts at the width the mirror computes trigger state against:
    // a fresh scope has no measured panel yet, so this is the same default
    // the frame loop's trigger computation falls back to, and the popup and
    // the dock align until the user resizes one of them.
    const size = undockedWindowOuterSize(DEFAULT_SCOPE_WIDTH);
    const win = window.open(
      `${import.meta.env.BASE_URL}pages/scopewin.html`,
      '_blank',
      `width=${size.width},height=${size.height}`,
    );
    if (!win) {
      s.setNotice('The browser blocked the pop-up window; allow pop-ups to undock a scope');
      return;
    }
    attachUndockedWindow(win, () => get().closeUndockedScope());
    s.commit();
    set((st) => {
      // Upstream's identically named command drops a floating scope element
      // onto the schematic near the clicked element (CommandManager.java:
      // 192-198); this port re-interprets the row as a display-only second
      // window instead. What carries over is upstream's always-fresh-scope
      // rule: no dedup against existing panels, because redocking one would
      // surprise whoever docked it. The plot shape is addScope's
      // voltage-plus-current-companion pair.
      const id = allocateId();
      const plots: ScopePlot[] = [makePlot(id, elementId, 'voltage')];
      const kind = st.elements.find((e) => e.id === elementId)?.kind;
      if (
        st.settings.showCurrent &&
        kind !== undefined &&
        !OUTPUT_LIKE.has(kind)
      ) {
        plots.push(makePlot(allocateId(), elementId, 'current'));
      }
      return {
        scopes: [...st.scopes, makeScope(id, null, plots, UI_SCOPE_SPEED, st.scopes.length)],
        ...bumpRevision(st),
        undocked: { scopeId: id, windowRef: undockedWindow() },
      };
    });
  },

  closeUndockedScope: () => {
    if (!get().undocked) return;
    // Closing the popup first reads best: the window disappears with the
    // click rather than after the state update lands. The bridge drops its
    // own attachment here, so the frame loop stops pushing immediately.
    detachUndockedWindow(true);
    set({ undocked: null });
  },

  loadNetlist: (text, opts) => {
    // The sample cache belongs to the open file, like the session models: the
    // previous file's buffers go, this file's fileNum tokens resolve to
    // nothing until the user imports fresh files (upstream clears both caches
    // on load, CircuitLoader.java:239-240).
    clearSampleCache();
    // The writable device-model store is document-scoped too. It must be empty
    // before the parse runs, or the fresh file's elements would resolve their
    // model names against the previous document's entries; the current file's
    // `34`/`32` lines are committed right after, the document-counter reset
    // the device-model feature rides (feature/overview.md, Live-state
    // read-back).
    clearUserModels();
    const parsed = parseCircuit(text);
    // The subcircuit library's session half belongs to the open file, so a load
    // rebuilds it: the previous file's `.` lines go, this file's arrive. Saved
    // models live in storage and are untouched by either half of this.
    clearSessionModels();
    for (const model of parsed.compositeModels) registerSessionModel(model);
    // The file's own `34`/`32` lines enter the writable device-model store the
    // same way, so the editor can tune them and the save path can rewrite an
    // edited line.
    registerFileModels(parsed.diodeFileModels, parsed.transistorFileModels);
    // The parser is deliberately pure, so a 410 can only resolve its model
    // name against the file's own `.` lines. Re-resolve every element against
    // the merged library (session then storage) so a 410 whose model lives
    // only in storage simulates at load, the way placement and paste do.
    // A `.`-named 410 re-derives the identical spec, the file's copy winning
    // over storage. A 410 serializes only its text, never the payload, so the
    // saved output is unchanged.
    const resolved = parsed.elements.map(resolveCompositeModel);
    // The parser has already resolved each plot's element index, which counts
    // element lines this build cannot read. The scope's display fields are
    // decoded from the raw tokens here and merged over the makeScope defaults,
    // so a loaded file renders and measures as configured; the raw tokens stay
    // attached so an untouched line still saves byte-for-byte.
    const kindById = new Map(resolved.map((e) => [e.id, e.kind]));
    const scopes: Scope[] = [];
    const unmatchedScopes: ScopeConfig[] = [];
    for (const c of parsed.scopes) {
      if (c.elementId === undefined) unmatchedScopes.push(c);
      else {
        // raw[0] is the speed token in both line styles (the o-line walk
        // starts at the element index, so raw slices it off). The scope's own
        // index in the list so far is the position fallback a line without a
        // position token gets, the same value the save path re-derives from
        // the scope's position in the store array.
        const speed = scopeSpeed(Number(c.raw[0]) || 64);
        const plots = c.plots.map((p) => makePlot(p.id, p.elementId ?? null, p.value));
        const kinds = c.plots.map((p) =>
          p.elementId === undefined ? null : (kindById.get(p.elementId) ?? null),
        );
        const decoded = decodeScopeLine(c.raw, plots, kinds, scopes.length);
        // Only the display fields merge: speed keeps the load path's clamping,
        // the trigger stays at the freeRun default (the text format carries no
        // trigger state), and the per-plot fields land on their plots.
        const { perPlot, speed: _speed, ...display } = decoded;
        scopes.push({
          ...makeScope(c.id, c.raw, plots, speed, decoded.position),
          ...display,
          // Re-assert the file's speed token: makeScope applies the stored
          // scope defaults first, and the file's own speed wins over them,
          // exactly as undump reads the speed after initialize()
          // (ScopeSerializer.java:195).
          speed,
          plots: plots.map((p, i) => ({
            ...p,
            acCoupled: perPlot[i].acCoupled,
            manScale: perPlot[i].manScale,
            manVPosition: perPlot[i].manVPosition,
            measurements: perPlot[i].measurements,
          })),
        });
      }
    }

    // The load banner: the missing-elements message plus any clamp-on-load
    // warnings (a hand-edited 12-input gate loading as 8), joined the same way
    // the frame loop joins the engine warnings, so a rebuild cannot wipe them.
    const loadProblem = mergeProblem(describeMissingComponents(parsed.unsupported), parsed.warnings);

    set((s) => ({
      elements: resolved,
      scopes,
      sliders: parsed.sliders.map((c): Slider => ({ ...c })),
      unmatchedScopes,
      passthrough: parsed.passthrough,
      order: parsed.order,
      settings: {
        ...s.settings,
        ...UNMODELLED_HEADER,
        // A file that stops before these tokens (or has no `$` line at all)
        // must fall back to the upstream new-circuit values, not inherit the
        // previous file's stepping behaviour.
        minTimeStep: DEFAULT_SETTINGS.minTimeStep,
        iterCount: DEFAULT_SETTINGS.iterCount,
        adaptiveTimeStep: DEFAULT_SETTINGS.adaptiveTimeStep,
        autoDC: DEFAULT_SETTINGS.autoDC,
        powerRange: DEFAULT_SETTINGS.powerRange,
        ...parsed.settings,
      },
      selectedIds: [],
      hoveredId: null,
      undoStack: [],
      redoStack: [],
      problem: loadProblem,
      // The same message in its own field: the frame loop's first engine build
      // must not wipe the banner, so it merges this with the engine warnings
      // instead of overwriting the store's `problem`.
      unsupportedProblem: loadProblem,
      // The previous circuit's notice says nothing about this one.
      notice: null,
      // A refusal from the previous circuit says nothing about this one.
      subcircuitError: null,
      // A load is a new document: any drill-in session that returned to it no
      // longer has a home, so the context stack is reset wholesale, exactly as
      // upstream's resetEditingContext clears it (CirSim.java:508-511).
      subcircuitStack: [],
      ...bumpRevision(s),
      // A load is a new document: the frame loop's rebuild gate must refuse to
      // inject the previous circuit's live charges into it.
      document: s.document + 1,
    }));
    // A load is a new document on screen too: centre it the way upstream's
    // finishReadCircuit always does unless RC_NO_CENTER is passed
    // (CircuitLoader.java:220-235), so opening a file doesn't leave the view
    // wherever the previous circuit happened to scroll to. The drill-in exit
    // passes noCenter and restores the saved view itself.
    // The fit runs twice on purpose. The immediate one keeps the store honest
    // on its own (headless callers, tests) and gets the first frame close;
    // the request re-fits after React has committed the new layout, because a
    // circuit that brings scopes with it (or drops the ones on screen) resizes
    // the canvas by the scope strip's height, and the size read above is still
    // the previous layout's.
    if (opts?.noCenter) {
      // A noCenter caller owns both the view and the baseline afterwards: the
      // drill-in exits are plain restores and must never touch lastSaved.
      return;
    }
    get().centerCircuit();
    get().requestCenter();
    // The loaded content is its own baseline: opening a file, a library
    // circuit or a share link is not "unsaved". `set` is synchronous, so this
    // `get()` reads the just-loaded state. The drill-in enter passes
    // noBaseline: lastSaved belongs to the outer document for the whole
    // session, and overwriting it with the inner netlist would read the
    // restored outer document dirty forever.
    if (!opts?.noBaseline) {
      set({ lastSaved: get().toNetlist() });
    }
  },

  toNetlist: () => {
    return serializeDocument(get().elements);
  },

  saveNetlist: () => {
    const live = get().liveStateProvider?.() ?? {};
    return serializeDocument(overlayLiveState(get().elements, live));
  },

  recoveryNetlist: () => {
    const s = get();
    // While a drill-in session is up, the inner sheet is scratch editing
    // context: the slot records the stack root so a crash recovers onto the
    // outer circuit as if the drill-in never happened. The entry's document
    // is already netlist text, so this serialises nothing.
    const root = s.subcircuitStack[0];
    return root !== undefined ? root.document : s.saveNetlist();
  },

  setLiveStateProvider: (provider) => set({ liveStateProvider: provider }),

  enterSubcircuit: (name) => {
    const s = get();
    // The default model is the built-in stub, not a model the user can edit,
    // matching upstream's refusal (CustomCompositeElm.java:253-255).
    if (name === DEFAULT_MODEL_NAME) {
      set({ subcircuitError: "Can't edit this model." });
      return false;
    }
    // The model must resolve somewhere: the session map first (the file's own
    // `.` lines), then storage, exactly the lookup the library and the 410
    // resolution use.
    const model = getModel(name);
    if (model === undefined) {
      set({ subcircuitError: `No subcircuit named "${name}" exists.` });
      return false;
    }
    // Reconstruct the editable inner document and check it loads cleanly. A
    // child kind the port cannot parse (a model not created here) must refuse
    // with the unsupported-kind banner rather than half-loading, reusing
    // ParsedCircuit.unsupported rather than inventing a second signal.
    // A model whose children include a 410 is a nested subcircuit. Drilling in
    // would have to load another model inside the editing context, which this
    // build does not support yet, so refuse with a specific message rather than
    // half-loading a document that points at an uneditable child
    // (upstream's CustomCompositeElm carries no edit-context for its children).
    if (modelHasNestedSubcircuit(model)) {
      set({
        subcircuitError:
          "This subcircuit contains a nested subcircuit, which can't be edited here yet.",
      });
      return false;
    }
    // Reconstruct the editable inner document and check it loads cleanly. A
    // child kind the port cannot parse (a model not created here) must refuse
    // with the unsupported-kind banner rather than half-loading, reusing
    // ParsedCircuit.unsupported rather than inventing a second signal.
    const inner = documentFromComposite(model);
    const missing = describeMissingComponents(parseCircuit(inner).unsupported);
    if (missing !== null) {
      set({ subcircuitError: missing });
      return false;
    }
    // The entry must be captured before the load: loadNetlist resets the stack
    // (a load is a fresh document), so the snapshot reads the document that is
    // about to be replaced, and the entry is set after the load re-pushed the
    // cleared stack position. The session caches freeze here too: the inner
    // load wipes them like any load, and only the exit brings this world back.
    const entry = {
      modelName: name,
      // saveNetlist, not toNetlist: the exit reloads this text, so the outer
      // circuit's live reactive charge (capacitor voltDiff, inductor currents)
      // must ride inside it or a look-and-return would discharge the circuit.
      // The document bump inside both loads keeps the rebuild gate from
      // injecting engine state across the round trip, so these tokens are the
      // operating point's only ride home.
      document: s.saveNetlist(),
      view: s.view,
      session: { samples: snapshotSampleCache(), models: snapshotUserModels() },
      // The outer level's undo histories are suspended here for the drill-in,
      // upstream's pushContext stash (CirSim.java:476-482). Both loads of the
      // round trip wipe the live stacks unconditionally, so without this every
      // pre-drill edit would come home unundoable. Copied, not aliased, like
      // the session caches: a stack mutated between here and its restore must
      // not reach back into this entry.
      undo: [...s.undoStack],
      redo: [...s.redoStack],
      // The app's own clean check, evaluated before anything is loaded: live
      // charge alone never reads dirty against lastSaved, so a charged but
      // unsaved-looking circuit counts as clean here exactly as it does in
      // App.tsx's beforeunload guard.
      cleanAtEnter: !hasUnsavedChanges(s.lastSaved, s.toNetlist()),
    };
    const stack = s.subcircuitStack;
    // noBaseline keeps lastSaved on the outer document for the whole session.
    // While inside, hasUnsavedChanges compares the inner sheet against that
    // outer baseline and may read dirty with no inner edit; that false
    // positive beats silently discarding unsaved outer edits on close.
    s.loadNetlist(inner, { noBaseline: true });
    set({ subcircuitStack: [...stack, entry], subcircuitError: null });
    return true;
  },

  exitSubcircuit: () => {
    const s = get();
    const stack = s.subcircuitStack;
    const top = stack[stack.length - 1];
    if (top === undefined) return;
    // The enclosing document's copy of the edited model, matched by name in
    // its own `.` lines. A model that resolves only from storage has no line
    // here; its flag word is read from the stored copy instead (the session
    // map was cleared by the inner load, so the lookup reaches storage).
    const lineModel = modelInText(top.document, top.modelName);
    const storedModel = getModel(top.modelName);
    const previous = lineModel ?? storedModel ?? {
      name: top.modelName,
      flags: 0,
      sizeX: 1,
      sizeY: 1,
      extList: [],
      nodeList: '',
      elmDump: '',
    };
    const { model: next, error } = compositeFromDocument(top.modelName, s.toNetlist(), previous);
    // An extraction failure (a deleted pin label, a net left unused) keeps the
    // session inside with the create path's reason shown.
    if (next === null) {
      set({ subcircuitError: error });
      return;
    }
    // Entering and leaving without touching anything changes no model, so the
    // return is a plain restore with no undo entry, exactly the round-trip the
    // tests assert byte for byte.
    if (sameCompositeModel(previous, next)) {
      s.loadNetlist(top.document, { noCenter: true });
      // The restore load wiped the session caches like any load; the pre-enter
      // world comes back, so a look-and-return round trip is invisible to them.
      // lastSaved is untouched by a noCenter load and stays on the outer
      // document, which is what keeps the round trip clean-read as it started.
      restoreSampleCache(top.session.samples);
      restoreUserModels(top.session.models);
      // The reload also wiped both undo stacks; the suspended outer histories
      // come back here (upstream's popContext, CirSim.java:500-506), so
      // pre-drill edits stay undoable after a look-and-return with no edits.
      //
      // The baseline follows only when the document was clean at enter. The
      // restored tokens carry the live charge as configured params, so the
      // non-live text has moved off the old baseline; re-recording it keeps
      // that round trip reading clean, the convention that running a circuit
      // must never arm hasUnsavedChanges (App.tsx). A document dirty before
      // the drill-in keeps its baseline, so its real edits stay flagged.
      const nextLastSaved = top.cleanAtEnter ? get().toNetlist() : s.lastSaved;
      set({
        view: top.view,
        undoStack: top.undo,
        redoStack: top.redo,
        subcircuitStack: stack.slice(0, -1),
        lastSaved: nextLastSaved,
        // A prior refused exit may have left a message here; a successful return
        // clears it so the Escape/breadcrumb alert call sites stay silent.
        subcircuitError: null,
      });
      return;
    }
    // Rewrite the enclosing document's `.` line for the model. The match is on
    // the parsed body per the Findings rule, never on which half of the
    // library held it, so a saved model whose body matches no line never edits
    // an unrelated open file; such a model's edit persists through the library
    // instead.
    let outer = top.document;
    if (lineModel !== undefined) outer = rewriteModelLines(top.document, lineModel, next);
    else saveModel(next);
    // One undo entry on the outer document covering the model change, and the
    // inner session's undo history dies with it (upstream's per-context
    // stacks, CirSim.java:480-482). The pre-change snapshot is the saved outer
    // text, loaded once to parse it, then the after text is loaded and the
    // stack is popped. The view comes back from the entry, the way upstream
    // restores its transform.
    s.loadNetlist(top.document, { noCenter: true });
    const pre = clone(get());
    pre.view = top.view;
    s.loadNetlist(outer, { noCenter: true });
    // Same session-cache restore as the no-edit return: the model write-back
    // touches only the `.` line and storage, never these caches, so the
    // pre-enter namespace is exactly what the outer document expects.
    restoreSampleCache(top.session.samples);
    restoreUserModels(top.session.models);
    set({
      // The suspended outer history comes back first and this exit's
      // model-change baseline lands on top of it, so pre-drill edits stay
      // undoable past an edited drill-in too; upstream's popContext restores
      // its stashed stacks the same way (CirSim.java:500-506). The redo future
      // dies with the model change, the way every other edit clears it.
      undoStack: [...top.undo, pre].slice(-UNDO_LIMIT),
      redoStack: [],
      view: top.view,
      subcircuitStack: stack.slice(0, -1),
      // Same as the no-edit return: clear any stale refusal so the caller's
      // alert only fires on a real failure.
      subcircuitError: null,
    });
  },

  newCircuit: () => {
    // New drops the open file, and its `.` line models with it, the same reset
    // a load performs. Saved models stay in storage.
    clearSessionModels();
    clearSampleCache();
    // The writable device-model store is document-scoped like the sample
    // cache: New is a fresh document, so no model from the old one may haunt
    // the new circuit's picker.
    clearUserModels();
    set((s) => ({
      elements: [],
      scopes: [],
      sliders: [],
      unmatchedScopes: [],
      passthrough: [],
      order: [],
      // The header-borne settings reset to a fresh circuit's defaults, exactly
      // as upstream clears maxTimeStep/minTimeStep on New (CircuitLoader.java:
      // 49-50); app prefs (colours, digits, font size, wheel sensitivity,
      // crosshair, the European-resistor symbol) and plain settings
      // (stepsPerFrame, showGrid, ...) survive.
      settings: {
        ...s.settings,
        ...UNMODELLED_HEADER,
        timeStep: DEFAULT_SETTINGS.timeStep,
        currentSpeed: DEFAULT_SETTINGS.currentSpeed,
        voltageRange: DEFAULT_SETTINGS.voltageRange,
        powerRange: DEFAULT_SETTINGS.powerRange,
        minTimeStep: DEFAULT_SETTINGS.minTimeStep,
        iterCount: DEFAULT_SETTINGS.iterCount,
        showCurrent: DEFAULT_SETTINGS.showCurrent,
        showVoltageColor: DEFAULT_SETTINGS.showVoltageColor,
        showPowerColor: DEFAULT_SETTINGS.showPowerColor,
        showValues: DEFAULT_SETTINGS.showValues,
        adaptiveTimeStep: DEFAULT_SETTINGS.adaptiveTimeStep,
        autoDC: DEFAULT_SETTINGS.autoDC,
      },
      selectedIds: [],
      hoveredId: null,
      undoStack: [],
      redoStack: [],
      problem: null,
      // A fresh circuit has no unsupported lines, so nothing for the frame
      // loop to merge into the engine warnings.
      unsupportedProblem: null,
      notice: null,
      subcircuitError: null,
      // New drops the drill-in session too: the outer document is gone.
      subcircuitStack: [],
      ...bumpRevision(s),
      // New is a fresh document, like a load: no live charges carry over.
      document: s.document + 1,
    }));
    // An empty fresh circuit is clean.
    set({ lastSaved: get().toNetlist() });
  },

  markSaved: () => {
    // The baseline stays on the outer document while a drill-in session is up:
    // a Save As from inside (Ctrl+S or the File menu) exports the scratch
    // sheet, and recording the inner text here would read the restored outer
    // circuit dirty forever. Skipping keeps the exit's dirty state exactly the
    // pre-enter state.
    if (get().subcircuitStack.length > 0) return;
    set({ lastSaved: get().toNetlist() });
  },

  recoverAutoSave: () => {
    // Nothing stored: the row is greyed, and a stale click must not clear the
    // session state.
    const recovery = readRecovery();
    if (recovery === null) return;
    const before = get();
    // The undo entry is the pre-recovery circuit, and it must be pushed after
    // the load: loadNetlist wipes both stacks, so committing before it would
    // lose the entry upstream's doRecover takes (UndoManager.java:83-88).
    const pre = clone(before);
    before.loadNetlist(recovery);
    set((s) => ({
      // The row stays disabled for the session; later autosave writes do not
      // re-enable it, exactly as upstream never re-enables recoverItem.
      hasRecovery: false,
      // A recovered circuit has never been exported, so it counts as unsaved:
      // upstream's doRecover calls allowSave(false). loadNetlist baselines
      // lastSaved to the recovered netlist, which would read as clean; the
      // RECOVERED_UNSAVED sentinel can never equal a serialised dump.
      lastSaved: RECOVERED_UNSAVED,
      undoStack: [...s.undoStack, pre].slice(-UNDO_LIMIT),
      redoStack: [],
    }));
  },

  undo: () => {
    const s = get();
    const prev = s.undoStack[s.undoStack.length - 1];
    if (!prev) return;
    set({
      ...prev,
      undoStack: s.undoStack.slice(0, -1),
      redoStack: [...s.redoStack, clone(s)],
      selectedIds: [],
      // An in-flight gesture cannot survive a state revert; drop the flag so it
      // does not strand a single undo entry open.
      scopeGesture: false,
      ...bumpRevision(s),
    });
    // The `.` lines that came back define library models, so the session half
    // of the library follows them. Both line sets are read, so a step that did
    // not touch a `.` line changes nothing here.
    syncSessionModels(s.passthrough, prev.passthrough);
    // A restored element can reference a writable device model the delete that
    // took it away pruned from the store; put such a model back, or a save
    // would drop its `34`/`32` line and a reload would silently revert it.
    restorePrunedModels(useStore.getState().elements);
  },

  redo: () => {
    const s = get();
    const next = s.redoStack[s.redoStack.length - 1];
    if (!next) return;
    set({
      ...next,
      redoStack: s.redoStack.slice(0, -1),
      undoStack: [...s.undoStack, clone(s)],
      selectedIds: [],
      scopeGesture: false,
      ...bumpRevision(s),
    });
    syncSessionModels(s.passthrough, next.passthrough);
    restorePrunedModels(useStore.getState().elements);
  },

  openContextMenu: (x, y, target, circuit, focusSearch = false) =>
    set((s) => {
      // Right-clicking an element outside the selection selects it alone so
      // the menu's copy and delete act on it; one already selected keeps the
      // whole group. Empty canvas leaves the selection untouched. While an
      // element gesture is in flight the rewrite stands down: upstream
      // returns from mousedown before mouseSelect for anything but left or
      // middle (MouseManager.java:1071-1075), so a click landing mid-drag
      // opens the menu without re-selecting and cannot hijack what the drag
      // is moving.
      const selectedIds =
        s.elementGesture === null && target !== null && !s.selectedIds.includes(target)
          ? [target]
          : s.selectedIds;
      return { contextMenu: { x, y, target, circuit, focusSearch }, selectedIds };
    }),

  closeContextMenu: () => set({ contextMenu: null }),

  openScopeMenu: (x, y, scopeId, plotId) => set({ scopeMenu: { x, y, scopeId, plotId } }),
  closeScopeMenu: () => set({ scopeMenu: null }),
  openScopeProperties: (scopeId) => set({ scopeProperties: scopeId, scopeMenu: null }),
  closeScopeProperties: () => set({ scopeProperties: null }),

  selectAll: () => set((s) => ({ selectedIds: s.elements.map((e) => e.id) })),

  copySelection: () => {
    const s = get();
    if (s.selectedIds.length === 0) return;
    const selected = s.elements.filter((e) => s.selectedIds.includes(e.id));
    // A selected 410 needs the `.` line that defines its model in the
    // clipboard, or a paste loses the model. Only the lines backing the
    // selection travel: copying a resistor must not drag the file's whole
    // subcircuit library along.
    set({ clipboard: serializeCircuit(selected, s.settings, [], modelLinesFor(s, selected)) });
  },

  cutSelection: () => {
    // Put the selection on the clipboard first, then let the existing delete
    // remove it with its single commit, so cut is one undo step.
    get().copySelection();
    get().deleteSelected();
  },

  pasteFromClipboard: () => {
    const text = get().clipboard;
    if (text === null) return;
    insertElementsFromText(text);
  },

  duplicateSelection: () => {
    const s = get();
    if (s.selectedIds.length === 0) return;
    const selected = s.elements.filter((e) => s.selectedIds.includes(e.id));
    // The same serialise-then-insert path as paste, but without touching the
    // clipboard, so Ctrl+D cannot clobber what the user copied. A duplicated
    // element's `.` line is already in the document (the part came from here),
    // so the clipboard carries no passthrough lines; the insert path resolves
    // the model from the library for the fresh id.
    insertElementsFromText(serializeCircuit(selected, s.settings));
  },
  }));
}

const globalScope = globalThis as { [STORE_INSTANCE_KEY]?: AppStore };
export const useStore: AppStore = (globalScope[STORE_INSTANCE_KEY] ??= createAppStore());

/** The view zoomed by `factor` about the current screen centre, which is the
 *  target upstream's keyboard zoom uses (zoomCircuit, MouseManager.java:1339). */
function zoomAroundCentre(s: AppState, factor: number): ViewTransform {
  const cx = s.view.x + s.viewSize.w / (2 * s.view.scale);
  const cy = s.view.y + s.viewSize.h / (2 * s.view.scale);
  return zoomAbout(s.view, cx, cy, factor);
}

/** The next throw after a toggle, matching the canvas pointer path: an SPST
 *  flips between its two positions, an SPDT cycles its throws, a ternary
 *  logic input cycles its three positions (SwitchElm.simpleToggle,
 *  SwitchElm.java:185-189), an MBB cycles its four, a DPDT its two. */
export function nextSwitchState(e: CircuitElement): number {
  const throwCount = Math.max(2, e.params.throwCount ?? 2);
  if (e.kind === 'logicInput' && (e.flags & LOGIC_INPUT_TERNARY) !== 0) {
    return ((e.state ?? 0) + 1) % 3;
  }
  if (e.kind === 'busLogicInput') {
    // The word cycles 0..2^width-1, upstream's toggle()
    // (BusLogicInputElm.java:116-120).
    const max = 2 ** Math.min(31, Math.max(2, Math.trunc(e.params.busWidth ?? 4)));
    return (((e.state ?? e.params.value ?? 0) + 1) % max + max) % max;
  }
  if (e.kind === 'mbbSwitch') return ((e.state ?? 0) + 1) % 4;
  // A centre-off two-throw switch cycles all three stops including the open
  // middle, upstream's simpleToggle over posCount (Switch2Elm.java:83,
  // :155-156); every other SPDT cycles its throws.
  const centreOff =
    e.kind === 'switch2' && (e.flags & SWITCH2_CENTER_OFF) !== 0 && throwCount === 2;
  const posCount =
    e.kind === 'switch' || e.kind === 'dpdtSwitch' ? 2 : throwCount + (centreOff ? 1 : 0);
  return ((e.state ?? 0) + 1) % posCount;
}

/** Shared insert path for paste and duplicate: parse, re-id, offset a grid step. */
function insertElementsFromText(text: string): void {
  const parsed = parseCircuit(text);
  if (parsed.elements.length === 0) return;
  // A paste adds to the open circuit instead of replacing it, so its `.` line
  // models join the library rather than resetting it, matching upstream's
  // RC_RETAIN read, which undumps the models without clearing the local map.
  // The parse alone registers nothing, so the `canPaste` probe that runs the
  // same text through the parser leaves the library alone.
  for (const model of parsed.compositeModels) registerSessionModel(model);
  // The pasted `34`/`32` lines join the writable device-model store the same
  // way, so a copied model's line travels with the copy and stays editable
  // after the paste.
  registerFileModels(parsed.diodeFileModels, parsed.transistorFileModels);
  const state = useStore.getState();
  state.commit();
  // A paste lands one square away, so the duplicate does not sit on top of
  // the original (UIManager.java:1001).
  const added = parsed.elements
    .map((e) => ({
      ...e,
      id: allocateId(),
      x1: e.x1 + GRID_SIZE,
      y1: e.y1 + GRID_SIZE,
      x2: e.x2 + GRID_SIZE,
      y2: e.y2 + GRID_SIZE,
    }))
    // A paste or duplicate can carry a 410 whose `.` line is not in the text
    // (a duplicate of a part whose model the document already holds, a copy of
    // one backed only by the library), and the parse resolves nothing without
    // a `.` line. Resolve through the merged library like placement does, or
    // the pasted part draws the fallback stub and never simulates.
    .map(resolveCompositeModel);
  // A pasted `.` line replaces every existing line of the same model name, or
  // a same-document paste stacks duplicate `.` lines and a reload would
  // re-bind the older 410s to the pasted model. The session map the paste just
  // overwrote (registerSessionModel) is the source of truth, so both line
  // stores converge to one line per name with it. The `34`/`32`/`!`/unknown
  // lines still append unchanged.
  const replacedNames = new Set(
    parsed.passthrough
      .map((line) => parseCompositeModelLine(line)?.name)
      .filter((name): name is string => name !== undefined),
  );
  const isReplaced = (line: string): boolean => {
    if (replacedNames.size === 0) return false;
    const trimmed = line.trim();
    if (!trimmed.startsWith('.')) return false;
    const model = parseCompositeModelLine(trimmed);
    return model !== null && replacedNames.has(model.name);
  };
  useStore.setState((s) => ({
    elements: [...s.elements, ...added],
    selectedIds: added.map((e) => e.id),
    passthrough: [...s.passthrough.filter((line) => !isReplaced(line)), ...parsed.passthrough],
    order: [
      ...s.order.filter((l) => l.kind !== 'other' || !isReplaced(l.line)),
      ...parsed.order.filter((l) => l.kind === 'other'),
    ],
    ...bumpRevision(s),
  }));
}

/** The model a netlist text's `.` lines define under `name`, or undefined when
 *  no line carries it. A repeated name shadows its predecessors, the same
 *  last-wins rule the parser's library map uses. */
function modelInText(text: string, name: string): CompositeModel | undefined {
  let found: CompositeModel | undefined;
  for (const line of text.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('.')) continue;
    const model = parseCompositeModelLine(trimmed);
    if (model !== null && model.name === name) found = model;
  }
  return found;
}

/** The netlist text with every `.` line that is the given model rewritten to
 *  `next`'s serialisation. Only lines whose parsed body matches move, the
 *  Findings rule (feature/overview.md): a different model that happens to
 *  share the name is preserved, while a file holding the same model twice is
 *  updated everywhere, exactly like the subcircuit rename's write-back. */
function rewriteModelLines(text: string, original: CompositeModel, next: CompositeModel): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('.')) return line;
      const model = parseCompositeModelLine(trimmed);
      if (model === null || !sameCompositeModel(model, original)) return line;
      return compositeModelLine(next);
    })
    .join('\n');
}

/** The document `.` lines that define the models the given composite elements
 *  reference. A 410 names its model in `text`; a `.` line whose parsed name
 *  matches is the model's definition, and a copy or duplicate of the element
 *  has to carry it or the model is lost. Lines backing no selected element are
 *  left out, so copying a resistor does not pull the file's whole subcircuit
 *  library into the clipboard. */
function modelLinesFor(s: AppState, elements: CircuitElement[]): string[] {
  const names = new Set<string>();
  for (const e of elements) {
    if (e.kind === 'customComposite' && e.text !== undefined) names.add(e.text);
  }
  if (names.size === 0) return [];
  const lines: string[] = [];
  for (const line of s.passthrough) {
    if (!line.startsWith('.')) continue;
    const model = parseCompositeModelLine(line);
    if (model !== null && names.has(model.name)) lines.push(line);
  }
  return lines;
}

/** The current selection in document order, the list the geometry commands
 *  and their shared-pivot computation both walk. */
function selectedElements(): CircuitElement[] {
  const s = useStore.getState();
  return s.elements.filter((e) => s.selectedIds.includes(e.id));
}

/**
 * One-undo-step geometry command over the selection. Refuses to touch a mixed
 * or unsupported selection, which keeps the menu's disabled state and the
 * keyboard path from diverging: if the menu would grey the item out, the same
 * `guard` makes the command a no-op here. Returns whether it applied, so a
 * caller banking gesture state (the placement's quarter turns) does not count
 * a refused command.
 */
function transformSelected(
  guard: (e: CircuitElement) => boolean,
  apply: (e: CircuitElement) => CircuitElement,
  skipCommit = false,
): boolean {
  const selected = selectedElements();
  if (selected.length === 0 || !selected.every(guard)) return false;
  // skipCommit is the in-flight pointer gesture's escape hatch, the same
  // reasoning as deleteSelected(true): the drag already committed its baseline
  // at pointer-down, and a second commit here would cost the gesture an extra
  // undo entry that reverts to a half-turned element.
  if (!skipCommit) useStore.getState().commit();
  useStore.setState((st) => ({
    elements: st.elements.map((e) => (st.selectedIds.includes(e.id) ? apply(e) : e)),
    ...bumpRevision(st),
  }));
  return true;
}

export type { AppState, ViewTransform };
export {
  hasUnsavedChanges,
  makeElement,
  makeGhostElement,
  makeToolElement,
  RECOVERED_UNSAVED,
  snap,
};
