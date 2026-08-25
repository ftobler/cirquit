/** Keyboard shortcut matching. Pure and DOM-free: it maps a plain event
 *  descriptor to an action id, and App.tsx does the dispatch. Stage 3 adds the
 *  user-assignable overlay: a runtime map from assignable action to a chord
 *  signature, consulted before the hardcoded table (the ShortcutsDialog edits
 *  it). Element-placement keys are assignable too, keyed per tool: upstream's
 *  Edit Shortcuts dialog lists every Draw-menu item beside the commands
 *  (ShortcutsDialog.java:69-76), so a placement letter can move like any
 *  command chord can. */

import { PLACEMENT_BY_CHAR, toolboxEntry } from '../model/registry';
import type { StorageLike } from '../state/appPrefs';

export type ShortcutAction =
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'delete' }
  | { type: 'escape' }
  | { type: 'selectMode' }
  | { type: 'nudge'; dx: number; dy: number }
  | { type: 'zoomIn' }
  | { type: 'zoomOut' }
  | { type: 'zoomReset' }
  | { type: 'save' }
  | { type: 'open' }
  | { type: 'copy' }
  | { type: 'cut' }
  | { type: 'paste' }
  | { type: 'duplicate' }
  | { type: 'selectAll' }
  | { type: 'rotate' }
  | { type: 'mirror' }
  | { type: 'swap' }
  | { type: 'toggleRunning' }
  | { type: 'print' }
  | { type: 'openPalette' }
  | { type: 'place'; kind: string };

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface ShortcutEntry {
  /** Requires ctrl or meta held, and no alt. False requires none of the three. */
  mod: boolean;
  /** Requires alt held. False/absent requires none. The rotate/mirror/swap
   *  rows live here: their plain letters are upstream placement chars, so the
   *  geometry commands moved to Alt rather than fight over them. */
  alt?: boolean;
  /** Required shift state. Undefined ignores shift, which the `+` zoom key
   *  needs: on most layouts it only exists behind Shift+=. */
  shift?: boolean;
  /** The key, lowercase for a Latin letter; punctuation and named keys exact. */
  key: string;
  action: ShortcutAction;
}

/** The binding table. Stage 3's user-assignable shortcut map is a runtime
 *  overlay on this table, so it must stay enumerable: one row per chord. */
export const SHORTCUTS: ShortcutEntry[] = [
  // Modifier chords, upstream's getCtrlKey() || getMetaKey()
  // (UIManager.java:1198). The shift-specific rows keep Ctrl+Shift+Z
  // distinguishable from Ctrl+Z, and a shifted Ctrl chord is unbound so
  // browser chords (Ctrl+Shift+S) pass through.
  { mod: true, shift: false, key: 'z', action: { type: 'undo' } },
  { mod: true, shift: true, key: 'z', action: { type: 'redo' } },
  { mod: true, shift: false, key: 'y', action: { type: 'redo' } },
  { mod: true, shift: false, key: 'c', action: { type: 'copy' } },
  { mod: true, shift: false, key: 'x', action: { type: 'cut' } },
  { mod: true, shift: false, key: 'v', action: { type: 'paste' } },
  { mod: true, shift: false, key: 'd', action: { type: 'duplicate' } },
  { mod: true, shift: false, key: 'a', action: { type: 'selectAll' } },
  { mod: true, shift: false, key: 's', action: { type: 'save' } },
  { mod: true, shift: false, key: 'o', action: { type: 'open' } },
  // Ctrl+P prints the schematic image, not the page (CommandManager.java:73).
  { mod: true, shift: false, key: 'p', action: { type: 'print' } },

  // Plain keys. Delete and Backspace both delete (UIManager.java:1134) and
  // the arrows nudge by one grid step per press (UIManager.java:1153). The
  // delta is a unit-less step count: the matcher has no store access, so
  // App.tsx resolves it against the constant grid step (GRID_SIZE = 16) at
  // dispatch.
  // Ctrl+Delete / Ctrl+Backspace pass through to the browser: the mod combos
  // above are exclusive, so a held ctrl unmatches these plain rows, which is
  // the deliberate consequence of the exact-match matcher.
  { mod: false, key: 'Escape', action: { type: 'escape' } },
  { mod: false, key: 'Delete', action: { type: 'delete' } },
  { mod: false, key: 'Backspace', action: { type: 'delete' } },
  { mod: false, key: 'ArrowUp', action: { type: 'nudge', dx: 0, dy: -1 } },
  { mod: false, key: 'ArrowDown', action: { type: 'nudge', dx: 0, dy: 1 } },
  { mod: false, key: 'ArrowLeft', action: { type: 'nudge', dx: -1, dy: 0 } },
  { mod: false, key: 'ArrowRight', action: { type: 'nudge', dx: 1, dy: 0 } },

  // Zoom keys. '+' and '=' both zoom in and the numpad variants zoom too,
  // which is what upstream's charCode path produces for a numpad
  // (UIManager.java:1091-1099). '0' resets to exactly 100%.
  { mod: false, key: '-', action: { type: 'zoomOut' } },
  { mod: false, key: 'Subtract', action: { type: 'zoomOut' } },
  { mod: false, key: '+', action: { type: 'zoomIn' } },
  { mod: false, key: '=', action: { type: 'zoomIn' } },
  { mod: false, key: 'Add', action: { type: 'zoomIn' } },
  { mod: false, key: '0', action: { type: 'zoomReset' } },
  // Numpad 0 reports the same key '0' as the top row in every modern browser,
  // so this row is never hit; kept for parity with the Add/Subtract rows,
  // which do carry distinct keys ('NumpadAdd'/'NumpadSubtract' are legacy key
  // values some engines still emit).
  { mod: false, key: 'Numpad0', action: { type: 'zoomReset' } },

  // Geometry commands, the landed editing-gestures keys. The plain r and t
  // were surrendered to upstream placement parity: upstream has no plain-key
  // rotate, mirror or swap, and its r arms a resistor and t arms a text label,
  // so the commands moved to Alt, which the matcher guards against the browser
  // the way Ctrl is (UIManager's modifier chords). m is free upstream too, and
  // joining it keeps the three letters memorable. Alt+Shift+r stays unbound:
  // the shift guard excludes it like the other letter chords.
  //
  // Space is rotate, the owner's call: it turns whatever is grabbed mid-drag
  // or selected. Upstream's Space (temporary select mode) is dropped, because
  // Escape already returns to select mode and Space would otherwise be the one
  // overloaded key in this table. It sits before the Alt+r row so
  // defaultBindingFor('rotate') reports Space; Alt+r stays a second default.
  // The shift guard keeps Shift+Space unbound, like the letter rows.
  { mod: false, shift: false, key: ' ', action: { type: 'rotate' } },
  { mod: false, alt: true, shift: false, key: 'r', action: { type: 'rotate' } },
  { mod: false, alt: true, shift: false, key: 'm', action: { type: 'mirror' } },
  { mod: false, alt: true, shift: false, key: 't', action: { type: 'swap' } },

  // Upstream's '/' opens the Find Component dialog (UIManager.java:1103-1110).
  // The port has no such dialog: the right-click menu already carries the
  // element search, so '/' opens that menu instead, focused on its search box.
  // A shifted '/' is '?' on most layouts, a different key, so no shift guard
  // is needed.
  { mod: false, key: '/', action: { type: 'openPalette' } },
];

/** The commands the ShortcutsDialog can rebind: upstream's assignable menu
 *  items plus the Start/Stop row (ShortcutsDialog.java:72-94). Nudge is
 *  excluded: its binding is the four-arrow chord, not a single key. */
export const COMMAND_ACTIONS = [
  'undo',
  'redo',
  'delete',
  'save',
  'open',
  'copy',
  'cut',
  'paste',
  'duplicate',
  'selectAll',
  'rotate',
  'mirror',
  'swap',
  'zoomIn',
  'zoomOut',
  'zoomReset',
  'escape',
  'selectMode',
  'toggleRunning',
] as const;

export type CommandAction = (typeof COMMAND_ACTIONS)[number];

/** The per-tool placement actions, one per entry of PLACEMENT_BY_CHAR, keyed
 *  by the toolbox id a `place` action arms (`place:resistor`, `place:npn`).
 *  Upstream's dialog rows are exactly these Draw-menu items. */
export const PLACE_ACTION_PREFIX = 'place:';
export type PlacementAction = `${typeof PLACE_ACTION_PREFIX}${string}`;

export function isPlacementAction(action: AssignableAction): action is PlacementAction {
  return action.startsWith(PLACE_ACTION_PREFIX);
}

export function placementToolOf(action: PlacementAction): string {
  return action.slice(PLACE_ACTION_PREFIX.length);
}

/** Registry order, so the dialog lists placement keys in the same order the
 *  defs scan. Deduplicated defensively: a duplicate toolbox id would silently
 *  collapse two rows into one otherwise. */
export const PLACEMENT_ACTIONS: readonly PlacementAction[] = [
  ...new Set(PLACEMENT_BY_CHAR.values()),
].map((id) => `${PLACE_ACTION_PREFIX}${id}` as PlacementAction);

/** Everything the ShortcutsDialog shows a row for: commands first, then the
 *  placement tools. */
export const ASSIGNABLE_ACTIONS: readonly AssignableAction[] = [
  ...COMMAND_ACTIONS,
  ...PLACEMENT_ACTIONS,
];

export type AssignableAction = CommandAction | PlacementAction;

/** The dialog's row labels for the command rows. Placement-row labels come
 *  from the registry via actionLabel, so no second name table exists here. */
export const ACTION_LABELS: Record<CommandAction, string> = {
  undo: 'Undo',
  redo: 'Redo',
  delete: 'Delete',
  save: 'Save As',
  open: 'Open File',
  copy: 'Copy',
  cut: 'Cut',
  paste: 'Paste',
  duplicate: 'Duplicate',
  selectAll: 'Select All',
  rotate: 'Rotate',
  mirror: 'Mirror',
  swap: 'Swap',
  zoomIn: 'Zoom In',
  zoomOut: 'Zoom Out',
  zoomReset: 'Zoom 100%',
  escape: 'Escape to select mode',
  selectMode: 'Select mode',
  toggleRunning: 'Start/Stop Simulation',
};

/** The dialog's row label for any assignable action: the command table for
 *  commands, the registry's own label for placement tools (upstream shows the
 *  menu item name, ShortcutsDialog.java:73). */
export function actionLabel(action: AssignableAction): string {
  if (isPlacementAction(action)) return toolboxEntry(placementToolOf(action)).label;
  return ACTION_LABELS[action];
}

/** A user-assigned binding: assignable action -> chord signature. Empty when
 *  unassigned. The dialog edits this map; matchShortcut consults it before the
 *  hardcoded table, so a user assignment wins over every default
 *  (UIManager.java:1174-1198). */
export type ShortcutOverlay = Partial<Record<AssignableAction, string>>;

/** One editable row in the ShortcutsDialog. */
export interface ShortcutRow {
  action: AssignableAction;
  /** The chord signature, or '' when unassigned. */
  chord: string;
}

const ASSIGNABLE_SET = new Set<string>(ASSIGNABLE_ACTIONS);

function isAssignableAction(t: string): t is AssignableAction {
  return ASSIGNABLE_SET.has(t);
}

/** Letters fold to lowercase so Shift+r and r are the same key; everything
 *  else (named keys, punctuation, digits, space) is compared exactly. */
export function normalizeKey(key: string): string {
  return key.length === 1 && /[a-zA-Z]/.test(key) ? key.toLowerCase() : key;
}

/** A printable ASCII char, upstream's cc >= 32 && cc < 127 range. Only these
 *  (space is cc 32 and included) can be switch keyShortcut assignments or
 *  element placement chars; named keys (Enter, Escape, arrows) never are. */
export function isPrintableKey(key: string): boolean {
  return key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) < 127;
}

/** The canonical chord signature for an event, the string the overlay is keyed
 *  by. Ctrl and Meta are one dimension (the table's mod flag, so a user
 *  assignment to Ctrl+z wins over the hardcoded undo just as upstream's
 *  custom shortcut wins over its Ctrl/Meta list). Alt is its own dimension,
 *  the geometry commands' home since their plain letters are placement chars.
 *  Shift is its own dimension only for a letter: a user-assigned 'z' must not
 *  swallow Ctrl+Shift+Z, while a shifted punctuation key already carries its
 *  shift in the key (Shift+= is '+'). */
export function chordOf(
  ev: Pick<KeyEventLike, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
): string {
  const key = normalizeKey(ev.key);
  const mod = ev.ctrlKey || ev.metaKey;
  const alt = ev.altKey ? 'Alt+' : '';
  const shift = ev.shiftKey && /^[a-z]$/.test(key) ? 'Shift+' : '';
  return `${mod ? 'Ctrl+' : ''}${alt}${shift}${key === ' ' ? 'Space' : key}`;
}

/** The action a chord is assigned to in the overlay, or null. An empty value
 *  is "unassigned", never a binding: the dialog clears rows to '' before
 *  overlayFromRows drops them, and the matcher's old truthiness guard only
 *  covered this one caller, so the rule lives here where every caller
 *  (the App.tsx repeat guard included) shares it. */
export function actionForChord(overlay: ShortcutOverlay, chord: string): AssignableAction | null {
  if (chord === '') return null;
  for (const [type, c] of Object.entries(overlay) as [AssignableAction, string][]) {
    if (c !== '' && c === chord) return type;
  }
  return null;
}

/** True when the overlay binds this chord, so a caller can repeat-guard a
 *  held user-assigned key the way upstream does (UIManager.java:1181). */
export function hasChord(overlay: ShortcutOverlay, chord: string): boolean {
  return actionForChord(overlay, chord) !== null;
}

/** The base placement map minus every tool the overlay reassigns elsewhere:
 *  moving a key off a letter must free the letter, which the raw map alone
 *  never models (it only knows what each char arms). The new chords themselves
 *  resolve earlier through actionForChord, so this map needs only deletions.
 *  The base object is returned untouched while no placement is assigned, which
 *  is the every-keystroke case. */
function freedPlacements(
  base: ReadonlyMap<string, string>,
  overlay: ShortcutOverlay,
): ReadonlyMap<string, string> {
  const moved = new Set<string>();
  for (const [action, chord] of Object.entries(overlay) as [AssignableAction, string][]) {
    if (chord !== '' && isPlacementAction(action)) moved.add(placementToolOf(action));
  }
  if (moved.size === 0) return base;
  const out = new Map(base);
  for (const [char, tool] of out) {
    if (moved.has(tool)) out.delete(char);
  }
  return out;
}

export function matchShortcut(
  ev: KeyEventLike,
  overlay: ShortcutOverlay = {},
  placement: ReadonlyMap<string, string> = PLACEMENT_BY_CHAR,
): ShortcutAction | null {
  // A user-assigned chord beats the hardcoded table and the placement map
  // (UIManager.java:1174). The overlay is exact per chord, so assigning 'x' to
  // copy never changes Ctrl+X. An Alt chord is only a chord if the overlay
  // says so: chordOf carries alt, so an assignment to Alt+r round-trips here
  // even though the table's plain-letter rows no longer collide with it. A
  // placement assignment resolves to the same `place` action its registry
  // letter produces.
  const assigned = actionForChord(overlay, chordOf(ev));
  if (assigned !== null) {
    if (isPlacementAction(assigned)) return { type: 'place', kind: placementToolOf(assigned) };
    return { type: assigned } as ShortcutAction;
  }
  // Letters match on the lowercase form (Shift+r is still r), punctuation and
  // named keys on the exact char.
  const key = normalizeKey(ev.key);
  const modHeld = ev.ctrlKey || ev.metaKey;
  for (const entry of SHORTCUTS) {
    if (entry.mod !== modHeld) continue;
    if ((entry.alt ?? false) !== ev.altKey) continue;
    if (entry.shift !== undefined && entry.shift !== ev.shiftKey) continue;
    if (entry.key !== key) continue;
    return entry.action;
  }
  // Element placement: a plain printable key that no command, user assignment
  // or surviving registry letter binds arms the element whose registry
  // shortcut it is, the same MODE_ADD_ELM the toolbox buttons arm
  // (UIManager.java:1273-1284). Modifiers suppress this path, so Ctrl+W
  // (browser close-tab) and Alt+key browser gestures never arm a tool, and
  // the char is looked up raw, not lowercased: 'p' and 'P' are different
  // elements, exactly as the map keys them. A tool the overlay reassigned is
  // missing here: its old letter is free.
  if (!modHeld && !ev.altKey && isPrintableKey(ev.key)) {
    const kind = freedPlacements(placement, overlay).get(ev.key);
    if (kind !== undefined) return { type: 'place', kind };
  }
  return null;
}

/** The uppercase placement chars seed a Shift+ chord, the form chordOf
 *  reports for a shifted letter; everything else seeds itself. */
function seedChordOfChar(char: string): string {
  return char >= 'A' && char <= 'Z' ? `Shift+${char.toLowerCase()}` : char;
}

const PLACE_DEFAULT_CHORDS = new Map<string, string>();
for (const [char, id] of PLACEMENT_BY_CHAR) {
  PLACE_DEFAULT_CHORDS.set(`${PLACE_ACTION_PREFIX}${id}`, seedChordOfChar(char));
}

/** The chord an action is bound to by default: the table binding for commands,
 *  the registry letter (case folded into Shift) for placement tools, or ''
 *  when none (toggleRunning, and selectMode since Space became rotate). The
 *  dialog shows it in a row the user has not reassigned, so these are the two
 *  single sources of truth for the defaults. An action with two table rows
 *  (rotate: Space and Alt+r) reports the first, so the dialog names one
 *  binding. */
export function defaultBindingFor(type: AssignableAction): string {
  const seeded = PLACE_DEFAULT_CHORDS.get(type);
  if (seeded !== undefined) return seeded;
  for (const entry of SHORTCUTS) {
    if (entry.action.type === type) return chordFromEntry(entry);
  }
  return '';
}

function chordFromEntry(entry: ShortcutEntry): string {
  const mod = entry.mod ? 'Ctrl+' : '';
  const alt = entry.alt ? 'Alt+' : '';
  const shift = entry.shift === true ? 'Shift+' : '';
  return `${mod}${alt}${shift}${entry.key === ' ' ? 'Space' : entry.key}`;
}

/** The dialog's rows: every assignable action with its current binding, the
 *  overlay's where assigned and the table's default otherwise. */
export function rowsFromOverlay(overlay: ShortcutOverlay): ShortcutRow[] {
  return ASSIGNABLE_ACTIONS.map((action) => ({
    action,
    chord: overlay[action] ?? defaultBindingFor(action),
  }));
}

/** The overlay a set of dialog rows represents: every non-empty chord that is
 *  a genuine override of the table default. A row showing its default binding
 *  is omitted, so a no-op OK never writes `delete:'Delete'` or `zoomIn:'+'`
 *  into the overlay, which would turn the App.tsx repeat guard
 *  (`ev.repeat && hasChord(...)`) on for keys that must repeat. Clearing a
 *  binding to the default keeps the same result: no override, default rules. */
export function overlayFromRows(rows: ShortcutRow[]): ShortcutOverlay {
  const out: ShortcutOverlay = {};
  for (const row of rows) {
    if (row.chord === '') continue;
    if (row.chord === defaultBindingFor(row.action)) continue;
    out[row.action] = row.chord;
  }
  return out;
}

/** True when a row already shows its default binding, so the dialog's Default
 *  button is a no-op and can be disabled. Clearing a row to '' is at default
 *  only for an action whose table binding is '' (toggleRunning); for delete it
 *  is a genuine override, and Default is the only way back to the Delete key,
 *  which the dialog keeps reserved. */
export function isDefaultBinding(row: ShortcutRow): boolean {
  return row.chord === defaultBindingFor(row.action);
}

/** True when two rows claim the same chord; the dialog flags them and greys
 *  OK, exactly as upstream's checkForDuplicates refuses to apply
 *  (ShortcutsDialog.java:188-214). */
export function hasDuplicateChords(rows: ShortcutRow[]): boolean {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.chord === '') continue;
    if (seen.has(row.chord)) return true;
    seen.add(row.chord);
  }
  return false;
}

/** The localStorage key for the overlay. Upstream stores it under "shortcuts"
 *  in a `1;char=command;...` encoding (UIManager.java:1506-1514); the port
 *  keeps the same concept under a versioned key and a JSON shape, following
 *  the appPrefs pattern. */
export const SHORTCUT_STORAGE_KEY = 'shortcuts.v1';

/** The browser storage, or undefined in a node test environment. Guarded
 *  because both callers reach it through a default argument, which evaluates
 *  before any body-level try/catch: with site data blocked the property
 *  access itself throws SecurityError, and this sits at store creation on
 *  module scope, so an unguarded read was a white screen at boot. */
function defaultStorage(): StorageLike | undefined {
  try {
    if (typeof globalThis === 'undefined') return undefined;
    return (globalThis as { localStorage?: StorageLike }).localStorage;
  } catch {
    // Storage denied: run without persistence rather than crash.
    return undefined;
  }
}

const NAMED_KEY = /^[A-Z][A-Za-z]*$/;

/** The key values a lone modifier keydown reports. The dialog's capture box
 *  ignores them: an assignment to bare Shift would fire on every Shift press
 *  anywhere in the editor and persist across reload, and only Shift of the
 *  four is even representable as a chord prefix (the others self-prefix
 *  harmlessly). */
const MODIFIER_KEYS = ['Shift', 'Control', 'Alt', 'Meta'] as const;

export function isModifierKey(key: string): boolean {
  return (MODIFIER_KEYS as readonly string[]).includes(key);
}

/** Key values that name no real printable key, so a chord on them can never
 *  do what its row promises: the four modifiers above plus CapsLock and the
 *  IME ghosts Dead and Unidentified. Rejected at load like the reserved keys,
 *  so not even a hand-edited blob binds them. */
const JUNK_NAMED_KEYS = [...MODIFIER_KEYS, 'CapsLock', 'Dead', 'Unidentified'] as const;

/** Named keys the dialog never assigns, so they must not persist even through
 *  a hand-edited blob. Enter, Tab and the arrows are reserved by the host
 *  (Enter confirms, Tab moves focus, arrows navigate); Backspace/Delete are
 *  the dialog's clear keys; Escape closes the dialog; the junk family binds
 *  nothing real. Upstream leaves all of these inert too
 *  (KeyNames.keyCodeToPlaceholder returns -1 for them). */
const NON_ASSIGNABLE_KEYS = new Set([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  ...JUNK_NAMED_KEYS,
]);

/** True when a stored chord is one chordOf could have produced: an optional
 *  Ctrl+/Alt+/Shift+ prefix and a single key (a printable char, Space, or a
 *  named key like ArrowUp). A hand-edited or stale blob that fails this never
 *  binds, and the host-reserved named keys (Enter, Tab, Escape, arrows, the
 *  clear keys) are rejected so they cannot be persisted outside the dialog
 *  either. */
function isValidChord(chord: string): boolean {
  let rest = chord.startsWith('Ctrl+') ? chord.slice(5) : chord;
  rest = rest.startsWith('Alt+') ? rest.slice(4) : rest;
  const key = rest.startsWith('Shift+') ? rest.slice(6) : rest;
  if (key === '') return false;
  if (key.length === 1) {
    const c = key.charCodeAt(0);
    return c >= 32 && c < 127;
  }
  if (key === 'Space') return true;
  return NAMED_KEY.test(key) && !NON_ASSIGNABLE_KEYS.has(key);
}

/** Reads the stored overlay. A missing, corrupt or wrong-typed blob yields {},
 *  and unknown actions or malformed chords are dropped, so a stale entry from
 *  an older build can never bind a key the matcher would not produce.
 *  Upstream alerts and falls back on a corrupt entry; the port is quiet, same
 *  result. */
export function loadShortcutOverlay(
  storage: StorageLike | undefined = defaultStorage(),
): ShortcutOverlay {
  if (!storage) return {};
  let raw: string | null = null;
  try {
    raw = storage.getItem(SHORTCUT_STORAGE_KEY);
  } catch {
    return {};
  }
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const out: ShortcutOverlay = {};
  for (const [type, chord] of Object.entries(parsed)) {
    if (isAssignableAction(type) && typeof chord === 'string' && isValidChord(chord)) {
      out[type] = chord;
    }
  }
  return out;
}

/** Writes the overlay. A storage failure (private mode, quota) is swallowed:
 *  shortcuts are a convenience, never a crash. */
export function saveShortcutOverlay(
  overlay: ShortcutOverlay,
  storage: StorageLike | undefined = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(overlay));
  } catch {
    // Shortcuts must never take the app down with them.
  }
}
