/** Application state. Everything the UI reads or mutates lives here. */

import type { Scope, ScopeTrigger, ScopeValue } from '../engine/simulator';
import type { NetlistLine, ScopeConfig } from '../io/netlist';
import type { ShortcutOverlay } from '../input/shortcuts';
import type { CircuitElement, SimSettings } from '../model/types';

export interface ViewTransform {
  /** Circuit-space coordinate at the canvas origin. */
  x: number;
  y: number;
  scale: number;
}

/** The dialogs the menubar opens, one component each in `web/src/ui`. */
export type DialogName =
  | 'importText'
  | 'saveAs'
  | 'exportAsLink'
  | 'exportAsText'
  | 'exportAsImage'
  | 'exportAsSvg'
  | 'about'
  | 'shortcuts'
  | 'findComponent';

/** A point-in-time copy of everything undo needs to restore. Settings and view
 *  travel with it like the dump header and transform do upstream, so undoing a
 *  drag, toggle or edit also brings back the voltage range and the pan/zoom. */
export interface Snapshot {
  elements: CircuitElement[];
  scopes: Scope[];
  sliders: Slider[];
  settings: SimSettings;
  view: ViewTransform;
}

/**
 * A slider (`38` line, upstream's Adjustable) in store form. `elementId`
 * resolves the line's `e` token to a session element; a slider whose target is
 * an element line this build could not read keeps `elementId` undefined and
 * renders nothing, but still round-trips.
 */
export interface Slider {
  id: number;
  elementId?: number;
  editItem: number;
  min: number;
  max: number;
  /** Optional trailing token; 0 means continuous. */
  step: number;
  /** The caption, unescaped. */
  text: string;
  logarithmic: boolean;
  /** FLAG_SHARED `ano` token, or null when the line carries none. */
  shared: number | null;
  /** Every token after `38`, so the line round-trips exactly. */
  raw: string[];
}

export interface AppState {
  elements: CircuitElement[];
  selectedIds: number[];
  scopes: Scope[];
  sliders: Slider[];
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
  /** White-background mode, upstream's `printable`/`whiteBackground` setting.
   *  UI-only, like `running`; the schematic and scope canvases render through
   *  makeTheme(dark). */
  dark: boolean;
  view: ViewTransform;
  /** Canvas size in CSS pixels, maintained by CircuitCanvas so keyboard
   *  zoom can target the exact screen centre like the wheel does
   *  (MouseManager.java:1339). */
  viewSize: { w: number; h: number };
  /** The dialog currently open over the workspace, or null. Lives in the store
   *  so the menubar, App's dialog host and the Ctrl+S path share one home. */
  dialog: DialogName | null;
  status: string;
  /** Element id under the pointer, for hover highlight; null when none. */
  hoveredId: number | null;
  /** Engine node of the shift-highlighted net; every element on it draws with
   *  `theme.highlight` (MouseManager.java:689-693). Null when none. */
  highlightedNode: number | null;
  /** Bumped by `requestEdit` so the options panel knows to refocus the first
   *  field of the newly selected element. */
  panelFocusTick: number;
  /** Set when the engine reports a problem. */
  problem: string | null;
  undoStack: Snapshot[];
  redoStack: Snapshot[];
  /** Bumped whenever the netlist changes, so the engine knows to reload. */
  revision: number;
  /** Bumped by scope capture-parameter edits (speed), which the frame loop
   *  applies through the engine's fast path instead of a rebuild. */
  scopeRevision: number;
  /** Bumped by value-only edits, applied to the live engine without a rebuild. */
  paramRevision: number;
  /** Value edits not yet pushed to the engine, keyed `${id}:${name}`. */
  pendingParams: Map<string, { id: number; name: string; value: number }>;
  /** Switch state edits not yet pushed to the engine, keyed by element id. */
  pendingStates: Map<number, number>;
  /** Menu shown by a right-click, or null when closed. */
  contextMenu: { x: number; y: number; target: number | null } | null;
  /** Whether the toolbox drawer is open. Only the mobile layout renders it as
   *  an overlay; on desktop the flag is inert because the aside is a flex
   *  sibling. */
  partsOpen: boolean;
  /** Whether the options panel is open. `requestEdit` opens it, so a
   *  double-tap or the context-menu Edit lands on the panel; the mobile drawer
   *  reads it. */
  panelOpen: boolean;
  /** Scope popup menu (right-click over a scope canvas), or null when closed.
   *  `plotId` is the plot under the cursor, for the Remove Plot command. */
  scopeMenu: { x: number; y: number; scopeId: number; plotId: number } | null;
  /** Scope id whose properties dialog is open, or null. */
  scopeProperties: number | null;
  /** Netlist text of the last copied or cut selection. */
  clipboard: string | null;
  /** Netlist text of the last export; null means no baseline yet (clean). */
  lastSaved: string | null;
  /** Whether a recovery exists in storage, so File>Recover Auto-Save is
   *  enabled (UIManager.java:170). App state, not circuit state: read once at
   *  store init and cleared by `recoverAutoSave`, so it never enters the undo
   *  Snapshot, and later autosave writes do not re-enable the row. */
  hasRecovery: boolean;
  /** User-assigned shortcut overlay: assignable action -> chord signature,
   *  loaded from localStorage at init and edited by the Shortcuts dialog. A
   *  runtime overlay on the SHORTCUTS table, so matchShortcut consults it
   *  before the hardcoded combos. Not part of the undo Snapshot: it is an
   *  app setting, and undoing a circuit edit must not rewrite a shortcut. */
  shortcuts: ShortcutOverlay;

  setRunning(running: boolean): void;
  toggleRunning(): void;
  setTool(tool: string | null): void;
  setView(view: ViewTransform): void;
  setViewSize(w: number, h: number): void;
  setStatus(status: string): void;
  setProblem(problem: string | null): void;
  updateSettings(patch: Partial<SimSettings>): void;
  /** White-background on (false) or off (true); see `dark`. */
  setDark(dark: boolean): void;
  openDialog(name: DialogName): void;
  closeDialog(): void;
  setHovered(id: number | null): void;
  setHighlightedNode(node: number | null): void;

  select(ids: number[]): void;
  addElement(e: Omit<CircuitElement, 'id'>): number;
  updateElement(id: number, patch: Partial<CircuitElement>): void;
  /** Finishes a wire placement: records the snapped end and, when it lands on
   *  another wire's interior, splits that wire so the two connect. */
  placeWireEnd(id: number, x: number, y: number): void;
  /** Moves elements without pushing a separate undo entry per frame. */
  moveElements(ids: number[], dx: number, dy: number): void;
  /** Moves the selection by dx/dy with exactly one undo entry per call: the
   *  arrow-nudge path (UIManager.java:1153-1163). */
  nudgeSelection(dx: number, dy: number): void;
  /** Zooms about the current screen centre, sharing the wheel's factor and
   *  clamp; zoomReset returns to exactly scale 1. */
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
  /** Pans so the whole circuit fits the viewport, capped at 1.5 like upstream.
   *  A view command, so it works with editing disabled. No undo entry. */
  centerCircuit(): void;
  /** Fits the whole circuit with no scale cap, the context menu's "Zoom to
   *  fit" seam (context-menu.md). */
  zoomToFit(): void;
  /** Moves a single stored endpoint by dx/dy. post 0 is (x1,y1), 1 is (x2,y2),
   *  the port of upstream's row/column capture which reads only stored
   *  endpoints, never derived posts (MouseManager.java:1161-1187). */
  movePoint(id: number, post: 0 | 1, dx: number, dy: number): void;
  /** Selects the element, opens the options panel, and asks it to focus the
   *  first field. The double-tap and the context menu's Edit item share this
   *  one implementation of "edit this element". */
  requestEdit(id: number): void;
  /** Opens or closes the toolbox drawer (the mobile overlay). */
  setPartsOpen(open: boolean): void;
  /** Opens or closes the options drawer; requestEdit routes through this. */
  setPanelOpen(open: boolean): void;
  deleteSelected(): void;
  /** Rotates the selection 90 degrees about each element's midpoint. */
  rotateSelection(): void;
  /** Mirrors the selection across each element's vertical centre axis. */
  mirrorSelection(): void;
  /** Exchanges posts 0 and 1 on each selected two-terminal part. */
  swapTerminals(): void;
  /** Merges plain-wire chains into routed wires, one undo entry, engine
   *  reload via the revision bump (the Convert Wires to Routed Wires command). */
  convertWiresToRouted(): void;
  /** Builds a test harness around the single selected chip (TestCreator.java):
   *  one logic input per input pin and one logic output per output pin,
   *  `gridSize * 4` outward from each post. Returns false when no single chip
   *  is selected, in which case nothing is placed and the caller shows the
   *  "Select a single chip element first" alert. One undo entry on success. */
  createTest(): boolean;
  setParam(id: number, name: string, value: number): void;
  /** Writes a slider's position-converted value into its bound element's
   *  parameter through the live `set_param` fast path. A slider that cannot be
   *  resolved (element gone, no matching field) does nothing: it is
   *  inert-but-preserved. The undo bracketing (one entry per drag) belongs to
   *  the panel's `beginEdit` on pointer-down, like the OptionsPanel range. */
  setSliderValue(id: number, value: number): void;
  /** Edits the element's free text (annotations, labels). */
  setText(id: number, text: string): void;
  /** Edits a switch's keyboard shortcut, session-only (never serialized).
   *  Sanitizes like upstream: the first character, lowercased; empty clears
   *  (SwitchElm.java:277-283). */
  setKeyShortcut(id: number, key: string): void;
  /** Toggles the switch whose keyShortcut equals `key`, returning whether one
   *  was found. The keyboard switch-toggle path (UIManager.java:1248-1268). */
  toggleSwitchByKey(key: string): boolean;
  /** Key-up release for momentary switches whose keyShortcut equals `key`
   *  (UIManager.java:1113-1131). */
  releaseMomentaryByKey(key: string): void;
  /** Replaces the user-assigned shortcut overlay and persists it; the
   *  Shortcuts dialog's OK path. */
  setShortcuts(overlay: ShortcutOverlay): void;
  /** Interactive state change (switch throw), routed through the live engine. */
  setElementState(id: number, state: number): void;
  /** Clears every fuse's live `state` and drops their queued pop-confirms, the
   *  store half of the Reset command: the engine half (`engine.reset`) already
   *  un-blows the models, and this keeps the serialized copies from re-injecting
   *  `blown true` on the next frame. */
  unblowFuses(): void;
  /** Drops queued value edits; the frame loop calls this after applying them. */
  clearPending(): void;

  addScope(elementId: number, value: ScopeValue): void;
  removeScope(id: number): void;
  /** Clears a scope's capture buffer (the Reset command). */
  resetScope(id: number): void;
  /** Changes the horizontal zoom without rewinding the simulation. */
  setScopeSpeed(id: number, speed: number): void;
  setScopeTrigger(id: number, patch: Partial<ScopeTrigger>): void;
  /** Display flags (overlays, scale mode, FFT/X-Y); never forces a reload. */
  setScopeFlags(id: number, patch: Partial<Omit<Scope, 'id' | 'raw' | 'plots' | 'trigger'>>): void;
  setPlotCoupling(scopeId: number, plotId: number, acCoupled: boolean): void;
  setPlotManScale(plotId: number, manScale: number | null): void;
  setPlotManPosition(plotId: number, manVPosition: number): void;
  /** Adds or removes a plot of `value`, never emptying the panel. */
  togglePlot(scopeId: number, value: ScopeValue): void;
  /** Merges `b`'s plots into `a` and drops `b` (Scope.combine). */
  combineScopes(aId: number, bId: number): void;
  /** Splits a panel into one per plot, keeping a V+I pair together. */
  separateScope(id: number): void;
  /** Moves a scope into the previous column, closing the gap it left. */
  stackScope(id: number): void;
  unstackScope(id: number): void;
  /** Stack All / Unstack All / Combine All / Separate All, the Scopes menu's
   *  batch commands (ScopeManager.java:296-318). One undo entry per command. */
  stackAllScopes(): void;
  unstackAllScopes(): void;
  combineAllScopes(): void;
  separateAllScopes(): void;

  loadNetlist(text: string): void;
  toNetlist(): string;
  newCircuit(): void;
  /** Records the serialised state the user last exported as the clean baseline. */
  markSaved(text: string): void;
  /** Loads the stored auto-save recovery, if any, as one undo entry, and marks
   *  the circuit unsaved (upstream's doRecover, UndoManager.java:83-88). A
   *  no-op when no recovery exists. */
  recoverAutoSave(): void;

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
  openScopeMenu(x: number, y: number, scopeId: number, plotId: number): void;
  closeScopeMenu(): void;
  openScopeProperties(scopeId: number): void;
  closeScopeProperties(): void;
  selectAll(): void;
  copySelection(): void;
  cutSelection(): void;
  pasteFromClipboard(): void;
  duplicateSelection(): void;
}
