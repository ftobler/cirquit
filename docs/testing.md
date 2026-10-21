# Testing

How the test suites are organised and the traps in writing them. The gate is `just ci`; see [AGENTS.md](../AGENTS.md).

## What the suites guard

- `roundtrip.test.ts` re-decodes each corpus element and its re-dump and
  compares kind, coordinates, canonical flags, model name, text and every
  param: the "never lose data" rule at payload level.
- Corpus golden asserts pin param mapping and `posts()`/node-merge geometry
  for real files.
- The topic files in `engine/core/tests/` hold the analytic per-element tests that
  catch stamping sign errors.
- `styleScan.test.ts` allowlists files that set inline styles
  (`DYNAMIC_STYLE_FILES`).
- The corpus test passes `scopes: []`, a known blind spot for scope
  registration regressions.
- Import cycles: none at runtime across `web/src` (the builder half of
  subcircuits lives in `io/subcircuitBuild.ts`; scope helpers in
  `web/src/engine/scopeModel.ts`, value tokens in `io/netlist/valueTokens.ts`). Keep
  it that way.

## Engine guard tests must discriminate

A guard test must fail without the code it guards. Examples from the closure
work: the op-amp `matrix_connects` guard needs a no-feedback comparator (a
feedback resistor joins the nodes anyway); the transformer guard reads a
loaded secondary at the DC operating point (an open-secondary sine is coupled
one step late through the RHS and still passes); the current-source guard puts
each terminal in a separate isolated network. Use deterministic measures
(`factor_flops()`, exact node voltages) instead of wall clocks.

## Timing in engine tests

`do_step` reads the previous step's `volts[]`, so an input edge is seen one
step late, and `ctx.time` accumulates float error (1000 steps of 1e-5 land at
9.99999999999976 ms). Assert with a step or two of margin, not on exact edge
steps.

## Corpus golden report

`web/src/io/corpus-report.json` is a golden; a kind flipping from missing to
modelled changes it and the corpus test fails until regenerated with
`just corpus`. The report test is gated behind `CORPUS_UPDATE=1` for writes.

## Benchmarks

`engine/core/tests/benchmarks.rs` runs inside `cargo test --workspace`, so it
gates in `just ci`. `just bench` runs the same binary with `--nocapture
--test-threads=1` and prints a table; its ms columns are informational and no
wall-clock value is ever asserted. Builders (`fan`, `resistor_chain`,
`resistor_mesh`, `diode_chain`, `fan_with_nonlinear_arm`) live in
`tests/common/mod.rs`. `Circuit::closure_rows()` and `closure_flops()` are
test hooks; `closure_flops()` must sum to `factor_flops()`.

- **Exact where the structure is the promise:** closure rows and backends,
  factor-once flatness of linear closures across `run(10)`, closure
  decomposition, dense > sparse * 1000 on the 40x40 fan.
- **Ranged where an LU optimisation legitimately changes counts** (fan
  100x100 in [1e4, 1e7], mesh 30x30 in [1e5, 4e6], and so on). A legitimate
  optimisation may re-pin a range in the test comment; the exact assertions
  stay exact. The nonlinear and mixed rows are generous upper bounds on
  purpose; do not tighten them to today's values.
- Benchmark reads rely on flops resetting per `build_closures`; re-verify the
  read points if restamp ever reuses systems.

## Clippy gate traps

`just lint` runs clippy with `-D warnings`. A struct field written but never
read fails it: delete the field rather than prefixing `_`. `for i in 0..N {
arr[i] }` trips `needless_range_loop`; use iterators. `box` is a Rust keyword:
the module is `pub mod r#box;`.

## Formatting

Do not run `npm run format` or bare `prettier`. Prettier is installed but not
in `just lint`, and it collapses the two-space inline comments the style rules
require. Format Rust with `cargo fmt`; match TypeScript style by hand. `just
format` reformats the whole tree, so do not use it to fix one lint failure.
