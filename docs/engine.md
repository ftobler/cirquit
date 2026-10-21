# Engine and solver

How the Rust engine builds, solves and steps a circuit. Architecture and the wasm boundary are in [OVERVIEW.md](../OVERVIEW.md) section 1; per-element models are in [elements.md](elements.md).

## Node numbering and matrix rows

Node 0 is the reference and gets no matrix row. Node `k` owns row `k-1`;
voltage-source unknown `j` owns row `nodeCount-1+j`. Ground symbols are
resolved by remapping their component onto node 0; a 0 V source per ground
symbol instead gives duplicate constraint rows and a singular matrix when two
grounds share a node.

## Closures (per-component matrices)

The engine solves per-closure systems, not one global matrix.
`engine/core/src/closure.rs` `build_closures` (port of upstream
`calculateClosures`, SimulationManager.java:710-791) splits the merged node
graph into connected components of the matrix graph, each with its own
`LinearSystem`. Networks that share only ground solve independently, and each
linear closure is factored once at build.

- **`Element::matrix_connects(a, b)`** (port of `getMatrixConnection`,
  CircuitElm.java:1286-1289) defaults to `connects` and is overridden to true
  on exactly the elements whose stamps couple rows `connects` keeps apart:
  op-amp (input columns into the output VS row), MOSFET (gate column into the
  channel rows), the three transformers (mutual VCCS), and the current source
  (the Norton companion; `connects` stays false so a source never rescues a
  floating node). Removing an override makes its guard test fail or panic on
  the "stamp straddles closures" `debug_assert`.
- **Stamps route per node, not per element.** A relay's `connects`
  (`a/3 == b/3`, RelayElm.java:570-575) joins each pole group and the coil
  separately, so one relay spans several closures. The Stamper routes
  node-based ops (`node_pair`, `node_rhs`, `conductance`, `resistor`,
  `current_source`, `vccs`, `voltage_source`) by each node's own closure, like
  upstream's `stampMatrix` (SimulationManager.java:1229-1268), and a stamp
  straddling closures trips a `debug_assert`. Only raw-row ops (`raw`,
  `raw_rhs`, `node_row`, `vs_row`) use the active closure set by
  `set_current`, and only the op-amp uses them.
- **Voltage-source rows.** `vs_row`/`vs_closure` are built in
  `build_closures`: a VS joins the closure of the terminal it stamps, preferring
  the non-ground first terminal (upstream `VoltageSource.assignMatrix`,
  VoltageSource.java:18-25). The hook is `Element::voltage_source_nodes(k)`,
  default `(nodes[0], nodes[1])`, overridden by the SPDT to `(common, selected
  throw)` and by the rail to `(GROUND, nodes[0])`. The SPDT override is
  load-bearing: with a grounded common, the first non-ground post is the other
  throw.
- **`restamp` is the rebuild point.** It rebuilds closures, stamps each
  element with `set_current` first, adds GMIN pins to each node's own closure
  and snapshots every closure. Per-closure `last_x` re-seeds to zero only when
  closure sizes change, so a halved retry or `set_param` restores from the last
  committed step. `write_back` copies closure vectors into the public
  `node_voltages` and `vs_currents`. `reanalyze`, `reset`, `set_param` and
  `set_state` all re-run it, so a switch throw recomputes membership.
- Every closure takes the circuit's global `nonlinear` flag, like upstream
  (SimulationManager.java:976-983). A singular closure is rejected at
  `set_circuit` by the eager build-time factor.
- `LinearSystem` counts LU multiply-adds (`flops()`); `Circuit::factor_flops()`
  is the deterministic speedup measure used by tests instead of wall clocks.

## Constant-row elimination (`simplified.rs`)

A nonlinear dense closure whose `do_step` rewrites only a few rows caches a
factor of the constant bulk and solves a small reduced system per Newton
iteration. Upstream's old `simplify` is gone from the modern reference, so this
algorithm is the port's own.

- Per epoch it solves `(A_RC - A_RD*E) x_C = b_R - A_RD*A_FD^-1*b_F` and
  back-substitutes `x_D = A_FD^-1*b_F - E*x_C`, where R are the changing rows,
  C their own diagonal columns, D the rest, `E = A_FD^-1 * A_FC` precomputed.
  `A_FD` is factored once; the reduced matrix per iteration.
- **Detection reuses the Stamper.** `set_recording` (`stamp.rs`) records every
  coefficient stamp's `(closure, row, col)` on Newton iteration 0 of a restamp
  epoch, value-independently (a 0.0 stamp counts, so a MOSFET in cutoff still
  marks its rows). RHS-only ops never record. No extra `do_step` runs, so the
  op-amp and logic gates' deterministic rng sequences are not perturbed.
- **Gating:** only nonlinear dense closures; `try_build` needs `fixed >= 8`,
  `changing <= 32`, `changing*2 <= n`. `SimOptions.simplify` (default true)
  disables it.
- **Soundness is fallback-driven.** Three guards route to the full solve and
  mark the closure unsimplifiable for the epoch: a fixed row drifted from the
  snapshot (state-dependent row sets like a latch's output-enable flip), a
  singular or non-finite reduced solve, or a gross full-system residual. The
  fallback reproduces the unsimplified path bit for bit.
- The factor-flop ratio overstates the win (26.5x on the `fan 12x12 + diode`
  bench row); per-iteration O(n^2) scans make the real steady-state win about
  1.5x to 2x. `closure_reduced_rows()` reports the reduced size.
- **The fixed block must be square.** It is `fixed_rows x fixed_cols`, so
  choose `changing_cols` as the changing rows' own diagonal positions (always
  |R| columns), never "the columns the changing rows touch": an op-amp's single
  VS row writes its own column plus two input columns, which gives a
  rectangular `Aff` and an out-of-bounds panic. The other columns a changing
  row writes land in `A_RD` and fold in per iteration via `A_RD * E`.

## Sparse backend

`engine/core/src/sparse.rs` is a left-looking sparse LU with column partial
pivoting and row scaling over CSC, the same family upstream ships
(SparseLU.java, EJML's solver) at the same 150-row threshold with no column
ordering. Dense stays the default below the threshold.

- **`Solver` is the seam.** `matrix.rs` `enum Solver { Dense, Sparse }` mirrors
  `LinearSystem`'s surface, so stamps never know the backend. Unboxed on
  purpose: it sits on the per-frame stamp hot path.
  `Circuit::closure_backends()` exposes the choice for tests.
- `SimOptions.solverType` (`Auto`/`Dense`/`Sparse`, default Auto) forces a
  path headlessly; Auto picks sparse at `SPARSE_THRESHOLD = 150`
  (SimulationManager.java:46).
- **The accumulator is a monotone pair set** (`Vec<BTreeMap<usize, f64>>`).
  `add` inserts a pair even for 0.0, so once introduced it stays until resize.
  That keeps `restore()` structure-preserving: it rewrites snapshot values and
  zeroes (never removes) pairs the snapshot never wrote, which is how the
  op-amp's `do_step`-only columns clear between iterations. A structure
  version bumps only on a new pair, so the CSC conversion is skipped once the
  pattern stabilises.
- The numeric pass computes each column's reach by DFS over the factored L
  (Gilbert-Peierls), pivots on the largest `|x| * scale[row]` with first-seen
  ties (matching dense strict `>`), and row-scales by `1/max|row|` like the
  dense path. NaN or Inf poisons the factor.
- **The solve permutes only `b`** (`L U = P A`), so no final un-permute.
- **The sparse singular decision is one ulp sharper than dense.** The sparse L
  diagonal is exactly 1.0, so an exactly singular matrix reports Singular
  where dense may factor a 5.5e-17 residue pivot and solve to megavolts. Do
  not relax the sparse pivot test.
- `resolve_stuck_wires` uses `LinearSystem` directly (tiny, always dense).
- Minimum-degree column ordering is not implemented; the 2D mesh row of the
  benchmark is its target.

## Column ordering

`engine/core/src/ordering.rs`: minimum degree over the pattern of `A + A'`,
explicit elimination graph, degree buckets with lazy deletion. Computed in
`SparseLU::symbolic`, so it reruns only when the structure version moves.
`L U = P A Q`; `SparseSystem::solve` scatters `x[q[k]] = z[k]`. The ordering
runs on the interactive path (every edit), so keep it near-linear: the first
O(n^2) version added about 1 s to a 9902-row build. `FILL_BUDGET` (4e6
clique-edge insertions) abandons ordering for near-dense closures.

## Switch state changes reallocate

Opening a switch removes its current unknown, so `set_state` reallocates the
matrix instead of re-stamping. `set_param` returns true only when the element
recognised the name ("accepted"); unknown names must return false or the UI
cannot tell a dead slider from a live edit. Only `set_state` keeps the
"needs reallocation" meaning.

## DC operating point

- Reactive elements stamp differently under DC (capacitor open, inductor
  short), so the matrix is built for DC, solved, then rebuilt for transient
  stepping.
- The operating point commits reactive state: capacitor and inductor
  `step_finished` run for the DC solve too, so the transient starts
  pre-charged, as upstream's unguarded `stepFinished` leaves it. Pinned by
  `dc_solve_charges_the_cap_before_the_first_transient_step`,
  `dc_solve_carries_the_inductor_current` and
  `dc_solve_freezes_ac_sources_at_bias`. The elements that still skip the DC
  pass are the probe (a DC snapshot would pollute its accumulators) and the
  transformer (it keeps file-seeded winding currents).
- A failed DC solve resets every element and clears `node_voltages`
  (`circuit.rs` `solve_operating_point`), so the transient starts uncharged
  instead of from a diverged Newton iterate (a current source into a reverse
  diode leaves about 1e12 V otherwise). Pinned by
  `failed_dc_solve_restarts_from_initial_conditions`.
- `autoDC` defaults off, matching upstream's `autoDCOnReset`
  (CircuitLoader.java:56): `DEFAULT_SETTINGS.autoDC` and
  `SimOptions::default()` are both false. A fresh circuit keeps its charging
  transients and the 1e-3 capacitor self-start seed; a file with header bit 128
  runs the solve. `fresh_lc_tank_self_starts_under_default_options` pins it.
- Node assignment runs once, before DC (`Circuit::set_circuit`: `assign_nodes`,
  `allocate_and_stamp`, `solve_operating_point`), so `internal_node_count()`
  cannot depend on `ctx.dc_analysis` the way upstream's
  `getInternalNodeCount()` can.

## Find DC Operating Point

Upstream is `dcAnalysisFlag = true; resetAction()` (CommandManager.java:
361-364): a full rewind plus one frame solved under DC models. The port's
`Circuit::find_dc_operating_point` wraps reset() under a temporarily-true
`autoDC` and restores it before the error check, so even Err puts the setting
back. `solve_operating_point` returns `Result<bool, String>` (converged,
degraded, singular message).

- Two ideal sources fighting over a node are rejected by `set_circuit`'s eager
  factor, so a fresh build never reaches the Err arm; it is reachable after
  post-build topology changes (restamp never factors).
- wasm throws `JsError` on Err, else returns "found" or "degraded"; the facade
  maps to null, "degraded" or an error string. Success and degraded are
  notices; only hard errors are sticky. **Diverges**: no force-start at t = 0,
  banners instead of upstream's pausing `stop()`.
- `solve_operating_point` routes `Stopped`/`BadStamp` distinctly: restore
  `dc_analysis`/time and restamp transient closures, so a failed DC reset never
  leaves DC-mode stamps behind (a test reads the capacitor diagonal from the
  closure matrix).

## Adaptive timestep

- Halve-first like upstream (SimulationManager.java:1391-1400): the shrink
  guard is `step / 2 >= min_time_step`, so attempted steps are exactly
  `{init/2^k : >= min}`. Budgets are port-side: 1000 iterations while
  shrinking, 5000 at the floor.
- Doubling seeds `good_iterations = 100` per frame and checks at the top of
  the step (SimulationManager.java:1311-1318), and requires
  `options.adaptive` like the halving arm.
- `restore_committed()` runs after `set_time_step` in both arms so a retry
  keeps its warm start.
- `SimCtx::nominal_dt` carries the configured step. Use it for anything sized
  or clamped by the nominal step: scope capture reset keys on it
  (Scope.java:598-600), transmission-line ring size, the AC/clock frequency
  clamp, and sample-gated elements (probe, test point, data recorder,
  transmission line sample once per nominal step, like upstream's
  `timeStepCount` bucket, SimulationManager.java:1414-1419).
- A restamp failure during halving or doubling propagates as non-converged
  plus the error side channel.

## Atomic set_circuit

`set_circuit` builds elements, ids and the id index into locals and commits
after the loop, so a mid-loop rejection leaves the previous circuit solving.
Options, warning clears, adaptive carry and ctx commit eagerly by design.
The element-count guard runs above every `with_capacity` reservation.
Post-commit failures (row cap, singular factor) still leave a half-initialised
list.

Warnings are owned by whole-analysis passes: `reset` and `reanalyze` clear the
vector first, so repeated switch throws do not accumulate copies.

## Facade bookkeeping is transactional

`SimEngine` (`web/src/engine/simulator.ts`) stages `indexById`,
`postOffsetById` and `scopeOrder` locally and publishes only after
`setCircuit` succeeds; a refused build leaves every map describing the
previous circuit. Element state tokens key off element id, never positional
zip.

## Read-side host and the node-number mirror

Live values reach the read side through `SimHost`
(`web/src/engine/simHost.ts`), never through a `SimEngine` held in the store.
The browser host (`web/src/ui/canvas/browserSimHost.ts`) reads the frame loop's
per-frame cache; step 4's headless runner owns its own build and synchronous
step. The store holds the host under `simHost`, set through `setSimHost`.

`SimHost` exposes `nodeVoltages()` indexed by the engine's node number but not
the post-to-node map, so `web/src/model/nets.ts` `assignNodes` mirrors the
engine's `assign_nodes`: terminals merge on coordinate plus bus bit, a labeled
node joins same-named labels, wires, closed switches and bus splitters merge as
ideal shorts, every ground pins its component to node 0, and with no ground and
no one-post voltage source the first node becomes the reference. This is a
deliberate duplication of engine logic, and
`web/src/commands/queries.engine.test.ts` pins the mirror against the engine's
own `elementNodes()` for a real build, so a divergence fails a test rather than
silently mis-numbering a net.

## Ground fallback

With no ground symbol, upstream's `setGroundNode` falls back to the first
element's first node only when the circuit has no rail
(SimulationManager.java:517-528). The port matches: any one-post voltage source
suppresses the fallback, otherwise a rail becomes a ground-to-ground row.
Pinned by `two_rails_without_a_ground_symbol_drive_their_difference`.

## Floating nodes

Floating subcircuits are pinned to ground per node with a 10 nS conductance
rather than erroring (upstream's 1e8 ohm per-node pin).

## Broken current sources

`Circuit::check_broken_sources` unions on `Element::dc_connects` with the same
private `UnionFind` used by `assign_nodes`, `floating_nodes` and wire-current
recovery. Ground paths count because ground symbols share node 0. The default
`dc_connects` is `connects`; the capacitor overrides it to false. `restamp()`
recomputes the nonlinear flag and re-runs `check_broken_sources` because a live
`maxVoltage` edit flips a current source's `nonlinear()`.

**Diverges from upstream.** Upstream's `FindPathInfo.java:84-91` traverses an
inductor only when its current matches the source's within 1e-10. The port's
union-find runs before any solve, when currents are unknown, so it always
traverses inductors. A current source whose only DC link is an inductor
carrying a different current is broken upstream and not here. Inherent to the
pre-solve design.

## Open current-source outputs are pinned

An ideal current source into an open load (qam-256: a VCCS into an open
analog switch, 2e-10 S) solves to megavolts, which couples into op-amp
constraint rows and never converges. **Diverges from upstream**, which
diverges on the same file.

`Circuit::pin_open_current_outputs` runs after each stamping pass: for every
`current_output_nodes()` terminal whose stamped load diagonal is below
`OPEN_LOAD_G` and whose previous voltage exceeded `PIN_RUNAWAY_V`, it stamps
`OPEN_PIN_G` to ground. Stamping before the solve is essential; a post-solve
clamp leaves the megavolt in the matrix.

- `OPEN_LOAD_G = 1e-8` S equals GMIN, so a gmin-pinned broken source (strict
  `<`) is never touched. `PIN_RUNAWAY_V = 1e4` V: corpus current-source outputs
  never pass 15 V. `OPEN_PIN_G = 1.0` S: the pinned node reads about the
  source current in amperes.
- The pin is sticky: `open_pinned` remembers pinned nodes across iterations,
  otherwise the pin toggles every other iteration. The load check re-runs each
  iteration so a node that gains a real load unpins. `reanalyze` clears it.
- Linear closures get the pin stamped into the cached matrix plus
  `invalidate`, or the stale LU ignores it
  (`linear_circuit_pins_an_open_current_source_output`).
- Composites do not implement `current_output_nodes`, so a current source
  inside one is never pinned (same blind spot as `check_broken_sources`).

## Capacitor validate walk

Port of upstream's `CapacitorElm.validate()` path checks.
`cap_v_path`/`cap_v_visit` and `validate_capacitors` live in `circuit.rs`, a
walk over the merged node graph shaped like `findPath`/`checkElm`
(FindPathInfo.java:26-104). The DFS is iterative so deep chains cannot
overflow the wasm stack.

- The SHORT check is not a walk: wires and closed switches are already merged
  by `assign_nodes`, so a short is `nodes[0] == nodes[1]`, which calls
  `shorted()` (zeroes `v_prev` and `i_prev`).
- CAP_V accepts `is_ideal_capacitor() || is_voltage_source()`, so a cap across
  a rail is damped. Damping is 0.1 ohm (CapacitorElm.java:285).
- Element order matters: a parallel pair damps exactly one member, like
  upstream's `validateCircuit` order (SimulationManager.java:807-809).
- `set_circuit` and `reanalyze` run up to 10 rounds of `assign_nodes` plus
  `validate_capacitors` (SimulationManager.java:944-947), since damping adds an
  internal node. `reanalyze` needs it because closing a switch can complete a
  cap loop.
- The damped 0.1 lives in engine state only; a save writes the params value.
  Files that record the 0.1 keep it (`cappar_recorded_pair_is_left_alone`).
- The real ringing case is a cap loop through a voltage source (the cap
  current flips sign every step at Nyquist), pinned by
  `ideal_capacitor_loop_settles_instead_of_ringing` and
  `cap_across_a_rail_is_damped_by_the_cap_v_walk`.

## Wire current recovery

Wires are merged out of the matrix, so their currents are recovered afterwards
for display only (`recover_wire_currents` / `recover_ground_currents` in
`circuit.rs`): a linear leaf-peeling queue over a coordinate adjacency built
once per topology change, cached on `Circuit` and keyed by a `topo_version`
bumped on `set_circuit`/`reanalyze`. Cyclic remnants go to the minimum-norm
`resolve_stuck_wires` (Gram solve capped at 256 coordinates). Self-loops read
0 like upstream.

- **Never resolve a wire from a ground-only coordinate.** The reference plane
  spans many coordinates, so a coordinate holding only a ground symbol says
  nothing locally; `can_resolve` takes a `ground_only` mask and pushes the
  wire to its far end. Without it a wire into a lone ground reported zero or
  reversed current depending on its orientation
  (`wire_into_a_pure_ground_reports_its_current`).
- **Every element must report `current_into_node` for every post.** The
  default returns 0 for `post_count() != 2`. One-post sources to ground (rail,
  var rail, sweep, ext voltage, antenna, logic input) override it to
  `+current` at post 0 (LogicInputElm.java:177-179), or wires off them read
  zero (`wires_off_a_rail_carry_the_rail_current`). SRAM data pins report real
  currents where upstream reports 0, so wires on them resolve.

## Stuck wire loops

`resolve_stuck_wires` caps one component's Gram solve at
`MAX_WIRE_LOOP_SOLVE = 256` coordinates; past it the zero-current fallback
stands (upstream's "wire loop detected").

## Ground current

`recover_ground_currents` runs after every solve and after the wire pass: it
sums each non-ground element's `current_into_node` at the ground's post
coordinate and splits the net evenly among symbols sharing it. The value sits
in `base.current`, so scopes read it like any element. A 0 V source per
ground was rejected: grounds already merge onto node 0, and upstream recovers
ground current through `calcWireCurrents` too (GroundElm.java:103-109).

## Controlled sources: first solve after reset

`ExprSource::primed`: the first `do_step` after `reset()` stamps the source
at its current value with no couplings. A clamped expression's first secant
otherwise runs against reset state where inputs sit exactly on clamp limits,
and Newton flip-flops between rails forever (cs-opamprail). `reset()`
re-primes.

## Transformer coupling of 1

`compute_coefficients` clamps k strictly below 1 by 1e-6, so `couplingCoef ==
1.0` cannot divide by a zero pivot; `invert()` keeps true division so a real
singular matrix still surfaces `BadStamp`. Transformer windings stamp as DC
shorts during the operating point like other reactive elements.

## Stop requests

`Stamper::request_stop` gives elements a way to stop the run
(`StepError::Stopped`, bypassing halve and retry): an over-long
transmission-line delay stops instead of clamping. Non-finite stamps are
tallied and surface as `StepError::BadStamp`.

## Hostile input

The engine rejects or clamps before allocating: zero or non-finite resistance
(named build error, where upstream dies loudly), non-positive or non-finite
C, L, inductance and transformer ratio, memristor widths, varactor base
capacitance, LED array and custom transformer sizes (32 coils), data
recorder, seq-gen and seven-segment counts, composite terminal slots against
`MAX_MATRIX_ROWS`, expression parser depth (`MAX_EXPR_DEPTH = 64`), shift
counts masked to five bits like Java (Expr.java:89). `Expr::eval` and its
`Drop` walk an explicit stack, so long flat chains cannot overflow the wasm
stack. A Rust panic is caught by the frontend `frameSafely` trap guard
(banner, frame loop paused, refused builds not retried every frame);
`SimEngine.create()` checks an `ENGINE_VERSION` handshake.
