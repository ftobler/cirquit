# Keyboard

Shortcut matching, user-assignable keys and precedence.

## Matching

All key matching lives in `web/src/input/shortcuts.ts`, pure and DOM-free:
`matchShortcut(KeyEventLike)` over the enumerable `SHORTCUTS` table. App code
keeps only the focus guard, the match call and one-line store dispatch.

- Mod combos match `ctrl||meta` and `!alt`; shift is exact-match per row, so
  Ctrl+Shift+Z is distinct from Ctrl+Z. **Diverges from upstream**, which
  ignores shift on the Ctrl path (Ctrl+Shift+C copies there).
- Plain keys ignore shift (needed for `+`), except `r`/`m`/`t`, which keep
  `shift: false` because every letter of both cases is a placement char.
- **Owner decision 2026-08-20: Space is rotate**, turning the grabbed or
  selected parts a quarter turn, replacing upstream's Space-is-select-mode
  (Escape covers that; `selectMode` survives as an assignable action). A held
  Space turns once; a live pointer gesture folds the turn into its undo entry.
  Run/pause has no key (P is PMOS placement upstream).
- The App keydown handler returns whenever a dialog is open, so the dialog
  owns Ctrl+V, Delete and the rest.

## User-assignable shortcuts

- `ShortcutOverlay` (`web/src/input/shortcuts.ts`) maps `AssignableAction` to
  a chord signature and is consulted before the table, so a user assignment
  beats hardcoded combos (UIManager.java:1174-1198). `chordOf` folds
  ctrl||meta into one dimension and tracks shift only for letters, so a
  user 'z' never swallows Ctrl+Shift+Z.
- Persisted as JSON under `shortcuts.v1` (upstream uses `1;char=command;...`
  under `shortcuts`, UIManager.java:1506-1514). Unknown actions and malformed
  chords drop on load. Not an undo entry.
- The dialog stores only real overrides (`overlayFromRows` skips defaults);
  persisting defaults would arm the repeat guard on keys that must repeat.
  Enter, Tab, Escape, arrows and Backspace/Delete are not assignable, as
  upstream's `keyCodeToPlaceholder` returns -1 for them.
- **Precedence on a plain key** (App keydown order): focus guard, dialog
  guard, switch `keyShortcut` (UIManager.java:1248), repeat guard for
  assigned chords (UIManager.java:1181), overlay, table.
- Keyboard switch toggles push no undo entry (upstream), while pointer throws
  commit one (port). The two run-mode paths differ on purpose; a store test
  pins the keyboard side. A held key never re-toggles; keyup releases
  momentaries (UIManager.java:1113-1131). Both paths share `nextSwitchState`.
- `/` (`openPalette`) opens the right-click menu with the caret in the
  palette search; a switch or user assignment on `/` wins through the normal
  precedence. The menu opens at the last pointer position kept in
  `web/src/ui/paletteAnchor.ts` (module state, not store state, because the
  pointer moves more often than a frame), falling back to the viewport centre.

## Placement keys

Placement chars come from the registry defs and toolbox (`PLACEMENT_BY_CHAR`,
scanned defs then toolbox, last write wins), verified against upstream's
`getShortcut()`. `registry.test.ts` asserts each of `s` (switch) and `S`
(switch2) is declared exactly once, so a duplicate cannot silently re-arm a
key. `place` is not assignable, so a stored overlay can never bind a
placement.

## Placement keys are assignable

Placement rows seed from `PLACE_DEFAULT_CHORDS` as Shift-chords; with an empty
overlay every path is the old behaviour. Uppercase seeds fold to Shift+x.
`actionForChord` skips empty overlay values. Defaults are unchanged from
upstream.

## Shortcut validation

Modifier-only and junk keys are not assignable; F-keys persist; IME
composition Enter never commits a dialog; placement collisions are refused,
not last-wins. `SWITCH_KEY_KINDS` keeps the key loops in step.
