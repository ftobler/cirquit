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
import { pointOnSegmentInterior, splitWire } from '../render/geometry';
import {
  canMirror,
  canRotate,
  canSwap,
  mirrorElement,
  rotateElement,
  swapTerminalOrder,
} from '../model/transform';
import { VOLTAGE_PULSE_DUTY } from '../model/registry/flags';
import {
  DEFAULT_SETTINGS,
  GRID_SIZE,
  UNMODELLED_HEADER,
  type CircuitElement,
} from '../model/types';
import type { AppState, Snapshot, ViewTransform } from './types';
import { hasUnsavedChanges, makeElement, makeToolElement, snap } from './helpers';

const clone = (s: Snapshot): Snapshot => ({
  elements: s.elements.map((e) => ({ ...e, params: { ...e.params } })),
  // Plots and triggers are nested objects, so a shallow spread would alias the
  // live state into the undo snapshot.
  scopes: s.scopes.map((x) => ({
    ...x,
    trigger: { ...x.trigger },
    plots: x.plots.map((p) => ({ ...p })),
  })),
  settings: { ...s.settings },
  view: { ...s.view },
});

/** Canonical fingerprint of the snapshot state, mirroring upstream's dump
 *  comparison (UndoManager.java:50-53). The top-level object is built in a
 *  fixed property order so equal content always stringifies equally; the inner
 *  objects carry the insertion order they were constructed with, which is
 *  stable because every mutator spreads rather than reordering. */
const snapshotKey = (s: Snapshot): string =>
  JSON.stringify({ elements: s.elements, scopes: s.scopes, settings: s.settings, view: s.view });

const UNDO_LIMIT = 100;

/**
 * The load warning. The two failure modes are not the same severity and must
 * not be reported as one: a missing element code means the component is absent
 * from both the drawing and the simulation, while a `38` slider or a `!` model
 * definition only means the line rides through untouched. Counts are of
 * distinct types, not lines, so seven sliders are one thing to report.
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
  settings: { ...DEFAULT_SETTINGS },
  passthrough: [],
  unmatchedScopes: [],
  order: [],
  running: true,
  tool: null,
  view: { x: 0, y: 0, scale: 1 },
  status: '',
  problem: null,
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
  clipboard: null,
  lastSaved: null,

  setRunning: (running) => set({ running }),
  toggleRunning: () => set((s) => ({ running: !s.running })),
  setTool: (tool) => set({ tool }),
  setView: (view) => set({ view }),
  setStatus: (status) => set({ status }),
  setProblem: (problem) => set({ problem }),

  updateSettings: (patch) =>
    set((s) => {
      const settings = { ...s.settings, ...patch };
      // The timestep, the adaptive floor/budget and the DC operating point
      // change every companion model's conductance or the solve itself, so
      // only those force a rebuild. Everything else is a per-frame argument
      // or display-only and must not restart the simulation.
      const reload =
        patch.timeStep !== undefined ||
        patch.minTimeStep !== undefined ||
        patch.adaptiveTimeStep !== undefined ||
        patch.autoDC !== undefined;
      return { settings, revision: reload ? s.revision + 1 : s.revision };
    }),

  select: (ids) => set({ selectedIds: ids }),

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
    set((s) => ({
      elements: s.elements.map((e) => {
        if (e.id !== id) return e;
        // Geometry must stay integral: the engine's post type is `[i32; 2]`
        // and node merging keys on exact coordinate equality, so any
        // coordinate the patch carries is rounded. Non-geometry patches pass
        // through untouched.
        return {
          ...e,
          ...patch,
          ...(patch.x1 !== undefined ? { x1: Math.round(patch.x1) } : {}),
          ...(patch.y1 !== undefined ? { y1: Math.round(patch.y1) } : {}),
          ...(patch.x2 !== undefined ? { x2: Math.round(patch.x2) } : {}),
          ...(patch.y2 !== undefined ? { y2: Math.round(patch.y2) } : {}),
        };
      }),
      revision: s.revision + 1,
    })),

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
      (e) =>
        e.id !== id &&
        e.kind === 'wire' &&
        pointOnSegmentInterior(end, { x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }),
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
      elements: s.elements.map((e) =>
        ids.includes(e.id)
          ? { ...e, x1: e.x1 + rdx, y1: e.y1 + rdy, x2: e.x2 + rdx, y2: e.y2 + rdy }
          : e,
      ),
      revision: s.revision + 1,
    }));
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
      selectedIds: [],
      revision: s.revision + 1,
    }));
  },

  rotateSelection: () => transformSelected(canRotate, rotateElement),
  mirrorSelection: () => transformSelected(canMirror, mirrorElement),
  swapTerminals: () => transformSelected(canSwap, swapTerminalOrder),

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
        // Editing a diode/zener model value makes the stored model name stale;
        // drop it so the next save writes the value form, not the dead name.
        if ((e.kind === 'diode' || e.kind === 'zener') && DIODE_MODEL_PARAMS.includes(name)) {
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

  setText: (id, text) =>
    set((s) => {
      const target = s.elements.find((e) => e.id === id);
      if (!target) return s;
      // The netlist format is line-based, so a raw newline would split the
      // element in two on the next save. Strip CR and LF at the door.
      const clean = text.replace(/[\r\n]/g, '');
      // A labeled node's text is structural, not display-only: the engine
      // merges nodes that share a label, so it must reload to learn the
      // change. Every other text-bearing element is display-only and can take
      // the fast path without restarting the simulation.
      const reload = target.kind === 'labeledNode';
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
          x.id === scopeId ? { ...x, plots: [...x.plots, makePlot(allocateId(), elementId, value)] } : x,
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
        ...parsed.settings,
      },
      selectedIds: [],
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
    );
  },

  newCircuit: () => {
    set((s) => ({
      elements: [],
      scopes: [],
      unmatchedScopes: [],
      passthrough: [],
      order: [],
      settings: {
        ...s.settings,
        ...UNMODELLED_HEADER,
        minTimeStep: DEFAULT_SETTINGS.minTimeStep,
        iterCount: DEFAULT_SETTINGS.iterCount,
        adaptiveTimeStep: DEFAULT_SETTINGS.adaptiveTimeStep,
        autoDC: DEFAULT_SETTINGS.autoDC,
      },
      selectedIds: [],
      undoStack: [],
      redoStack: [],
      problem: null,
      revision: s.revision + 1,
    }));
    // An empty fresh circuit is clean.
    set({ lastSaved: get().toNetlist() });
  },

  markSaved: (text) => set({ lastSaved: text }),

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

/** Shared insert path for paste and duplicate: parse, re-id, offset a grid step. */
function insertElementsFromText(text: string): void {
  const parsed = parseCircuit(text);
  if (parsed.elements.length === 0) return;
  const state = useStore.getState();
  state.commit();
  const added = parsed.elements.map((e) => ({
    ...e,
    id: allocateId(),
    x1: e.x1 + GRID_SIZE,
    y1: e.y1 + GRID_SIZE,
    x2: e.x2 + GRID_SIZE,
    y2: e.y2 + GRID_SIZE,
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
export { hasUnsavedChanges, makeElement, makeToolElement, snap };
