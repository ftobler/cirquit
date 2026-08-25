# Overview and porting roadmap

A port of [CircuitJS1](https://github.com/pfalstad/circuitjs1) (GWT/Java) to
React + TypeScript with a Rust/WebAssembly simulation engine.

This document is the coordination point for the port: it explains how the
pieces fit together, records decisions that are easy to get wrong, and tracks
what is left. The work is far too large for one sitting, so **treat the
checklists below as the shared source of truth** and tick items off as they
land.

---

## 1. Architecture

```
┌─────────────────────────── web/ (TypeScript + React) ────────────────────────┐
│  ui/         menubar, toolbox, options panel, scopes, canvas + mouse editing │
│  model/      element registry: geometry, symbols, editable fields            │
│  io/         netlist parse/serialise, ctz URL sharing, circuit library       │
│  state/      zustand store: elements, selection, view, undo                  │
│  engine/     thin facade over the wasm module                                │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    │  one engine call batch per animation frame
                                    │  JSON in (on change), typed arrays out
┌───────────────────────────────────▼─────── engine/ (Rust → wasm) ────────────┐
│  circuit.rs  node analysis, timestep loop, Newton-Raphson                    │
│  matrix.rs   dense and sparse LU backends, cached factors                   │
│  stamp.rs    MNA stamping helpers and sign conventions                       │
│  elements/   device models                                                   │
│  scope.rs    per-timestep waveform capture                                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Why the split is where it is

The entire simulation — element models, matrix assembly, Newton iteration —
lives in Rust. Only rendering, editing and file handling are in TypeScript.

That matters for performance. A frame advances 160 timesteps by default, and
each timestep visits every element at least once. Had the element models stayed
in JavaScript, a 200-element circuit would mean ~32,000 boundary crossings per
frame. As it is the frame loop crosses the boundary about 8 times: `run`, then
the flat-array getters for node voltages, element currents and the rest. Each
crossing is one flat typed array, never one call per element model, which is
why the whole frame stays cheap.

The cost is that each element type is defined in two places: a simulation model
in Rust and a drawing/geometry definition in TypeScript, joined by a shared
`kind` string. That duplication is deliberate and is the main thing to
understand before adding elements.

### Data flow

1. The user edits; the store bumps `revision`.
2. On the next frame the canvas notices and calls `SimEngine.setCircuit`,
   serialising elements as `{kind, posts: [[x,y],…], params, flags}`.
3. Rust merges terminals that share coordinates into nodes, allocates
   voltage-source unknowns, sizes the matrix and runs the constant stamp pass.
4. Each frame: `run(stepsPerFrame)`, then read back node voltages, per-element
   currents and voltages, and scope columns.
5. The renderer colours each terminal by its node voltage and animates current
   dots from the per-element current.

**Geometry never crosses the boundary.** The engine knows only that two
terminals share a coordinate, never what an element looks like.

---

## 2. Conventions that are easy to get wrong

**Node numbering.** Node `0` is the reference and gets no matrix row. Node `k`
owns row `k-1`; voltage-source unknown `j` owns row `nodeCount-1+j`.

**Sign convention.** A node row reads *currents leaving the node through
elements = currents injected by sources*. `voltage_source(n1, n2, k, v)`
constrains `V(n2) − V(n1) = v`, and its current unknown is positive flowing
`n1 → n2` inside the source. For two-terminal elements, positive current enters
post 0 and leaves post 1 — the same convention throughout.

**Ground.** Ground symbols are resolved during analysis by remapping their
component onto node 0, rather than by stamping a 0 V source per symbol. This
lets any number of ground symbols share a node without producing duplicate,
singular constraint rows. Current *through* a ground symbol is not a matrix
unknown; a post-solve KCL pass (`recover_ground_currents`) sums every
non-ground element's current into the ground's post coordinate and splits the
net evenly among the symbols sharing it. That recovered current is reported
like any element's: it animates the current dots on the stem, shows in the
options readout, and can be scoped. The KCL recovery was kept rather than a
"single shared 0 V source per coordinate" because all ground terminals already
merge onto node 0, so a per-coordinate source would tie the already-merged
node to itself and add a degenerate matrix row for no information, and
upstream recovers ground current the same way, via `calcWireCurrents`.

**Floating subcircuits** get a 10 nS conductance to ground per node, with a
warning, rather than an error. Ungrounded circuits pick the first node as the
reference and warn.

**When to `stamp` vs `do_step`.** `stamp` runs once and holds everything
constant for the whole run; the result is snapshotted. `do_step` runs on every
Newton iteration and contributes what changes. Getting this wrong is the usual
cause of a "linear circuit refactors every step" performance bug: for a linear
circuit only the right-hand side is restored between steps and the LU factors
are reused.

**Time-varying sources** stamp their topology in `stamp` with a zero value and
supply the value in `do_step` via `voltage_source_value`, which touches only the
right-hand side. That is why an AC-driven linear circuit still factors once.

**Switches and unknowns.** A closed switch is an ideal short like a wire, so
the analyser merges its terminals and the matrix never sees it. Toggling one
re-merges or un-merges terminals via `reanalyze` rather than reallocating a
current unknown; only the SPDT switch keeps a current unknown, in both
positions.

---

## 3. Adding an element

The repeatable unit of work. Roughly:

1. **Model** — add a struct in `engine/core/src/elements/` implementing
   `Element`. Two-terminal linear parts are ~40 lines; nonlinear parts need
   `nonlinear() -> true`, junction limiting and a convergence check.
2. **Register** — add the `kind` to `KINDS` and `build_element` in
   `engine/core/src/elements/mod.rs`.
3. **Test** — add a case to one of the topic files in
   `engine/core/tests/` asserting against a known analytic result. This is the
   part that catches sign errors; do not skip it.
4. **Draw** — add an `ElementDef` to `web/src/model/registry.ts`: `dumpCode`
   (from the table in section 6), `posts()`, `draw()`, `fields`, and
   `parse`/`dump` matching the file format's field order.

Terminal coordinates from `posts()` must match upstream exactly, or wires in
loaded circuits will not connect. Check the upstream `setPoints()` and
`getPost()` for the type in `reference/circuitjs1` (run `just reference` to
fetch it).

---

## 4. Current status

### Working

- MNA solver: dense LU with partial pivoting and row scaling, cached
  factorisation, singularity detection. Closures of 150 rows or more route to
  the sparse left-looking LU (column partial pivoting, monotone pair set,
  minimum-degree column ordering) automatically, matching upstream's
  `solverType` threshold.
- Constant-row elimination for nonlinear dense closures: rows `do_step` never
  rewrites are factored once per build and each Newton iteration solves a
  small reduced system instead of refactoring the whole matrix (see
  `engine/core/src/simplified.rs`). A nonlinear element buried in a large
  passive network is the win case; fallback guards keep it bit-exact with the
  unsimplified path.
- Newton-Raphson with junction limiting and per-element convergence reporting.
- DC operating point before transient, with reactive elements switched to their
  steady-state stamps.
- Trapezoidal and backward-Euler companion models for reactive elements.
- Per-timestep scope capture with min/max column aggregation.
- Canvas renderer: voltage colouring, animated current dots, pan/zoom, grid.
- Editing: place, select, rubber-band, drag, delete, undo/redo, live parameter
  edits, interactive switches. A dropped or placed terminal splits what it
  lands on, wires and bare component leads alike, and the posts that only touch
  another element are drawn red and tallied in the info area. The wire tool has
  its own placement rule (`model/wirePlacement.ts`): no pre-press ghost, and a
  drag inserts 0, 1 or 2 wires, never a diagonal one, with the corner of the L
  on whichever axis the drag first moved along.
- File format: read and write the original `.txt`, `ctz`/`cct` URL sharing,
  and the bundled 373-circuit library.
- Adaptive timestep: halve-and-retry with step rejection on a non-convergent
  step, and step doubling back up after easy ones, off by default like
  upstream's `adjustTimeStep` (header flag bit 64 turns it on).
- Live operating-point state crossing back out of the engine: capacitor
  `voltDiff` and series resistance, inductor current, junction voltages, relay
  and logic-latch state. Event-driven (save and rebuild only), so it adds no
  per-frame crossing.
- Multi-bit buses, matching upstream's model: a wire whose width exceeds one
  carries N independent signals on N node pairs (`w` lines take an optional
  trailing width token; widths also propagate from wide pins through wire
  chains at build time, upstream's `detectBusWidths`), terminals merge by
  coordinate *and* bit index (upstream's `Point.z`), the bus splitter really
  fans out (its bit pairs merge like wires, one pair per bit, with per-bit
  currents recovered for the dots), and the two remaining XML-only classes
  exist as engine elements: the bus logic input (dump 435) and the bus
  transceiver (437). The instruction display presents its pins the way
  upstream does now, all N on one coordinate tagged per bit. Labeled nodes
  take part too: each resolves to the widest width claimed by its coordinate
  or any same-named label and presents one post per bit at its anchor, so a
  label joins whole buses instead of only bit 0, while a narrow label named A
  stays a different net from a wide one (upstream's two closure-key forms,
  LabeledNodeElm.java:99, :137-140); width disagreements surface as red
  bad-connection dots through the same list upstream folds its
  `busMismatchList` into. The corpus alu74181 simulates again; see the XML
  circuits bullet for what still waits.
- Bus-mode chips (upstream's BIT_ORDER_BUS, ChipElm.java:37): counter2,
  fullAdder, SRAM and ROM accept the collapsed pin layout under which each
  makeBitPins group shares one coordinate and its pins carry per-post bit
  tags, shrinking a 4-bit counter to 4 rows instead of 7 and the td4 ROM to 2
  instead of 9. Upstream carries the state only as the XML attribute
  `bo="2"`, which has no text-format home, so the port parks it in a free
  chip flag bit (`CHIP_BIT_ORDER_BUS`, engine `FLAG_BIT_ORDER_BUS`, 1 << 14)
  that round-trips with the rest of the word; the converter sets it, and
  wide-pin seeding treats the collapsed banks exactly like a splitter's bus
  side when re-deriving wire widths. The td4 corpus family simulates again;
  see the XML circuits bullet.
- Undocked scope window: the port's own interpretation of the element context
  menu's View in New Undocked Scope row. Upstream's identically named command
  drops a floating scope element onto the schematic near the clicked element
  (its separate-window command is File > New Window); this port instead opens
  a `scopewin.html` popup (a second Vite entry) that mirrors a freshly created
  scope as a pure display client. The engine stays in the main window; each
  frame copies the trace snapshots it already read back into one postMessage
  carrying the samples and the full draw state, so properties-dialog edits
  reach the child on the next frame and both windows draw through the same
  `drawScope`. One window at a time; Escape closes it, an actual reload of the
  main window closes it, and a window whose scope disappears under it (remove,
  undo, load) closes itself.
- Custom X-Y axes and per-element value plots: a scope's X-Y locus takes any
  two of its plots as the axes (plus brightness and R/G/B colour modulators,
  ScopePlot2d.java:22-28), chosen in the X-Y Plots fieldset of the scope
  properties dialog; the pair itself is session-only, since the text `o` line
  carries no axis indexes (only upstream's XML format does). A transistor
  scope can plot Ib, Ic, Ie, Vbe, Vbc and Vce plus the Vce-vs-Ic 2D trace and
  a lamp its hot resistance: the engine answers a `scope_value` hook per
  sample (`element.rs`, transistor.rs, lamp.rs) inside the existing scope
  capture, so no new boundary crossing exists. The parser maps those tokens to
   real values instead of null plots (a token outside an element's table still
   rides raw only), and early.txt's Vce-vs-Ic X-Y panels draw again.
- Review-pass batch 2026-08-23: a settled-selection rotate is upstream's
  flipXY-then-flipY, and both switch overrides reverse their position, so the
  turn nets zero and no longer flips an SPDT throw or a DPDT bank; a mirror
  keeps its single reversal. A momentary linked SPDT now returns to rest on
  release like a push switch, fanning the second toggle across the gang. The
  combined relay honours FLAG_PULLDOWN: constant r_off resistors from both
  throw posts to ground while the pole-to-unselected-throw link drops in the
  settled positions, matching RelayElm.java; every bundled relay carries the
  bit. Two load guards landed: a lone trailing mux token can never be mistaken
  for the bus/bus input-mode pair, and the battery SOC table sorts at parse so
  the caption interpolates what the engine stamps; with that came the real fix
  that the table string carrier reaches spec.model unquoted, so batteries
  simulate their chemistry instead of the flat fallback. The drill-in round
  trip keeps one outer-document baseline (Save As inside no longer baselines
  the inner sheet), restores session device models, tombstones and imported
  samples on exit, and recovery writes the stack-root document while stacked.
  The info box draws the full nine-row transistor table through a new
  on-demand elementScopeValues readback (the transmissionLineWave precedent:
  only the hovered element pays), with upstream's signed current/voltage rows,
  the operating-mode thresholds, and getPower fixed on the flat array from
  Vbc*Ic to upstream's (Vb-Ve)*Ib + (Vc-Ve)*Ic; source/rail and diode-family
  tables print signed too, and the undocked popup computes its lines only
  when Show Extended Info is on. A follow-up strip of review nits landed the
  same day: momentary holds on the pointer path now cover the make-before-break,
  DPDT and crossover switches (every kind whose parse reads the momentary
  token), the darlington reports upstream's composite getPower instead of the
  trait default, a   push switch joined the toolbox resting open through a new
  optional rest-state field on toolbox entries, and the stale XML note in the
  examples docs matches what parseCircuit actually does. The Find DC Operating
  Point command landed on top: File menu row between Create Subcircuit and
  Recover Auto-Save, engine `find_dc_operating_point` wrapping a reset under a
  temporarily-true autoDC option, wasm and facade crossings carrying found /
  degraded / singular distinctly (upstream surfaces the same three outcomes as
  stop messages), with four Rust tests in the new dc_command.rs file and seven
   TypeScript ones across the facade and menu-row suites.
- Owner-bug batch 2026-08-23b: a mid-discharge save now carries the battery's
  running charge (the dump prefers overlayLiveState's `soc` token over the
  configured initialSoc, an over-discharged negative percent seeds the live
  route while the config slot stays clamped, and committing Initial SOC moves
  the live state too); three engine-hygiene fixes (a rejected set_circuit
  build commits nothing, so the previous circuit keeps solving; reset and
  reanalyze own their warnings, so switch throws no longer grow the vector;
  the adaptive timestep attempts every halved step down to the floor,
  upstream's halve-first rule, with the stale budget comment made honest);
  the junction-dot scan collapses each chip bus bank to one counted post per
  element, so a labeled node anchored on a bank no longer paints a permanent
  grey dot on its origin (and an untouched bank covered without connecting is
  now eligible for the red lonely-post dot); and embedded 403 scope windows
  decode their config token, register real engine traces and draw live
  waveforms inside their frame, so multivib-a's four windows and qam-256's
  X-Y window render instead of placeholder frames while the raw token stays
  byte-for-byte.
- Review batch 2026-08-24: entering and leaving a subcircuit keeps the outer
  undo history and the live reactive charge (stack snapshots travel on the
  stack entry, the entry document is captured live, a clean look-and-return
  comes home reading clean, redo futures restore verbatim on a no-edit exit
  and die on an edited one); multi-select rotate and mirror turn about one
  shared bounding-box pivot exactly as upstream's prepareFlip walk does, so
  selections no longer collapse onto themselves while single-element turns
  keep their grid-snapped axis; and element lines whose coordinate or flags
  tokens do not parse are skipped verbatim like upstream's per-line catch
  instead of loading at coordinate zero (fractional, exponent and hex
  coordinate forms stay a deliberate accommodation), with the undocked
   popup's message listener also checking the sender origin.
- Scout batch 2026-08-24b: a wire drawn across an existing junction post
  splits and connects there like upstream's draggingDone (sub-segments
  duplicating an existing part are dropped, plain colinear seams stay whole,
  one undo entry per gesture, the first piece keeps the drawn id); SRAM
  gained upstream's Load File button, bytes masked to the configured data
  width on load, and hex-mode `0b` tokens parse as the numbers they are;
  element-placement keys are rebindable in Edit Shortcuts with the default
  table behaviourally unchanged; and File > Toggle Full Screen landed,
   re-fitting the circuit when the fullscreen transition actually lands.
- Interaction-audit batch 2026-08-24: every modal surface owns the keyboard
  through one shared predicate (the device-model editor and context menu no
  longer leak Delete, undo and placement letters to the circuit behind them,
  and one Escape closes only the open menu); touch long-press, two-finger
  abandon and pointercancel clean up armed placements and wire tools instead
  of stranding zero-length parts; Remove Plot removes the clicked plot by
  identity while protecting raw-only plots that exist only to preserve `o`
  line tokens, and Show Value checkboxes became their own undo step; and a
  right-click during a group drag can no longer hijack it (move drags freeze
  their id list and the frame paints from it).
- Fidelity batch 2026-08-24b: the diode family's junction gmin tracks
  leakage*0.01 like upstream below the ramp start (transistors keep their
  hardcoded floor), unijunction and LED-array junctions included, with the
  Newton-cancellation consequence documented: converged well-posed results
  are gmin-invariant either way, the divergence lives in stamped conductance
  and iteration behaviour, where the bridge-startup limit cycle no longer
  forms; MOSFETs and JFETs share upstream's convergence ladder (beta>1 x100,
  relative pass past ten iterations, loosening past one hundred); the wheel
  value popover owns the keyboard through the shared modal predicate, Space
  reverts and Enter commits, and an untouched session reverts without
  writing; fresh parts place upstream constructor defaults (1 H inductor,
  60 Hz sources) while tokenless loaded v/R lines keep the file-constructor
  40 Hz seed, and AC voltage/rail toolbox entries carry the 120 V rms sine
  presets.
- Scout-leftover batch 2026-08-24c: digital chips whose clock/load edge
  memory is private state (latch, SIPO shift, PISO shift, sequence
  generator) keep it across Reset like upstream's ChipElm.reset, so a clock
  or load pin held high through Reset no longer re-triggers a load or
  shift; DFF/JK/T/counters still clear their lastClock, and the port's
  deliberately broader saved-state load deferral (every chip skips its
  first execute when any voltage{i} token exists, where upstream arms the
  skip in exactly three kinds) is documented in chip.rs with a counter
  that reloads 9 through an active-low reset pin; the OTA restores its
  supply voltages from the first two composite child-dump tokens on load,
  where upstream reads them off the loaded rail children (OTAElm.java), so
  a +15/-15 part no longer silently clips at +/-9 V after a reload: the
  parse is finite-guarded with defaults on short lists, supply edits reach
  the file, save re-derives only the two rail slots and carries the
  sixteen transistor tokens verbatim; and the XML converter maps the five
  remaining plain chip tags (dmux 185, ctr 164, T flip-flop 193, JK
  flip-flop 156, latch 168) consuming exactly the attributes upstream
  writes for those classes, with anything beyond staying a trace comment,
  so future upstream XML circuits containing them convert losslessly.
- Scout batch 2026-08-24d: six findings from four parallel scouts, each
  implemented on its own worktree branch and reviewed by an independent agent
  before landing. The triac, SCR and diac keep their latch state through Reset
  like upstream's base reset (the port's shared Base::reset zeroes more than
  upstream's, so the diac preserves its element current around it). Elements
  gained a channel to halt the run with a message
  (`Stamper::request_stop` + `StepError::Stopped`, bypassing halve-and-retry),
  used by the transmission line for upstream's "delay too large" stop; its
  delay ring also truncates instead of rounding, matching upstream's `(int)`
  cast. The XML converter re-admits the live `ssd` tag to BO_TAGS (4bd3cbe had
  dropped the live form along with the dead ones), seeds missing `fr` at the
  fresh-constructor 60 Hz, and defaults `<ctr>`'s missing `in` to active-high.
  Scope overlays hide RMS/Average/Duty when span is zero like upstream's
  guards, degrade RMS to Average off the voltage/current unit families, gate
  zero relocation and gridline visibility on allPlotsSameUnits, derive the Max
  Scale `/div` from the drawn span, and truncate duty cycle. Undo/redo clears
  elementGesture beside scopeGesture, entry-free run-mode mutations (keyboard
  switch throws, momentary releases, fuse unblow, settings edits) truncate the
  stale redo future via one shared action, and an undo under a scope plot drag
  cancels the drag so one gesture stays one entry. The engine clears every
  scope capture when the effective timestep changes (upstream's resetGraphs on
  maxTimeStep change) and preserves samples across a columns-only resize like
  upstream's index-mapped copy.
- Review-pass batch 2026-08-24e: seven fixes from the parallel session's
  review lanes, each worktree-implemented and independently reviewed. Keyboard:
  denied-storage no longer crashes app boot (every defaultStorage lookup is
  guarded, five modules), a stale scopeProperties id can no longer leave an
  invisible modal gate (cleared on remove/load/new/undo/redo/delete), open
  menubar dropdowns own the keyboard via a store flag in ModalSurfaces,
  Disable Editing refusals consume the key so the page stops scrolling, and
  momentary holds release through text-field keyup, gated surfaces and window
  blur. Elements: opampReal FLAG_SWAP keeps rails and triangle fixed like
  upstream's hsswap split (mirror no longer toggles the bit), and text became
  a true zero-post annotation with FLAG_BAR and per-line drawing ported from
  TextElm. Sources: phase edits in degrees and duty cycle in percent with
  file bytes unchanged. Scopes: valid_data_count counts to the newest written
  column (stale pre-trigger pixels after triggers gone), memristor and
  ohmmeter resistance plots decode, walk and regenerate correctly with real
  engine values behind them, showScale gates the H=/V= row, manual headers sit
  beside their bullets and wrap. XML: nine more tags convert to real lines
  (Timer, Comparator, OTA incl. child vbe/vbc splice, OpAmpReal, DAC,
  AnalogMux, DelayBuffer, both analog switches). Undo: collapse reverts no
  longer stage the refused element into redo, mirror/swap/delete fold into an
  in-flight gesture like rotate, setKeyShortcut truncates the stale future,
  and the model-outside-undo comment now records the deliberate divergence.
  Engine: zero-resistance resistor/fuse/lamp specs are rejected at build
  naming the element (build_element returns Result), the capacitor-voltage
  walk is iterative so deep chains cannot overflow the wasm stack, and refused
  non-finite or non-positive stamps are surfaced through a tally plus a new
  StepError::BadStamp instead of silently vanishing.
- Review-pass batch 2026-08-24f: five more fixes from the review lanes. Loads:
  a malformed circuit now routes into the problem banner from every entry
  path, the startup share link falls back to the starter with a status
  message instead of the engine-fatal page. Editing: repeated pastes fan out
  right-or-below from the circuit bounds like upstream's bbox rule and the
  internal clipboard persists across reloads; undo no longer arms a false
  unsaved-changes after an edited drill-in exit on a charged circuit, the
  session subcircuit library follows a changed body under the same name, and
  app preferences survive undo while header-borne keys still rewind. Canvas:
  fractional DPR no longer reallocates the backing store every frame, read-only
  circuits ignore the row/column chords, chorded mouse buttons leave armed
  drags alone. Relay: legacy short `178` lines seed upstream's old-constructor
  defaults and run the faithful old model when switchingTime is zero.
  Keyboard: crossover switch and logic input honour their shortcuts through one
  shared kind set, modifier/junk keys are refused, F-keys survive reloads, IME
  Enter no longer commits dialogs early, placement-char collisions warn.
  Scopes: regenerating an edited scope line preserves plot tokens it cannot
  interpret, mixed-element scopes hide the per-element rows like upstream's
  shared-element rule, deleted embedded X-Y windows free their canvases.
- 563 Rust tests, of which 451 are the end-to-end circuit checks across
  `engine/core/tests/` (the old monolithic `circuits.rs` was split into topic
  files), plus 77 in-module unit tests and one doctest.
  2984 TypeScript tests (one corpus report test skipped); the owner-bug batch
  added four of the Rust tests (the new analysis_hygiene.rs) and thirty-eight
  TypeScript ones across the battery, junction, embedded-scope and facade
  suites. The relay pulldown
  parity fix added three Rust tests: the flag grounds an unwired throw in
  either settled position, a flag-clear guard keeps the old pole coupling,
  and the mid-travel position stamps identically with and without the flag.
  The bus-label-width
  branch added 14 of them, all plain additions over its base: 11 in
  busWidths.test.ts, one each in junction.test.ts, infoBoxLines.test.ts and
  registry.test.ts. The op-amp LM324 work added seven Rust tests (the two
  composite VCVS/VCCS child checks, the composite named-model resolution, the
  LM324 and 324v2 analytic tests, the 741-dispatch regression guard and the
  default-limit inverting amp) and three TypeScript ones (the 324/324v2
  round-trip, the two-way Model choice and the conditional-field row hiding).
  The device-model editor added 32 more TypeScript tests across the new
  deviceModels, parse, store.model-editor and elementFields suites, the
  SRAM/ROM contents editor added 34 more across its codec, store and
  elementFields suites, and the battery element added six Rust tests and
  nineteen TypeScript ones (round-trip, presets, caption flags, the XML
  converter mapping). The voltage-source time-spec feature added 30 more
  TypeScript tests: the per-waveform voltage and rail row sets, the High/Low
  Time swap and its commit/guard semantics, the Specify As flag toggle, the
  synthetic visible/get/apply/label mechanism tests, the FLAG_TIME_SPEC
  round-trip, the flag-gated voltage and rail captions, and the updated
  slider index and registry metadata checks. The SPDT group-linking feature
  added 20 more TypeScript tests across the transform, store, canvas
  pointer-down, load and elementFields suites, and the logic-input edit-fields
  feature added 7 more across the registry, store and pointer-down suites, and
  the subcircuit drill-in feature added 25 more across the compositeDocument
  and store.subcircuit suites (single-level model editing, the context-stack
  undo/reset, and the nested-subcircuit deferral), and the scope Show Extended
  Info feature added 11 more across the infoBox, scope draw and undocked suites
  (the shared infoLines table, the header loop and the protocol swap), and the
  bus/bus multiplexer feature added seven Rust and seven TypeScript tests
  (group routing, strobe, the inverted bus, the value integer, the mode-0
  negative control, the pin table and round-trips). The drill-in document
  integrity fixes added seven more store.subcircuit tests (the lastSaved round
  trips in both dirty directions, the Save As guard that keeps the baseline off
  the inner sheet, the surviving session device model and imported samples, and
   the stacked recovery payload). The 2026-08-23 review-pass batch added the
   rotate/mirror and momentary-hold switch tests, the mux width-token and
   battery table-sort cases, three Rust relay tests already counted above, the
   transistor info-table suite (analytic Ib/Ic, the declared-order readback
   walk, upstream's getPower on the flat array, plus the infoBox and undocked
   gating cases), and the seven drill-in integrity tests just named.
   CI runs fmt, clippy, tests, typecheck, lint and build,
   then deploys to Pages.

### Deliberate gaps

- **Matrix simplification is implemented** as constant-row elimination for
  nonlinear dense closures (`engine/core/src/simplified.rs`): the rows
  `do_step` rewrites are detected on the first Newton iteration of each
  restamp epoch via the Stamper's touch recording, the constant bulk is
  factored once, and each iteration solves a small reduced system plus a
  back-substitution. Three fallback guards (fixed-row drift, singular or
  non-finite reduced solve, full-system residual) route back to the exact
  unsimplified solve rather than ever returning a wrong answer, so the corpus
  report and every analytic test are unchanged. The deterministic factor-flop
  win on a 134-row dense fan with one diode is 2,187,354 to 82,400 over a
  10-step run (26.5x), but that counts only LU factor multiply-adds: the
  simplified path also pays per-iteration O(n²) work the full path never
  does (the fixed-row drift scan, the `A_FD^-1*b_F` solve and the residual
  scan, roughly 53k ops/iteration against the full factor's ~81k), so the
  real steady-state win is about 1.5-2x, not the factor-only headline. The
  `simplify` SimOptions flag (on by default) disables it for tests. Sparse
  closures are deliberately not simplified: their refactor is already cheap
  and the dense reduced system would not pay for itself.
- **Sparse matrix ordering** is a minimum-degree column order over the
  symmetric pattern of `A + A'` (`engine/core/src/ordering.rs`), computed once
  per structural change alongside the CSC pattern and reused by every factor
  after it. Degree buckets with lazy deletion pick each step's node, so the
  pass costs about what the pattern build does rather than the `O(n²)` a
  rescan-per-step would; a pattern whose cliques outgrow a fill budget
  abandons the order and hands back the identity, which is exactly the old
  behaviour. The wins on the benchmark rows: the 30x30 mesh factors 910,598
  flops in the natural order and 239,849 ordered (3.8x), and the fan families
  halve (100x100: 19,600 to 9,800). No supernodes, no mass elimination, no
  column-count refinement: AMD's speedups matter at a scale a per-closure
  matrix of a few thousand rows never reaches.
- **Device model libraries.** The built-in diode, transistor and MOSFET/JFET
  model tables are ported (`web/src/model/deviceModels.ts`): a named model
  with no `34`/`32` line resolves from the table at load, the file's model
  line wins over it, and unknown names fall back to defaults with the name
  preserved. A model-name selector sits in the element options panel. The
  zener picker hides the zero-breakdown models, exactly as upstream's
  `getModelList(zener)` does (DiodeModel.java:193-194); the diode, varactor
  and LED pickers keep the full list. Mosfet/JFET model names never appear in
  the text format, so their picker choices are session-only, as upstream.
- **Scope line fidelity.** `o` lines are parsed for their element attachment and
  their display fields decode into scope state on load and regenerate on edit,
  so an untouched loaded scope still saves byte-for-byte. Interpreting the
  display fields (the `scope-settings-sync` feature) reached every flag the
  port models: speed, stacking position, showV/showI (live trace-visibility
  toggles, Scope.java:289-315), scale mode (auto/max/manual), manDivisions,
  the measurement toggles, FFT/log-spectrum, X-Y, the label, and the per-plot
  DC/AC coupling and manual scale/position. The nine value readouts (Scale,
  Max, Min, P-P, Freq, RMS, Average, Duty Cycle, Phase Angle) are additionally
  settable per trace: each plot carries its own mask in the per-plot flags
  token under FLAG_PERPLOTFLAGS, bit 0 staying FLAG_AC and bits 1..9 the
  port's own fresh convention (set bit means the readout is on, no inheritance
  of upstream's historical showMax inversion), with bit 10 marking that a
  mask exists at all so an all-off mask survives a save/load instead of
  collapsing into inheriting; bits 11 and up are reserved and never written.
  A token that sets neither the sentinel nor a measurement bit leaves the
  plot inheriting the scope word, so existing files behave and encode
  byte-for-byte as before. The trigger bits (1<<24) are
  deliberately not read: the text format carries no trigger state and upstream
  never restores it. Hints (`h`) are preserved verbatim but inert.
- **XML circuits.** Current upstream saves a `<cir …>` document rather than
  the text format, and 38 of the 373 bundled circuits are in that form. The
  port does not implement the XML format; instead, by owner decision
  (2026-08-15, revising 2026-08-12), `parseCircuit` runs every XML document
  through a one-way XML-to-text converter at load (`web/src/io/xml.ts` and
  `xmlToText.ts`), so those circuits load and save as ordinary text. The
  converter maps each element tag's attributes to the port's own text tokens,
  carries the device models (`dm`/`tm`/`mm`/`ccm`), re-encodes scopes and
  sliders, converts the bus elements (`bli` to 435, `bt` to 437, and an `rw`
  bus wire's `bw` onto every straight segment it becomes), converts the
  instruction display (`ins` to a real 434 line carrying its lookup table),
  the battery (`Battery` to a real 438 line carrying its SOC table), and
  degrades routed wires to straight `w` segments. A clock needs no special
  case either: ClockElm dumps as its parent RailElm, so its `<R>` tag runs
  through the ordinary voltage-token writer into a real clock rail line
  carrying FLAG_CLOCK. The XML-only element classes still unrealized
  (Gyrator, NortonAmp, CustomCompositeChip) stay as `#` comment lines so
  nothing is lost. All 38 convert and simulate: the last holdouts,
  the td4 family, fell to bus-mode chip support (see the Working bullet above;
  their grounds on enable pins and the PC register's rails were drawn against
  upstream's collapsed pin coordinates, and a non-bus rebuild put those rails
  on an output pin). One conversion gap remains visible rather than fixed: of
  the chip bit order only ctr2/FullAdder/ROM/SRAM honour `bo="2"` end to end,
  while any other allowBus kind carrying a nonzero `bo` keeps its line under
  the same kind of trace. The multiplexer's bus-in/bus-out input mode (the td4
  files' `im="2"`) is no longer a gap: the engine models `INPUT_MODE_BUS_BUS`
  with grouped data-bus inputs and one output bus, the converter emits the two
  params instead of its old trace comment, so the td4 ROM-to-data-bus wiring
  routes. Input mode 1 (bus in, single output) stays deferred under a trace.
  Where nothing can be honoured the whole element is
  already a full comment. `DIAGNOSED_SIM_FAILURES`
  is empty and the corpus report has no `sim error` entries left. alu74181,
  which used to wait on bus support, simulates again. The derivative-driven
  controlled sources that used to sit there, cs-varicap and cs-varinduct,
  fell to the `ExprState` step-length fix, and cs-opamprail, a clamped
  gain-1000 VCVS whose secant collapsed at its rails and flip-flopped under
  Newton, fell to the controlled sources stamping a fixed value for the first
  solve after a reset (`ExprSource::primed`). The text format remains what
  the `cct` and plain-text share links use.
- **Chip bit-order leftovers, accepted deliberately.** The port carries the
  chip bit order in flag bit 14 because upstream has no text-format home for
  it (`bo` is an XML attribute only); if upstream ever defines one, migrate
  rather than reuse the bit. A stale bit-14 row against already-expanded pin
  geometry would silently open per-bit connections instead of erroring:
  upstream never writes bit 14 there, so the risk is nil, but it is a silent
  direction by nature. `bo="1"` (LSB first, non-bus) flips row order within
  each pin group; the converter cannot honour it and marks every occurrence
  with a trace comment instead. No bundled file uses it, and acting on it
  needs the same row-flip layout work in the registry defs. The td4 command
  decoder also rides out its composite as a diagonal `cc` placement whose
  pins mostly miss their nets; that fidelity gap belongs to the
  CustomCompositeChip geometry work, not here.
- **The DC operating point runs per the `autoDC` setting, not always.** The
  solve runs before the first timestep and on every reset only when `autoDC`
  is on: the header's flag bit 128 drives it (CirSim.java:440-444), and a new
  circuit defaults it off, matching upstream's `autoDCOnReset`
  (CircuitLoader.java:56). A freshly drawn circuit therefore keeps its
  charging transients and its 1e-3 capacitor self-start seed; a file with the
  bit set gets the pre-charging solve. Under it, every non-DC source freezes
  at its bias (VoltageElm.java:168-169), and the solve commits its reactive
  state: the capacitor's and inductor's `step_finished` run for the operating
  point too, so the transient starts pre-charged to the solved steady state,
  exactly as upstream's unguarded `stepFinished` leaves it after its own DC
  analysis. The inductor is stamped as a 1e-6 ohm short while solving: this
  port's single-solve-per-frame architecture cannot integrate a whole frame of
  steps the way upstream does, so the exact short finds the steady-state loop
  current in one pass and carries it into the transient. A failed solve is
  guarded: every element is reset and the node voltages cleared, so the
  transient degrades to the uncharged start rather than committing the last
  Newton iterate. `DIAGNOSED_SIM_FAILURES` is empty and the corpus report has
  no `sim error` entries left: the last one, qam-256, fell to the solver
  grounding an effectively-open current-source output that had run away, not
   to the DC solve. The one-shot "Find DC Operating Point" File menu command
   rides this same path: it flips `autoDC` on around a single reset, upstream's
   `dcAnalysisFlag` plus `resetAction` (CommandManager.java:361-364), so it
   solves whatever the setting says and puts the setting back afterwards.
- **Shared sliders parse but never link.** A slider's shared-index token
  (`ano`, FLAG_SHARED bit 1) lands in `SliderConfig.shared`
  (`web/src/io/netlist/types.ts`) and round-trips verbatim on save, but the
  sibling resolution never happens: a slider pointing at another renders and
  drags independently where upstream mirrors its value onto the shared one
  (Adjustable.java sharedSlider).

---

## 5. Roadmap

### Milestone A — solver depth

- [x] Adaptive timestep with step rejection
- [x] Matrix simplification / constant-row elimination
- [x] Sparse matrix path for large circuits
- [x] Convergence diagnostics surfaced in the UI (which element failed)
- [x] Benchmark harness with representative circuits, wired into CI

### Milestone B — editing parity

- [x] Rotate/flip, and the element-specific flags that control orientation
- [x] Copy/paste and duplicate
- [x] Wire auto-routing and junction dots
- [x] Sliders (`38` lines) bound to element parameters
- [x] Full scope UI: stacked traces, time/div, cursors, X-Y mode, FFT
- [x] Subcircuits (`CustomComposite`): `.` model lines, Create Subcircuit, the
  subcircuit manager, and the 410 element

### Milestone C — element coverage

Grouped by upstream type. Each needs a Rust model, a TypeScript definition and
a test. Done so far: **129 kinds implemented** (the `KINDS` list in
`engine/core/src/elements/mod.rs`); the only upstream types still absent are
the permanently-deferred XML-only classes (Gyrator, NortonAmp,
CustomCompositeChip).

**Passive / basics** — done: wire, ground, resistor, capacitor, polarised
capacitor, inductor, transformer, tapped transformer, custom transformer, fuse,
lamp, thermistor, potentiometer, switch, SPDT switch, make-before-break switch,
DPDT switch, LDR, varactor, memristor, transmission line, spark gap, antenna,
relay (coil/contact), crossover switch, motor-protection switch, crystal.

- [x] Crystal

**Sources** — done: voltage source (all waveforms), rail, current source.

- [x] Variable rail, sweep, AM, FM, VCO, noise, audio input, external voltage
- [x] Controlled sources: VCVS, VCCS, CCVS, CCCS, CC2

**Semiconductors** — done: diode, Zener, BJT, MOSFET, JFET, Darlington, tunnel
diode, LED, LED array, SCR, triac, diac, unijunction, triode, optocoupler.

- [x] Optocoupler

**Analog** — done: op-amp (saturating VCVS), OTA, analog switch, analog mux,
timer (555), phase comparator, ADC, DAC, realistic op-amp with gain-bandwidth,
comparator.

- [x] Realistic op-amp with gain-bandwidth, comparator

**Logic** — done: inverter, AND, NAND, OR, NOR, XOR, XNOR, tri-state buffer,
Schmitt trigger (inverting and non-inverting), all behind the `euroGates` IEC
symbol toggle, which is on by default.

- [x] Gates: AND, OR, NAND, NOR, XOR, XNOR, inverter, tri-state, Schmitt
- [x] Flip-flops: D, JK, T, latch, monostable
- [x] Counters, shift registers (SIPO/PISO), ring counter, sequence generator
- [x] Multiplexer, demultiplexer, adders, seven-segment and decoders
- [x] SRAM, ROM, delay buffer, bus splitter
- [x] Bus splitter real fan-out, bus logic input (435), bus transceiver (437)
- [x] Custom logic (the `!` model line and the `208` element)

**Instruments and annotation** — done: labeled node, output,
voltmeter, text, ammeter, box, line, scope-as-element, ohmmeter, test point,
wattmeter, data recorder, stop trigger, instruction display.

**Electromechanical** — done: three-phase motor, DC motor, time-delay relay.

### Milestone D — polish

- [x] Mobile / touch layout
- [x] Keyboard shortcut parity
- [x] Import upstream's `subcircuits.html` and other side pages
- [x] Accessibility pass on the panels

---

## 6. File format reference

Line-oriented, whitespace-separated. Element lines are:

```
<dumpCode> x1 y1 x2 y2 flags <type-specific tokens…>
```

The header is `$ flags timeStep iterCount currentSpeed voltageRange powerRange
minTimeStep`. `timeStep`, `iterCount`, `currentSpeed`, `voltageRange`,
`powerRange` and `minTimeStep` are all modelled, as are flag bits 1 (show
current), 4 (volts off, i.e. voltage colouring), 8 (power colouring), 16 (show
values), 64 (adaptive timestep) and 128 (DC operating point on reset); the
colour mode bits are mutually exclusive, with power winning when both arrive,
matching upstream's `readCircuitFlags`. Only bits 2 (upstream's small grid, an
option the port removed) and 32 (linear scale in the afilter) round-trip
verbatim without being interpreted, so a save never clears a bit upstream
wrote. An old header that stops after `voltageRange` gains the two missing
fields on save, which is what upstream writes too.

Unrecognised lines are preserved verbatim on load and re-emitted on save, in
their original positions, along with blank lines and `#` comments, so
round-tripping a file never loses data. A file with no `$` line and no element
this build can read comes back byte-for-byte. An upstream XML `<cir>` document
is converted to the text format inside `parseCircuit` (see the XML circuits
section above), so an untouched converted file saves as the migrated text, not
as XML.

Dump codes implemented so far, with their trailing field order:

| Code  | Kind           | Fields after `flags`                                       |
| ----- | -------------- | ---------------------------------------------------------- |
| `w`   | wire           | [busWidth] (port extension: a trailing width token, written only when above one; a bus wire presents N terminals per endpoint) |
| `g`   | ground         | symbolType                                                 |
| `r`   | resistor       | resistance                                                 |
| `c`   | capacitor      | capacitance, voltDiff, [initialVoltage], [seriesResistance] |
| `209` | polarised capacitor | same as `c`, then maxNegativeVoltage (ESR only under FLAG_RESISTANCE = 4) |
| `l`   | inductor       | inductance, current, initialCurrent, saturationCurrent     |
| `T`   | transformer    | inductance, ratio, current0, current1, [couplingCoef], [saturationCurrent] |
| `169` | tapped transformer | inductance, ratio, current0, current1, [current2], [couplingCoef] |
| `406` | custom transformer | inductance, couplingCoef, description (escaped), coilCount, coilCurrent0 … |
| `404` | fuse           | resistance, i2t, heat, blown                               |
| `181` | lamp           | temp, nomPower, nomVoltage, warmTime, coolTime              |
| `350` | thermistor     | r25, r50, minTempr, maxTempr, position, sliderText (escaped) |
| `174` | potentiometer  | maxResistance, position, sliderText (raw, may span tokens) |
| `374` | LDR            | position, sliderText (escaped)                              |
| `v`   | voltage source | waveform, frequency, maxVoltage, bias, phaseShift, duty    |
| `R`   | rail           | same as voltage source                                     |
| `i`   | current source | current, maxVoltage                                        |
| `d`   | diode          | modelName (FLAG_MODEL), else fwdrop (FLAG_FWDROP)          |
| `z`   | zener          | modelName (FLAG_MODEL), else [fwdrop] then zvoltage        |
| `176` | varactor       | [modelName (FLAG_MODEL) or fwdrop (FLAG_FWDROP)], capVoltDiff, baseCapacitance |
| `t`   | transistor     | pnp, lastVbe, lastVbc, beta, modelName                     |
| `f`   | mosfet         | pnp, threshold, beta                                       |
| `s`   | switch         | position, momentary, [label] (FLAG_LABEL = 4)              |
| `S`   | SPDT switch    | position, momentary, [label], link, throwCount             |
| `178` | relay          | poleCount, inductance, coilCurrent, r_on, r_off, onCurrent, coilR, [offCurrent, switchingTime, position] |
| `425` | relay coil     | label, inductance, coilCurrent, onCurrent, coilR, offCurrent, switchingTime, type, state, switchPosition |
| `426` | relay contact  | label, r_on, r_off, [i_position]                           |
| `a`   | op-amp         | maxOut, minOut, gbw, volts0, volts1, gain                  |
| `402` | OTA            | one raw `_`-joined child-dump token per composite child (2 rails + 16 transistors); the two rail tokens re-derived from posVolt/negVolt on save, the sixteen transistor tokens carried verbatim |
| `409` | realistic op-amp | slewRate, capValue, currentLimit, modelType              |
| `407` | optocoupler    | three raw `_`-joined child-dump tokens (LED, CCCS, phototransistor), then ctr |
| `401` | comparator     | one raw `_`-joined child-dump token per composite child (internal op-amp, analog switch, ground) |
| `412` | crystal        | four raw `_`-joined child-dump tokens (parallel cap, series cap, inductor, resistor), re-derived from params on save |
| `207` | labeled node   | text (FLAG_ESCAPE = 4, always set on save; never a width token, the resolver derives it) |
| `368` | test point      | meter, [label] (FLAG_LABEL = 1)                             |
| `216` | ohmmeter        | current, maxVoltage (the CurrentElm tokens)                 |
| `420` | wattmeter       | width, meter                                                |
| `210` | data recorder   | dataCount                                                   |
| `408` | stop trigger    | triggerVoltage, type, delay, count                          |
| `O`   | output          | scale                                                      |
| `p`   | probe          | meter, scale, resistance                                   |
| `x`   | text           | size, text (FLAG_ESCAPE = 4, always set on save)           |
| `I`   | inverter       | slewRate, highVoltage                                      |
| `150` | AND gate       | inputCount, lastOutputVoltage, highVoltage                 |
| `151` | NAND gate      | same as `150`                                              |
| `152` | OR gate        | same as `150`                                              |
| `153` | NOR gate       | same as `150`                                              |
| `154` | XOR gate       | same as `150`                                              |
| `431` | XNOR gate      | same as `150`                                              |
| `180` | tri-state buffer | r_on, r_off, r_off_ground, highVoltage                   |
| `182` | Schmitt trigger (non-inverting) | slewRate, lowerTrigger, upperTrigger, logicOnLevel, logicOffLevel |
| `183` | Schmitt trigger (inverting) | same as `182`                                    |
| `208` | custom logic   | modelName (escaped), then one outputVoltage per output pin |
| `435` | bus logic input| busWidth, value, hiV, loV                                  |
| `437` | bus transceiver| bits, [highVoltage] (the standard chip stream)             |
| `434` | instruction display | busWidth, threshold, lookup table (one escaped token) |
| `438` | battery        | r0, r1, c1, capacityAh, initialSocPercent, batteryType, SOC table (one escaped token) |

For the gate rows the `inputCount` token is the post count minus one (1 to 8
inputs); `lastOutputVoltage` restores the gate's output state on load
(`> highVoltage/2` means the output was high) and seeds the inputs so the
first solve agrees. Flag bits on the gate rows: 1 FLAG_SMALL (half-size
geometry), 2 FLAG_SCHMITT (input hysteresis at 0.35/0.55 of `highVoltage`),
4 FLAG_INVERT_INPUTS. The tri-state buffer is single-bit here (upstream's bus
width is XML-only); its `r_off_ground` token defaults to 0 on load, so a bare
`180` line round-trips.

For the `t` row: the `pnp` token is `+1` for NPN and `-1` for PNP; the file sign
is the type, so a non-negative token (including `0` from older saves) reads as
NPN. The `lastVbe`/`lastVbc` tokens are restored as the initial junction state
on load, swapped against their names: `lastVbe` seeds the collector node and
`lastVbc` the emitter node. The trailing `modelName` token is optional (3 to 5
tokens occur in the wild; beta then keeps its default of 100) and is preserved
verbatim on save.

For the `208` row the model is a named `!` line, parsed into real state like
the `34`/`32` model lines: `! <escaped name> <flags> <escaped inputs> <escaped
outputs> <escaped infoText> <escaped rules>` (CustomLogicModel.undump). The
input/output tokens are comma-separated pin-name lists and `rules` is a series
of `left=right` pairs separated by newlines, the `\q`/`\n` escapes decoding to
`=` and a newline. The line rides through in passthrough so a save re-emits it
in place; only its parameters are interpreted. The element token stream is the
escaped model name then one saved output voltage per output pin
(CustomLogicElm.java:24-36), the count coming from the resolved model, so a
`208` line whose model name has no `!` line falls back to a 4-input/2-output
default. The engine evaluates the rule table every step and each output is a
voltage source to ground; a model with a `_` in any right side is tri-state,
needing an internal node and a 1e8/1e-3 ohm resistor per output. The model
reaches the engine as a serialised blob in `spec.model`, separate from the
label, which carries the model name.

Bus wires and the bus chips: terminals merge into one node only when both the
coordinate and a per-post bus bit index match, which is upstream's `Point`
equality including `z` (Point.java:61-67, `ChipElm.Pin.busZ` at
ChipElm.java:708). Plain posts are bit 0, so circuits with no wide elements
behave exactly as before. The bus splitter's N west pins share one coordinate
with bits 0..N-1; its bit pairs merge out of the matrix like wires (`isRemovableWire`,
one pair per bit) and the wire-current recovery reports each bit's current.
The `435` row is the port's own text form of BusLogicInputElm (upstream saves
it only as XML): width, then the driven word, then hiV and loV written
unconditionally so the line is self-describing. All N posts sit on the anchor
coordinate tagged per bit, matching upstream's `getPost(n) = new Point(x, y,
n)`; clicking cycles the word through 0..2^width-1. The `437` row is the bus
transceiver in the standard chip stream (the XML attribute is `db`), OE
active-low at top-left, DIR top-right, A and B banks MSB first down the sides;
its A/B pins are individual, upstream's default outside bus mode. Wire widths:
a saved token above one is honoured, but widths also propagate from wide pins
through wire chains and matching labels on every build
(`web/src/model/busWidths.ts`, mirroring upstream's `detectBusWidths`), so a
plain wire drawn onto a splitter becomes a bus without any token and two
same-named labels carry the width to each other; a coordinate where two
different declared widths meet is collected into a mismatch set that draws as
red bad-connection dots, like upstream's `busMismatchList`. Labeled nodes save
no width token either: like wires, their width is derived at build time and
injected into the engine spec only. Upstream's own text format never saves
wire widths at all.

For the `438` row the battery is the port's own text form of BatteryElm
(upstream saves it only as XML, so it gets the same invented code treatment as
the 435/437 rows): `r0 r1 c1 capacityAh initialSocPercent batteryType`, then
the SOC-to-voltage table as ONE escaped token (`\n` inside the token, never a
raw newline, or the line-oriented parser would eat the rest of the file). The
`initialSocPercent` token is 0..100 and the engine works in a 0..1 fraction;
`batteryType` is the preset index 0..4 or -1 for a custom table. Every token
is written unconditionally so the line is self-describing, like the `435`
row's rationale. The running SOC and the polarization cap's stored charge
cross back out through the live-state tokens `soc` and `capVoltDiff` (the
capacitor's voltDiff precedent), so a mid-discharge save resumes where it
left off. Flag bits 1 (FLAG_SHOW_VOLTAGE) and 2 (FLAG_SHOW_SOC) gate the two
halves of the caption; a fresh battery is a lithium-ion with both set.

For the `402` row the OTA is a `CompositeElm` of two rails and sixteen
transistors (OTAElm.java:8-9), and every token after the flags is one composite
child's dump, `_`-joined by the old text format and carried raw. The first two
tokens are the rails, whose `maxVoltage` fields are the loaded supply values;
the frontend reads them back into `posVolt`/`negVolt` exactly as upstream does
(OTAElm.java:39-43), leaving the +/-9 V defaults in force only when no usable
rail values arrive. On save the two rail slots are re-derived from those params,
upstream's setEditValue + initOTA pattern (OTAElm.java:183-188), which
reproduces the loaded bytes unless a supply was edited; the sixteen transistor
dumps stay verbatim. The token list
reaches the engine in `spec.model` as a JSON array of the raw strings, the same
string carrier the custom-logic model uses, and the engine maps each token onto
the matching child spec (ota.rs). The five posts are the non-inverting input,
the inverting input, the collector load, the Iabc bias pin and the output, in
that order.

For the `409` row the token stream is `slewRate capValue currentLimit modelType`
(OpAmpRealElm.java:79-86); the 32 child dumps upstream's `dump()` writes are
discarded on load and not regenerated, because the children are a pure function
of the four parameters and upstream ignores them on load too. `modelType`
selects the netlist the engine builds: 0 the LM741, 1 the LM324 and 2 its v2
revision (OpAmpRealElm.java:51-53), each with its own cap-sizing formula and
output-stage current-limit scaling, and the 324v2's named transistor models
resolve engine-side to their SPICE satCur/betaR (composite.rs), so the v2 is
genuinely the ON Semiconductor netlist. The Model choice offers the LM741 and
the LM324v2; the old LM324 (modelType 1) is deliberately not offered to fresh
parts, exactly like upstream hides it (OpAmpRealElm.java:270-281): its
follower's DC operating point collapses the input stage (the pair saturates,
the mirror turns off and the first-stage output floats, stranding the output
near V-), so the model is only reachable through a file that already names it,
which the choice row still displays as a disabled option. The v2 takes no
slew/current tuning (its compensation is fixed in the netlist), so those two
rows are hidden on it as upstream hides them (:288-289). The `capValue` token
restores the compensation
capacitor's stored charge on load (`set_param("voltDiff", …)`, upstream
`getCapacitor().voltdiff`); the 324v2 has no compensation capacitor upstream
sizes from the slew rate, so its `capValue` token is carried but inert. The
rail posts sit at the outer ends of the supply
stubs, 32 px from the body axis (upstream `rail1p[0]`).

For the `407` row the three tokens are the `_`-joined dumps of the LED model,
the CCCS and the phototransistor; the port appends a `ctr` scale token after
them because upstream's text save drops it (the stop-trigger precedent). A
tokenless `407` line (no trailing ctr) keeps the default ctr of 1. The internal
LED is forced to upstream's `default-optocoupler-led` model (Is = 1.714e-7,
n = 4.077, optocoupler.rs), matching OptocouplerElm.java:25.

For the `401` row the token stream is the `_`-joined dumps of the internal
op-amp, the analog switch and the ground child, carried raw like the OTA's. The
three posts are V−, V+ and the output; the op-amp's inverting input is wired to
the V+ post, so net behaviour is standard comparator logic. FLAG_SWAP (bit 4)
swaps the V−/V+ post sides and the −/+ glyphs track it; FLAG_SMALL (bit 2)
halves the body.

For the `412` row the four tokens are the `_`-joined dumps of the parallel
capacitor, the series capacitor, the inductor and the series resistor; the port
re-derives them from the current params on save so parameter edits persist.
Saved child voltDiff/current state tokens are dropped: the crystal is the one
composite that still writes its file state rather than the live running state.
FLAG_SHOW_FREQ (bit 2) is set on a fresh crystal and draws the
series-resonance frequency caption.

For the `f` row the channel type is FLAG_PNP (bit 1), not a token: `+1` is an
N-channel and `-1` a P-channel, so flags 1 means P. The two trailing tokens are
the legacy `vt beta` pair, read defensively and omitted by modern files, which
load the default model (`threshold = 1.5 V`, `beta = 0.02 A/V²`, `lambda = 0`,
body diode on, no gate caps). Upstream's own text save writes neither token;
this port writes both anyway, so a save never loses the model. The source and
drain hang off `x2,y2` at ±16 perpendicular, flipped by FLAG_FLIP (bit 8), the
same dsign convention as the transistor's collector and emitter.

For the `d` and `z` rows the trailing tokens depend on the flags. FLAG_MODEL
(bit 2) means the one token is an escaped model name, kept verbatim but not
looked up; otherwise FLAG_FWDROP (bit 1) contributes a forward drop, and a `z`
line always carries its zener voltage after that. The port writes the model
name when it has one and the value form otherwise, and the value form always
sets FLAG_FWDROP and clears FLAG_MODEL. A `z` line that carries a forward drop
with no zener voltage behind it throws on load in the original and the element
disappears, so the zener value form is never written as a single token.

For the `c` and `209` rows only the first two tokens are guaranteed.
`initialVoltage` is optional and defaults to 1e-3, the small charge upstream
puts on every capacitor so a fresh LC tank self-starts. The port writes
FLAG_RESISTANCE (bit 4) and all four tokens on every save, as upstream's
`dump()` does.

For the `178`, `425` and `426` rows the relays link by label, not by a
numeric id: a `425` coil and a `426` contact with the same label are one
device, and the engine resolves that pairing once when the circuit is built
rather than scanning per step (`RelayCoilElm.java:353-378`). A `426` contact
is an SPST whose `i_position` comes from the file or from its coil;
FLAG_NORMALLY_CLOSED (bit 2) inverts the coil's drive. The third throw the
`426` draws is cosmetic, and its posts() returns only the two circuit
terminals. The `178` format's three trailing tokens are optional in old
files, which the token constructor fills from the model defaults; every
bundled circuit carries all ten. The relay coil's `type` token is the
six-state machine: 0 normal, 1 on-delay, 2 off-delay, 3 latching, 4
latching-set, 5 latching-reset.

The two rows differ on reading that fourth token. Upstream takes it only when
the flag is set (`CapacitorElm.java:59-60`), but the flag is there to keep the
stream position unambiguous for `PolarCapacitorElm`, which reads
`maxNegativeVoltage` off the same stream straight after. Nothing follows on a
plain `c`, where the fourth token can only be the series resistance, so this
port reads it either way; `cappar.txt` carries three flagless four-token lines
and one of them holds a real 0.1 ohm that upstream's own `validate()` wrote
there, which honouring the flag would silently discard and the next save would
overwrite with a zero. A `209` line does honour the flag, because without it
the rating genuinely is the fourth token rather than the fifth.

The `voltDiff` token is the saved charge and it is restored into the engine on
load; the engine's running charge crosses back out on save and rebuild, so a
mid-transient save writes the live value (see the live-state Working bullet in
section 4).

The three transformer rows are one electrical family: coupled inductors stamped
as a mutual-inductance Norton companion with no voltage-source unknowns. The
engine builds the mutual-inductance matrix `M` (diagonal `n²·L`, off-diagonal
`k·sqrt(Li·Lj)·pi·pj`), inverts it densely and stamps the result as
conductances and VCCSs, one current source per winding. The `ratio` token is
stored inverted, N2/N1, so a line reading `ratio` 10 steps the voltage up ten
times. Coupling defaults to 0.999 for the basic and custom transformers and
0.99 for the tapped one, and the tapped secondary is split in half (each half
`ratio/2` turns). The basic transformer's polarity lives in FLAG_REVERSE
(bit 4), which the drawing turns into a post swap rather than a token. A basic
`T` line may carry `saturationCurrent`; the port models it as a core-saturation
rolloff `L_eff = L0/(1 + (I/Isat)^2)` per winding, `Isat` scaled by the winding's
turns ratio, exactly as upstream (TransformerElm.java:195-270). A saturated
core flips the element nonlinear, so its companion is re-stamped every Newton
iteration. The `169` and `T` lines both omit their optional
trailing tokens when a file stops short, and the save writes exactly the tokens
that were present. The `406` description is one escaped token
(`CustomLogicModel.escape`: `+→\p`, `=→\q`, `#→\h`, `&→\a`, CR, space, and
empty as `\0`) with `:` splitting primary from secondary and `,` separating
coils; the escape set is the same one the text rows use, so it round-trips
through the shared netlist layer. Node wiring matches upstream's `getPost`:
the basic primary spans posts 0-2 and the secondary posts 1-3, the tapped
primary posts 0-1 and the secondary posts 2-3-4 (the tap is post 3), and a
custom's coils own consecutive node pairs in description order.

The `176` row is a `VaractorElm`, which extends `DiodeElm`: the same leading
tokens as the `d` row, driven by the same flags. `VaractorElm`'s own token
constructor then unconditionally reads two more tokens after those —
`capvoltdiff` (the persisted junction voltage) and `baseCapacitance` — but
its own `dump()` is inherited straight from `DiodeElm` and never writes
either one, a real quirk like the thermistor's and LDR's: a save-then-reload
in the original loses both. The bundled corpus (`varactor.txt`,
`varactorvco.txt`) shows the tokens are genuinely part of the format in
practice, so this port's writer appends both unconditionally, the same fix
applied there.

Waveform codes: `0` DC, `1` sine, `2` square, `3` triangle, `4` sawtooth,
`5` pulse, `6` noise.

A scope line is `o <element> <display fields...>`. The element number counts
element lines in the file, including the ones this build has no model for, so
it is not an index into the elements the port loaded: a circuit with one
unimplemented part ahead of a scope would otherwise attach the trace to its
neighbour. A trace whose target is one of those unreadable lines has nothing
to draw, and its line is carried through untouched. The display fields are
interpreted into scope state: speed, stacking position, showV/showI, scale
mode, manDivisions, the measurement toggles, FFT/log-spectrum, X-Y, the label
and per-plot coupling and manual scale/position. Under FLAG_PERPLOTFLAGS each
plot carries one hex flags token whose bit 0 is upstream's FLAG_AC, whose
bits 1..9 are the port's per-trace measurement readouts in the order Scale,
Max, Min, P-P, Freq, RMS, Average, Duty Cycle, Phase Angle (set meaning on: a
fresh convention, no inheritance of upstream's historical showMax inversion),
and whose bit 10 marks that a mask exists at all so an explicitly all-off mask
round-trips instead of collapsing into inheriting. Bits 11 and up are
reserved: nothing writes them, and unknown high bits in a foreign token
decode as off and drop on regeneration. A token that sets neither the
sentinel nor a measurement bit leaves the plot inheriting the scope word,
and the flag word sets FLAG_PERPLOTFLAGS only when a plot actually
carries a token or an AC bit, so scopes that never used per-channel
measurements encode byte-for-byte as upstream's do. The trigger bits (1<<24)
are deliberately not read, so a loaded line's trigger field is left alone;
see the scope line fidelity section.

For the `s` and `S` rows the label token exists only when FLAG_LABEL (bit 4) is
set, and the SPDT reads it before `link` and `throwCount`, so a label shifts
both of them one token along. The port sets the bit when there is a label and
clears it when there is not, which keeps the token count and the flag in step.
FLAG_CENTER_OFF (bit 1) on an `S` row widens the position range to three stops:
position 2 is the open middle one, stamps no voltage source, reports no current
unknown and stays open on save and on a live toggle, matching upstream's
`hasCenterOff()` which only accepts it on a two-throw switch. No bundled
circuit uses the bit, so no corpus line changed.

For the `174` row the slider caption is every remaining token joined with
single spaces, and it is **not** escaped: those tokens go in and out raw. A
caption containing `+` is therefore lossy, in the original too, because `+` is
one of the format's token separators. Current upstream reads these three
tokens but no longer writes them; its own save path is XML.

For the `350` row the slider caption is, unlike the potentiometer's, a single
escaped token (`ThermistorNTCElm.java`'s token constructor unconditionally
unescapes it, with no raw-token fallback). Upstream's own class never
overrides `dump()` either, so its base-class implementation writes only the
common x/y/flags fields for this type — a real upstream quirk that would
silently drop `r25`, `r50`, the temperature range, `position` and the caption
from a legacy text save. This port writes all six anyway, matching every
other type here, so a save from this app never loses that state.

For the `374` row the slider caption is likewise a single escaped token
(`LDRElm.java`'s token constructor unconditionally unescapes it, just like the
thermistor's), and `LDRElm.java` has the exact same real quirk: it never
overrides `dump()`, so upstream's own text save would drop `position` and the
caption too. This port writes both tokens anyway, for the same reason. `LDR`'s
`minLux`/`maxLux` are hardcoded constants in both of upstream's constructors
(0.1 and 10000), never read from a file or exposed via `getEditInfo`, so they
carry no tokens at all — only `position` and the slider caption round-trip.

Text tokens that may contain spaces are escaped with upstream's full set: space
`\s`, newline `\n`, carriage return `\r`, backslash `\\`, `+` `\p`, `=` `\q`,
`#` `\h`, `&` `\a`, and the empty string as `\0`. Any other `\x` loses its
backslash and keeps the letter. The `x` and `207` rows carry FLAG_ESCAPE
(bit 4) to say the text is one escaped token; without it the old-style reader
joins the remaining tokens with spaces and turns `%2b` back into `+`.

---

## 7. Working on this repo

```sh
just setup            # toolchains, npm install, fetch upstream reference
just wasm             # build the Rust engine to web/src/wasm/
just dev              # dev server (does not build the engine)
just test             # Rust + TypeScript tests
just lint             # everything CI checks
just ci               # lint + test + build, in CI order
just import-cirquits-upstream  # refresh the bundled circuit library from upstream
```

`reference/circuitjs1` is a gitignored checkout of upstream, kept purely as a
behavioural and file-format reference. It is not built and not shipped.

**Licensing.** This is a derivative work of a GPL-2.0 project, so the port is
GPL-2.0-or-later too, and the bundled circuit library keeps its upstream
licence. Keep it that way.
