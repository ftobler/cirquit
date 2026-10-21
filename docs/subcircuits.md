# Subcircuits and composites

Custom subcircuits (`.` model lines and `410` elements), built-in composites, and drill-in editing.

## Session and stored models

- `parseCircuit` is pure: `.` lines come back as `ParsedCircuit.compositeModels`
  and still ride in passthrough. Registering mid-parse grew the library on
  every Import preview keystroke and paste probe.
- The store owns the per-load library: `loadNetlist` and `newCircuit` call
  `clearSessionModels()`; paste and duplicate register additively (upstream
  `RC_RETAIN`). Upstream never clears `localModelMap` on load; the port must,
  because it lists the merged map in the Subcircuit Manager and a closed file's
  model would be a ghost row.
- **Each name has one origin.** `saveModel` writes the storage key, reads it
  back and compares the value (a throwing `setItem` is swallowed by
  `defaultStorage`, and presence alone would match an older model), then drops
  the session entry. Mirrors upstream's `loadModelsFromStorage` move from local
  to global (CustomCompositeModel.java:99-102). `removeModel` therefore removes
  only the session entry for a name the open file defines, uncovering any
  stored model instead of destroying it.
- Storage reads go through one `readItem(storage, key)` helper in
  `web/src/io/subcircuits.ts`.

## Deriving a model from a selection

- External pins come from labeled nodes only (`getCircuitAsComposite`,
  SimulationManager.java:1567-1611). Select All then Create Subcircuit is the
  normal flow; no selection builds from the whole circuit.
- A pin's side comes from the label's own `dx`/`dy` (`labelSide`): W default,
  E when `|dx|>=|dy| && dx>0`, N when `|dx|<=|dy| && dy<0`, S when
  `|dx|<=|dy| && dy>0`. Side codes are ChipElm's 0 N, 1 S, 2 W, 3 E; W/E sort
  by y, N/S by x (EditCompositeModelDialog.java:97-111).
- `buildModelFromSelection` returns `{ model, unsupported, reason? }`; a kind
  outside `KIND_TO_CLASS` (which mirrors the engine's `child_kind`) refuses
  the build rather than emit a model missing parts.
- `SKIPPED_KINDS` is upstream's `extraList` exemption (SimulationManager.java:
  1622-1627): wire, labeledNode, ground, scope, decoration, box, line. Probe
  and output are real children.
- Internal labeled nodes (`LABELED_NODE_INTERNAL = 1`, LabeledNodeElm.java:
  31, 76) are not pins (upstream `lne.isInternal()` skip,
  SimulationManager.java:1575-1576). Without the check a ground-net internal
  node refuses the build.
- Ground is model node 0, claimed before the `nextNode = 1` walk; no
  `GroundElm` child is emitted.
- Refusals ported from upstream: a pin on the ground net (`Node "x" can't be
  connected to ground`), a pin net no child touches (`Node "x" is not used!`),
  and no pins at all (`Device has no external inputs/outputs!`). A second label
  on a net with a pin is skipped (first wins). The reason reaches the UI via
  the `subcircuitError` store field, worded by the pure
  `describeBuildFailure`.
- **Pin order matches upstream.** After side-major assembly, pins get a
  stable case-insensitive name sort (EditCompositeModelDialog.java:76-80), so a
  `410` referencing a model wires identically in both programs. Layout is
  carried by `pos`/`side`, and loaders take the line's pin order verbatim.

## Composite children

- `child_kind` (`engine/core/src/elements/composite.rs`) and `KIND_TO_CLASS`
  (`web/src/io/subcircuits.ts`) must stay in step. Upstream restricts nothing
  (`CompositeElm.loadComposite` builds any class).
- JFET/MOSFET polarity lives in flag bit 1 (`MOSFET_PNP`); `from_model` folds
  it into `params["pnp"]`, which jfet.rs and mosfet.rs read.
- **A closed switch inside a composite stamps a resistor.** Wire merging
  (`removable_wire`) runs only for top-level elements, so an in-composite
  switch gets `in_composite` (an `inComposite = 1` param from `from_model`) and
  stamps `COMPOSITE_CLOSED_R` (0.001), like SwitchElm.java:171-178, 219-229;
  `removable_wire` is `closed() && !in_composite`.
- `apply_dump` parses `f64` fields only: a named model token or a
  `true`/`false` token is skipped in order and the child keeps value-form
  defaults.
- Composite build errors from children propagate by name instead of silently
  shifting later children. Children with unparseable expressions are named
  build errors, not panics.

## Model resolution for `410`

- `parseCircuit` resolves a `410` only against the file's own `.` lines.
  `loadNetlist` then maps elements through `resolveCompositeModel` after
  registering the file's session models, so a `410` naming a storage-only model
  resolves at load like placement and paste. Session first, so the file's copy
  beats storage. A truncated `.` line whose name matches a stored model
  resolves from storage.
- A `410` serializes only its name (`e.text`), never `e.model`, so attaching a
  payload never moves `toNetlist()` output or the saved baseline.
- **Paste carries `.` lines.** `insertElementsFromText` appends the pasted
  `passthrough` and its `other` order entries (never header, element, scope or
  slider entries, which reference pre-re-id ids). Same-name `.` lines already in
  the document are removed first, so each name has one line. `copySelection`
  passes `modelLinesFor(s, selected)` so a copied `410` carries only the lines
  backing the selection; `duplicateSelection` carries nothing and relies on
  commit-time resolution. A cut-paste still stacks a duplicate line (delete
  never prunes model lines); harmless shadowing.

## Renaming a model

Renaming a subcircuit the open file introduced rewrites the file's `.` line,
matched on the parsed model body (`sameCompositeModel`), never on which half
of the library held it. A saved model whose body matches no line never edits
an unrelated file; a paste-introduced model is a library-only rename. Undo of
a rename in the saved-branch case is asymmetric: the document line reverts,
storage keeps the new name (storage is not transactional).

## Subcircuit Manager

- Rename rules are pure in `web/src/ui/subcircuitManager.ts`:
  `commitSubcircuitEdit` returns `'blank'` (row stays open with an error),
  `'unchanged'` (trimmed draft equals the name; closes without asking the
  library), `'renamed'` or `'missing'` (close and refresh). Named unions leave
  room for a `'taken'` collision outcome.
- The list is a plain `listModels()` call per render, with a `bump` reducer to
  force re-render after a delete or rename. The `bump()` in `remove()` is
  load-bearing: resetting `edit` to the same constant makes React bail out.

## Drill-in (Edit Model)

Port of CustomCompositeElm.java:234-238, 273-281. Engine untouched.

- `web/src/io/compositeDocument.ts`: `documentFromComposite(model)` lays child
  lines out one row each (ROW_SPACING 64), chains every post sharing a model
  node with wires, grounds node 0, and emits one `207` labeled node per pin,
  pointing so `labelSide` re-derives the side. `compositeFromDocument` runs
  the edited document through `buildModelFromSelection` (the create path) and
  keeps `previous.flags`. Enter then exit reproduces the model byte for byte
  except pin label positions; the port's child dumps carry no x/y.
- Store `subcircuitStack: { modelName, document, view, ... }[]`.
  `enterSubcircuit` refuses the default name ("Can't edit this model."),
  unresolvable names, and models containing a `410`. Stack snapshots travel
  on the entry; enter captures live state before loading the inner document
  with a clean undo history.
- `exitSubcircuit` re-extracts, matches the outer `.` line on parsed body,
  saves a library-only model through `saveModel` if no line matches, and on a
  real change produces exactly one outer undo entry, restoring view
  (`loadNetlist(..., { noCenter })`, RC_NO_CENTER). No change: plain restore.
- `lastSaved` must stay coherent across levels: Save As inside a drill-in
  baselines the outer document, not the inner sheet. Recovery inside a
  drill-in is refused. Loading, New and recover reset the stack.
- **Single level only.** Nested drill-in is refused up front: a parent names
  its child by reference, so a child edit would need writing back to wherever
  that child is defined, which the exit path does not traverse.
