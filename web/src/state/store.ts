import { create } from 'zustand';
import type { Scope } from '../engine/simulator';
import {
  allocateId,
  isElementLine,
  parseCircuit,
  serializeCircuit,
  type ScopeConfig,
} from '../io/netlist';
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
import { hasUnsavedChanges, makeElement, snap } from './helpers';

const clone = (s: Pick<AppState, 'elements' | 'scopes'>): Snapshot => ({
  elements: s.elements.map((e) => ({ ...e, params: { ...e.params } })),
  scopes: s.scopes.map((x) => ({ ...x })),
});

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
  paramRevision: 0,
  pendingParams: new Map(),
  pendingStates: new Map(),
  contextMenu: null,
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
      // Only the timestep changes every companion model's conductance, so
      // only it forces a rebuild. Everything else is a per-frame argument or
      // display-only and must not restart the simulation.
      const reload = patch.timeStep !== undefined;
      return { settings, revision: reload ? s.revision + 1 : s.revision };
    }),

  select: (ids) => set({ selectedIds: ids }),

  commit: () =>
    set((s) => ({
      undoStack: [...s.undoStack, clone(s)].slice(-UNDO_LIMIT),
      redoStack: [],
    })),

  addElement: (e) => {
    const id = allocateId();
    get().commit();
    set((s) => ({
      elements: [...s.elements, { ...e, id }],
      revision: s.revision + 1,
    }));
    return id;
  },

  updateElement: (id, patch) =>
    set((s) => ({
      elements: s.elements.map((e) => (e.id === id ? { ...e, ...patch } : e)),
      revision: s.revision + 1,
    })),

  moveElements: (ids, dx, dy) =>
    set((s) => ({
      elements: s.elements.map((e) =>
        ids.includes(e.id)
          ? { ...e, x1: e.x1 + dx, y1: e.y1 + dy, x2: e.x2 + dx, y2: e.y2 + dy }
          : e,
      ),
      revision: s.revision + 1,
    })),

  deleteSelected: () => {
    const { selectedIds } = get();
    if (selectedIds.length === 0) return;
    get().commit();
    set((s) => ({
      elements: s.elements.filter((e) => !selectedIds.includes(e.id)),
      scopes: s.scopes.filter((x) => !selectedIds.includes(x.elementId)),
      selectedIds: [],
      revision: s.revision + 1,
    }));
  },

  rotateSelection: () => transformSelected(canRotate, rotateElement),
  mirrorSelection: () => transformSelected(canMirror, mirrorElement),
  swapTerminals: () => transformSelected(canSwap, swapTerminalOrder),

  setParam: (id, name, value) =>
    set((s) => ({
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
    })),

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

  addScope: (elementId, value) =>
    set((s) => {
      // One trace per element and quantity is plenty; adding the same one
      // twice is almost always a misclick.
      if (s.scopes.some((x) => x.elementId === elementId && x.value === value)) return s;
      return {
        scopes: [...s.scopes, { id: allocateId(), elementId, value }],
        revision: s.revision + 1,
      };
    }),

  removeScope: (id) =>
    set((s) => ({
      scopes: s.scopes.filter((x) => x.id !== id),
      revision: s.revision + 1,
    })),

  loadNetlist: (text) => {
    const parsed = parseCircuit(text);
    // The parser has already resolved each `o` line's element index, which
    // counts element lines this build cannot read. The parse-time id and the
    // untouched display tokens both travel with the scope, so a save puts the
    // line back where it was with every field it arrived with.
    const scopes: Scope[] = [];
    const unmatchedScopes: ScopeConfig[] = [];
    for (const c of parsed.scopes) {
      if (c.elementId === undefined) unmatchedScopes.push(c);
      else scopes.push({ id: c.id, elementId: c.elementId, value: c.value, raw: c.raw });
    }

    set((s) => ({
      elements: parsed.elements,
      scopes,
      unmatchedScopes,
      passthrough: parsed.passthrough,
      order: parsed.order,
      settings: { ...s.settings, ...UNMODELLED_HEADER, ...parsed.settings },
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
    const scopeConfigs: ScopeConfig[] = s.scopes.map((x) => ({
      id: x.id,
      // Recomputed by the writer from where the element lands in the file;
      // this is only the fallback for a scope with no element left.
      elementIndex: indexById.get(x.elementId) ?? -1,
      elementId: x.elementId,
      value: x.value,
      // A loaded line keeps every display field it came with. One created here
      // gets the defaults matching the original layout: speed, flags, scale.
      raw: x.raw ?? ['64', '0', '4099'],
    }));
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
      settings: { ...s.settings, ...UNMODELLED_HEADER },
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
export { hasUnsavedChanges, makeElement, snap };
