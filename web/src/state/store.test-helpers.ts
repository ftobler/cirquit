import { DEFAULT_SETTINGS, type CircuitElement } from '../model/types';
import { checkpoint, emptyHistory, type HistoryEntry } from './history';
import { useStore } from './store';
import type { AppState } from './types';

/** A pristine store, matching the initialiser in store.ts. */
export const fresh = () => ({
  elements: [],
  selectedIds: [],
  scopes: [],
  sliders: [],
  settings: { ...DEFAULT_SETTINGS },
  shortcuts: {},
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
  notice: null,
  hoveredId: null,
  highlightedNode: null,
  history: emptyHistory(),
  elementGesture: null,
  toolTurns: 0,
  revertEpoch: 0,
  revision: 0,
  paramRevision: 0,
  pendingParams: new Map(),
  pendingStates: new Map(),
  contextMenu: null,
  scopeMenu: null,
  scopeProperties: null,
  menubarOpen: false,
  scrollValuePopover: null,
  partsOpen: false,
  panelOpen: false,
  elementProperties: null,
  deviceModelEditor: null,
  sliderElementId: null,
  clipboard: null,
  lastSaved: null,
  hasRecovery: false,
  liveStateProvider: null,
  document: 0,
  subcircuitStack: [],
  undocked: null,
  floating: [],
});

export const addResistor = () =>
  useStore.getState().addElement({
    kind: 'resistor',
    x1: 0,
    y1: 0,
    x2: 160,
    y2: 0,
    flags: 0,
    params: { resistance: 1000 },
  });

export const addCapacitor = () =>
  useStore.getState().addElement({
    kind: 'capacitor',
    x1: 160,
    y1: 0,
    x2: 320,
    y2: 0,
    flags: 0,
    params: { capacitance: 1e-5 },
  });

export const dropId = (e: CircuitElement) => {
  const { id, ...rest } = e;
  void id;
  return rest;
};

/** The history readouts the tests used to take straight off the old stored
 *  stacks. Undo depth is the number the assertions pinned; the entry helpers
 *  expose the labelled snapshots where a test reads one. */
export const undoDepth = (s: Pick<AppState, 'history'>): number => s.history.undo.length;
export const redoDepth = (s: Pick<AppState, 'history'>): number => s.history.redo.length;
export const undoEntries = (s: Pick<AppState, 'history'>): HistoryEntry[] => s.history.undo;
export const redoEntries = (s: Pick<AppState, 'history'>): HistoryEntry[] => s.history.redo;
export const undoEntry = (s: Pick<AppState, 'history'>, index: number): HistoryEntry =>
  s.history.undo[index];
export const redoEntry = (s: Pick<AppState, 'history'>, index: number): HistoryEntry =>
  s.history.redo[index];

/** Test-only checkpoint. Production code opens a transaction; tests that set a
 *  baseline and then mutate the store directly still need the raw pre-state
 *  push the old `commit` action provided, so they call this instead. */
export const commit = (): void => {
  useStore.setState((s) => ({ history: checkpoint(s.history, s, 'Edit', 'user') }));
};
