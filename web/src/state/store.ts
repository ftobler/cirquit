/** Application state. Everything the UI reads or mutates lives here. */

import { create } from 'zustand';
import type { Scope } from '../engine/simulator';
import { allocateId, parseCircuit, serializeCircuit, type ScopeConfig } from '../io/netlist';
import { defFor } from '../model/registry';
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
  dark: boolean;
  status: string;
  /** Set when the engine reports a problem. */
  problem: string | null;
  undoStack: Snapshot[];
  redoStack: Snapshot[];
  /** Bumped whenever the netlist changes, so the engine knows to reload. */
  revision: number;

  setRunning(running: boolean): void;
  toggleRunning(): void;
  setTool(tool: string | null): void;
  setView(view: ViewTransform): void;
  setDark(dark: boolean): void;
  setStatus(status: string): void;
  setProblem(problem: string | null): void;
  updateSettings(patch: Partial<SimSettings>): void;

  select(ids: number[]): void;
  addElement(e: Omit<CircuitElement, 'id'>): number;
  updateElement(id: number, patch: Partial<CircuitElement>): void;
  /** Moves elements without pushing a separate undo entry per frame. */
  moveElements(ids: number[], dx: number, dy: number): void;
  deleteSelected(): void;
  setParam(id: number, name: string, value: number): void;

  addScope(elementId: number, value: Scope['value']): void;
  removeScope(id: number): void;

  loadNetlist(text: string): void;
  toNetlist(): string;
  newCircuit(): void;

  /** Records the current state so the next change can be undone. */
  commit(): void;
  undo(): void;
  redo(): void;
}

/** Rounds a coordinate to the nearest grid intersection. */
export function snap(v: number): number {
  return Math.round(v / GRID_SIZE) * GRID_SIZE;
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
  dark: window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true,
  status: '',
  problem: null,
  undoStack: [],
  redoStack: [],
  revision: 0,

  setRunning: (running) => set({ running }),
  toggleRunning: () => set((s) => ({ running: !s.running })),
  setTool: (tool) => set({ tool }),
  setView: (view) => set({ view }),
  setDark: (dark) => set({ dark }),
  setStatus: (status) => set({ status }),
  setProblem: (problem) => set({ problem }),

  updateSettings: (patch) =>
    set((s) => {
      const settings = { ...s.settings, ...patch };
      // Timestep changes alter every companion model, so the engine has to
      // rebuild rather than just carry on.
      const reload = patch.timeStep !== undefined || patch.stepsPerFrame !== undefined;
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

  setParam: (id, name, value) =>
    set((s) => ({
      elements: s.elements.map((e) =>
        e.id === id ? { ...e, params: { ...e.params, [name]: value } } : e,
      ),
      revision: s.revision + 1,
    })),

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

  newCircuit: () =>
    set((s) => ({
      elements: [],
      scopes: [],
      passthrough: [],
      selectedIds: [],
      undoStack: [],
      redoStack: [],
      problem: null,
      revision: s.revision + 1,
    })),

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
}));

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
