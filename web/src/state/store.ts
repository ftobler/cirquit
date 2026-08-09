import { create } from 'zustand';
import type { Scope, ScopePlot, ScopeTrigger, ScopeValue } from '../engine/simulator';
import { scopeSpeed } from '../scope/geometry';
import {
  allocateId,
  isElementLine,
  parseCircuit,
  serializeCircuit,
  type ScopeConfig,
} from '../io/netlist';
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
import { paramScale, resolveParam } from '../model/sliders';
import {
  DEFAULT_SETTINGS,
  UNMODELLED_HEADER,
  type CircuitElement,
} from '../model/types';
import type { AppState, Slider, Snapshot, ViewTransform } from './types';
import { loadAppPrefs, saveAppPrefs, touchesAppPrefs } from './appPrefs';
import { readRecovery } from './recovery';
import { loadShortcutOverlay, normalizeKey, saveShortcutOverlay } from '../input/shortcuts';
import { gridSize, hasUnsavedChanges, makeElement, makeToolElement, RECOVERED_UNSAVED, snap } from './helpers';
import { ZOOM_FACTOR, circuitBounds, fitView, zoomAbout } from './view';

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
    if (e.model) {
      copy.model = Array.isArray(e.model)
        ? [...e.model]
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
  // live state into the undo snapshot.
  scopes: s.scopes.map((x) => ({
    ...x,
    trigger: { ...x.trigger },
    plots: x.plots.map((p) => ({ ...p })),
  })),
  sliders: s.sliders.map((x) => ({ ...x, raw: [...x.raw] })),
  settings: { ...s.settings },
  view: { ...s.view },
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
  });

const UNDO_LIMIT = 100;

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

/** The `value`/`val` token a trace quantity serializes as, the inverse of
 *  `scopeValueFromToken`. */
function valueTokenOf(value: ScopeValue | null): number {
  return value === 'current' ? 3 : value === 'power' ? 7 : 0;
}

function makePlot(id: number, elementId: number | null, value: ScopeValue | null): ScopePlot {
  return { id, elementId, value, manScale: null, manVPosition: 0, acCoupled: false };
}

function defaultTrigger(): ScopeTrigger {
  return { mode: 'freeRun', edge: 'rising', level: 0 };
}

/** A new-style `o` line for a UI-created scope, plot list included. The first
 *  token is the live speed; per-plot `ne val` pairs (plus any W-scale tokens)
 *  follow the plot count, so upstream parses the line back into the same
 *  plots. `indexOf` resolves element ids to their file ordinals.
 *  (ScopeSerializer.java:188-289.) */
function scopeUIRaw(
  speed: number,
  plots: ScopePlot[],
  indexOf: (elementId: number) => number | undefined,
): string[] {
  const first = plots[0];
  const tokens = [String(speed), String(valueTokenOf(first.value)), '4099', '20', '0.05', '0'];
  if (plots.length === 1) {
    tokens.push('1');
    if (first.value === 'power') tokens.push('20');
    return tokens;
  }
  tokens.push(String(plots.length));
  for (let i = 1; i < plots.length; i++) {
    const p = plots[i];
    const index = p.elementId === null ? -1 : (indexOf(p.elementId) ?? -1);
    tokens.push(String(index), String(valueTokenOf(p.value)));
    if (p.value === 'power') tokens.push('20');
  }
  return tokens;
}

/** A scope panel with the full field set. Position defaults to its own column,
 *  which is what a fresh UI scope gets. */
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
    trigger: defaultTrigger(),
  };
}

export const useStore = create<AppState>((set, get) => ({
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
  status: '',
  problem: null,
  hoveredId: null,
  highlightedNode: null,
  panelFocusTick: 0,
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
  clipboard: null,
  lastSaved: null,

  setRunning: (running) => set({ running }),
  toggleRunning: () => set((s) => ({ running: !s.running })),
  setTool: (tool) => set({ tool }),
  setView: (view) => set({ view }),
  setViewSize: (w, h) => set({ viewSize: { w, h } }),
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
      return { settings: merged, revision: reload ? s.revision + 1 : s.revision };
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
      revision: s.revision + 1,
    }));
    return id;
  },

  updateElement: (id, patch) =>
    set((s) => {
      const geometry =
        patch.x1 !== undefined ||
        patch.y1 !== undefined ||
        patch.x2 !== undefined ||
        patch.y2 !== undefined;
      const target = s.elements.find((e) => e.id === id);
      // A routed wire's polyline is valid only for its exact endpoints. When a
      // post moves, re-run the router against the current obstacle set so the
      // polyline follows the post and keeps avoiding the other elements'
      // bodies, upstream's setPoints re-route (RoutedWireElm.java:86-123). A
      // fully blocked re-route falls back to the L-shape upstream uses.
      let reroute: [number, number][] | null = null;
      if (geometry && target && target.route && target.route.length >= 2) {
        const grid = gridSize(s.settings);
        const routed = routeWire(
          { x: Math.round(patch.x1 ?? target.x1), y: Math.round(patch.y1 ?? target.y1) },
          { x: Math.round(patch.x2 ?? target.x2), y: Math.round(patch.y2 ?? target.y2) },
          routingObstacles(s.elements, id),
          grid,
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
        revision: s.revision + 1,
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
        revision: st.revision + 1,
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
      revision: st.revision + 1,
    }));
  },

  moveElements: (ids, dx, dy) => {
    // Round the delta, not each endpoint: a fractional pointer jitter must not
    // corrupt integral coordinates, and one shared delta keeps the selection's
    // internal spacing whatever the snap state. When the caller already
    // snapped to the grid this is identity.
    const rdx = Math.round(dx);
    const rdy = Math.round(dy);
    return set((s) => ({
      elements: s.elements.map((e) => {
        if (!ids.includes(e.id)) return e;
        // A routed wire's polyline moves with it, so the route stays valid
        // under a group move (RoutedWireElm.move, RoutedWireElm.java:76-82).
        const route = e.route
          ? e.route.map(([x, y]): [number, number] => [x + rdx, y + rdy])
          : undefined;
        return { ...e, x1: e.x1 + rdx, y1: e.y1 + rdy, x2: e.x2 + rdx, y2: e.y2 + rdy, ...(route ? { route } : {}) };
      }),
      revision: s.revision + 1,
    }));
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

  deleteSelected: () => {
    const { selectedIds } = get();
    if (selectedIds.length === 0) return;
    get().commit();
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
      revision: s.revision + 1,
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
    set({ elements: converted, revision: s.revision + 1 });
  },

  setParam: (id, name, value) => {
    // A non-finite value would serialize as JSON null, which serde rejects
    // for an `f64` param and which would break the engine the same way a
    // fractional post does. Reject it at the door: no state change, no queued
    // edit. The property panel's number field guards first, this is the store
    // choke point for any other input path.
    if (!Number.isFinite(value)) return;
    return set((s) => ({
      elements: s.elements.map((e) => {
        if (e.id !== id) return e;
        const next = { ...e, params: { ...e.params, [name]: value } };
        // Editing a diode/zener/varactor model value makes the stored model
        // name stale; drop it so the next save writes the value form, not the
        // dead name. The varactor shares the diode machinery upstream, so a
        // stale name there re-applies the model on the next reload and
        // silently discards the edit.
        if (
          (e.kind === 'diode' || e.kind === 'zener' || e.kind === 'varactor') &&
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
        return next;
      }),
      // Queue the edit for the engine's set_param fast path rather than
      // bumping `revision` (which would trigger a full rebuild and rewind the
      // clock). A Map keyed by id and name coalesces slider drags to the last
      // value.
      pendingParams: new Map(s.pendingParams).set(`${id}:${name}`, { id, name, value }),
      paramRevision: s.paramRevision + 1,
    }));
  },

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

  setText: (id, text) =>
    set((s) => {
      const target = s.elements.find((e) => e.id === id);
      if (!target) return s;
      // The netlist format is line-based, so a raw newline would split the
      // element in two on the next save. Strip CR and LF at the door.
      const clean = text.replace(/[\r\n]/g, '');
      // A labeled node's text is structural, not display-only: the engine
      // merges nodes that share a label, so it must reload to learn the
      // change. A custom-logic model name is structural too: the model fixes
      // the post count, which only a rebuild can reallocate. Every other
      // text-bearing element is display-only and can take the fast path
      // without restarting the simulation.
      const reload = target.kind === 'labeledNode' || target.kind === 'customLogic';
      return {
        elements: s.elements.map((e) => (e.id === id ? { ...e, text: clean } : e)),
        revision: reload ? s.revision + 1 : s.revision,
        paramRevision: reload ? s.paramRevision : s.paramRevision + 1,
      };
    }),

  setElementState: (id, state) =>
    set((s) => ({
      elements: s.elements.map((e) => (e.id === id ? { ...e, state } : e)),
      pendingStates: new Map(s.pendingStates).set(id, state),
      paramRevision: s.paramRevision + 1,
    })),

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
      if ((e.kind === 'switch' || e.kind === 'switch2') && e.keyShortcut === k) {
        s.setElementState(e.id, nextSwitchState(e));
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
        (e.kind === 'switch' || e.kind === 'switch2') &&
        (e.params.momentary ?? 0) !== 0 &&
        e.keyShortcut === k
      ) {
        s.setElementState(e.id, nextSwitchState(e));
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
        revision: s.revision + 1,
      };
    });
  },

  removeScope: (id) => {
    if (!get().scopes.some((x) => x.id === id)) return;
    get().commit();
    set((s) => ({
      scopes: s.scopes.filter((x) => x.id !== id),
      revision: s.revision + 1,
    }));
  },

  resetScope: (id) => {
    if (!get().scopes.some((x) => x.id === id)) return;
    // The Reset command clears the capture buffer and the sticky scale, which
    // a rebuild does for the buffer; the menu drops the scale state itself.
    set((s) => ({ revision: s.revision + 1 }));
  },

  setScopeSpeed: (id, speed) =>
    set((s) => {
      const clamped = scopeSpeed(speed);
      const scope = s.scopes.find((x) => x.id === id);
      // A no-op must not touch scopeRevision, or a wheel tick with nothing to
      // do would still patch the engine.
      if (!scope || scope.speed === clamped) return s;
      return {
        scopes: s.scopes.map((x) => (x.id === id ? { ...x, speed: clamped } : x)),
        scopeRevision: s.scopeRevision + 1,
      };
    }),

  setScopeTrigger: (id, patch) =>
    set((s) => {
      const scope = s.scopes.find((x) => x.id === id);
      if (!scope) return s;
      const trigger = { ...scope.trigger, ...patch };
      return {
        scopes: s.scopes.map((x) => (x.id === id ? { ...x, trigger } : x)),
        // The trigger is part of the engine spec, so it must reload.
        revision: s.revision + 1,
      };
    }),

  setScopeFlags: (id, patch) =>
    set((s) => {
      const scope = s.scopes.find((x) => x.id === id);
      if (!scope) return s;
      return {
        scopes: s.scopes.map((x) => (x.id === id ? { ...x, ...patch } : x)),
      };
    }),

  setPlotCoupling: (scopeId, plotId, acCoupled) =>
    set((s) => {
      const scope = s.scopes.find((x) => x.id === scopeId);
      if (!scope) return s;
      return {
        scopes: s.scopes.map((x) =>
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
      };
    }),

  setPlotManScale: (plotId, manScale) =>
    set((s) => ({
      scopes: s.scopes.map((x) => ({
        ...x,
        plots: x.plots.map((p) => (p.id === plotId ? { ...p, manScale } : p)),
      })),
    })),

  setPlotManPosition: (plotId, manVPosition) =>
    set((s) => ({
      scopes: s.scopes.map((x) => ({
        ...x,
        plots: x.plots.map((p) =>
          p.id === plotId ? { ...p, manVPosition: Math.max(-100, Math.min(100, manVPosition)) } : p,
        ),
      })),
    })),

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
          revision: s.revision + 1,
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
        revision: s.revision + 1,
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
        revision: st.revision + 1,
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
      return { scopes: [...others, ...out], revision: st.revision + 1 };
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
        revision: st.revision + 1,
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
      revision: st.revision + 1,
    }));
  },

  stackAllScopes: () => {
    if (get().scopes.length === 0) return;
    // One commit for the whole batch, so the menu command is one undo step.
    get().commit();
    set((s) => ({
      scopes: s.scopes.map((x) => ({ ...x, position: 0, showMax: false, showMin: false })),
      revision: s.revision + 1,
    }));
  },

  unstackAllScopes: () => {
    if (get().scopes.length === 0) return;
    get().commit();
    set((s) => ({
      scopes: s.scopes.map((x, i) => ({ ...x, position: i, showMax: true })),
      revision: s.revision + 1,
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
        revision: st.revision + 1,
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
      return { scopes: out, revision: st.revision + 1 };
    });
  },

  loadNetlist: (text) => {
    const parsed = parseCircuit(text);
    // The parser has already resolved each plot's element index, which counts
    // element lines this build cannot read. The parse-time ids and the
    // untouched display tokens all travel with the scope, so a save puts the
    // line back where it was with every field it arrived with.
    const scopes: Scope[] = [];
    const unmatchedScopes: ScopeConfig[] = [];
    for (const [index, c] of parsed.scopes.entries()) {
      if (c.elementId === undefined) unmatchedScopes.push(c);
      else {
        // raw[0] is the speed token in both line styles (the o-line walk
        // starts at the element index, so raw slices it off). raw[5] is the
        // stacking position.
        const speed = scopeSpeed(Number(c.raw[0]) || 64);
        const posToken = Number(c.raw[5]);
        const position = Number.isFinite(posToken) && posToken >= 0 ? posToken : index;
        scopes.push(
          makeScope(
            c.id,
            c.raw,
            c.plots.map((p) => makePlot(p.id, p.elementId ?? null, p.value)),
            speed,
            position,
          ),
        );
      }
    }

    set((s) => ({
      elements: parsed.elements,
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
      highlightedNode: null,
      undoStack: [],
      redoStack: [],
      problem: describeUnsupported(parsed.unsupported),
      revision: s.revision + 1,
    }));
    // The loaded content is its own baseline: opening a file, a library
    // circuit or a share link is not "unsaved". `set` is synchronous, so this
    // `get()` reads the just-loaded state.
    set({ lastSaved: get().toNetlist() });
  },

  toNetlist: () => {
    const s = get();
    const indexById = new Map(s.elements.map((e, i) => [e.id, i]));
    const scopeConfigs: ScopeConfig[] = s.scopes.map((x) => {
      const first = x.plots[0];
      const speedToken = String(x.speed);
      return {
        id: x.id,
        // Recomputed by the writer from where the element lands in the file;
        // this is only the fallback for a plot with no element left.
        elementIndex: indexById.get(first.elementId ?? -1) ?? -1,
        elementId: first.elementId ?? undefined,
        // A loaded line keeps every display field it came with, only the
        // speed token tracks the live zoom. One created here gets a full
        // new-style line (position 0, one or two plots) that upstream parses,
        // replacing the old unloadable 4-token stub.
        raw: x.raw
          ? x.raw[0] === speedToken
            ? x.raw
            : [speedToken, ...x.raw.slice(1)]
          : scopeUIRaw(x.speed, x.plots, (id) => indexById.get(id)),
        plots: x.plots.map((p) => ({
          id: p.id,
          elementIndex: indexById.get(p.elementId ?? -1) ?? -1,
          elementId: p.elementId ?? undefined,
          value: p.value,
        })),
      };
    });
    return serializeCircuit(
      s.elements,
      s.settings,
      [...scopeConfigs, ...s.unmatchedScopes],
      s.passthrough,
      s.order,
      s.sliders,
    );
  },

  newCircuit: () => {
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
        smallGrid: DEFAULT_SETTINGS.smallGrid,
        showVoltageColor: DEFAULT_SETTINGS.showVoltageColor,
        showPowerColor: DEFAULT_SETTINGS.showPowerColor,
        showValues: DEFAULT_SETTINGS.showValues,
        adaptiveTimeStep: DEFAULT_SETTINGS.adaptiveTimeStep,
        autoDC: DEFAULT_SETTINGS.autoDC,
      },
      selectedIds: [],
      hoveredId: null,
      highlightedNode: null,
      undoStack: [],
      redoStack: [],
      problem: null,
      revision: s.revision + 1,
    }));
    // An empty fresh circuit is clean.
    set({ lastSaved: get().toNetlist() });
  },

  markSaved: (text) => set({ lastSaved: text }),

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

  undo: () =>
    set((s) => {
      const prev = s.undoStack[s.undoStack.length - 1];
      if (!prev) return s;
      return {
        ...prev,
        undoStack: s.undoStack.slice(0, -1),
        redoStack: [...s.redoStack, clone(s)],
        selectedIds: [],
        revision: s.revision + 1,
      };
    }),

  redo: () =>
    set((s) => {
      const next = s.redoStack[s.redoStack.length - 1];
      if (!next) return s;
      return {
        ...next,
        redoStack: s.redoStack.slice(0, -1),
        undoStack: [...s.undoStack, clone(s)],
        selectedIds: [],
        revision: s.revision + 1,
      };
    }),

  openContextMenu: (x, y, target) =>
    set((s) => {
      // Right-clicking an element outside the selection selects it alone so
      // the menu's copy and delete act on it; one already selected keeps the
      // whole group. Empty canvas leaves the selection untouched.
      const selectedIds =
        target !== null && !s.selectedIds.includes(target) ? [target] : s.selectedIds;
      return { contextMenu: { x, y, target }, selectedIds };
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
    set({ clipboard: serializeCircuit(selected, s.settings) });
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
    // clipboard, so Ctrl+D cannot clobber what the user copied.
    insertElementsFromText(serializeCircuit(selected, s.settings));
  },
}));

/** The view zoomed by `factor` about the current screen centre, which is the
 *  target upstream's keyboard zoom uses (zoomCircuit, MouseManager.java:1339). */
function zoomAroundCentre(s: AppState, factor: number): ViewTransform {
  const cx = s.view.x + s.viewSize.w / (2 * s.view.scale);
  const cy = s.view.y + s.viewSize.h / (2 * s.view.scale);
  return zoomAbout(s.view, cx, cy, factor);
}

/** The next throw after a toggle, matching the canvas pointer path: an SPST
 *  flips between its two positions, an SPDT cycles its throws, and a ternary
 *  logic input cycles its three positions (SwitchElm.simpleToggle,
 *  SwitchElm.java:185-189). */
export function nextSwitchState(e: CircuitElement): number {
  const throwCount = Math.max(2, e.params.throwCount ?? 2);
  if (e.kind === 'logicInput' && (e.flags & LOGIC_INPUT_TERNARY) !== 0) {
    return ((e.state ?? 0) + 1) % 3;
  }
  return ((e.state ?? 0) + 1) % (e.kind === 'switch' ? 2 : throwCount);
}

/** Shared insert path for paste and duplicate: parse, re-id, offset a grid step. */
function insertElementsFromText(text: string): void {
  const parsed = parseCircuit(text);
  if (parsed.elements.length === 0) return;
  const state = useStore.getState();
  state.commit();
  // A paste lands one square away, so on a small grid it offsets by 8 to keep
  // the duplicate from sitting on top of the original (UIManager.java:1001).
  const grid = gridSize(state.settings);
  const added = parsed.elements.map((e) => ({
    ...e,
    id: allocateId(),
    x1: e.x1 + grid,
    y1: e.y1 + grid,
    x2: e.x2 + grid,
    y2: e.y2 + grid,
  }));
  useStore.setState((s) => ({
    elements: [...s.elements, ...added],
    selectedIds: added.map((e) => e.id),
    revision: s.revision + 1,
  }));
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
    revision: st.revision + 1,
  }));
}

export type { AppState, ViewTransform };
export { gridSize, hasUnsavedChanges, makeElement, makeToolElement, RECOVERED_UNSAVED, snap };
