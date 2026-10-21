# Commands

The command registry is the public mutation API: one enumerable list of
everything that changes the document, shared by the keyboard, the menubar, the
context menu, the dialogs and the canvas, and the list a later MCP server
exposes as tools.

## Shape

`web/src/commands/` holds it. `types.ts` defines `CommandDef` (id, label,
description, `args`, `history`, `edits`, `destructive`, `enabled`, `undoLabel`,
`run`), `CommandResult` and `CommandContext`. `schema.ts` is a hand-rolled
JSON-Schema subset (object, number, integer, string, boolean, null, array,
enum, anyOf, required, min/max, `additionalProperties`), chosen over a runtime
validator so a definition serialises straight into an MCP `inputSchema` with no
bundle cost. `registry.ts` is the table and the deliberate non-command list;
the command families live in `edit.ts`, `scope.ts`, `circuit.ts`,
`selection.ts` and `history.ts`.

## Ids are stable

An id is dotted and starts each segment lowercase, camel case allowed inside a
segment (`element.mirrorVertical`). It is the public name: an MCP tool name
derives from it, and renaming one is a breaking change. `registry.test.ts`
pins uniqueness, the shape, a valid schema and a non-empty description.

## `execute` is the one door

`execute(id, args, ctx)` looks up the id, validates `args`, applies the editing
gate, asks the definition's `enabled`, refuses an agent call during a live user
gesture, and runs the body. `history: 'step'` wraps the run in one
`store.transact`; a throw becomes a `failed` result with the transaction
already closed. `history: 'none'` never touches the stacks and `'history'` is
undo/redo itself.

- `edits: true` commands are refused while `settings.editable` is false, with
  the same status line every door shows. This is the old `EDIT_ACTIONS` rule,
  now on the definition.
- `enabled` returns `true` or the reason the command is disabled; the menubar,
  context menu and shortcut dialog read that one reason.
- The busy gate refuses a non-user source while a user transaction, gesture or
  wheel session is open. An agent must never write into the middle of a human
  drag, and a human drag must never merge with an agent edit. User-sourced
  commands keep today's behaviour, so Space still rotates mid-drag.
- `execute` never touches the DOM. Host-only effects (the file picker, print,
  fullscreen, the run controls on the wasm engine) stay outside the table;
  `CommandContext.sim` carries the engine's reset and DC solve for the two
  run-control commands that need them.

## Explicit ids, never a faked selection

Every command that acts on elements takes `ids?: number[]`, defaulting to the
current selection when the UI omits it. The store exposes the id-taking body
(`deleteElements`, `rotateElements`, `mirrorElements`, `swapTerminalsOf`,
`copyElements`, `cutElements`, `duplicateElements`) and the selection action is
a thin wrapper, so there is one code path. An agent never has to select
anything to edit it.

## Batch

`history.batch {calls, label}` runs nested commands through the same
`execute`, so each keeps its own validation and gating, inside one undo entry
named by `label`. The first failure restores the pre-batch document and the
pre-batch history through `revertBatch` and reports the failing call index; the
outer transaction's `finally` then prunes the entry it opened, so the undo
depth is unchanged.

## Destructive commands

`circuit.new` and `circuit.loadText` replace the document and wipe the undo
history, exactly as the File menu always has. Both carry `destructive: true`;
the deferred live-bridge plan uses that flag to ask before running one from an
agent.

## Deliberately not commands

`NON_COMMAND_STORE_ACTIONS` in `registry.ts` lists every store action outside
the table with a one-line reason: hover and highlight, menu and popover
open/close, drawer toggles, canvas pan and fit, gesture helpers
(`placeWireEnd`, `autoSplitAt`), dialog and floating-panel presentation, the
device-model dialog's own session store, and the undo/gesture boundary
helpers. `registry.test.ts` parses the `AppState` action list and fails when a
new action is neither reachable from a command nor in the allow-list, so a
mutating action cannot be added silently.

## Door migrations

- `web/src/input/shortcuts.ts` rows carry a command id plus arguments; the
  host union is only `open`, `print`, `openPalette`, `escape`, `selectMode`,
  `save` and `place`. A stored `shortcuts.v1` overlay migrates its old action
  names on read (`undo` to `history.undo` and so on), and an explicit new key
  wins over a legacy key for the same command.
- Menubar rows use `commandRow` and take their label, disabled state and
  reason from the definition.
- **Diverges from upstream.** Edit > Undo and Redo name the step from the
  history entry: `Undo Add Resistor`, not a bare `Undo`. Upstream's
  `UndoManager` rows never name the step. The undo icon buttons' titles follow
  the same wording.
- The context menu, scope properties, scope menu, slider dialog and element
  fields call `execute` for discrete edits. The element-fields dispatcher keeps
  its pure `FieldEditActions` interface and its methods are command calls.
- Canvas gestures stay one open transaction. A click-place ends in
  `element.add` (with the toolbox tool id and banked turns, so the drop and an
  agent placement share the ghost builder) and a wire drag ends in `wire.add`.
