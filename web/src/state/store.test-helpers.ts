import { DEFAULT_SETTINGS, type CircuitElement } from '../model/types';
import { useStore } from './store';

/** A pristine store, matching the initialiser in store.ts. */
export const fresh = () => ({
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
