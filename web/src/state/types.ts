/** Application state. Everything the UI reads or mutates lives here. */

import type { Scope, ScopeValue } from '../engine/simulator';
import type { NetlistLine, ScopeConfig } from '../io/netlist';
import type { CircuitElement, SimSettings } from '../model/types';

export interface ViewTransform {
  /** Circuit-space coordinate at the canvas origin. */
  x: number;
  y: number;
  scale: number;
}

/** A point-in-time copy of everything undo needs to restore. Settings and view
 *  travel with it like the dump header and transform do upstream, so undoing a
 *  drag, toggle or edit also brings back the voltage range and the pan/zoom. */
export interface Snapshot {
  elements: CircuitElement[];
  scopes: Scope[];
  settings: SimSettings;
  view: ViewTransform;
}

export interface AppState {
  elements: CircuitElement[];
  selectedIds: number[];
  scopes: Scope[];
  settings: SimSettings;
  /** Lines from the loaded file this build does not model, kept for saving. */
  passthrough: string[];
  /** `o` lines whose element index lands on an element line this build could
   *  not read. There is nothing to draw, but the line still has to come back. */
  unmatchedScopes: ScopeConfig[];
  /** The loaded file's line arrangement, replayed on save. Empty for a fresh
   *  circuit, which then saves in the default header/elements/scopes layout. */
  order: NetlistLine[];
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

  addScope(elementId: number, value: ScopeValue): void;
  removeScope(id: number): void;

  loadNetlist(text: string): void;
  toNetlist(): string;
  newCircuit(): void;
  /** Records the serialised state the user last exported as the clean baseline. */
  markSaved(text: string): void;

  /** Records the current state so the next change can be undone. */
  commit(): void;
  /** Marks the start of an edit session (a field focus or a pointer-down on a
   *  slider). One undo entry per session; a session that changes nothing is
   *  deduped away by commit. */
  beginEdit(): void;
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
