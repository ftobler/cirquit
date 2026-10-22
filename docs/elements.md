# Element models

Per-element knowledge: model equations, upstream sources, file-format quirks and traps. Every element is defined twice, a Rust model and a TypeScript registry entry joined by a `kind` string; see [OVERVIEW.md](../OVERVIEW.md) section 3. Line formats are tabulated in OVERVIEW section 6; rules shared by many lines are in [netlist.md](netlist.md).

## Junction helpers index local volts

A `Junction` helper must read the element's `base.volts` at local positions
(`volts[2]-volts[1]`), while stamps use global node ids. Indexing `volts` with
`base.nodes[k]` panics out of bounds once node ids pass the post count.

## Never seed ground

`seed_initial_voltages` must never write node 0. Guard every seeded node with
`!= GROUND` (scr.rs, transistor.rs); scractrig.txt grounds the cathode and
carries nonzero saved voltages.

## Fresh part defaults

Inductor 1 H; source and rail 60 Hz (VoltageElm.java:57). **Parity trap:** a
tokenless loaded `v`/`R` line keeps the 40 Hz file-constructor seed
(VoltageElm.java:66); parse restores `FILE_FREQUENCY = 40` when the token is
absent. AC toolbox entries carry sine, 120*sqrt(2) V, 60 Hz via
`entry.defaults`. Fresh text seeds "hello" and fresh labels "label" like
upstream's constructors.

## Info tables

`Circuit::element_scope_values(id)` walks `Element::scope_value_table`
through `scope_value` (wasm export beside `transmissionLineWave` and
`dataRecorderData`, the on-demand single-element precedent). The transistor
declares `[ib, ic, ie, vbe, vbc, vce]`, so X-Y plots and the info box cannot
drift apart; MOSFET, lamp and fuse tables should reuse this channel. Source,
rail and diode tables print signed values; zener prints "Zener diode"
(ZenerElm.java:91-96). The rms multiplier table is data; pulse rms is
`sqrt(dutyCycle)` like upstream.

## Capacitor

- **ESR is an internal node, never a folded conductance.** `Capacitor`
  (`engine/core/src/elements/capacitor.rs`) carries `cap_node`, upstream's
  `capNode2` (`CapacitorElm.java:159`): 1 for ideal, 2 once
  `series_resistance > 0`. The companion spans post 0 to the internal node and
  a resistor spans post 1 to it. Folding (`geq = 1/(1/geq + R_s)`) gives a cap
  of `C/(1 + 2*C*R_s/dt)` with no ESR dynamics.
- The terminal voltage includes the `i*R_s` drop; `step_finished` and
  `calculate_current` work off the plate voltage `volts[0] - volts[cap_node]`,
  which is what `v_prev` holds.
- Under DC the stamp adds `resistor(n1, cap_node, R_s)` only so the internal
  node's row is not all zeros (the dense LU calls that singular).
- **`initialVoltage` defaults to 1e-3, not 0** (`CapacitorElm.java:38,46`), in
  the engine and the registry `defaults`; a 2-token `c` line loads and saves
  1e-3 like upstream. `voltDiff` is restored into `v_prev`.
- `seriesResistance` is absent from `Capacitor::set_param` on purpose: an ESR
  edit returns false and forces a full reload, because it changes node count.
- Ideal-capacitor loops are damped at analysis time, see "Capacitor validate
  walk" in [engine.md](engine.md).

## Current source

- **Compliance is a Norton companion** of `i(vd) = current*0.5*(1 -
  tanh((vd - vMid)/vt))`: `current_source.rs` `do_step` stamps
  `resistor(n0, n1, 1/gres)` and `current_source(n0, n1, i + gres*vd)` with
  `gres = |slope| + 1e-6`. Direction matches `CurrentElm.java:173-174`.
  `voltage_limited_current_source_clips` pins about 5.06 V for 0.01 A / 5 V
  into 1 M.
- **Diverges from upstream.** Upstream stamps `absG = |slope*vd| + 1e-6`
  (`CurrentElm.java:166,172`), a conductance built from a current term. The
  port stamps the correct Newton linearization; both reach the same operating
  point.
- `broken = b && !isVoltageLimited()` exactly as `CurrentElm.java:102-104`: a
  compliance source keeps its companion path with no DC path.
- **A zero current is forced to 0.01 on load, frontend only**
  (`CurrentElm.java:43-44`, registry `current.ts`); a live edit to 0 stays 0
  and the engine keeps 0.

## Controlled source defaults

Fresh vcvs/vccs default to `.1*(a-b)` (VCCSElm.java:45), ccvs/cccs to `2*a`
(CCVSElm.java:39), via `defaultText`.

## CCVS (214) and CCCS (215)

- Share the VCCS text format (`inputCount`, then the escaped expression in
  `spec.label`). Inputs A+/A-, B+/B- on the west, output pair east; each input
  pair is shorted by a 0 V sensing source whose `vs_currents[k]` is upstream's
  `getCurrent(vs)`. `input_pair_count` truncates an odd input count.
- CCVS output stamps `raw(vs_row(out), vs_row(sense_k), -dx)` plus
  `raw_rhs(out, v0 - sum(dx*cur))` each Newton step. The derivative
  perturbation is the fixed 1e-9 of CCVSElm.java:124, unlike the VCCS family's
  clamped `v - last`.
- CCCS output is `current_source(O-, O+, rs)` plus a `cccs` coupling per input;
  node order O- to O+ gives the +expr sign. Its extra convergence slot is the
  output current itself. `dc_connects` ties input pairs, never the output.
- The `i` alias (`set_current_value` in `controlled_source.rs`) writes
  `values[8]` alongside `values[0]`, matching `setCurrentExprValue` inside
  upstream's derivative loop (CCVSElm.java:118-138).
- A fresh part dumps `2*a` (`CCS_DEFAULT_EXPR`), upstream's constructor
  default.

## Voltage source symbol

`FLAG_CIRCLE_SYMBOL` (bit 8) is modelled: a plain DC `v` draws the two-plate
battery (VoltageElm.java:247-253, 281-291: 8-unit leads, short plate half
height 10, long plate 16), a DC line with bit 8 draws the circled +/- symbol.
Plates take per-post voltage colours so Show Power does not wash them. Dots run
the whole `point1 -> point2`. Caption offset 16 for the battery. Fresh sources
are 60 Hz (VoltageElm constructor); a tokenless line keeps the 40 Hz seed.

## Voltage source and rail rows

- FLAG_TIME_SPEC (bit 32, VoltageElm.java:33, 495) swaps frequency/duty for
  High Time/Low Time on square and pulse. Frequency and duty stay the stored
  truth; High/Low are derived rows (`H = duty/freq`, `L = (1-duty)/freq`,
  written back as `freq = 1/(H+L)`, `duty = H/(H+L)`, guarded against zero or
  negative times like :636-641, 652-657). No new file token.
- Rows hide per waveform: sine offers frequency and phase, DC and noise
  nothing more, square and pulse the full set. Rail rows equal the voltage
  source's minus Circle Symbol, pinned by a test.
- Show Voltage captions gate on FLAG_SHOW_VOLTAGE (bit 16, VoltageElm.java:
  308-322) for sources and bit 64 for rails; the rail's DC label always draws,
  so its Show Voltage row hides on DC (VoltageElm.java:541).
- A waveform change resets pulse duty (1/(2 pi) entering pulse, 0.5 leaving).

## Antenna (`A`)

A rail whose voltage is a synthesized AM/FM waveform: three
`sin(2 pi f t)*(1.3+sin(2 pi fmod t))*3` carriers plus a `3*sin(fm_phase)` FM
term, `fm_phase += 2 pi (2200 + 100 sin(2 pi 13 t)) dt` in `step_finished`.
`reset()` leaves `fm_phase` alone (upstream rewinds only `freqTimeZero`).
`|V| <= 23.7` for every t. A loaded `A` line gains six canonical rail tokens on
save, still upstream-readable.

## Transistor (BJT)

- **The file sign is the type.** `TransistorElm.java:53,60`: `+1` is NPN, `-1`
  is PNP. Engine: `spec.param("pnp", 1.0) < 0.0` (`transistor.rs`);
  registry: `(e.params.pnp ?? 1) === -1`. A non-negative token, including the
  legacy `0`, reads as NPN.
- **Default model saturation current is 1e-13** (`TransistorModel.java:118`,
  `"default"`). 1e-16 is `"spice-default"` and would move Vbe up about 0.18 V.
  `vcrit` is recomputed from it.
- **`lastVbe`/`lastVbc` tokens seed the junctions, swapped.**
  `TransistorElm.java:65-67` sets `volts[1] = -lastvbe` (collector) and
  `volts[2] = -lastvbc` (emitter). The engine stores `last_vbe =
  polarity*lastVbc` and `last_vbc = polarity*lastVbe` so the first `do_step`
  agrees with the seeded voltages. Seeding goes through
  `Element::seed_initial_voltages`, called from `Circuit::set_circuit` after
  `assign_nodes` and before `allocate_and_stamp`; a GROUND guard keeps a
  grounded emitter at 0. Warm start only: `reset()` zeroes it.
- **The optional 5th token is the model name**, escaped like every text token
  (`TransistorElm.java:69`). 3- and 4-token lines are legal: beta stays 100 and
  the model is `"default"`. The registry re-emits the name only when present.

## Transistor power

`BipolarTransistor::power()` is upstream `getPower = (Vb-Ve)*Ib +
(Vc-Ve)*Ic`; the trait default (`Vbc*Ic`) is wrong for three-terminal parts.
The darlington sums its two internal transistors' junction powers like
`CompositeElm.getPower`. A conducting PNP reads negative currents
(TransistorElm.java:455-457).

## Darlington (400)

A composite of two transistors (`1 2 4` and `4 2 3`: base, collector, emitter,
internal). Dump is `CompositeElm.dump() + " " + pnp`: two opaque per-transistor
state tokens carried verbatim, then the pnp sign. Bit 1 is FLAG_ESCAPE, not a
flip. Gain is about `beta*(beta+2)`.

## Diode-family gmin

Junction gmin is `leakage * 0.01` below subiteration 100
(`junction_gmin`, used by diode, SCR, triac, diac, unijunction emitter, LED
array); transistors and darlington keep the hardcoded 1e-12 like upstream.
Upstream's Norton `nc = I(v) - geq*v` has no gmin term, so at the Newton fixed
point gmin cancels: converged well-posed results are gmin-invariant. Do not
write tests asserting droop at tau = C/gmin; real hold drains linearly at
Is/C.

## MOSFET legacy body terminal

- **Upstream parity:** a MOSFET has four posts only when the legacy flags word
  sets bit 32 (body diode) and bit 64 (body terminal) and clears both bit 4
  (digital) and bit 16 (hide bulk) (MosfetElm.java:106-142). Flags 96 and 97 in
  the bundled corpus (`cmostransgate.txt`, `mux.txt`, `samplenhold.txt`,
  `switchfilter.txt`) select it; a fresh part and every other word stay three
  posts.
- The body post is the midpoint of the source and drain posts, upstream's
  `body[0]`, which is the element's `point2` (MosfetElm.java:391-413). The
  frontend derives it in `mosfetPosts` and the engine from the same rule;
  `postCountOf` in `web/src/model/registry/elements/mosfet.ts` and
  `Mosfet::post_count` in `engine/core/src/elements/mosfet.rs` must agree, or
  `Circuit::set_circuit` rejects the post-count mismatch.
- **Upstream parity:** the four-post form simulates two body diodes from the
  body post to posts 1 and 2, N-channel body to each channel terminal and
  P-channel each channel terminal to the body (MosfetElm.java:496-515). Post 3
  reports `-(diodeCurrent1 + diodeCurrent2)`, post 1 adds the first, post 2
  the second, and the reported power adds both diode terms to the channel term
  (MosfetElm.java:560-562, :805-825). The three-post form keeps its single
  source-to-drain diode.
- The legacy bits stay in the saved flags word, so a save and reload keeps the
  fourth post. The model-table structural flags (`sb`, `bd`, `bt`, `sbd`,
  `dsy`) remain unmodelled; only the file-format bits above are honoured.

## MOSFET and JFET convergence

`convergence_ladder(beta, subiter, last, now)` is shared (JfetElm extends
MosfetElm): beta > 1 multiplies the difference by 100 before every branch, a
relative pass after subiter 10, loosening after 100. MOSFET
`restore_committed` re-anchors its body diodes like the JFET.

## Tunnel diode

TunnelDiodeElm.java:93-127 constants and I-V curve; reverse bias conducts
unboundedly (an upstream quirk, matched). Convergence threshold 0.01 V, step
limited to 1 V per iteration. A load line through the negative-resistance
region can stall Newton, so tests stay in the steep forward region.

## SCR, diac and triac

- SCR: on iff `ig/triggerI + ia/holdingI > 1` (the reduced form of upstream's
  `C = -icmult*ic + ia*iamult`). Anode, `aresistance` (0.0105 on / 10e5 off),
  internal node, Shockley diode, cathode; gate 50 ohm to cathode. State flips
  one step after the gate fires.
- Diac (203): two back-to-back branches, each a latch resistor (500 on / 1e8
  off) plus a default diode. Clears on `|i| < holdcurrent`, fires on
  `|vd| > breakdown`, fire wins, flips one step late.
- Triac (206): antiparallel diode pair, internal node, latch resistor; gate
  resistor 100 ohm. Clear on `|i2| < holdingI`, set on `|ig| > triggerI`.
  The `state` token is a Java boolean string.
- Reset keeps latch state for all three, like upstream's base `reset`; the
  diac saves and restores `base.current` around `Base::reset` because the
  port's shared reset zeroes what upstream leaves. The spark gap clears by its
  own upstream override.

## Triode

`ival = vgk + vpk/mu`, `ids = ival^1.5/kg1`, `ids = vpk*1e-8` when ival < 0.
Grid resistor 6000 when `vgk > 0.01` else 1e8. Grid and cathode (not plate)
clamp to 0.5 V per iteration. Defaults mu 93, kg1 680. `FLAG_FLIP = 1`,
`FLAG_DSIGN_FIX = 2` (set on fresh parts); mirroring a loaded flags-0 triode
toggles `FLAG_FLIP` like TriodeElm.flipX/flipY.

## LED array (405)

A crossbar of pure Shockley junctions (the embedded `Diode` has no series
resistance, Diode.java:22), anode on row posts, cathode on column posts, cells
iy-major. "default-led" constants Is 93.2e-12, vscale 3.73*VT
(DiodeModel.java:90). Tokens `[highVoltage] sizeX sizeY`, 0 falls back to 8x8;
grids outside upstream's dialog range 2..16 are rejected at build. Not built on
the Chip base (no outputs).

## Memristor and varactor guards

`Memristor::new` rejects non-positive or non-finite `totalWidth` and clamps
`dopeWidth` to `[0, totalWidth]` (a NaN `dopeWidth` still slips the clamp).
`VaractorCap::new` rejects non-positive or non-finite `baseCapacitance`.

## Built-in device model library

- `web/src/model/deviceModels.ts` holds upstream's diode
  (DiodeModel.java:82-116), transistor (TransistorModel.java:114-145) and
  MOSFET/JFET (MosfetModel.java:110-135) tables with exact literals.
  `internal: true` entries are hidden from pickers but still resolve when a
  file names them.
- `resolveModelParams(family, name, fileModel)`: file `34`/`32` model first,
  then the built-in table by exact case-sensitive name, else `undefined`
  (defaults kept, name round-trips). Diode family writes the four params plus
  derived `forwardVoltage`; transistor writes `saturationCurrent` and
  `betaReverse`; MOSFET/JFET only `threshold` and `beta`. The MOSFET model
  table's structural flags stay unmodelled: the legacy body-terminal bits are
  read from the element flags, never from the model row. `default-jfet` equals
  the engine's JFET defaults.
- Pickers (`FieldDef` `type: 'modelChoice'`) list `selectableModels(family)`
  sorted like upstream's `getModelList`, plus "(default)"; a loaded unknown
  name shows as a disabled option so it is never lost. `setModelName` bumps
  `revision` because model params are read at build time. The zener picker
  passes `zenerBreakdown`, so `selectableModels(family, requireBreakdown)`
  drops zero-breakdown rows like upstream's `getModelList(zener)`
  (DiodeModel.java:193-194).
- `default-led` resolves its real I-V (Is 93.2e-12, n 3.73, Rs 0.042);
  `old-default-led` resolves to the port's existing LED values.

## Switch flips: rotate nets zero

Upstream rotate is flipXY then flipY (CommandManager.java:419-429), and
`Switch2Elm` overrides all three flips with position reversal plus a
`positionFlipped` toggle (Switch2Elm.java:241-259), so a rotate nets zero on
position and parity. `rotateElement` has no kind special cases;
`flipSwitch2`/`flipDpdtPosition` are mirror-only. `DPDTSwitchElm.flip()`
reverses position and shifts both endpoints by 48; two flips per rotate
cancel, so a rigid quarter turn is exact. MBB and cross switch have no flip
overrides.

## Momentary switches

Press-and-hold arms every kind whose parse reads the momentary token: switch,
logicInput, switch2, mbbSwitch, dpdtSwitch, crossSwitch. Release toggles once
more, one step forward wrapping at posCount (SwitchElm.java:180-183), so a
two-stop switch returns to rest and an MBB (4 stops) rests on its second pole.
Release routes through `toggleSwitch` so linked twins follow. Abandoned
gestures (long-press, two-finger, pointercancel) do not release a hold; the
finger is still on the lever. The push-switch toolbox entry rests open via a
toolbox rest-state field (upstream `PushSwitchElm = SwitchElm(xx, yy, true)`).

## SPDT centre-off

An `S` line with FLAG_CENTER_OFF (bit 1) and position 2 has an open middle
stop (Switch2Elm.java:82-83, only when `throw_count == 2`). In
`multi_throw_switch.rs`, `selected_post()` returns `None` there: no source,
`voltage_source_count()` 0, no connection. The toggle cycles 0, 1, 2, 0
(`nextSwitchState` uses `throwCount + 1` positions). Dropping the current
unknown is handled by `reanalyze`. Not for the DPDT: upstream gives it no
centre-off.

## SPDT group linking and mirror

Group Number (`params.link`, 0..100) links SPDTs: `toggleSwitch` fans one
throw to every same-link switch2, mirrored by `params.flipParity`, clamped to
each twin's stops, in one set. Mirror and settled rotate reverse the lever and
bump `flipParity` (session only; never dumped, stripped from the engine
spec). The placement ghost keeps its throw.

## Cross switch (430)

Both positions conduct: 0 joins (0,1)+(2,3), 1 joins (0,3)+(2,1). Each pole is
a 0 V voltage source. `voltage_source_nodes(k)` must return the
position-aware stamped pair, or a grounded pole at position 1 tears the
closure.

## MBB (416) and DPDT (429) switches

- Ideal paths are position-aware voltage sources (the cross-switch trap):
  `voltage_source_nodes(k)` returns the pair actually stamped for the current
  position. `set_state` returns true so a throw reallocates.
- **A `resistance` edit crossing zero refuses the live path.** It changes
  `voltage_source_count`, and a live `restamp` would index `vs_closure` past
  its old size and panic. Returning false triggers a full rebuild, which
  re-serialises `params`, so the value survives
  (`mbb_switch_resistance_edit_crossing_zero_rebuilds` and the DPDT twin).
- `poleCount` clamps 2..10 in both halves (`normalizePoleCount` in the
  store's `BITS_NORMALIZERS`).
- Geometry: MBB throw 0 pinned to +16 (MBBSwitchElm.java:71-74). DPDT pole i
  at `interp(p1, p2, 0, -i*48)`.
- Linked MBBs fan out through the `toggleSwitch(id)` store action in one
  `set()`; the engine only carries `link`.
- DPDT rotate and mirror flip the throw position (DPDTSwitchElm.flip,
  256-262), and mirror also shifts the pole fan one `POLE_GAP` so it stays on
  the same physical side (`flip()` then `flipX`, 264-267).

## Relay

- FLAG_PULLDOWN (bit 16): `stamp()` adds constant `r_off` from both throw
  posts of every pole to ground (RelayElm.java:394-401); settled positions drop
  the pole-to-unselected-throw `r_off`. Every bundled relay carries the bit.
  An unwired throw gets the gmin pin plus a floating warning where upstream
  stays silent (no `hasGroundConnection` analogue).
- Legacy short-format `178` lines seed like upstream's old constructor
  (`offCurrent = onCurrent`, `switchingTime = 0`) and run
  `start_iteration_old` term by term; untouched legacy lines round-trip
  byte-for-byte.

## Time-delay relay (414)

Not a chip: the coil sense is a fixed 10k (posts 0-1), the switched path
(2-3) is re-stamped as on or off resistance each step (`nonlinear()`). State
machine in `step_finished`: powered when the sense exceeds 2.5 V, `on_state`
follows after `on_delay`/`off_delay`. Pins W1, E1, W0, E0
(TimeDelayRelayElm.java:69-77).

## Logic input

Rows beyond hiV/loV: `momentary` (live `set_param`), `ternary` (bit 1) and
`numeric` (bit 2) as flag rows that rebuild. No keyboard shortcut row (by
scope), so the keyboard toggle path never sees logic inputs. Press-and-hold
covers `switch` and `logicInput`; `releaseHeldMomentary` restores
generically.

## Logic gates as composite children

`child_kind`/`dump_fields` carry the six gates and the inverter. Gate dump
order `inputCount lastOutputVoltage highVoltage` (GateElm.java:55-61),
inverter `slewRate highVoltage`. `gate_input_count` seeds `inputCount` from
`nodes.len() - 1` when no token supplies it; otherwise a dumpless child builds
2 inputs and is dropped by the node-count check. There is no WireElm child
kind: the composite does no node merging, so the frontend collapses wires
into shared node ids.

## Chip elements: shared rules

- Engine chips use a `just_loaded` skip in place of upstream's "avoid clearing
  on first iteration" hack (Counter2Elm.java:56-57) and keep upstream's
  `read_inputs`/`execute`/`commit_clock` order.
- PISO, SIPO, seq-gen and monostable writers are lossless where upstream's
  `dump()` drops data words and counts; upstream's constructors still consume
  the extra tokens. The 188 legacy upgrade is byte-compatible: upstream's
  bit reversal is a no-op (SeqGenElm.java:59's guard is always true).
- Chip pin rows must match upstream `setupPins` (counter2: CLR/LOAD at
  `sizeY-2`, EnP/EnT at `sizeY-1`, Counter2Elm.java:86-93). Registry
  post-coordinate tests catch this class; engine tests cannot.
- Reset: latch, SIPO, PISO and SeqGen keep sticky clock and load edge memory
  across Reset (upstream `ChipElm.reset` clears only `lastClock`); DFF, JK, T
  and counters clear.

## Chip reset and load protection

`Chip` carries `sticky_clock` (latch, SIPO, PISO, seq gen): `Chip::reset`
leaves `last_clock` alone for those, because upstream's private edge memories
(LatchElm.lastLoad, SipoShiftElm.clockstate, PisoShiftElm.clockState,
SeqGenElm.clockstate) survive Reset and a held clock must not re-trigger.
DFF, JK, T, counters and ring counter clear; the monostable clears its own
state. **Diverges:** the port arms `just_loaded` (skip the first execute)
whenever any `voltage{i}` token exists; upstream only in DFF, JK and ring
counter.

## ADC, DAC, mux and demux

- ADC is full-flash with no clock: `clamp(trunc(imax*V(In)/V(+)), 0, imax)`.
  Truncation is deliberate; In and V+ are raw analog sense posts.
- DAC: `v = ival * V(V+) / ((1<<bits)-1)` with ival from bits above
  `highVoltage/2`; a custom `do_step` re-reads node voltages, so it stays
  linear (factors cached) and the output lags one step.
- Mux/demux select little-endian, combinationally. Mux `FLAG_BUS_SELECT` (8) is
  draw-only. Mux input modes: see "Multiplexer bus modes" below.

## Half adder, full adder, seven-segment decoder

- 195: optional high voltage only; S/C east, A/B west.
- 196: `bits` exists only under FLAG_BITS (bit 1); a flagless line is the
  1-bit adder and round-trips byte-exact. Editing `bits` on a flagless part
  sets FLAG_BITS in `setParam`. Carry pins: `pins[3*bits]` is Cin,
  `3*bits+1` is C (FullAdderElm.java:50-54).
- 197: `segmentType` (0/1/2 for 7/14/16 segments) after the optional high
  voltage. Upstream's `dump()` never writes it, so upstream reloads its own
  save as 7-segment; the port always writes it. Glyph tables are packed one
  segment per bit, bit 0 = segment `a`.

## Bus splitter (433)

`bits` bus-side pins share one node; each bit is a 0 V source to its own pin
(upstream merges removable wires; the port keeps sources so per-bit currents
report). `connects(a,b)` is `abs(a-b) == bits`. bits clamped 2..32. The bus
side draws every bit's lead at default width (upstream draws one 5-wide lead).

## SRAM (413) and ROM (436)

- Post order WE (SRAM only), OE, then A and D banks MSB first. Each data pin
  has an internal node holding a source for the stored bit; `do_step` stamps a
  1 ohm coupling (output enabled) or a 1e8 pulldown (write), so `nonlinear()`
  is true. `matrix_connects` joins each `(internal, data)` pair.
- Writes land while WE is low, at the address from the previous step
  (upstream's lag). ROM never writes. `FLAG_RELOAD_ON_RESET` (2) restores the
  build-time map on reset; `FLAG_HEX_DISPLAY` (4) is display-only.
- ROM's OE is at W row 0 (ROMElm.java:47-49); SRAM's OE is at E row 0.

## Analog mux (432)

Purely resistive: `r_on` to the selected input, `r_off` elsewhere or to ground
under FLAG_PULLDOWN. Upstream's pulldown pin current is `-volts[i]/r_off`,
not negated, and never sums into the output (AnalogMuxElm.java:149-151).
selectBitCount clamped 1..6; sizeX is selectBitCount+1.

## VCO

A behavioural current mirror: three voltage sources (output, a 0 V sense from
Vi to R1, 5 V to R2) plus a 1 M bleeder across the cap pins; `do_step` mirrors
the sense currents into the external cap, giving `f = (Vi/R1 + 5/R2)/(8C)`
with hysteresis at 4.5/0.5 V. `nonlinear()` is true so the closure re-stamps.

## Delay buffer

Delay defaults to 0 (the no-arg constructor never sets it,
DelayBufferElm.java:29-34); threshold 2.5, high voltage 5. `delay_end_time`
survives reset. Drawn as the inverter without the bubble.

## Composite-built elements

Comparator, OTA, realistic op-amp, darlington, unijunction, optocoupler and
crystal are composites; see [subcircuits.md](subcircuits.md) for child rules.
Unijunction (417) is DiodeElm + VoltageElm + CCVSElm + ResistorElm + VCCSElm +
CapacitorElm; its text line is bare, and upstream sets `adjustTimeStep` for it.

## Ground children in composites

`from_model` maps every model node a `GroundElm` child touches (plus node 0)
to `GROUND_NODE`. Upstream's comparator ground child is a 0 V source pinning
node 5 (CompositeElm.java:99-100); without the mapping the drive floats.

## Comparator (401)

Model `OpAmpElm 1 2 3\rAnalogSwitchElm 4 5 3\rGroundElm 5`, external
`{2, 1, 4}` (ComparatorElm.java:8-9). The op-amp's in+ wires to the V- post;
the switch to ground inverts back, so the net is a standard open-collector
comparator. `COMPARATOR_SMALL = 2`, `COMPARATOR_SWAP = 4` (bit 1 is the
composite escape flag). The glyphs use the already-swapped `hs`
(ComparatorElm.java:77-80).

## OTA supplies

Composite child dump layout is flags then `dump_fields`
(waveform, frequency, maxVoltage, ...), so maxVoltage is `split('_')[3]` of
child tokens 0 (negVolt) and 1 (posVolt) (OTAElm.java:41-42). Parse fills
params, finite-guarded, default +/-9 V; save rewrites only those two slots
(canonical `0_0_40_X_0_0_0.5`) and keeps the sixteen transistor tokens
verbatim.

## Realistic op-amp (409)

- The 32-child 741 netlist (OpAmpRealElm.java:9-17): 20 transistors, the
  compensation cap (child 20) and 11 resistors. `init741` lives in
  `opamp_real.rs` `from_spec`: cap `30e-12/(slewRate/.6)` with its voltDiff set
  to `capValue`, children 21/22 scaled by `currentLimit/.0231`, children 13/18
  beta `currentMult*100`. Tokens `slewRate capValue currentLimit modelType`.
- Posts V-, V+, out, V+ supply, V- supply; the rail posts sit at the far rail
  ends (OpAmpRealElm.java:236-248). `OPAMPREAL_SWAP = 2` keeps the supply posts
  fixed like upstream, and mirror does not toggle it (no upstream flip
  override).
- `Capacitor::set_param("voltDiff")` writes `v_prev`, so a composite can set a
  child's stored charge. Reset still reverts to `initialVoltage`.
- Model types: see "Op-amp LM324 models".

## Op-amp LM324 models

- `opamp_real.rs` `from_spec` switches on `modelType`: 0 LM741, 1 LM324, 2
  LM324v2. Netlists and `/`-separated child dumps are verbatim upstream
  (OpAmpRealElm.java:21-49). LM324 tuning: cap child 4, output resistor child
  11, output transistors [9,10,12,16], cap `10e-12/(slew/.55)`. The v2 takes no
  post-build tuning.
- Composite children `VCVSElm`/`VCCSElm` read their expression off the dump
  token (`flags_inputCount_exprString`); an unparseable child expression is a
  named build error; a missing one falls back to `.1*(a-b)`.
- **The old LM324 (type 1) latches as a follower** at the default
  currentLimit: a genuine degenerate equilibrium of the crude model, not a
  solver bug. Upstream hides it from fresh parts (OpAmpRealElm.java:270-281);
  so does the port: the picker offers LM741 and LM324v2, type 1 files load and
  simulate, and the row shows "LM324, old" as a disabled option
  (`FieldDef.outOfRangeLabel`).
- LM324v2 transistor model names resolve engine-side from `TRANSISTOR_MODELS`
  in `composite.rs` (TransistorModel.java:121-126). Slew Rate and Output
  Current Limit rows hide for v2 (OpAmpRealElm.java:288-289).

## Optocoupler (407)

Model `DiodeElm 6 1\rCCCSElm 1 2 3 4\rNTransistorElm 3 4 5`, external
`{6, 2, 4, 5}`. Upstream builds children from a null token stream
(OptocouplerElm.java:29-34), so saved child dumps are ignored; the port does
the same. The light path is the CCCS expression (OptocouplerElm.java:70-72)
scaled by `ctr`, handed to the child through `Element::set_string_param` /
`Composite::set_child_string` (strings cannot ride numeric `set_param`).
Transistor beta 700. The collector carries `(1+700)*ctr*curve`. `ctr` is
appended as a trailing token (upstream's dump never writes it); a tokenless
line keeps ctr 1 (`Number('')` is 0, so read `undefined` as missing). CTR
field minimum is 1 (OptocouplerElm.java:241).

## Crystal (412)

Model `CapacitorElm 1 2\rCapacitorElm 1 3\rInductorElm 3 4\rResistorElm 4 2`,
external `{1, 2}`. The four motional values are the element's params;
`Composite::set_param` routes each name to exactly one child (a name fallback
would hit both capacitors). The frontend re-derives the four child dumps on
save. The composite reports the branch current `-current_into_node(0)`
(CrystalElm.java:151), not the sum of children (which triples a series
branch). Fresh crystals set `CRYSTAL_SHOW_FREQ` (2), drawing
`fs = 1/(2 pi sqrt(L Cs))`.

## Transmission line

Ring length truncates like upstream's `(int)` cast; an over-long delay stops
the run. The ring is sized from `nominal_dt`. An ungrounded-line check was
deliberately skipped: it rejects three shipped circuits whose ports sit in
floating AC islands.

## Audio input (411) and data input (424)

- Samples live in a session cache (`web/src/model/sampleCache.ts`), keyed by
  `fileNum`, never in the store or undo snapshot, like upstream's static maps
  (AudioInputElm.java:48-50). `nextFileNum()` never resets and never reuses, so
  0 means "no file" and undo of a sample load restores an old number whose
  entry still exists. `clearSampleCache()` runs on `loadNetlist` and
  `newCircuit` only (CircuitLoader.java:239-240), so a loaded circuit shows
  "No file" until re-imported, like upstream.
- The engine reads samples from `spec.model` as JSON; Rust structs need
  `#[serde(rename_all = "camelCase")]` or `samplingRate` silently defaults to 0.
- Both extend RailElm: six VoltageElm tokens then three of their own. Parse
  accepts 9 or the trailing 3 (upstream writes 3); dump writes 9. Both force
  `WF_AC`. Both return 0 during the DC solve.
- Data FLAG_REPEAT (256) wraps the cursor inside the value read
  (DataInputElm.java:123-126), so `voltage()` takes `&mut self`.
- Data file format: one value per line, blank and `#` lines skipped
  (DataInputElm.java:185-216).

## Battery (438)

Port extension code (435/437 precedent for XML-only classes). SOC table
interpolation and extrapolation, coulomb counting, a polarization cap; live
state `soc` and `capVoltDiff`.

- **The SOC table is a string carrier.** `engineModelOf` passes strings into
  `spec.model` verbatim and serialises only objects. JSON-stringifying it gave
  the engine a quoted literal, zero rows and a flat 3.7 V for every chemistry.
  Rule: a param whose engine consumer reads a raw string must never pass
  through `JSON.stringify`. A wasm-boundary test asserts the alkaline 1.23 V.
- The table stable-sorts ascending at parse (duplicates keep parse order, like
  the engine's insertion sort); a table whose valid rows already ascend
  round-trips byte-for-byte, a hand-typed unsorted table normalises on save.
- **Live token name vs dump field name.** The live token `soc` differs from the
  dumped `initialSocPercent`, so overlayLiveState silently lost it at save.
  Dump prefers `params.soc ?? params.initialSoc ?? 1`. Audit every new
  live-state token against its dump field name; the capacitor only works
  because `voltDiff` is both.
- The engine models SOC below zero (no lower clamp); parse caps `soc` high only
  (BatteryElm.java:115-122). Reset restores the clamped initial SOC where
  upstream restores unclamped. `capVoltDiff` has no token: survives rebuilds,
  not files.

## Probe

- The engine `value()` (`probe.rs`) keys only on VOL and otherwise reports the
  differential; upstream reads 0 for FRQ/PWI/DUT/PER. Latent: the UI offers
  only the seven `meterChoices()` modes (ProbeElm.java:444-446), so only a
  hand-edited file shows it.
- The probe caption uses the shared `meterCaption` but ignores the Scale field
  (`ProbeElm.java:428-441`), which is parsed and dumped. Ammeter and output
  honour Scale.

## Ammeter

A 0 V series voltage source, not a removable wire, so it reports current every
step; `is_voltage_source()` is true so the CAP_V walk crosses it (upstream
`isWireEquivalent`, FindPathInfo.java:68). RMS finalises only at direction
changes, so constant DC reads 0 in RMS mode. Skips the DC pass like the probe.

## Ohmmeter (216)

OhmMeterElm extends CurrentElm, so `ohmmeter.rs` carries the whole current
source model including tanh compliance. `value()` is `voltage_diff()/current`;
zero current reports infinity, and the caption gates on nonzero current. The
info box is upstream's two-row `R = V/I` table.

## Test point (368)

`TESTPOINT_LABEL = 1` (TestPointElm.java:41), not the switch's bit. A
tokenless line loads with label `TP` (TestPointElm.java:73); the dump writes
the label only when it differs, and sets bit 1 exactly then. Upstream's
`dump()` drops meter and label; the port writes both. Each TP_ mode needs an
explicit match arm (a catch-all makes constants dead and fails clippy).

## Wattmeter (420)

Two 0 V sources: `voltage_source_nodes(k)` must return `(nodes[2k],
nodes[2k+1])` or the "VS terminal straddles closures" assert fires when the
channels sit in different closures. Power is `(V(post2) - V(post0)) *
currents[1]`. Placement width follows upstream `drag()` (WattmeterElm.java:
75-89) through the per-def `dragParams(start, pointer)` hook, called before
the axis snap discards the perpendicular component. Average power of a pure
sine converges to 0.5 W after about two mean crossings (PM_AVG).

## Data recorder (210)

Ring export is oldest-first (DataRecorderElm.java:108-114), read through
`Element::data_recorder_data`, the wasm `dataRecorderData` export and
`SimEngine.recordedData(id)`. The download button is `FieldDef`
`type: 'download'`; the file format (`# time step = ... sec` header, one
sample per line, `data-YYYYMMDD-HHmm.circuitjs.txt`) lives in the pure
`web/src/model/recorder.ts`. `dataCount` is range-checked before allocation.

## Stop trigger (408)

Upstream calls `setSimRunning(false)` from `stepFinished`; the engine cannot,
so `stop_trigger.rs` latches `stopped` and `useFrameLoop.ts` pauses when the
element state reads >= 1. Upstream's `stepFinished` re-arms on the first step
after resume (StopTriggerElm.java:92); the port's latch must survive stepping,
so it re-arms through a dedicated `clear_stop` / `Circuit::clear_stops` /
wasm `clearStops`, called by the frame loop on the pause-to-run edge without
rewinding time. A delay arms at the crossing step's end time. Meters
(including the stop trigger) are skipped during the DC operating point.

## DC motor (415)

- Two embedded `Inductor`s (the relay's `sync_ind` pattern) forced to
  backward Euler: electrical coil, armature R, back-EMF source
  `inertia_current * Kb`; mechanical inertia (L = J), friction (b), torque
  source `coil_current * K`. `voltage_source_nodes`: k0 -> `(nodes[3],
  nodes[1])`, k1 -> `(nodes[4], GROUND)`.
- The DC pass leaves the motor at rest; `calculate_current` also guards DC,
  because the inductor's DC stamp is a 1e-6 ohm short and would report a huge
  current into the first transient step.
- **Diverges from upstream (open owner call).** Upstream's speed sign is
  negative (DCMotorElm.java:152-155) and its RPM readout hides it behind
  `Math.abs`; the port negates both coupling sources for a conventional
  positive-speed machine. See [decisions.md](decisions.md).
- `gearRatio` and `tau` are draw/file only (`set_param("gearRatio")` is a
  no-op so live edits do not rebuild). Kb dumps as `params.Kb ?? params.K`
  since the torque field sets both upstream (DCMotorElm.java:251-254). A fresh
  motor's angle is pi/2.

## Three-phase motor (427)

Six posts, seven internal nodes, two voltage sources. Five coupled windings
(three stator, two rotor) stamped as a mutual-inductance Norton companion with
L diagonal `{Ls, Ls, Ls, 1.5 Lr, 1.5 Lr}` and the mutuals `M[0][3] = Lm`,
`M[1][3] = M[2][3] = -Lm/2`, `M[1][4] = Lm*sqrt(3)/2`, `M[2][4] = -Lm*sqrt(3)/2`.
Inverted densely and scaled by `dt`, not `dt/2`: `startIteration` injects only
previous currents, so it is backward Euler. Back-EMF uses
`voltage_source_value(-vs1)` because the stamp constrains
`V(GROUND)-V(node)`. Tokens `Rs Rr Ls Lr Lm b [J]`. Skips the DC pass.

## Motor protection switch (428)

Three channels, each a leaky I^2t integrator like the fuse (`heat += i^2 dt;
heat -= dt*i2t/3`); any channel over `i2t` blows the shared flag. Heat reads the
previous step's current, so the trip lags a step. Defaults 0.0613 ohm, i2t 6.73
(Littelfuse 218). It drives every relay contact sharing its label: intact is
position 1 (closes NC), unlike the relay coil's `1 - switchPosition`.
