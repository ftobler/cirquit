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

## Queries

`web/src/commands/queries.ts` is the read side: `QueryDef` (id, label,
description, `args`, `run`) is `CommandDef` minus `history`, `edits` and the
gates, and `run` returns JSON-safe data. `query(id, args, ctx)` mirrors
`execute`: an unknown id, bad args or a refusal come back as a `QueryResult`,
never as a throw.

**A query is pure, and a test enforces it.** `queries.test.ts` runs every id
with valid sample args and asserts the snapshot fingerprint (`snapshotKey` and
the WeakMap-cached `cachedSnapshotKey`), `revision`, `paramRevision` and both
history stacks are unchanged. A query never calls `set`, never opens a
transaction and never returns a live view into the store (params and scope
records are copied).

The inventory: `kinds.list`, `kind.describe`, `circuit.netlist`,
`circuit.summary`, `elements.list`, `element.get`, `nodes.list`,
`element.readings`, `scopes.list`, `scope.samples`, `sim.state`, `history.list`
and `schematic.svg`. They reuse the existing paths rather than re-implementing
them: `saveNetlist` for the text, the registry defs and `postsOf` for geometry,
`render/infoBox.ts` `infoLines` for the readout, `engine/scopeModel.ts` for the
scope model, and `render/svg.ts` `renderCircuitToSvg` for the export.

## SimHost and why the engine stays out of the store

Live values belong to the engine, and the store never holds a `SimEngine`.
`web/src/engine/simHost.ts` defines `SimHost` (sync, time, running, step,
nodeVoltages, elementReadings, infoLines, scopeSamples), and the store holds one
under `simHost`, set through `setSimHost` exactly as `liveStateProvider` is set
through `setLiveStateProvider`. A query that needs live values calls
`requireEngine`, which refuses with `{ ok: false, error: 'no-engine' }` when no
host is attached, instead of reporting a stale zero. Those queries are
`element.readings`, `scope.samples` and `sim.state`.

The browser host (`web/src/ui/canvas/browserSimHost.ts`, wired in `App.tsx`
beside the live-state provider) reads the frame loop's per-frame cache for the
operating-point triple, so a query never pays a second wasm crossing for what
the renderer already fetched this frame; node voltages, per-post currents and
the scope rings are one crossing per call, never per element. It deliberately
does not build or step: the frame loop is the single builder (it rebuilds on
every revision change within a frame) and the single stepper while the run is
live, so the browser host's `sync` is a no-op and its `step` refuses while
running. Step 4's headless runner provides the other implementation, where
`sync` builds and `step` advances synchronously.

`sim.step` is a command (`history: 'none'`) because it needs `SimHost`. It is
disabled while the run is live with the reason `pause the simulation first`;
the browser host refuses the same way, so a direct call cannot race the loop.

## Units and caps

Every measured number is reported in SI base units beside a `unit` string, and
the human-readable `formatValue` output rides a separate `display` field. The
display never replaces the number: an agent computes on `value`, a person reads
`display`. This covers `element.readings` (V, A, W), `scope.samples` (s per
point, V/A/... per trace), `sim.state` (s) and the quantities in
`circuit.summary` and `element.get`.

Coordinates are circuit units, and `circuit.summary` reports `gridSize` (16) so
a caller can place terminals on grid multiples; `kind.describe` says the same
and returns the reference-orientation terminal offsets. Terminal geometry must
match upstream exactly or loaded wires do not connect.

Three reads can be large, so each has a named cap with a `truncated: true`
flag: `circuit.netlist` (`MAX_NETLIST_CHARS`), `scope.samples`
(`MAX_SCOPE_SAMPLES` points) and `schematic.svg` (`MAX_SVG_CHARS`). The caps
are sized well above any real document and only bound one generated or corrupt
payload. A truncated text payload is a prefix and, for the SVG, is not valid
XML.
