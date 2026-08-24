/** Application state. Everything the UI reads or mutates lives here. */

import type {
  PlotMeasurementKey,
  Scope,
  ScopeTrigger,
  ScopeValue,
} from '../engine/simulator';
import type { CompositeModel, NetlistLine, ScopeConfig } from '../io/netlist';
import type { LiveState } from '../io/liveState';
import type { RenameOutcome } from '../io/subcircuits';
import type { ModelFamily, UserModelEntry, UserModelSnapshot } from '../model/deviceModels';
import type { ShortcutOverlay } from '../input/shortcuts';
import type { ScrollValueSession } from '../model/scrollValue';
import type { CircuitElement, Point, SimSettings } from '../model/types';
import type { WireSegment } from '../model/wirePlacement';
import type { SampleCacheSnapshot } from '../model/sampleCache';

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
  | 'createSubcircuit'
  | 'subcircuitManager'
  | 'otherOptions'
  | 'sliders';

/** The session-scoped caches frozen at drill-in enter: the audio/data sample
 *  buffers and the writable device-model namespace with its delete tombstones.
 *  Both enter and exit run the full load pipeline, which clears these caches,
 *  so without the freeze a look-and-return round trip would silently destroy
 *  models created in dialogs and imported files this session held. */
export interface DrillSessionSnapshot {
  samples: SampleCacheSnapshot;
  models: UserModelSnapshot;
}

/** A dialog-free inline model editing session, the port's analogue of
 *  upstream's `CircuitContext` (CirSim.java:679-686): one entry per level of
 *  drill-in, holding everything needed to return to the level below. The stack
 *  holds snapshots rather than names, so the single editing context is wholly
 *  replaced on enter and restored on exit. Nested subcircuits (a model whose
 *  children include a 410) are not drillable yet, so the only level the stack
 *  ever reaches is one: the outer circuit and the model being edited.
 */
export interface SubcircuitStackEntry {
  /** The model name being edited at this level. */
  modelName: string;
  /** The enclosing document's netlist text at the moment this level was
   *  entered, what loadNetlist consumes to get back out. Captured with the
   *  live overlay so a look-and-return reloads the operating point instead of
   *  discharging every capacitor and inductor on the outer sheet. */
  document: string;
  /** The enclosing document's pan/zoom, restored on exit the way upstream
   *  restores its transform (CirSim.java:499). */
  view: ViewTransform;
  /** The pre-enter session caches, restored on exit. Travels with the entry
   *  so any wholesale stack reset (a mid-drill load, New) drops it too, and
   *  nothing stale can ever be restored onto the wrong document. */
  session: DrillSessionSnapshot;
  /** The enclosing level's suspended undo histories, restored on exit because
   *  both loads of the round trip wipe the live stacks (upstream stashes them
   *  in pushContext/popContext, CirSim.java:476-500). They travel with the
   *  entry for the same reason `session` does: a mid-drill load or New drops
   *  them with it, so nothing stale restores onto the wrong document. */
  undo: Snapshot[];
  redo: Snapshot[];
  /** Whether the enclosing document read clean against `lastSaved` at enter,
   *  by the app's own non-live comparison (App.tsx's beforeunload guard). The
   *  exit reload bakes live reactive charge into the restored params, so on a
   *  no-edit return of a clean circuit the baseline must move to that restored
   *  text or the round trip arms hasUnsavedChanges with no user edit. A
   *  document already dirty at enter keeps its baseline, so its real edits
   *  stay flagged after coming home. */
  cleanAtEnter: boolean;
}

/** A point-in-time copy of everything undo needs to restore. Settings and view
 *  travel with it like the dump header and transform do upstream, so undoing a
 *  drag, toggle or edit also brings back the voltage range and the pan/zoom. */
export interface Snapshot {
  elements: CircuitElement[];
  scopes: Scope[];
  sliders: Slider[];
  settings: SimSettings;
  view: ViewTransform;
  /** The document's own lines, both copies of them. A subcircuit rename
   *  rewrites the `.` line in each, which is the one edit that changes the
   *  saved file without changing an element, so undo has to bring them back. */
  passthrough: string[];
  order: NetlistLine[];
  /** `o` lines whose element index lands on an element line this build could
   *  not read. See `AppState.unmatchedScopes`; undo/redo must round-trip it
   *  identically to the other document fields above. */
  unmatchedScopes: ScopeConfig[];
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

/** The open mouse-wheel value popover, positioned at the cursor. Lives in the
 *  store rather than in component state so `modalSurface` can count it the
 *  way upstream counts `scrollValuePopup.isShowing()` (UIManager.java:1007-
 *  1008): while it shows, no shortcut may act on the circuit behind it. */
export interface ScrollValuePopover {
  session: ScrollValueSession;
  /** The stepped field's display label, resolved at open (a dynamic label
   *  needs the element's state, which the session itself does not carry). */
  name: string;
  x: number;
  y: number;
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
  /** Bumped whenever something asks for a fit that must wait for the layout to
   *  settle: a load can add or drop the scope strip, which resizes the canvas
   *  only on the render after the store changed, so the size `centerCircuit`
   *  would read is still the previous layout's. CircuitCanvas watches this
   *  counter, re-measures the canvas once the DOM is committed and fits
   *  against the real viewport. */
  centerRequest: number;
  /** The dialog currently open over the workspace, or null. Lives in the store
   *  so the menubar, App's dialog host and the Ctrl+S path share one home. */
  dialog: DialogName | null;
  /** The model Create Subcircuit built from the selection, awaiting its name
   *  in the Create Subcircuit dialog. Null when no draft is pending. */
  subcircuitDraft: CompositeModel | null;
  /** Why the last Create Subcircuit refused, for the caller's alert; null once
   *  a build succeeds. The refusals differ (an unsupported kind, a labeled
   *  node on ground or on an unused net, no labeled nodes at all), so the
   *  reason has to travel out of the store with the false. */
  subcircuitError: string | null;
  status: string;
  /** Element id under the pointer, for hover highlight; null when none. */
  hoveredId: number | null;
  /** Engine node of the shift-highlighted net; every element on it draws with
   *  `theme.highlight` (MouseManager.java:689-693). Null when none. */
  highlightedNode: number | null;
  /** The problem banner: what the user has to act on, so it sticks until it is
   *  dismissed or the circuit changes. Missing element types, clamped values, a
   *  failed build, a convergence failure, a frame crash. Null when none apply.
   *  Anything the port handled by itself goes to `notice` instead. */
  problem: string | null;
  /** The load-time part of `problem`, kept apart from it so the frame loop can
   *  merge it with the engine's report instead of letting one rebuild wipe it.
   *  Set by `loadNetlist`, cleared by `newCircuit`. */
  unsupportedProblem: string | null;
  /** The transient notice: something the port handled on its own and only
   *  mentions in passing (a substituted ground reference, a pinned floating
   *  node). It flashes and clears itself; nothing here is waiting on the
   *  user. */
  notice: string | null;
  undoStack: Snapshot[];
  redoStack: Snapshot[];
  /** True while a scope editing gesture (a plot-Y drag or a speed wheel burst)
   *  is in progress. The scope setters skip their per-call `commit()` while it
   *  holds, so the whole gesture collapses into one undo entry. Transient: it
   *  is not part of `Snapshot`, so it never touches undo dedup. */
  scopeGesture: boolean;
  /** The in-flight canvas pointer gesture, mirrored from the canvas drag ref so
   *  the keyboard path can act on the grabbed element. `place` carries the
   *  anchor-relative quarter turns Space has applied, which the placement's
   *  pointer-move re-applies to the cursor-derived endpoint. Transient: not
   *  part of `Snapshot`, so it never reaches the undo stack or `snapshotKey`. */
  elementGesture: { kind: 'place' | 'move'; placeTurns: number } | null;
  /** Quarter turns applied to the armed tool's ghost, before any press. Reset
   *  by `setTool`, so arming a part always starts flat and the counter cannot
   *  survive into the next placement. Transient: not part of `Snapshot`, so it
   *  never reaches the undo stack or `snapshotKey`, exactly like
   *  `elementGesture` and `scopeGesture`. */
  toolTurns: number;
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
  /** Menu shown by a right-click, or null when closed. `circuit` is the
   *  screen point projected into circuit space at open time, so commands that
   *  act on the click location (Split Wire Manually) do not need the canvas.
   *  `focusSearch` is set only by the '/' key, which opens the menu with no
   *  pointer involved and so must land the caret in the element search. */
  contextMenu: {
    x: number;
    y: number;
    target: number | null;
    circuit: Point;
    focusSearch: boolean;
  } | null;
  /** Whether the toolbox drawer is open. Only the mobile layout renders it as
   *  an overlay; on desktop the flag is inert because the aside is a flex
   *  sibling. */
  partsOpen: boolean;
  /** Whether the options drawer (the selected element's properties and the
   *  circuit's sliders) is open. Only the mobile layout renders it as an
   *  overlay; on desktop the flag is inert because the aside is a flex
   *  sibling. */
  panelOpen: boolean;
  /** The element whose properties dialog is open, or null. The port of
   *  upstream's EditDialog, which edits the element under the cursor; the side
   *  panel keeps showing the same rows for the selection behind it. */
  elementProperties: number | null;
  /** The open device-model create/edit dialog, or null. `initial` is the model
   *  being edited or the copy a create starts from; `attachedElementId` is set
   *  on a create (the element whose Create button opened it, which OK rebinds),
   *  and `prevName` is the name an edit started from, so a rename in the dialog
   *  moves the writable entry and the naming elements with it. Transient UI
   *  state like `elementProperties`: never part of the undo Snapshot. */
  deviceModelEditor: {
    family: ModelFamily;
    initial: UserModelEntry;
    attachedElementId?: number;
    prevName?: string;
  } | null;
  /** The element the Sliders dialog is scoped to, from the context menu's
   *  Sliders... row, or null for the circuit-wide menubar dialog. The dialog
   *  shows create/remove checkboxes for this element's adjustable fields. */
  sliderElementId: number | null;
  /** Scope popup menu (right-click over a scope canvas), or null when closed.
   *  `plotId` is the plot under the cursor, for the Remove Plot command. */
  scopeMenu: { x: number; y: number; scopeId: number; plotId: number } | null;
  /** Scope id whose properties dialog is open, or null. */
  scopeProperties: number | null;
  /** The open mouse-wheel value popover (see ScrollValuePopover), or null.
   *  Transient UI state like `contextMenu`: never part of the undo Snapshot,
   *  and one of the surfaces the keyboard gate counts. */
  scrollValuePopover: ScrollValuePopover | null;
  /** Netlist text of the last copied or cut selection. */
  clipboard: string | null;
  /** Netlist text of the last export; null means no baseline yet (clean). */
  lastSaved: string | null;
  /** Whether a recovery exists in storage, so File>Recover Auto-Save is
   *  enabled (UIManager.java:170). App state, not circuit state: read once at
   *  store init and cleared by `recoverAutoSave`, so it never enters the undo
   *  Snapshot, and later autosave writes do not re-enable the row. */
  hasRecovery: boolean;
  /** Reads the engine's live operating-point tokens on demand, or null until
   *  the engine is up. `saveNetlist` falls back to the non-live document
   *  without it. A provider keeps the engine out of the store's data flow. */
  liveStateProvider: (() => LiveState) | null;
  /** Bumped by `loadNetlist` and `newCircuit` so the frame loop can refuse to
   *  inject the previous document's live charges into the next one. Undo and
   *  redo do not bump it. */
  document: number;
  /** The subcircuit drill-in stack: one entry per level of model editing,
   *  each holding the enclosing document and view to return to. Non-empty
   *  exactly when the canvas shows a model's internals rather than the outer
   *  circuit. Reset wholesale by any load, New and recover, exactly as
   *  upstream's `resetEditingContext` clears its context stack. */
  subcircuitStack: SubcircuitStackEntry[];
  /** User-assigned shortcut overlay: assignable action -> chord signature,
   *  loaded from localStorage at init and edited by the Shortcuts dialog. A
   *  runtime overlay on the SHORTCUTS table, so matchShortcut consults it
   *  before the hardcoded combos. Not part of the undo Snapshot: it is an
   *  app setting, and undoing a circuit edit must not rewrite a shortcut. */
  shortcuts: ShortcutOverlay;
  /** The open undocked scope window: the id of the scope it mirrors and the
   *  handle postMessage pushes go to. Transient UI state like `dialog`: never
   *  part of Snapshot, no undo entry, dropped when the child window closes or
   *  the mirrored scope disappears under it (a remove, an undo, a load). */
  undocked: { scopeId: number; windowRef: Window | null } | null;

  /**
   * The "View in New Undocked Scope" command. The port's own interpretation
   * of upstream's identically named menu row: there it drops a floating scope
   * element onto the schematic near the clicked element (CommandManager.java:
   * 192-198), here it opens a display-only second window mirroring a freshly
   * created scope for that element. The menu row has no scope to name, so
   * this takes the element and creates the scope itself; the entry records
   * the created scope's id. Refuses while one window is up, and falls back to
   * a notice when the browser blocks the pop-up.
   */
  openUndockedScope(elementId: number): void;
  /** Closes the undocked scope window and drops the entry. A no-op when none. */
  closeUndockedScope(): void;

  setRunning(running: boolean): void;
  toggleRunning(): void;
  setTool(tool: string | null): void;
  /** Turns the armed tool's ghost a quarter turn, the pre-press half of
   *  `rotateSelection`. A no-op with no tool armed or on a part `canRotate`
   *  refuses, so the counter cannot drift on a ghost Space does nothing to.
   *  Commits nothing: the ghost is not in the document. */
  turnTool(): void;
  setView(view: ViewTransform): void;
  setViewSize(w: number, h: number): void;
  setStatus(status: string): void;
  setProblem(problem: string | null): void;
  setNotice(notice: string | null): void;
  updateSettings(patch: Partial<SimSettings>): void;
  /** Puts every setting the Other Options dialog shows back to its default,
   *  through `updateSettings`, so the app-pref keys persist and the timestep
   *  keys rebuild exactly as a hand edit would. Settings carry no undo entry,
   *  so the dialog confirms first. */
  resetSettings(): void;
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
  /** Inserts a whole wire run as one edit: the 0, 1 or 2 segments a wire drag
   *  produced (`model/wirePlacement.ts`). One undo entry covers the run
   *  however many segments it is, and the run's two free ends split whatever
   *  they landed on, the same connect-on-drop rule a dragged part follows.
   *  The corner between two segments is left alone: it is this gesture's own
   *  junction, and upstream splits only at the dragged element's own ends.
   *  After those endpoint splits each drawn segment also breaks at every
   *  junction-dot post lying on its interior (upstream's WireElm.draggingDone),
   *  dropping any sub-segment that would lie parallel on an existing
   *  colinear two-terminal part. Returns the surviving new ids, empty when
   *  the run had no length or nothing of it was kept. */
  addWires(segments: WireSegment[]): number[];
  /** Splits the wire at `id` at `point` (circuit coordinates, snapped to the
   *  grid here like upstream's doSplit), replacing it with the two halves. The
   *  manual Split Wire Manually context-menu command; refuses non-wires and
   *  points off the span or on an endpoint. */
  splitWireAt(id: number, point: Point): void;
  /** Splits every wire whose interior `point` lands on, except `exceptId`, so
   *  the post that was just dropped there connects. Upstream's `splitWireAt`
   *  loop, run from `endDrag` after a single post drag (MouseManager.java:
   *  1254-1258). Pushes no undo entry: the gesture that calls it committed at
   *  pointer-down and owns the whole drag as one step. */
  autoSplitAt(point: Point, exceptId: number): void;
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
  /** Asks for a centre that waits for the next layout, for the callers whose
   *  own change resizes the canvas (a load that adds or removes scopes). See
   *  `centerRequest`. */
  requestCenter(): void;
  /** Fits the whole circuit with no scale cap, the context menu's "Zoom to
   *  fit" seam (context-menu.md). */
  zoomToFit(): void;
  /** Moves a single stored endpoint by dx/dy. post 0 is (x1,y1), 1 is (x2,y2),
   *  the port of upstream's row/column capture which reads only stored
   *  endpoints, never derived posts (MouseManager.java:1161-1187). */
  movePoint(id: number, post: 0 | 1, dx: number, dy: number): void;
  /** Selects the element and opens its properties dialog. The double-click,
   *  the touch double-tap and the context menu's Edit... item share this one
   *  implementation of "edit this element". */
  requestEdit(id: number): void;
  /** Closes the element properties dialog. */
  closeElementProperties(): void;
  /** Opens the device-model create/edit dialog for the element's family.
   *  `create-simple`/`create-advanced` seed a copy of the element's current
   *  model in the matching diode mode (upstream's Create New Simple/Advanced
   *  Model rows, DiodeElm.java:211-220); `create` does the same for the
   *  transistor and mosfet/jfet families (TransistorElm.java:632-636,
   *  MosfetElm.java:738-742); `edit` opens the existing writable entry (the
   *  readOnly-gated Edit Model row). A no-op when the element is gone or, for
   *  edit, when its name does not resolve to a writable entry. */
  openDeviceModelEditor(
    kind: string,
    elementId: number,
    action: 'create-simple' | 'create-advanced' | 'create' | 'edit',
  ): void;
  /** Closes the device-model dialog without applying anything. */
  closeDeviceModelEditor(): void;
  /** Applies a model edit or create, as one undo step. The writable store is
   *  updated first (module state, so undo never rolls a model back), then the
   *  document half: a create rebinds the attached element through
   *  `setModelName`, an in-place edit re-resolves every element naming the
   *  model against the new entry, and a rename moves those elements to the new
   *  name. The revision bump rebuilds the engine either way, since model
   *  params are read at build time. */
  applyDeviceModelEdit(
    family: ModelFamily,
    entry: UserModelEntry,
    attachedElementId?: number,
    prevName?: string,
  ): void;
  /** Opens or closes the toolbox drawer (the mobile overlay). Opening it
   *  closes the options drawer, since only one mobile drawer shows at a time. */
  setPartsOpen(open: boolean): void;
  /** Opens or closes the options drawer (the mobile overlay). Opening it
   *  closes the toolbox drawer, since only one mobile drawer shows at a time. */
  setPanelOpen(open: boolean): void;
  /** skipCommit is set by the placement-cancel path (a zero-length drop):
   *  the deleted element's own creation is already the gesture's undo
   *  baseline, so this must not push a second one. Every other caller
   *  omits it and gets the normal pre-delete commit. */
  deleteSelected(skipCommit?: boolean): void;
  /** Rotates the selection 90 degrees about each element's midpoint, one undo
   *  entry. Under an `elementGesture` it skips the commit (the gesture's
   *  pointer-down commit is the baseline) and a placement turns about its press
   *  anchor instead, banking the turn in `elementGesture.placeTurns`. */
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
  /** Builds a subcircuit model from the selected elements, or from the whole
   *  circuit when nothing is selected (the File>Create Subcircuit command,
   *  CommandManager.doCreateSubcircuit). On success the model waits in
   *  `subcircuitDraft` for a name and the Create Subcircuit dialog opens;
   *  returns false with the reason in `subcircuitError` when the selection
   *  cannot become a model, so the caller can alert. */
  createSubcircuit(): boolean;
  /** Names the pending `subcircuitDraft`, stores it in the model library and
   *  closes the dialog. A no-op with no draft pending. */
  saveSubcircuitDraft(name: string): void;
  /** Drops a pending `subcircuitDraft` without storing it (the dialog's
   *  Cancel path). */
  cancelSubcircuitDraft(): void;
  /** Renames a subcircuit model for the Subcircuit Manager's Edit row. The
   *  library half is `renameModel`; the document half is this action's own,
   *  since renaming a model the open file's `.` line introduced has to rewrite
   *  that line, as one undo step. A saved model has no line here, so its rename
   *  leaves the circuit alone. The outcome is the library's, passed straight
   *  through to the Manager. */
  renameSubcircuit(oldName: string, newName: string): RenameOutcome;
  setParam(id: number, name: string, value: number): void;
  /** Replaces an SRAM/ROM element's stored contents with `pairs`, rewriting
   *  the whole `addr{i}`/`val{i}` family atomically so a shrink cannot leave a
   *  stale trailing pair behind, and bumps both revisions so the engine
   *  rebuilds its memory map. Commits once, so the textarea's onFocus commit
   *  and this one bracket the whole edit as one undo entry. */
  setMemoryContents(id: number, pairs: [number, number][]): void;
  /** Edits an element's named device model: `''` deletes the name (the
   *  name-free value form), any other value sets it and re-runs the built-in
   *  model resolution into `params`. The revision bump forces a full engine
   *  rebuild, since model params are read at build time and can change the
   *  stamp or the node count. */
  setModelName(id: number, name: string): void;
  /** Writes a slider's position-converted value into its bound element's
   *  parameter through the live `set_param` fast path. A slider that cannot be
   *  resolved (element gone, no matching field) does nothing: it is
   *  inert-but-preserved. The undo bracketing (one entry per drag) belongs to
   *  the caller's `beginEdit` on pointer-down, like the edit dialog's range. */
  setSliderValue(id: number, value: number): void;
  /** Creates a slider bound to `elementId`'s `editItem`-th adjustable field,
   *  one per (element, field). A caption that resolves to a different field
   *  than the index (caption wins in resolveParam) is the caller's choice. */
  addSlider(elementId: number, editItem: number, caption?: string): void;
  /** Removes a slider; the Sliders dialog's uncheck row and the store-level
   *  delete path both land here. */
  removeSlider(id: number): void;
  /** The element the Sliders dialog is scoped to; null opens the
   *  circuit-wide dialog from the menubar. */
  setSliderElement(id: number | null): void;
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
  /** Loads a decoded audio buffer into an audio-input element: assigns a fresh
   *  `fileNum`, caches the samples against it and records the basename as the
   *  element's rail label, as one undo entry. The previous `fileNum`'s cache
   *  entry survives, so undo restores the old file. */
  loadAudioFile(id: number, samples: number[], samplingRate: number, fileName: string): void;
  /** Loads parsed data values into a data-input element, the same shape as
   *  `loadAudioFile` but with no sampling rate. */
  loadDataFile(id: number, samples: number[], fileName: string): void;
  /** Interactive state change (switch throw), routed through the live engine. */
  setElementState(id: number, state: number): void;
  /** Throws the switch at `id` to its next position, carrying every MBB in the
   *  same nonzero Switch Group along in one set (MBBSwitchElm.java:182-195).
   *  The keyboard and canvas pointer toggle paths both route through this, so
   *  the fan-out cannot be skipped by one of them. */
  toggleSwitch(id: number): void;
  /** Clears every fuse's live `state` and drops their queued pop-confirms, the
   *  store half of the Reset command: the engine half (`engine.reset`) already
   *  un-blows the models, and this keeps the serialized copies from re-injecting
   *  `blown true` on the next frame. */
  unblowFuses(): void;
  /** Drops queued value edits; the frame loop calls this after applying them. */
  clearPending(): void;

  addScope(elementId: number, value: ScopeValue): void;
  /** Adds a plot of `value` for `elementId` to an existing scope, the "Add to
   *  Existing Scope" context-menu command (Scope.addElm). Dedup is per scope:
   *  the command's point is reaching a specific panel, not creating one. */
  addToScope(elementId: number, scopeId: number, value: ScopeValue): void;
  removeScope(id: number): void;
  /** Clears a scope's capture buffer (the Reset command). */
  resetScope(id: number): void;
  /** Changes the horizontal zoom without rewinding the simulation. */
  setScopeSpeed(id: number, speed: number): void;
  setScopeTrigger(id: number, patch: Partial<ScopeTrigger>): void;
  /** Display flags (overlays, scale mode, FFT/X-Y); never forces a reload. */
  setScopeFlags(id: number, patch: Partial<Omit<Scope, 'id' | 'raw' | 'plots' | 'trigger'>>): void;
  /** Puts one scope's display settings, speed and trigger back to what a
   *  freshly created panel gets, stored scope defaults included: the Reset to
   *  Default button beside Save as Default. Keeps the traces and the column
   *  position; one undo entry. */
  resetScopeToDefaults(id: number): void;
  /** Shows or hides every voltage (showV) or current (showI) plot, the
   *  Properties dialog's Show Voltage / Show Current boxes (Scope.java:115-134).
   *  Enabling a value with no plot of it present adds one for the scope's first
   *  element; adding a plot forces a reload, the flag alone does not. */
  setScopeShowValue(scopeId: number, value: 'voltage' | 'current', show: boolean): void;
  setPlotCoupling(scopeId: number, plotId: number, acCoupled: boolean): void;
  setPlotManScale(plotId: number, manScale: number | null): void;
  setPlotManPosition(plotId: number, manVPosition: number): void;
  /** Sets one plot's per-trace measurement readout, the properties dialog's
   *  per-channel checkbox path. The plot's mask is seeded from the scope word
   *  on first use; display-only, like setScopeFlags. */
  setPlotMeasurementFlag(plotId: number, key: PlotMeasurementKey, on: boolean): void;
  /** Drops every plot's measurement mask in one scope so all traces inherit
   *  the scope word again: the "Apply to all traces" toggle's switch-on path.
   *  A no-op (and no undo entry) when nothing overrides. */
  clearPlotMeasurementOverrides(scopeId: number): void;
  /** Adds or removes a plot of `value`, never emptying the panel. */
  togglePlot(scopeId: number, value: ScopeValue): void;
  /** Removes exactly the plot `plotId` names, the scope popup's Remove Plot
   *  (Scope.removePlot(int)): a combined panel can carry two plots of the
   *  same value, so identity is by id, not by value. Refuses stale ids,
   *  raw-only plots (they only preserve their o line tokens for the next
   *  save) and the panel's last plot; one undo entry when it acts. */
  removePlot(scopeId: number, plotId: number): void;
  /** The Show Vce vs Ic row's action: replaces a transistor scope's plots
   *  with the VCE/IC pair and turns X-Y on (Scope.java:1312-1317). */
  setScopeVceIc(scopeId: number): void;
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

  /** Replaces the document with a parsed netlist. `noCenter` skips the
   *  fit-to-view, for the drill-in exit which restores its own saved view;
   *  `noBaseline` skips the `lastSaved` write, for the drill-in enter whose
   *  baseline must stay on the outer document for the whole session. */
  loadNetlist(text: string, opts?: { noCenter?: boolean; noBaseline?: boolean }): void;
  toNetlist(): string;
  /** Serialises the document the way `toNetlist` does, but overlaid with the
   *  engine's live operating-point tokens where the provider reports them, so
   *  a mid-transient save writes the charge the circuit actually holds. */
  saveNetlist(): string;
  /** The netlist the auto-save slot should hold: the live document normally,
   *  but the stack-root (outer) document while a drill-in session is up, so a
   *  crash inside recovers onto the outer sheet as if the drill-in never
   *  happened. */
  recoveryNetlist(): string;
  newCircuit(): void;
  /** Enters a model's internals for editing (the 410 element's Edit Model
   *  button): pushes the current document and view onto the subcircuit stack,
   *  then loads the reconstructed inner document with a clean undo history,
   *  exactly as upstream's `pushContext` + `readCircuit` do
   *  (CustomCompositeElm.java:273-281). Refuses the default model and an
   *  unresolvable name with the reason in `subcircuitError`; returns false
   *  then and changes nothing. */
  enterSubcircuit(name: string): boolean;
  /** Leaves the innermost model editing session: derives the edited model from
   *  the inner document, rewrites the enclosing document's `.` line for it,
   *  restores the saved document and view and pops the stack. One undo entry
   *  lands on the outer document covering the model change, so the inner
   *  session's own undo history dies with it, matching upstream's per-context
   *  stacks (CirSim.java:489-505). On an extraction error the session stays
   *  inside with the reason in `subcircuitError`. */
  exitSubcircuit(): void;
  /** Points the store at the engine's token reader, or clears it. */
  setLiveStateProvider(provider: (() => LiveState) | null): void;
  /** Marks the current document clean: `lastSaved` is set to the non-live
   *  `toNetlist`, the same baseline a load or New records, so the F5 and
   *  autosave checks compare like against like. The live overlay a save wrote
   *  is deliberately not the baseline. A no-op while a drill-in session is up:
   *  a Save As from inside exports the scratch sheet, and the baseline belongs
   *  to the outer document for the whole session. */
  markSaved(): void;
  /** Loads the stored auto-save recovery, if any, as one undo entry, and marks
   *  the circuit unsaved (upstream's doRecover, UndoManager.java:83-88). A
   *  no-op when no recovery exists. */
  recoverAutoSave(): void;

  /** Begins a scope editing gesture: commits the pre-gesture baseline once,
   *  then raises `scopeGesture` so the scope setters stop committing until
   *  `endScopeGesture`. Mirrors `beginEdit` for element drags. */
  beginScopeGesture(): void;
  /** Ends a scope editing gesture, lowering `scopeGesture` so the scope setters
   *  resume committing. The gesture's whole edit is one undo entry. */
  endScopeGesture(): void;
  /** Begins a canvas pointer gesture on an element: raises `elementGesture` so
   *  a keyboard rotate mid-drag folds into the gesture's single undo entry.
   *  Unlike `beginScopeGesture` this does not commit: both callers (a placement
   *  arm and a move arm) have already committed their own baseline. */
  beginElementGesture(kind: 'place' | 'move'): void;
  /** Ends the canvas pointer gesture, lowering `elementGesture` so the next
   *  command commits normally again. Every drag teardown owes this call. */
  endElementGesture(): void;
  /** Records the current state so the next change can be undone. */
  commit(): void;
  /** Marks the start of an edit session (a field focus or a pointer-down on a
   *  slider). One undo entry per session; a session that changes nothing is
   *  deduped away by commit. */
  beginEdit(): void;
  undo(): void;
  redo(): void;

  /** Opens the wheel value popover session. Pushes no undo entry: the wheel
   *  path commits its baseline before calling this, upstream's constructor
   *  pushUndo (ScrollValuePopup.java:59), and a second commit here would
   *  split the session across two undo steps. */
  openScrollValuePopover(popover: ScrollValuePopover): void;
  /** Steps the open session by one wheel event's normalized pixels, writing
   *  the stepped value through `setParam` so it stays live. A no-op when no
   *  session is open. */
  stepScrollValuePopover(deltaY: number): void;
  /** Closes the popover keeping the current selection; mouse-out, Escape and
   *  Enter. The value is already live, so only the field clears. */
  closeScrollValuePopover(): void;
  /** Restores the opening value and closes; right-click and Space
   *  (ScrollValuePopup.close(false)). */
  revertScrollValuePopover(): void;

  openContextMenu(
    x: number,
    y: number,
    target: number | null,
    circuit: Point,
    focusSearch?: boolean,
  ): void;
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
