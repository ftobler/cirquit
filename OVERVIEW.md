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
                                    │  one call per animation frame
                                    │  JSON in (on change), typed arrays out
┌───────────────────────────────────▼─────── engine/ (Rust → wasm) ────────────┐
│  circuit.rs  node analysis, timestep loop, Newton-Raphson                    │
│  matrix.rs   dense LU with partial pivoting and cached factors               │
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
frame. As it is there is exactly **one** call per frame, and the results come
back as flat typed arrays.

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
singular constraint rows. Consequence: current *through* a ground symbol is not
reported. If that is wanted later, give ground a single shared 0 V source
rather than one per symbol.

**Floating subcircuits** get a 1 nS conductance to ground with a warning, rather
than an error. Ungrounded circuits pick the first node as the reference and warn.

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
3. **Test** — add a case to `engine/core/tests/circuits.rs` asserting against a
   known analytic result. This is the part that catches sign errors; do not
   skip it.
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
  factorisation, singularity detection.
- Newton-Raphson with junction limiting and per-element convergence reporting.
- DC operating point before transient, with reactive elements switched to their
  steady-state stamps.
- Trapezoidal and backward-Euler companion models for reactive elements.
- Per-timestep scope capture with min/max column aggregation.
- Canvas renderer: voltage colouring, animated current dots, pan/zoom, grid.
- Editing: place, select, rubber-band, drag, delete, undo/redo, live parameter
  edits, interactive switches.
- File format: read and write the original `.txt`, `ctz`/`cct` URL sharing,
  and the bundled 373-circuit library.
- 93 Rust tests, of which 87 are the end-to-end circuit checks against analytic
  results in `engine/core/tests/circuits.rs`, and 302 TypeScript tests. CI runs
  fmt, clippy, tests, typecheck, lint and build, then deploys to Pages.

### Deliberate gaps

- **Adaptive timestep.** Upstream shrinks the step when convergence struggles.
  Here the step is fixed. Worth adding before the trickier nonlinear parts.
- **Matrix simplification.** Upstream pre-eliminates rows that are constant,
  which materially speeds up large circuits. Not implemented; the solver is a
  plain dense LU. This is the single biggest performance lever remaining.
- **Sparse matrices.** Dense LU is `O(n³)`. Fine to a few hundred nodes;
  circuits in the thousands will need a sparse solver.
- **Device model libraries.** Diodes, transistors and MOSFETs upstream carry
  named model libraries. Here they take direct parameters; the model name in a
  file is preserved but not looked up.
- **Scope line fidelity.** `o` lines are parsed for their element attachment
  only; the remaining display fields are preserved verbatim but not
  interpreted. Sliders (`38`), hints (`h`) and subcircuit definitions are
  likewise preserved but inert.
- **XML circuits.** Current upstream saves a `<cir …>` document rather than
  the text format, and 38 of the 373 bundled circuits are in that form. They
  load as an empty circuit here and are passed through byte-for-byte on save,
  so nothing is lost, but nothing is drawn either. Importing them means
  porting `XMLSerializer`/`XMLDeserializer` and the per-element
  `dumpXml`/`undumpXml` pair for every type. The text format remains what the
  `cct` and plain-text share links use.
- **Ground current** is not reported (see section 2).
- **Live state never comes back out of the engine.** A file's operating-point
  tokens (capacitor `voltDiff`, inductor `current`, transistor `lastVbe`) are
  read on load and seeded into the models, but the running values are not
  copied back into `params`, so a mid-transient save writes the values the file
  was loaded with. Matching upstream needs a state-readback path across the
  engine boundary.
- **The DC operating point always runs**, whereas upstream only solves one when
  the user picks "DC Analysis" (`CommandManager.java:361-364`). Combined with
  restored reactive state this puts the first transient step in a position
  upstream never reaches: upstream's `CapacitorElm.stepFinished()` has no
  `doDcAnalysis` guard, so its rare DC solve overwrites the restored `voltDiff`
  and the transient starts self-consistent, while this port keeps the guard so
  the file's charge survives a DC pass that knows nothing about it. Four
  bundled circuits fail to converge because of it and are recorded, with what
  each one actually needs, in `web/src/io/corpus.ts`'s
  `DIAGNOSED_SIM_FAILURES`. Three of them are op-amp chaos oscillators whose
  real defect is the op-amp's convergence test, not the restored charge. The
  inductor diverges the same way: `Inductor.java` has no `doDcAnalysis()`
  branch either, so its transient companion, holding the stored `current`,
  carries through a DC solve, while this port stamps the inductor as a hard
  short and zeroes its voltage. The DC current the short yields, `v/DC_SHORT`,
  is the true steady-state loop current, so only the zeroed voltage diverges.
  The saturating-inductor model is now honoured; the inductor's DC handling is
  already decided in `feature/dc-operating-point.md` (scope item 2 keeps the
  1e-6 ohm short and commits that current into history), so only that DC
  behaviour stays behind.
- **A rebuild re-injects the file's saved charge.** The engine reads `voltDiff`
  out of the element spec on every build, and `setCircuit` re-serialises
  `e.params`, which still holds the value the file was loaded with. So any
  mid-run rebuild, including ticking a capacitor's Backward Euler checkbox,
  snaps every capacitor back to its file charge rather than continuing from
  where the run had got to. It used to snap them to zero instead; neither is
  right, and both go away with the state-readback path above.
- **`CapacitorElm.validate()` is not ported.** Upstream walks a path from one
  capacitor terminal to the other after analysis and, on finding a loop of
  ideal capacitors, gives one of them a 0.1 ohm series resistance to damp the
  oscillation the trapezoidal companion would otherwise ring with
  (`CapacitorElm.java:274-291`); the same walk calls `shorted()` on a capacitor
  shorted by wires. Here a freshly drawn pair of parallel ideal capacitors
  rings undamped. Files that already carry the guard's output keep it, because
  the `c` reader takes the series-resistance token whether or not
  FLAG_RESISTANCE is set (see section 6).

---

## 5. Roadmap

### Milestone A — solver depth

- [ ] Adaptive timestep with step rejection
- [ ] Matrix simplification / constant-row elimination
- [ ] Sparse matrix path for large circuits
- [ ] Convergence diagnostics surfaced in the UI (which element failed)
- [ ] Benchmark harness with representative circuits, wired into CI

### Milestone B — editing parity

- [x] Rotate/flip, and the element-specific flags that control orientation
- [x] Copy/paste and duplicate
- [ ] Wire auto-routing and junction dots
- [ ] Sliders (`38` lines) bound to element parameters
- [ ] Full scope UI: stacked traces, time/div, cursors, X-Y mode, FFT
- [ ] Subcircuits (`CustomComposite`)

### Milestone C — element coverage

Grouped by upstream type. Each needs a Rust model, a TypeScript definition and
a test. Done so far: **26 of ~200**.

**Passive / basics** — done: wire, ground, resistor, capacitor, polarised
capacitor, inductor, fuse, lamp, thermistor, potentiometer, switch, SPDT
switch, LDR, varactor.

- [ ] Memristor
- [ ] Transformer, tapped transformer, custom transformer
- [ ] Transmission line, crystal, spark gap, antenna
- [ ] Relay coil / contact / relay, DPDT, crossover and motor-protection switches

**Sources** — done: voltage source (all waveforms), rail, current source.

- [ ] Variable rail, sweep, AM, FM, VCO, noise, audio input, external voltage
- [ ] Controlled sources: VCVS, VCCS, CCVS, CCCS, CC2

**Semiconductors** — done: diode, Zener, BJT, MOSFET.

- [ ] JFET, Darlington, tunnel diode, LED, LED array
- [ ] SCR, triac, diac, unijunction, optocoupler, triode

**Analog** — done: op-amp (saturating VCVS).

- [ ] Realistic op-amp with gain-bandwidth, OTA, comparator
- [ ] Analog switch, analog mux, timer (555), phase comparator
- [ ] ADC, DAC, sample and hold

**Logic** — none yet.

- [ ] Gates: AND, OR, NAND, NOR, XOR, XNOR, inverter, tri-state, Schmitt
- [ ] Flip-flops: D, JK, T, latch, monostable
- [ ] Counters, shift registers (SIPO/PISO), ring counter, sequence generator
- [ ] Multiplexer, demultiplexer, adders, seven-segment and decoders
- [ ] SRAM, ROM, custom logic, delay buffer, bus splitter

**Instruments and annotation** — done: labeled node, voltage readout,
voltmeter, text.

- [ ] Ammeter, ohmmeter, wattmeter, test point, data recorder, stop trigger
- [ ] Boxes, lines, scope-as-element

**Electromechanical**

- [ ] DC motor, three-phase motor, time-delay relay

### Milestone D — polish

- [ ] Mobile / touch layout
- [ ] Keyboard shortcut parity
- [ ] Import upstream's `subcircuits.html` and other side pages
- [ ] Accessibility pass on the panels

---

## 6. File format reference

Line-oriented, whitespace-separated. Element lines are:

```
<dumpCode> x1 y1 x2 y2 flags <type-specific tokens…>
```

The header is `$ flags timeStep iterCount currentSpeed voltageRange powerRange
minTimeStep`. Only `timeStep`, `currentSpeed`, `voltageRange` and flag bit 16
(show values) are modelled; `iterCount`, `powerRange`, `minTimeStep` and flag
bits 1, 2, 4, 8, 32, 64 and 128 round-trip verbatim without being interpreted.
An old header that stops after `voltageRange` gains the two missing fields on
save, which is what upstream writes too.

Unrecognised lines are preserved verbatim on load and re-emitted on save, in
their original positions, along with blank lines and `#` comments, so
round-tripping a file never loses data. A file with no `$` line and no element
this build can read comes back byte-for-byte, which is how the XML circuits
survive.

Dump codes implemented so far, with their trailing field order:

| Code  | Kind           | Fields after `flags`                                       |
| ----- | -------------- | ---------------------------------------------------------- |
| `w`   | wire           | —                                                          |
| `g`   | ground         | symbolType                                                 |
| `r`   | resistor       | resistance                                                 |
| `c`   | capacitor      | capacitance, voltDiff, [initialVoltage], [seriesResistance] |
| `209` | polarised capacitor | same as `c`, then maxNegativeVoltage (ESR only under FLAG_RESISTANCE = 4) |
| `l`   | inductor       | inductance, current, initialCurrent, saturationCurrent     |
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
| `a`   | op-amp         | maxOut, minOut, gbw, volts0, volts1, gain                  |
| `207` | labeled node   | text (FLAG_ESCAPE = 4, always set on save)                 |
| `O`   | output         | scale                                                      |
| `p`   | probe          | meter, scale, resistance                                   |
| `x`   | text           | size, text (FLAG_ESCAPE = 4, always set on save)           |

For the `t` row: the `pnp` token is `+1` for NPN and `-1` for PNP; the file sign
is the type, so a non-negative token (including `0` from older saves) reads as
NPN. The `lastVbe`/`lastVbc` tokens are restored as the initial junction state
on load, swapped against their names: `lastVbe` seeds the collector node and
`lastVbc` the emitter node. The trailing `modelName` token is optional (3 to 5
tokens occur in the wild; beta then keeps its default of 100) and is preserved
verbatim on save.

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
load; a mid-transient save still writes the load-time value, because live state
does not yet cross back over the engine boundary.

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
preserved verbatim and none of them is interpreted yet.

For the `s` and `S` rows the label token exists only when FLAG_LABEL (bit 4) is
set, and the SPDT reads it before `link` and `throwCount`, so a label shifts
both of them one token along. The port sets the bit when there is a label and
clears it when there is not, which keeps the token count and the flag in step.

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
