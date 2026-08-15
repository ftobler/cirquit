import { create } from 'zustand';
import type { Scope, ScopePlot, ScopeTrigger, ScopeValue } from '../engine/simulator';
import { scopeSpeed } from '../scope/geometry';
import { positionToOffset } from '../scope/scale';
import {
  allocateId,
  isElementLine,
  parseCircuit,
  serializeCircuit,
  type ScopeConfig,
} from '../io/netlist';
import { overlayLiveState } from '../io/liveState';
import { decodeScopeLine, encodeScopeLine, scopeLineMatches } from '../io/scopeLine';
import {
  buildModelFromSelection,
  clearSessionModels,
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
import { pointOnWireInterior, splitWire } from '../render/geometry';
import { convertWires } from '../render/wireConverter';
import { lShapeRoute, routeWire, routingObstacles } from '../render/wireRouter';
import {
  canMirror,
  canRotate,
  canSwap,
  mirrorElement,
  rotateElement,
  swapTerminalOrder,
} from '../model/transform';
import { LOGIC_INPUT_TERNARY, VOLTAGE_PULSE_DUTY } from '../model/registry/flags';
import { postsOf } from '../model/registry';
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
import { normalizeSramBits } from '../model/registry/elements/sram';
import { normalizeAnalogMuxSelects } from '../model/registry/elements/analogMux';
import { normalizeSipoBits } from '../model/registry/elements/sipoShift';
import { normalizeRingBits } from '../model/registry/elements/ringCounter';
import { normalizePoleCount } from '../model/registry/elements/dpdtSwitch';
import { normalizeInputCount } from '../model/registry/shared';
import { createTestHarness, selectHarnessChip } from '../model/testHarness';
import { nextFileNum, setAudioSamples, setDataSamples, clearSampleCache } from '../model/sampleCache';
import { paramScale, resolveParam } from '../model/sliders';
import { modelFamilyFor, resolveModelParams } from '../model/deviceModels';
import {
  DEFAULT_SETTINGS,
  GRID_SIZE,
  UNMODELLED_HEADER,
  type CircuitElement,
} from '../model/types';
import type { AppState, Slider, Snapshot, ViewTransform } from './types';
import { loadAppPrefs, saveAppPrefs, touchesAppPrefs } from './appPrefs';
import { readRecovery } from './recovery';
import { loadShortcutOverlay, normalizeKey, saveShortcutOverlay } from '../input/shortcuts';
import {
  hasUnsavedChanges,
  makeElement,
  makeToolElement,
  RECOVERED_UNSAVED,
  resolveCompositeModel,
  snap,
} from './helpers';
import { ZOOM_FACTOR, circuitBounds, fitView, zoomAbout } from './view';

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
    // A resolved device model is a nested object, and the custom-logic rules
    // vectors inside it are arrays; clone them so a snapshot can never alias
    // the live element. The OTA's model is the same carrier holding a string
    // array (the composite child-dump tokens), which clones as a plain copy.
    // The composite's own engine spec is the third payload shape: its external
    // and dump vectors are arrays too, and the `external` key is what tells the
    // two object payloads apart (a custom-logic model never carries one).
    if (e.model) {
      copy.model = Array.isArray(e.model)
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
    plots: x.plots.map((p) => ({ ...p })),
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
        : encodeScopeLine(x, (id) => indexById.get(id));
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
 * The load warning. The two failure modes are not the same severity and must
 * not be reported as one: a missing element code means the component is absent
 * from both the drawing and the simulation, while a `!` model definition or a
 * `h` hint only means the line rides through untouched. Counts are of distinct
 * types, not lines, so seven sliders are one thing to report.
 */
function describeUnsupported(unsupported: string[]): string | null {
  const types = [...new Set(unsupported)];
  const missing = types.filter(isElementLine);
  const inert = types.filter((t) => !isElementLine(t));
  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(
      `${missing.length} element type(s) (${missing.join(', ')}) are not implemented yet, ` +
        'so those components are missing from the drawing and the simulation.',
    );
  }
  if (inert.length > 0) {
    parts.push(
      `${inert.length} other line type(s) (${inert.join(', ')}) were preserved ` +
        'but not interpreted.',
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

/** The frame loop's banner: the load-time unsupported-lines message joined
 *  with the engine's warnings, so neither can wipe the other. The frame loop
 *  recomputes this from the two separate sources on every build, so an engine
 *  warning is never reported twice and a stale unsupported message (cleared by
 *  a fresh load) stays dead. */
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
  // Power and charge plots start at the bottom of the manual-mode screen, the
  // port of ScopePlot's constructor (ScopePlot.java:62-66).
  const manVPosition = value === 'power' || value === 'charge' ? -100 : 0;
  return { id, elementId, value, manScale: null, manVPosition, acCoupled: false };
}

function defaultTrigger(): ScopeTrigger {
  return { mode: 'freeRun', edge: 'rising', level: 0 };
}

/** A scope panel with the full field set. Position defaults to its own column,
 *  which is what a fresh UI scope gets. showV/showI mirror upstream's
 *  initialize(), which turns both on when the scope carries the matching plots
 *  (Scope.java:276-285); the port's one default cannot know the plot units, so
 *  it opts into showing them, and the scale tokens use the values the UI line
 *  has always written. */
function makeScope(
  id: number,
  raw: string[] | null,
  plots: ScopePlot[],
  speed: number,
  position: number,
): Scope {
  return {
    id,
    raw,
    plots,
    speed,
    position,
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
    showElmInfo: false,
    showI: true,
    showV: true,
    scaleV: 20,
    scaleA: 0.05,
    trigger: defaultTrigger(),
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
  dialog: null,
  subcircuitDraft: null,
  subcircuitError: null,
  status: '',
  problem: null,
  unsupportedProblem: null,
  hoveredId: null,
  highlightedNode: null,
  undoStack: [],
  redoStack: [],
  revision: 0,
  scopeRevision: 0,
  paramRevision: 0,
  pendingParams: new Map(),
  pendingStates: new Map(),
  contextMenu: null,
  scopeMenu: null,
  scopeProperties: null,
  partsOpen: false,
  panelOpen: false,
  panelFocusTick: 0,
  sliderElementId: null,
  clipboard: null,
  lastSaved: null,
  liveStateProvider: null,
  document: 0,

  setRunning: (running) => set({ running }),
  toggleRunning: () => set((s) => ({ running: !s.running })),
  setTool: (tool) => set({ tool }),
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
      panelOpen: true,
      partsOpen: false,
      panelFocusTick: s.panelFocusTick + 1,
    })),

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
      elements: s.elements.filter((e) => !selectedIds.includes(e.id)),
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
  },

  rotateSelection: () => transformSelected(canRotate, rotateElement),
  mirrorSelection: () => transformSelected(canMirror, mirrorElement),
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
    if (resolved) {
      const dup = s.sliders.some(
        (x) =>
          x.elementId === elementId &&
          resolveParam(element.kind, x.editItem, x.text)?.name === resolved.name,
      );
      if (dup) return;
    } else if (s.sliders.some((x) => x.elementId === elementId && x.editItem === editItem)) {
      return;
    }
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
        target.kind === 'customComposite';
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
    set((st) => ({
      elements: st.elements.map((e) =>
        e.id === id || linked.has(e.id) ? { ...e, state: next } : e,
      ),
      pendingStates: (() => {
        const m = new Map(st.pendingStates);
        m.set(id, next);
        for (const lid of linked) m.set(lid, next);
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
        scopes: [...s.scopes, makeScope(id, null, plots, 64, s.scopes.length)],
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
    s.commit();
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
    s.commit();
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
    s.commit();
    set((st) => ({
      scopes: st.scopes.map((x) => (x.id === id ? { ...x, ...patch } : x)),
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
    s.commit();
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

  setPlotManScale: (plotId, manScale) => {
    const s = get();
    const scope = s.scopes.find((x) => x.plots.some((p) => p.id === plotId));
    if (!scope) return;
    const plot = scope.plots.find((p) => p.id === plotId)!;
    // A repeat of the current scale changes nothing and must not push an undo
    // entry.
    if (plot.manScale === manScale) return;
    s.commit();
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
    s.commit();
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
        out.push(makeScope(allocateId(), null, [p], scope.speed, base + out.length));
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
          out.push(makeScope(allocateId(), null, [p], scope.speed, position++));
          last = p;
        }
      }
      return { scopes: out, ...bumpRevision(st) };
    });
  },

  loadNetlist: (text) => {
    // The sample cache belongs to the open file, like the session models: the
    // previous file's buffers go, this file's fileNum tokens resolve to
    // nothing until the user imports fresh files (upstream clears both caches
    // on load, CircuitLoader.java:239-240).
    clearSampleCache();
    const parsed = parseCircuit(text);
    // The subcircuit library's session half belongs to the open file, so a load
    // rebuilds it: the previous file's `.` lines go, this file's arrive. Saved
    // models live in storage and are untouched by either half of this.
    clearSessionModels();
    for (const model of parsed.compositeModels) registerSessionModel(model);
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
          plots: plots.map((p, i) => ({
            ...p,
            acCoupled: perPlot[i].acCoupled,
            manScale: perPlot[i].manScale,
            manVPosition: perPlot[i].manVPosition,
          })),
        });
      }
    }

    // The load banner: the unsupported-lines message plus any clamp-on-load
    // warnings (a hand-edited 12-input gate loading as 8), joined the same way
    // the frame loop joins the engine warnings, so a rebuild cannot wipe them.
    const loadProblem = mergeProblem(describeUnsupported(parsed.unsupported), parsed.warnings);

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
      // A refusal from the previous circuit says nothing about this one.
      subcircuitError: null,
      ...bumpRevision(s),
      // A load is a new document: the frame loop's rebuild gate must refuse to
      // inject the previous circuit's live charges into it.
      document: s.document + 1,
    }));
    // A load is a new document on screen too: centre it the way upstream's
    // finishReadCircuit always does unless RC_NO_CENTER is passed
    // (CircuitLoader.java:220-235), so opening a file doesn't leave the view
    // wherever the previous circuit happened to scroll to.
    get().centerCircuit();
    // The loaded content is its own baseline: opening a file, a library
    // circuit or a share link is not "unsaved". `set` is synchronous, so this
    // `get()` reads the just-loaded state.
    set({ lastSaved: get().toNetlist() });
  },

  toNetlist: () => {
    return serializeDocument(get().elements);
  },

  saveNetlist: () => {
    const live = get().liveStateProvider?.() ?? {};
    return serializeDocument(overlayLiveState(get().elements, live));
  },

  setLiveStateProvider: (provider) => set({ liveStateProvider: provider }),

  newCircuit: () => {
    // New drops the open file, and its `.` line models with it, the same reset
    // a load performs. Saved models stay in storage.
    clearSessionModels();
    clearSampleCache();
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
      subcircuitError: null,
      ...bumpRevision(s),
      // New is a fresh document, like a load: no live charges carry over.
      document: s.document + 1,
    }));
    // An empty fresh circuit is clean.
    set({ lastSaved: get().toNetlist() });
  },

  markSaved: () => set({ lastSaved: get().toNetlist() }),

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
      ...bumpRevision(s),
    });
    // The `.` lines that came back define library models, so the session half
    // of the library follows them. Both line sets are read, so a step that did
    // not touch a `.` line changes nothing here.
    syncSessionModels(s.passthrough, prev.passthrough);
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
      ...bumpRevision(s),
    });
    syncSessionModels(s.passthrough, next.passthrough);
  },

  openContextMenu: (x, y, target, circuit) =>
    set((s) => {
      // Right-clicking an element outside the selection selects it alone so
      // the menu's copy and delete act on it; one already selected keeps the
      // whole group. Empty canvas leaves the selection untouched.
      const selectedIds =
        target !== null && !s.selectedIds.includes(target) ? [target] : s.selectedIds;
      return { contextMenu: { x, y, target, circuit }, selectedIds };
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
  if (e.kind === 'mbbSwitch') return ((e.state ?? 0) + 1) % 4;
  return ((e.state ?? 0) + 1) % (e.kind === 'switch' || e.kind === 'dpdtSwitch' ? 2 : throwCount);
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

/**
 * One-undo-step geometry command over the selection. Refuses to touch a mixed
 * or unsupported selection, which keeps the menu's disabled state and the
 * keyboard path from diverging: if the menu would grey the item out, the same
 * `guard` makes the command a no-op here.
 */
function transformSelected(
  guard: (e: CircuitElement) => boolean,
  apply: (e: CircuitElement) => CircuitElement,
): void {
  const s = useStore.getState();
  const selected = s.elements.filter((e) => s.selectedIds.includes(e.id));
  if (selected.length === 0 || !selected.every(guard)) return;
  s.commit();
  useStore.setState((st) => ({
    elements: st.elements.map((e) => (st.selectedIds.includes(e.id) ? apply(e) : e)),
    ...bumpRevision(st),
  }));
}

export type { AppState, ViewTransform };
export { hasUnsavedChanges, makeElement, makeToolElement, RECOVERED_UNSAVED, snap };
