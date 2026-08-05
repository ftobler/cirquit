/** Application state. Everything the UI reads or mutates lives here. */

import { create } from 'zustand';
import type { Scope } from '../engine/simulator';
import { allocateId, parseCircuit, serializeCircuit, type ScopeConfig } from '../io/netlist';
import { defFor } from '../model/registry';
import {
  canMirror,
  canRotate,
  canSwap,
  mirrorElement,
  rotateElement,
  swapTerminalOrder,
} from '../model/transform';
import { DEFAULT_SETTINGS, GRID_SIZE, type CircuitElement, type SimSettings } from '../model/types';

export interface ViewTransform {
  /** Circuit-space coordinate at the canvas origin. */
  x: number;
  y: number;
  scale: number;
}

/** A point-in-time copy of everything undo needs to restore. */
interface Snapshot {
  elements: CircuitElement[];
  scopes: Scope[];
}

interface AppState {
  elements: CircuitElement[];
  selectedIds: number[];
  scopes: Scope[];
  settings: SimSettings;
  /** Lines from the loaded file this build does not model, kept for saving. */
  passthrough: string[];
  running: boolean;
  /** Element kind currently armed for placement; null means select mode. */
  tool: string | null;
  view: ViewTransform;
  status: string;
  /** Set when the engine reports a problem. */
  problem: string | null;
  undoStack: Snapshot[];
  redoStack: Snapshot[];
  /** Bumped whenever the netlist changes, so the engine knows to reload. */
  revision: number;
  /** Bumped by value-only edits, applied to the live engine without a rebuild. */
  paramRevision: number;
  /** Value edits not yet pushed to the engine, keyed `${id}:${name}`. */
  pendingParams: Map<string, { id: number; name: string; value: number }>;
  /** Switch state edits not yet pushed to the engine, keyed by element id. */
  pendingStates: Map<number, number>;
  /** Menu shown by a right-click, or null when closed. */
  contextMenu: { x: number; y: number; target: number | null } | null;
  /** Netlist text of the last copied or cut selection. */
  clipboard: string | null;
  /** Netlist text of the last export; null means no baseline yet (clean). */
  lastSaved: string | null;

  setRunning(running: boolean): void;
  toggleRunning(): void;
  setTool(tool: string | null): void;
  setView(view: ViewTransform): void;
  setStatus(status: string): void;
  setProblem(problem: string | null): void;
  updateSettings(patch: Partial<SimSettings>): void;

  select(ids: number[]): void;
  addElement(e: Omit<CircuitElement, 'id'>): number;
  updateElement(id: number, patch: Partial<CircuitElement>): void;
  /** Moves elements without pushing a separate undo entry per frame. */
  moveElements(ids: number[], dx: number, dy: number): void;
  deleteSelected(): void;
  /** Rotates the selection 90 degrees about each element's midpoint. */
  rotateSelection(): void;
  /** Mirrors the selection across each element's vertical centre axis. */
  mirrorSelection(): void;
  /** Exchanges posts 0 and 1 on each selected two-terminal part. */
  swapTerminals(): void;
  setParam(id: number, name: string, value: number): void;
  /** Edits the element's free text (annotations, labels). */
  setText(id: number, text: string): void;
  /** Interactive state change (switch throw), routed through the live engine. */
  setElementState(id: number, state: number): void;
  /** Drops queued value edits; the frame loop calls this after applying them. */
  clearPending(): void;

  addScope(elementId: number, value: Scope['value']): void;
  removeScope(id: number): void;

  loadNetlist(text: string): void;
  toNetlist(): string;
  newCircuit(): void;
  /** Records the serialised state the user last exported as the clean baseline. */
  markSaved(text: string): void;

  /** Records the current state so the next change can be undone. */
  commit(): void;
  undo(): void;
  redo(): void;

  openContextMenu(x: number, y: number, target: number | null): void;
  closeContextMenu(): void;
  selectAll(): void;
  copySelection(): void;
  cutSelection(): void;
  pasteFromClipboard(): void;
  duplicateSelection(): void;
}

/** Rounds a coordinate to the nearest grid intersection. */
export function snap(v: number): number {
  return Math.round(v / GRID_SIZE) * GRID_SIZE;
}

/** True when reloading the page would lose edits since the last export. */
export function hasUnsavedChanges(lastSaved: string | null, current: string): boolean {
  return lastSaved !== null && current !== lastSaved;
}

const clone = (s: Pick<AppState, 'elements' | 'scopes'>): Snapshot => ({
  elements: s.elements.map((e) => ({ ...e, params: { ...e.params } })),
  scopes: s.scopes.map((x) => ({ ...x })),
});

const UNDO_LIMIT = 100;

export const useStore = create<AppState>((set, get) => ({
  elements: [],
  selectedIds: [],
  scopes: [],
  settings: { ...DEFAULT_SETTINGS },
  passthrough: [],
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
      elements: s.elements.map((e) =>
        e.id === id ? { ...e, params: { ...e.params, [name]: value } } : e,
      ),
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
    // Scope lines address elements by position in the file.
    const scopes: Scope[] = parsed.scopes
      .filter((c: ScopeConfig) => c.elementIndex >= 0 && c.elementIndex < parsed.elements.length)
      .map((c) => ({
        id: allocateId(),
        elementId: parsed.elements[c.elementIndex].id,
        value: c.value,
      }));

    set((s) => ({
      elements: parsed.elements,
      scopes,
      passthrough: parsed.passthrough,
      settings: { ...s.settings, ...parsed.settings },
      selectedIds: [],
      undoStack: [],
      redoStack: [],
      problem: parsed.unsupported.length
        ? `${parsed.unsupported.length} element type(s) in this file are not implemented yet and were skipped.`
        : null,
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
      elementIndex: indexById.get(x.elementId) ?? -1,
      value: x.value,
      // Defaults matching the original layout: speed, flags, and the
      // remaining display settings.
      raw: [String(indexById.get(x.elementId) ?? -1), '64', '0', '4099'],
    }));
    return serializeCircuit(s.elements, s.settings, scopeConfigs, s.passthrough);
  },

  newCircuit: () => {
    set((s) => ({
      elements: [],
      scopes: [],
      passthrough: [],
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

/** Builds a new element of `kind` spanning the given points. */
export function makeElement(kind: string, x1: number, y1: number, x2: number, y2: number) {
  const def = defFor(kind);
  return {
    kind,
    x1,
    y1,
    x2,
    y2,
    flags: 0,
    params: { ...(def?.defaults ?? {}) },
    state: def?.interactive ? 0 : undefined,
  };
}
