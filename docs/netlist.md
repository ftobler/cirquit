# Netlist format rules

Rules for reading and writing upstream's `.txt` format that cut across elements. The per-code token table is [OVERVIEW.md](../OVERVIEW.md) section 6. The prime rule: loading and saving must never lose data, and unknown lines are preserved.

## Defaults seed params before parse

The loader seeds `params` from the registry `defaults` before `parse` runs, so
an omitted trailing token loads as the upstream default and saves back.

## Strict element lines

All five leading tokens (four coordinates and flags) must be finite on a
known-code element line, else the line degrades verbatim to passthrough with
its slot kept and a load warning (CircuitLoader.java:186-211's per-line
catch). Fractional, exponent and hex coordinates load by choice. Coordinates
past i32 range degrade the one line. `i32::MIN` is accepted. The tokenizer
splits on ASCII whitespace only, so NBSP-bearing tokens round-trip.

## Header flags

`parse.ts` decodes header bit 2 into `settings.smallGrid` and `serialize.ts`
recomputes it. The `headerFlags` passthrough mask in `headerLine` lists every
bit the port models; a newly modelled bit must be dropped from the mask too,
or the setting and the passthrough disagree. Bit 32 (afilter linear scale) is
unmodelled and rides through. Small grid is circuit-borne (bit 2), not an app
pref: `gridSize(s)` is `s.smallGrid ? 8 : 16`.

## Boolean tokens

Upstream readers like `Boolean(String)`/`parseBoolean` are case-insensitive;
one shared `boolToken` helper reads momentary, retriggerable, blown, triac
state and counter invert-reset that way. Position compares stay
case-sensitive (upstream `compareTo`). Saves write lowercase. Legacy boolean
position tokens on `L` lines load inverted ('true' is low, SwitchElm.java:
56-62, LogicInputElm only).

## Waveform codes

0 DC, 1 sine, 2 square, 3 triangle, 4 sawtooth, 5 pulse, 6 noise.

## Zero-post elements

Scope (403), line, box and text annotations have `post_count() == 0` and
`connects() == false`; the engine handles empty node lists everywhere. The TS
registry must match with `posts: () => []` or the post-count guard trips. Never
give a decoration posts: a wire dropped on its endpoint must not merge.

## Lossless writers where upstream's text dump drops data

Thermistor, LDR, mux select count, PISO/SIPO words, seq-gen, monostable,
seven-segment decoder `segmentType`, SRAM/ROM contents: upstream's
constructors read these tokens but its `dump()` does not write them. The port
writes them in constructor read order, so upstream can still parse the
output. Treat a missing token on load as the constructor default.

## Fresh comparator and OTA lines carry child dumps

A fresh 401/402 used to save a line ending after the flags, which upstream's
`loadComposite` throws on. The registry emits upstream's demanded tokens
(comparator 3, OTA 18 with the two rails derived from params), keyed on an
empty `model` list, so a bare line is repaired on the next save. A knowing
exception to "never lose data": the preserved bytes were a file upstream could
not open. The optocoupler is exempt.

## Capacitor `c` and `209` lines

The ESR token is conditional on `209` and unconditional on `c`.
`capacitorHead` reads `capacitance, voltDiff, [initialVoltage]`;
`capacitorParse` reads `seriesResistance` whatever the flags say, while
`polarCapacitorParse` honours FLAG_RESISTANCE because `maxNegativeVoltage`
follows on the same stream (`PolarCapacitorElm.java:13-17`). Saving ORs bit 4
in like `CapacitorElm.dump()` (:69-72).

**Diverges from upstream on read.** `cappar.txt` carries a flagless 0.1 ESR:
it is upstream's post-`validate()` state written by a build that did not yet
set the flag. Following upstream's conditional read literally loses it.

## Chip lines

- ADC/DAC read `bits` then an optional `highVoltage` under
  `CHIP_CUSTOM_VOLTAGE` (ChipElm.java:51-56). Mux/demux read the optional
  `highVoltage` first, then the select count (default 2). Upstream's mux never
  overrides `dump()`, so the count survives only in XML upstream; the port
  appends it in constructor read order.
- Param-name divergence accepted: mux uses `bits`, demux `selectBits`, for the
  same positional token.

## Mux trailing tokens

The `<inputMode> <dataBusWidth>` pair is recognised only when exactly two
extra tokens trail and the first is 1 or 2; a lone trailing token is
`dataBusWidth`. Mode 0 is individual, 2 is bus/bus
(MultiplexerElm INPUT_MODE_BUS_BUS); mode 1 (bus in, single output) has no
text-format home and is treated as mode 0; the XML converter leaves a
`# mux im="1" not modelled` trace.

## Memory contents stream (`413`, `436`)

`addressBits dataBits` after the optional high voltage, then runs of
consecutive addresses each closed by `-1`, the whole stream closed by `-2`
(SRAMElm.java:55-70; ROM identical). Upstream's text `dump()` drops widths and
contents; the port writes them. The frontend flattens runs into
`addr{i}`/`val{i}` pairs and the dump regroups consecutive addresses, which
recovers the runs. The inner run loop must consume the `-1`, or the outer loop
reads it as a run start and ends early.

## Memory contents editor

`web/src/model/memoryContents.ts` ports SRAMElm `contentsToString`
(:169-197: runs of consecutive addresses, at most 8 per line, zero or gap ends
a run, hex addresses bare, values masked and two-digit padded) and
`parseContentsString` (:199-224). Where upstream skips a bad line silently,
the port reports the first bad line, and a value past the data width errors.
`setMemoryContents` replaces every `addr*`/`val*` pair atomically and bumps
`revision` (the engine reloads contents at build).

## SRAM binary load

`parseNumber` order is `0x`, bare radix digits, then `0b` (upstream
902f965). `bytesToHexRun` matches SRAMLoadFile.java:41-44 including its
128000-byte guard. Loaded bytes mask to the data width (upstream stores raw
ints); text entry keeps the stricter refusal. The contents textarea uses
token-stamped drafts (`draftForToken`) so a stale draft cannot clobber a binary
load on blur.

## Relay legacy lines

See "Relay" in [elements.md](elements.md).

## Diode model lines (`34`)

- A `34` line is a diode-model library entry, not an element, and takes no
  scope index (CircuitLoader.java:175-178). Format: `34 <escaped name> <flags>
  <saturationCurrent> <seriesResistance> <emissionCoefficient>
  <breakdownVoltage> [<forwardCurrent>]` (DiodeModel.java:338-341). `parse.ts`
  dispatches it before the element lookup into a `Map<string, DiodeModel>`;
  a repeated name overwrites (DiodeModel.java:53-59). The line still rides
  through passthrough, so a save re-emits it in place.
- Resolution is a second pass after the full read (a `34` line can sit below
  the element naming it). `diode`, `zener` and `varactor` share it (they
  extend DiodeElm). A hit writes the four params and derives
  `forwardVoltage = n * 0.025865 * ln(1/Is + 1)` (DiodeModel.java:32,
  332-336), so a later value-form save writes the real drop. A miss keeps
  defaults (`getModelWithNameOrCopy`, DiodeModel.java:62-76).
- Resolvable needs `saturationCurrent > 0` and `emissionCoefficient > 0`
  (else the derived drop is Infinity); a bare `34` with no name degrades to
  preserved but unresolvable.
- Editing any of `DIODE_MODEL_PARAMS` drops the element's `modelName` for all
  three kinds, so the next save writes the value form instead of a stale name
  that resolution would re-apply.
- Upstream's save of a legacy 6.2 V zener names the model
  `fwdrop=0.805904783 zvoltage=6.2` (escaped `fwdrop\q0.805904783\szvoltage\q6.2`);
  the element's escaped name and the `34` line's must match exactly.
- Built-in names (`1N4148` and so on) are not in the file; see "Built-in
  device model library" in [elements.md](elements.md).

## Transistor model lines (`32`)

Twin of `34` (CircuitLoader.java:175-178), not an element, no scope index.
Order: `32 <name> <flags> <satCur> <invRollOffF> <BEleakCur>
<leakBEemissionCoeff> <invRollOffR> <BCleakCur> <leakBCemissionCoeff>
<emissionCoeffF> <emissionCoeffR> <invEarlyVoltF> <invEarlyVoltR> <betaR>`
plus optional capacitance and transit-time tails. The port resolves only
`satCur` and `betaR` (all its Ebers-Moll uses); the line rides through
verbatim. Only plain `transistor` resolves; the darlington's model slot holds
an opaque internal state token and upstream's composite internals use the
default model.

## Writable device models (`34`, `32` on save)

- The writable store is module state in `web/src/model/deviceModels.ts`, one
  map per family, not a zustand field. It clears on load and New (before
  parse) and registers the file's `34`/`32` lines (`registerFileModels`).
  Lookups are family-scoped: a diode and a transistor model can share a name.
- `resolveModelParams` order: file, then writable store, then built-ins.
- The serializer writes a line for an element whose `modelName` resolves to a
  writable entry: fresh models once, ahead of the first naming element. A file
  model's line stays byte-for-byte unless its parsed body changed, then it
  regenerates in place; the decision pass runs before the order walk because
  a `34` can sit above its first user, and it consults every live element.
  Transistor regeneration rewrites tokens 3 and 14 only when their value
  changed (`1.0` stays `1.0`). Regenerated `34` lines keep the original
  `flags` token. MOSFET/JFET never emit; value-form diodes never emit.
- `=` in a model name escapes to `\q`.
- **Delete-then-undo.** `pruneUnreferencedModels` tombstones removed entries;
  undo/redo call `restorePrunedModels(elements)`. Models live outside the undo
  stack otherwise.
- The simple-mode editor keeps the stored emission coefficient when no simple
  field changed: re-deriving n does not round-trip bit-exactly (1.906 becomes
  1.9060000000000001).
- Explicit names that collide are suffixed with a notice (upstream suffixes
  only synthesized names; accepted divergence).

## Slider lines (`38`)

- `parseCircuit` walks the undump (Adjustable.java:47-76): element index `e`,
  optional `F` flags marker, `editItem`, min/max (defaults 1/1000), the
  FLAG_SHARED `ano` under bit 1, the escaped caption, and an optional step.
  `e < 0` and a non-numeric `e` stay pure passthrough. `e` resolves through
  `idByFileIndex` at parse time, so a slider above its target is inert
  (upstream's `getElm` has the same forward-reference limit).
- Sliders have their own order kind `{ kind: 'slider', id }`, deferred like a
  scope, with `e` rewritten from `ordinalById` on save. `sliderLineFor`
  rewrites only `e`; a deleted target writes `-1`; a UI-created slider emits
  upstream's canonical `e F<flags> editItem min max ano text step`
  (Adjustable.java:194-195).
- **Binding resolves the caption, not `editItem`.** `resolveParam`
  (`web/src/model/sliders.ts`) matches the caption against the target's
  `FieldDef` labels case- and separator-insensitively, then an alias table
  (`beta/hfe`, `phase control`, `duty cycle`, `temperature`,
  `light brightness`), then falls back to an index into the numeric fields
  (skipping choice, bool and text rows), then null (inert but preserved).
  Reason: corpus files are stale against upstream's current `getEditInfo`
  ordering, so faithful index binding reproduces upstream's own broken bindings
  (conv-buckboost's editItem 6 is "Specify As" now). Pinned by "binds every
  bundled 38 line".
- **Scaled params.** `PARAM_SCALE` maps a resolved param to the factor between
  the slider's range and the param's unit, e.g. `dutyCycle -> 0.01` (upstream
  edits percent, VoltageElm.java:578, :660; the port stores a fraction).
  Reads go through `fieldValue` so the thumb matches the write path.
- Position mapping ports Adjustable.java:142-159 (log needs `min > 0`;
  degenerate ranges fall back to linear).

## Embedded scope element (`403`)

The element line carries one whitespace-free config token (the scope view
state joined with `_`). Its `e`/`ne` tokens are upstream element indices; see
[scope.md](scope.md) for how embedded windows decode and re-encode.

## Switch keyboard shortcuts are not in the text format

`keyShortcut` is a session-level field on `CircuitElement`, absent from every
parse/dump pair: upstream serializes it only in XML (SwitchElm.java:79-90). A
save loses it by design; a store test pins the switch line byte-identical with
and without it. Sanitized like SwitchElm.java:277-283 (first char, lowercase).

## XML documents convert to text on load

**Owner decision.** The port never implements XML `<cir>` editing;
`parseCircuit` converts XML to the text format at load, one way, so the
bundled XML circuits load and save as text. `web/src/io/xml.ts` parses
upstream's `XMLSerializer.prettyPrint` shape; `xmlToText.ts` maps each tag's
attributes to text tokens.

- `x` is always `x1 y1 x2 y2`; multi-post parts derive inner posts from the
  endpoints (ChipElm.setPositionFromXml).
- XML-only kinds with no port model become `#` comment lines (newlines
  escaped, values flattened through `singleLine`), so a save keeps them and a
  crafted attribute cannot forge an element line. Coordinates are re-emitted
  canonically from validated numbers for the same reason.
- Device models: `mm` has no line, `dm` -> `34`, `tm` -> `32`, `ccm` -> `.`
  with each child dump escaped per child and space-joined (the text path's
  form). A child's dump is pushed only when its model line is, because the
  engine indexes dumps by line position.
- Scopes re-encode through `encodeScopeLine`; sliders write the canonical
  `38` form. Slots and kinds are pre-assigned in a first pass so out-of-order
  references resolve.
- Dropped or degraded attributes leave value-gated trace comments (gated at
  upstream's seed, so default files convert byte-identically).
- The round-trip test asserts a stable fixpoint, not byte-identical first
  conversion.
- `parse.ts -> xmlToText.ts -> scopeLine.ts -> parse.ts` was an import cycle;
  shared helpers now live in `valueTokens.ts`. Keep cross-module bindings
  inside function bodies if a new cycle appears.

## XML chip tags

dmux -> 185, ctr -> 164, TFlipFlop -> 193, JKFlipFlop -> 156, Latch -> 168;
consumed attrs are x/f plus bi/hv/bo where applicable plus `v{i}` on state
pins only. `BO_TAGS` lists exactly the allowBus tags upstream can emit.

## Corpus fixtures for "unmodelled kind"

Tests that need an unmodelled dump code must pick one that stays unmodelled;
when a kind lands, those fixtures move (corpus.test.ts, slider-unknown.txt,
parse.test.ts, store.load.test.ts, sliders.test.ts). `resolveParam` tests pick
a kind string with no registry def.
