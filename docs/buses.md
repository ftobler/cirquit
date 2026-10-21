# Multi-bit buses

How N-bit buses work across engine and frontend.

## Bit-tagged terminals

`Element::post_bus_z(post)` (`element.rs`) returns a terminal's bus bit,
upstream's `Point.z` / `ChipElm.Pin.busZ`; plain posts default to 0.
`assign_nodes` keys its merge map by `(coordinate, bit)`, upstream's Point
equality including z.

**`post_bus_z` must live inside `impl Element for X`.** In the inherent impl
it compiles, shadows nothing, and the trait default (z = 0) merges the whole
bank into one node. The tell: all bank pins share one node id in
`element_nodes()`.

## Wires

- A wire's width is `params.busWidth`, sent as the `busWidth` param; the
  engine clamps 1..32 and builds `2*width` posts (bits 0..N-1 at each end).
  `removable_wire_pair_count()` + `removable_wire_pair(k)` are indexed trait
  methods, not a returned Vec, because both callers run every step.
- **Width propagation is frontend-side** (`web/src/model/busWidths.ts`
  `resolveBusWidths`, memoised as `cachedBusWidths` on element identity): wide
  pins seed a coordinate map (splitter bus side, bus logic input, instruction
  display, collapsed chip banks via their pin tables), widths flood through
  wires and same-named labels to a fixpoint, max wins. Effective width is
  `max(stored token, propagated)`. Consumers: `SimEngine.setCircuit` (expands
  posts and `postOffsetById`), `postsForRender(e, widths)` for render and
  export (a bus wire's end-to-end voltage reads indices 0 and width), and
  `DrawContext.busWidth` (weight 5).
- Plain wires save no width token: propagation re-derives it, and upstream
  never saves wire widths either.
- **Import direction matters.** `storedBusWidth` lives in
  `registry/elements/wire.ts`. `busWidths -> registry` is fine; a registry
  element importing busWidths creates a cycle that breaks `BY_KIND`
  construction at module init ("Cannot read properties of undefined (reading
  'kind')").

## Labeled nodes on buses

Upstream's LabeledNodeElm is a bus citizen: post count is its width, every
post at the anchor tagged with its bit, closure keys `label:text` (narrow) or
`label:text:b` (wide) (LabeledNodeElm.java:67, 99, 126-140).
`detectBusWidths` (SimulationManager.java:141-225) floods widths through wires
and same-named labels, then records declared-vs-propagated disagreements in
`busMismatchList`, drawn as bad connections.

- Engine `labeled_node.rs`: optional `busWidth` (1..32), `post_count()` is the
  width, `post_bus_z(post)` is the post index. `node_label_key(post) ->
  Option<(&str, Option<usize>)>` keys the label merge on `(text, Option<bit>)`;
  narrow labels key `(text, None)`, the old behaviour. `connects(a, b) =
  a == b`, so the floating-node pass cannot ground bit 1 through bit 0.
- **A wide label's `voltage_diff` returns `volts[0]`**
  (LabeledNodeElm.java:243). The trait default would report
  `V(bit0) - V(bit1)` once `post_count() > 1`.
- `resolveBusWidths` returns `{ widths, mismatches }`. Mismatches are
  recorded only at seeding collisions and in the final recheck, never inside
  the flood (mid-fixpoint disagreements are element-order noise).
  `badConnectionPoints` unions them.
- A lone label away from any wide coordinate stays width 1; labels learn width
  only from their coordinate or same-named labels.
- Wire width tokens are a port extension, so wire-vs-wire token conflicts are
  not mismatches; only a real wide pin disagreeing counts.
- The label def stays `postCount: 1`: junction dots read `postsOf(e)` while the
  engine boundary uses `postsForRender`. Widening the def would grow N
  junction dots per wide label. A wide label draws its box border at 4.
- XML `<ln nn=...>` is dropped; the resolver re-derives the width.

## Bus splitter is a removable wire

`removable_wire() = true` with one pair per bit, like upstream
`isRemovableWire`. The earlier 0 V source per bit made two through-connected
splitters a ring of ideal sources (singular). Per-bit currents come from wire
recovery via `set_recovered_pair_current(pair, i)`; signs unchanged.

Wire and ground current recovery key coordinates as `(position, bit)`. A
ground at a bus coordinate pins only bit 0.

## Collapsed voltage sources are no-ops

A source whose terminals both merged onto ground (a chip output drawn onto a
ground symbol) would leave an all-zero constraint row. Upstream tolerates it
because the stamp lands on the dropped ground row. The port stamps an identity
on the unknown's row so its current reads 0: the stamp pass collects the ids,
`restamp` drains them onto `Circuit::collapsed_vs`, and `try_step` hands the
set to every step-loop Stamper (`set_collapsed_sources`). The hoist matters:
the step loop builds a fresh Stamper per attempt, and without the set
`voltage_source_value` writes the driven level onto the identity row as a
phantom current. Same-node non-ground self-shorts still fail loudly.

## Bus elements

- 435 bus logic input: N posts at the anchor tagged per bit, N
  ground-referenced sources; the word lives in `e.state` and is injected as
  the `value` param.
- 437 bus transceiver: OE active-low, DIR, A/B banks MSB first, an internal
  node per bit; source side 1e8, destination 1 or 1e10; nonlinear. Width from
  `bits` (text) or `dataBits` (XML).
- Both are XML-only upstream (`getDumpType 0`); 435 and 437 are port
  extensions beside 434. 434 instruction display has all N posts on the anchor
  tagged per bit, like upstream.
- XML: `bli` -> 435, `bt` -> 437, `ins` -> 434 (body text escaped into one
  token), `rw` with `bw > 1` appends the width to each converted segment.

## Bus-mode chips (bit order 2)

Upstream ChipElm `bitOrder` 2 (BIT_ORDER_BUS) collapses each bit-pin group
onto one coordinate tagged per bit and shrinks sizeY (counter2 4 not 7, full
adder 3 not 9, SRAM/ROM 2 not 9). The text format has no home for it, so the
port uses `FLAG_BIT_ORDER_BUS = 1 << 14` (chip.rs; `CHIP_BIT_ORDER_BUS` in
`dFlipFlop.ts`), a **port extension** upstream does not define. If upstream
ever ships its own token, migrate rather than reuse.

- counter2, full adder, SRAM and ROM honour it, each with a `post_bus_z`
  where busZ equals the logical bit the pin carries. `drawChip` skips busZ > 0
  duplicates, draws the surviving lead at width 5 and labels wide pins
  `name/width` (ChipElm.java:103-129). Non-bus layouts are byte-identical.
- XML `bo="2"` sets the flag for ctr2, FullAdder, ROM and SRAM. Any other
  allowBus chip with a nonzero `bo` keeps a `# ... converted as non-bus pin
  rows` trace; `bo="1"` (LSB first) gets `# bit order stays MSB first`. Trace
  lines take no file slot.
- The td4 failure was this: without the bus layout, rails meant for EnP/EnT
  landed on a Q output, two ideal constraint rows on one node, singular.

## Test traps

- A circuit with no ground symbol references its first node, often a driver's
  output. A "shorted outputs" test needs a grounded load elsewhere, or the
  shorted net becomes ground and the test silently passes.
- Chip tests must hold active-low pins high: a floating clear sits low
  through gmin and wipes preloaded state on the first step.
