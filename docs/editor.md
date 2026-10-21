# Editor and store

Editing behaviour, the zustand store, undo and geometry. Terminal coordinates must match upstream or loaded wires do not connect.

## Terminal geometry must match upstream

Grid size is 16 circuit units. Terminal coordinates must match upstream or
wires in loaded circuits do not connect.

- Op-amp default (size 2, `FLAG_SMALL` clear) has `opheight = 16`,
  `opwidth = 26`; the small variant is 8/13 (OpAmpElm.java:113-118, setPoints
  :127-133). Switch throw and transistor collector/emitter offsets are 16.
- `dsign(a, b)` in `web/src/render/draw.ts` is upstream's `sign`
  (`CircuitElm.java:335`): +1 for a part drawn right or down, -1 for left or
  up. Every multi-terminal post helper applies it before its own flag:
  `opampInputSign` = `opheight*dsign`, negated by `FLAG_SWAP`; the transistor
  offset is `OPEN_HS*dsign*pnp` with `FLAG_FLIP` negating `dsign`
  (`TransistorElm.java:218-220`). The SPDT is the exception: its throw offsets
  are absolute (`Switch2Elm.java:76-80`), and `switch2Posts` uses Java integer
  division for throw spacing.
- `interp` rounds with `floor(x + .48)` (`CircuitElm.java:404-405`), so an
  exact half rounds down, matching upstream's grid orientation.
- `potPosts` replicates `PotElm.setPoints` (PotElm.java:184-209): the far post
  snaps to the dominant axis (length rounded up to a `2*GRID_SIZE` multiple),
  the wiper offset comes from the perpendicular drag delta, and an axis-aligned
  pot gets the wiper 16 above the axis unless `FLAG_FLIP_OFFSET`. The file keeps
  the dragged `x2,y2` while the posts use the normalized endpoint.

## Revision versus paramRevision

`revision` (`web/src/state/store.ts`) is bumped only by topology mutators
(add, delete, move, scope, undo/redo) and turns into a full
`engine.setCircuit` in the frame loop. Value edits go through `paramRevision`
plus `pendingParams`/`pendingStates`, applied via the engine's `set_param` /
`set_state` fast paths that keep time and reactive state. A `set_param` that
returns false makes the frame loop fall back to a full reload.
`updateSettings` reloads only on `timeStep`.

Flag checkboxes (`FieldDef.flag`, a `type: 'bool'` field) go through
`updateElement` and bump `revision`: flags are read at build time and can
change the stamp or node count, which the re-stamp-only path cannot handle.

## Editing keeps the run going

**Owner decision (diverges from the port's earlier behaviour, matches
upstream).** A topology edit rebuilds the engine but continues the run:
upstream's `analyzeCircuit` never touches `t`; only Reset does.

- `CircuitSpec.preserve_run` (`engine/core/src/spec.rs`) means "this build
  continues the run". `set_circuit` keeps `ctx.time`, the adaptive working
  step (clamped to the new nominal), `good_iterations` and scope captures, and
  skips `solve_operating_point`, which would snap a charging capacitor back to
  bias. The DC gate still runs when `time == 0.0`, or a paused autoDC circuit
  shows 0 V after each edit.
- `build_scopes` reuses traces whose `ScopeSpec` is equal, consuming from the
  old list so duplicates each get their own.
- The frontend flag is `shouldInjectLiveState(builtDocument, document)`: a load
  or New bumps `document` and restarts; undo and redo continue.
- **Residual:** element state survives a rebuild only through file-format
  tokens (`state_tokens` / `seed_initial_voltages`: capacitor `voltDiff`,
  inductor `current`, transistor `lastVbe`/`lastVbc`). Lamp temperature, the
  trapezoidal `i_prev`, transmission-line and delay-buffer histories and
  sequential logic outputs restart. Fixing it means reusing element instances
  by `(id, kind)`.

## Live state and the save baseline

- `markSaved` records `toNetlist()`, the non-live document, never the live
  overlay, or F5 and autosave report every saved charged circuit as dirty.
- Autosave's clean check compares the non-live document while the recovery
  slot is written live (`writeNetlist`), so a clean circuit never clobbers the
  previous session's recovery. Inside a drill-in the recovery slot holds the
  outer document.
- A rebuild injects the engine's live charge only when a document counter
  (bumped by `loadNetlist` and `newCircuit`) says the engine still holds the
  same document. Undo keeps the charge.
- Read-back is event-driven (save and rebuild only); the per-frame loop must
  not grow per-element calls.

## Undo

- `Snapshot` carries `settings` and `view` (`web/src/state/types.ts`), like
  upstream's `UndoItem` (`UndoManager.java:36-45`).
- `commit` dedups against the top of the stack via a canonical `snapshotKey`
  (`UndoManager.java:50-53`). A no-change click adds nothing; a focus-only edit
  adds nothing, which makes `beginEdit` safe. On a dedup the redo stack is
  still cleared, as upstream's `pushUndo` does.
- `beginEdit()` is `commit()`: inputs commit on focus, range inputs on pointer
  down, so a typing run or slider drag is one undo entry.
- **Diverges from upstream (owner decision).** Switch toggles are undoable.
  Upstream's `doSwitch` (`MouseManager.java:314-326`) returns before the
  mouse-down `pushUndo`. Do not "fix" back.
- Undo bumps `revision` (engine reload) but not `document`, so the clock keeps
  running.
- Snapshots are un-aliased because `clone` copies every element and params
  object; the "does not alias the live state into the undo snapshot" test makes
  a future in-place mutator fail loudly.
- Arrow nudge is one undo step per press (`UIManager.java:1163`); the matcher
  emits a unit step and App resolves it through `gridSize(settings)`, so a
  small-grid circuit nudges by 8.

## Undo internals

- Snapshot fingerprints are cached in a `WeakMap<Snapshot, string>` at push;
  safe because snapshots are immutable after push and `clone()` keeps key
  order.
- Drill-in stack entries carry suspended undo/redo stacks. A no-edit exit
  restores both; an edited exit restores undo, appends the model-change
  baseline and clears redo (a stale future would let redo revert the model
  edit).
- Safari does not focus on some field changes: `changeArmsBaseline(cell, id)`
  arms and commits in one step, and a self-armed session dies when the element
  id changes.
- Pure app preferences are not rewound by undo.

## Gestures and document replacement

- `modalSurface(state)` (`web/src/input/modalSurface.ts`) is dialog, scope
  properties, element properties, device model editor, context menu or
  scroll-value popover; it gates keydown and keyup. The dispatcher lives in
  `web/src/input/appKeys.ts` with an `AppKeyHost` seam. Escape with a menu up
  closes only the menu (UIManager.java:1057). The scope menu stays ungated
  like upstream.
- A move drag freezes its ids at pointer-down after the press's select;
  right-click during a place or move does not reselect, and the frame paints
  from the frozen list (`paintedSelection`).
- `revertEpoch` is bumped by undo, redo, revertToBaseline, `loadNetlist` and
  `newCircuit`, and synchronously cancels any live gesture (place, move,
  dragpost, rowcol, scope drag, momentary holds). Refused loads bump nothing.
- Every document replacement (undo, redo, load, New, recover) must clear
  id-anchored transient UI: context menu, dialog, element properties, scope
  properties, scroll-value popover, slider element id, device model editor,
  hover id, undocked window, gestures. A stale id leaves an invisible modal
  that kills the keyboard. `deleteSelected`, `combineScopes` and friends clear
  the ids they remove.
- Run-mode mutations without an undo entry (keyboard throws, momentary
  releases, fuse unblow, settings) discard the redo future
  (`discardRedoFuture`), or a later redo silently rewinds them.
- Selection is intersected with surviving ids wherever elements are absorbed.

## Selection and post drag

**Diverges from upstream (owner decision).** Ctrl-click is additive selection;
upstream uses it to split a wire. Ctrl-drag moves a single endpoint: a
`dragpost` drag armed at pointer-down, using `nearestPost` (nearer stored
endpoint, midpoint ties go to post 1) and `postPatch` in
`web/src/render/geometry.ts`. Do not "fix" toward upstream.

`dragpost` snaps the endpoint to absolute grid coordinates; `move` snaps the
delta so a group keeps its spacing. A post drag that collapses an element to a
point is undone on pointer-up, not deleted mid-drag.

## Placement

**Diverges from upstream (owner decision 2026-08-20).** Upstream places by
drag only and keeps its in-flight part out of `elmList` (UIManager.java:
703-706). The port adopts the element at pointer-down and adds a click-place
ghost: an armed tool draws a half-alpha `makeGhostElement` at the snapped
cursor, Space turns it (`toolTurns`), a click drops it, the tool clears after
one placement, and the drag gesture is unchanged. The ghost follows
`hoverRef` (mouse and pen), never `pointerRef` (which the touch path writes),
and hides when editing is disabled.

A kind with no `defaultLength` uses `DEFAULT_PLACEMENT_LENGTH = 4` (64 px,
upstream's base `getDragLength`). See "Rotate axis" for why odd lengths cost a
shift per turn.

## Wire placement

`web/src/model/wirePlacement.ts`. No ghost and no element on press: the `wire`
Drag mode holds `start`, `current` and a latched `axis`; the frame loop draws
the pending run at `GHOST_ALPHA`; release calls `addWires`. `wireSegments`
returns 0, 1 or 2 never-diagonal segments; `wireDragAxis` latches on the first
move so the corner does not flip at the diagonal. `addWires` commits once and
splits only at the two outer ends (the corner is the gesture's own junction).

## Splitting on drop

- Upstream `MouseManager.endDrag` splits only when a post was dragged
  (`draggingPost >= 0`); a whole element or selection move never splits.
  `autoSplitAt(point, exceptId)` splits every wire whose interior holds the
  point, skips the dragged element, and pushes no undo entry (pointer-down
  committed the baseline).
- `autoSplitAt` also does the lead half of upstream's `splitAt`: an element
  with a lead stub under the point has that post pulled in and a new wire laid
  back (`movePoint` + `new WireElm`). `leadPostAt` (`web/src/render/geometry.ts`)
  reads the body extent from the def's `bodyRect`, built on the same
  `calcLeads` as the symbol. Refusals: diagonal parts, wires, parts whose posts
  are not their endpoints (transistor, op-amp, chips), and one-post parts whose
  `bodyRect` covers the span (a ground never splits; a rail's stem does).
- `finishPostDrag` and `finishPlacement` (`web/src/ui/canvas/pointerDown.ts`)
  run the collapse guard first, then split, and only where the endpoint is a
  real post (a rail or ground free end connects nothing). Placement splits at
  both ends (MouseManager.java:1276-1280).

## Wire crossing split

The interior split pass runs last in `addWires`, after endpoint splits
(MouseManager.java:1280-1283); one pass suffices. Post qualification is the
junction-dot scan minus the gesture's own wire ids, reproducing upstream's
`postDrawList` staleness (WireElm.java:266). A colinear two-wire joint counts
exactly 2, so a wire drawn through it stays whole. Any two-post element with
equal endpoints drops a parallel duplicate segment (WireElm.java:245-256).
`addWires` filters returned ids against survivors so no ghost selection ids
remain.

## Parts with more than two posts stay axis-aligned

Owner rule: every element with more than two connectable posts sits at 90
degrees. `axisConstrained(e)` in `web/src/model/registry/index.ts` is
`def.noDiagonal || postCountOf(e) > 2`; `dominantAxisSnap` constrains the
placement drag and `constrainPostDrag` the single-endpoint drag (upstream
`movePoint`, CircuitElm.java:661-666). Group moves stay pure translation like
upstream's `move`. **Diverges from upstream** for pot, SCR, triac,
three-phase motor and motor protection switch, which upstream leaves
unconstrained.

## Rotate pivot

**Diverges from upstream (owner decision 2026-10-02).** A settled quarter turn
turns every selected part about one `turnPivot` (`web/src/model/transform.ts`),
so a group is a rigid body and four turns return it exactly. The pivot is the
endpoint-box centre when the box's width and height (in grid squares) share
parity; otherwise it moves half a square along x (right when the odd side is
the width, left when it is the height), so the part toggles between two
neighbouring places instead of wandering. Upstream snaps its turn axis
(CommandManager.java:385-431), which keeps parts on the grid but walks them a
square per turn. A placement drag passes its press anchor as the pivot.
`turnPointAbout` accumulates turns exactly and rounds once.

Upstream rotate is flipXY then flipY, and the switch families override each
flip with a throw reversal, so a rigid turn needs no position compensation.

**Chip rotation is not post-rigid.** `chipFrame` re-anchors a chip at its
leftmost endpoint, so a quarter turn moves the local origin to the other end
and the pins do not land on their rotated positions even though the stored
endpoints turn correctly. The rigid-turn property test skips the chip family
for that reason. Making chips rigid needs the upstream flip bits plus an
anchor-preserving frame, a separate representation change.

## Rotate and mirror flag bookkeeping

Every transform must land each post on the turned or reflected position of
that same post; switch throws may trade places when the lever follows
(`switch2`, `dpdtSwitch`). `web/src/model/transform.ts` owns the per-kind side
bookkeeping in `rotateFlags` and `mirrorElement`. There are two shapes:

- A `dsign`-driven offset (transistor, MOSFET, opamp, JFET, darlington, OTA
  inputs, realistic op-amp rails) flips sign with a horizontal part's mirror
  and with a quarter turn from horizontal, so its bit toggles on a horizontal
  quarter turn and on a vertical mirror.
- An absolute offset (`scr`/`triac` gate, `crossSwitch` fan, OTA bias pin,
  wattmeter and transmission line side, potentiometer wiper) has no axis sign
  to compensate, so its bit toggles on every horizontal mirror; a rotation
  leaves it alone unless the kind's own `ds`/`dir` formula changes (the
  wattmeter and transmission line toggle on a vertical pre-turn).

The op-amp `FLAG_SWAP` and transistor "Swap E/C" are the same bit 1. The plain
op-amp toggles it once on a horizontal rotate (twice, net zero, on a vertical
one) and only on a vertical mirror. The realistic op-amp keeps the user's
"Swap Inputs" choice and carries the rail side in `OPAMPREAL_BODY_FLIP`
instead, so a turn never rewrites the checkbox. Draw functions share the
offset helpers so leads and labels follow.

Several kinds upstream never turns or mirrors (`threePhaseMotor`,
`motorProtectionSwitch`, `ota`, `wattmeter`, `transmissionLine`) because its
`canFlipX`/`canFlipY` gates refuse them; the darlington refuses only flipY
(`DarlingtonElm.java:161`), which upstream also uses to disable rotate. The
port allows the commands on every part with at least two draggable posts, so
those kinds carry port-only side bits in the common flags word
(`MOTOR_PHASE_FLIP`,
`MPS_ORIENT_MASK`, `DARLINGTON_FLIP`, `OTA_HS_FLIP`, `OTA_ABS_FLIP`,
`OPAMPREAL_BODY_FLIP`, `SCR_FLIP`, `TRIAC_FLIP`, `CROSS_SWITCH_FLIP`,
`TRANSMISSION_LINE_FLIP`, `WATTMETER_FLIP`; `MOSFET_FLIP` doubles as the JFET
side on bit 8). **Diverges from upstream** in the file, not the format: the
bits are ordinary flags tokens upstream reads and writes but ignores. A
rotated or mirrored part saved by the port therefore loads upstream with its
old absolute geometry, so the port's own transform results are not portable
back. A freshly loaded unrotated part has state 0 and keeps upstream's exact
coordinates.

For the darlington, the port deliberately offers Mirror Vertically even though
upstream's `canFlipY` returns false; `DARLINGTON_FLIP` carries the collector
and emitter side through it. The JFET is the other side of the same call:
upstream allows the transform but its `hasSwapDS` false makes the result
non-rigid, so the port uses the same bit it otherwise reads as FLAG_FLIP.

The motor protection switch needs a full dihedral state rather than one side
bit: its body always extends in fixed local +x/+y directions, so
`MPS_ORIENT_MASK` stores two quarter-turn bits and a mirror bit. Transform
composition follows `R D = R^(r+1) M^m` and `M D = R^-r M^(m+1)`.

The custom transformer's frame follows the stored axis instead of forcing
`point2.y = point1.y`, which is what lets a quarter turn keep its node columns
rigid. Horizontal and legacy diagonal parts keep the old geometry; vertical
parts use the turned frame.

## Group mirror

Mirror reflects every selected part across one axis: the endpoint-box centre,
truncated like Java's division (CommandManager.java:408-417; centres
:385-405). Rounding instead would drift odd-span selections by a square. A
post-only annotation's stray second point is ignored for the box. Vertical
mirror (`mirrorElementVertical`) has its own centre.

`groupMirrorable` admits a multi-post part only when `canMirror` is true. The
SCR, triac, cross switch, motor protection switch, transmission line,
wattmeter, OTA and both analog switches gained rigid flip bookkeeping, so they
now join groups; gates, the MBB switch and the three-phase motor still refuse
the whole selection, because a bare reflection would move their hanging posts
to the wrong side.

## Mirroring chips

Mirroring is enabled for chip-pin kinds, optocoupler, customComposite and the
four controlled sources, byte-exact with upstream `ChipElm.flipX` including
the group anchor shift (`chipExtentsOf` is the one span source). Vertical
chips and four upstream-unmirrorable kinds refuse. Text has no anchor post
(a phantom post caused junction dots and floating warnings on bare
annotations); FLAG_BAR is modelled and multiline text follows TextElm.split.

## Click boxes for switches

**Diverges from upstream (owner decision, form only).** Switch and SPDT toggle
boxes (`switchRect`) are derived from the drawn geometry (both lever states,
the full throw fan) and grown by `CONTACT_STROKE_WIDTH` on each side. The SPDT
box is position-independent, so a centre-off switch toggles from anywhere in
the fan. The cross switch box is `rectOfPoints` over both poles' leads and all
lever tips, which also covers the IEC symbol's tips at fraction 1.2
(CrossSwitchElm.java:78).

## Canvas gestures

Alt row/column chords respect the editing-disabled gate; chorded mouse
buttons do not disrupt an armed drag; momentary holds record their button.

## Scroll-value popover

The wheel value session is store state (`scrollValuePopover`), so
`modalSurface` sees it. Space reverts, Enter commits, Escape commits
(**diverges** from upstream's revert), and an untouched revert writes
nothing.

## Editing disabled

`editable` (upstream `noEditing`, UIManager.java:116) is a UI gate, no
revision bump. The run-mode switch toggle is hoisted above the gate so a switch
still throws (upstream's doSwitch runs before its read-only forcing,
MouseManager.java:1101). Select, place, move, post drag and rubber band are
blocked; pan and wheel zoom stay live; the wheel value stepper falls through
to zoom; the key handler drops `EDIT_ACTIONS` with "Editing disabled.
Re-enable from the Options menu."

## Zoom and view

`web/src/state/view.ts` holds `zoomAbout`, `ZOOM_FACTOR = 1.12` and the wheel
clamp `[0.15, 6]`; the wheel and the `zoomIn`/`zoomOut`/`zoomReset` actions
share it. `viewSize` is a store field kept by CircuitCanvas through a
`ResizeObserver`, absent from the undo `Snapshot`. `circuitBounds` uses stored
endpoints, not `posts()`; `fitView` shares the 140/100 margins with
`exportGeometry` through `CENTER_MARGIN_W/H`.

## Crosshair

`pointerRef` holds a canvas-relative client point; the frame loop re-projects
it through the current view each frame, so keyboard zoom keeps the guides
under the cursor.

## FieldDef mechanisms

`web/src/model/types.ts`, `web/src/ui/elementFields.ts`:

- `visible?(e)`: conditional rows; `fieldRows` filters on it.
- `get?(e)` / `apply?(e, v)`: derived rows whose value is not a stored param.
  `apply` mutates a draft clone and `applyFieldChange` diffs it against stored
  params, dispatching one `setParam` per change inside the edit session (one
  undo entry). Derived views only; plain rows keep the default binding.
- `label` may be `(e) => string`, resolved by `fieldLabel(e, f)`.
  `resolveParam` skips function labels.
- `adjustableFields` excludes derived and `contents` rows: a slider there
  would write a phantom param.
- `type: 'contents'`, `'download'`, `'file'`, `'modelChoice'` bind no scalar
  param; the registry "binds every field" test skips them.

## Integer fields

`FieldDef.integer` renders a spinner instead of a slider, and `setParam` runs
any integer field through `clampInteger` (`web/src/ui/elementFields.ts`) so a
slider can never write a fraction into a saved token. `BITS_NORMALIZERS`
entries win where an engine needs a specific truncate and range.

## Reset to defaults

`resetSettings()` restores only `RESETTABLE_SETTINGS` (the Other Options
keys) through `updateSettings`; `editable`, `mouseWheelEdit`,
`euroResistors`, `euroGates`, `showHitboxes` and `iterCount` are not reset.
`resetScopeToDefaults(id)` rebuilds through `makeScope`, keeping plot
identity; one undo entry.

## Create Test Harness

`CHIP_PINS` is exactly upstream's ChipElm subclass set reachable from port
kinds. VCCSElm extends ChipElm and the other controlled sources extend it,
but they stay out on purpose; ROM extends SRAM; DelayBufferElm is not a chip.
Upstream ships TestCreator disabled with its body commented out; the port
treats the algorithm as the spec. Wide pins get a BusLogicInput (inputs) or a
show-bus-value wire (outputs), like TestCreator's width rule.
