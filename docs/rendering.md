# Rendering

Canvas drawing conventions, symbols and overlays. The renderer is pure TypeScript; nothing here touches the engine.

## Coordinates and perpendicular offsets

`interp(a, b, f, g)` in `web/src/render/draw.ts` displaces perpendicular with
`px = b.y-a.y, py = a.x-b.x`, so a positive `g` is up on screen for a
left-to-right element (canvas y grows down), identical to upstream's
`interpPoint`. Tests that assert only `Math.abs` on this miss a flipped lever.

Symbols are drawn in circuit coordinates with no per-element context rotation
(upstream uses `ctx.transform`), so there is no `strokeRect` or `arc`: every
shape is built from `interp`/`interp2` points and fed to `polyline`.

## Line widths

Upstream has two stroke weights: `drawThickLine`/`drawThickPolygon`/
`drawThickCircle` at 3 (bodies and leads) and plain `drawLine` at 1 (fine
detail). The draw primitives default to 3; fine-detail sites pass 1
explicitly. Explicit widths appear only where they differ from 3. Exceptions
kept from upstream: gate and schmitt hysteresis Z at 2 (GateElm.java:209), the
three-phase motor rotor spokes at 6, the source waveform glyph at 3
(VoltageElm.java:392). Wires draw at 3 with round caps.

Junction dots are radius 3.5 (upstream `drawPost` 7x7 oval,
CircuitElm.java:851-854). Current dots are radius 2, not line-width scaled
(upstream 4x4 `fillRect`, CircuitElm.java:510). Grid and crosshair stay 1;
scope traces use their own widths.

## Moving contacts

**Diverges from upstream.** The switch lever, SPDT lever and relay blade
stroke at `CONTACT_STROKE_WIDTH = 4` (`web/src/model/registry/shared.ts`), one
above body weight, so the moving part reads as moving.

## Coils

Each coil loop is stroked as its own butt-capped path (`gradientCoil`,
`coilLoopPoints` in `web/src/render/draw.ts`) so the arcs read as separate
loops, not a resistor body. All loops of one coil share one gradient
(`axisPaint`) so shading stays continuous. Inductor, relay and transformer use
it.

## Ground symbol

The four symbol types match upstream geometry (Earth bars at `1, 1+5/dn,
1+10/dn`, half widths 10, 6, 2). The stem and bars use the port's butt cap
policy; upstream draws round caps (UIManager.java:636). `point2` is a drag
handle only (`draggablePosts: 2`). The Symbol choice is the `g` token after
flags; upstream's static `lastSymbolType` is not modelled.

## Value captions (`label()`)

`label(g, e, text, offset)` in `web/src/render/draw.ts` ports `drawValues`
(CircuitElm.java:914-943). It branches on `dpx`, upstream's truncated
perpendicular x: `dpx == 0` (a horizontal body) centres the caption above at
`(xc, yc - |dpy| - 2)`; otherwise it sits beside at `xc + |dpx| + 2` with
baseline `yc + dpy + fontSize/2`. The baseline is canvas default `alphabetic`,
which keeps a horizontal capacitor's caption off its plate. The near-side flip
(CircuitElm.java:938-939) applies to voltage sources and up-right diagonals.
Captions use `theme.text` rather than upstream's `whiteColor`. Rails, sweep,
varRail, noise, extVoltage and antenna use their own anchor helpers.

## Wire captions

`WIRE_SHOW_CURRENT = 1` and `WIRE_SHOW_VOLTAGE = 2` (WireElm.java:35-36) apply
to plain and routed wires. Text is `|current|` then post-0 voltage
(WireElm.java:90-102). Plain wires use `label(g, e, s, 4)`; routed wires use
`labelOnSegment`, the port of `drawValuesOnLongestSegment`
(RoutedWireElm.java:318-347). **Diverges from upstream**: captions gate on the
global Show Values toggle, like every caption in the port.

## Output readout (`O`)

Ports OutputElm: `OUTPUT_SHOW_VOLTAGE = 1`, `OUTPUT_FIXED = 2`; a flagless
output draws the literal `out`. Two points, one post (`draggablePosts: 2`).
The stem stops at `interp(p1, p2, 1-(w/2+8)/dn)` for the measured text width;
text centres at p2, bold while highlighted. `outputText` ports
`getUnitTextWithScale` (CircuitElm.java:1139-1150): fixed precision keeps
trailing zeros. The writer always emits the scale token, so a six-token corpus
line gains a `0` on save.

## Labeled-node text

`labeledNodeText` (`web/src/model/registry/shared.ts`) ports
`CircuitElm.drawLabeledNode` (CircuitElm.java:945-973), used by the data
recorder and stop trigger free-end labels. Ohm captions drop the glyph
(the symbol carries it), like resistors.

## Selection and hover colours

**Diverges from upstream (owner decision).** Upstream paints hover, selection
and the highlighted net in one `selectColor` (cyan in dark mode). The port
keeps two theme roles, `theme.selection` and `theme.highlight` (hover and
`onHighlightedNet`), but both stock palettes give them the same blue (dark
`#58a6ff`, light `#54aeff`). Selection is the one colour-scale role not
pinned to upstream's constant; a custom `selectionColor` still overrides only
selection.

## Current dots anchor at posts

`currentDotsFrom(g, a, b, current, phase)` places dots at
`wrapPhase(phase) + 16k` from `a`. A wire's run is anchored at a post, so a run
anchored at a body point carries a `distance(body, post) mod 16` residue and
its dots cannot meet the wire's train at the post (dots vanish and respawn out
of phase, size-dependently). Anchor every run at the post. SCR and triac do;
the transistor collector and emitter runs are still body-anchored (latent).

- `postCurrents[i]` is the negated terminal current, so post-anchored runs pass
  `-postDotPhases[i]`. `currentDotsFrom`'s `current` only gates on zero or
  non-finite; direction comes from the phase sign. Chained segments use
  `dotPhaseAfter`.
- Negating a phase must keep the `TOO_FAST` (+Infinity) sentinel, or
  `-Infinity % 16` is NaN and the flow line blanks.

## Junction dots and bus banks

The render post scan keys raw `x,y`. Collapsed banks declare N pins on one
coordinate, so `countedPosts()` skips busZ > 0 pins and a bank counts once,
like `drawChip` paints it; it reads `chipPinsOf` directly. Anchor drivers
without pin tables (bus logic input, instruction display) count once via a
kind list; revisit if a third appears. Junction-dot offsets are a
deterministic hash of the segment start, never `Math.random()`.

## Bad connections

`badConnectionPoints` (`web/src/render/junction.ts`) is upstream's
`badConnectionList` (SimulationManager.java:1075-1108): a post alone at its
coordinate that still lands on another element. Wires test the path
(`pointOnWireInterior`), not the bounding box. Post-less elements are skipped.
`cachedBadConnectionPoints` memoises on `elements` identity and is shared by
the dot pass and the info box count (`N bad connection(s)`,
UIManager.java:879-883). Text (`decoration`) keeps one post where upstream's
TextElm has none, so it contributes a junction dot.

## Drag-time intersection hints

`web/src/render/junctionHints.ts` (owner request). While a move, place or
post drag is live, a thin conductor-coloured bar normal to the chain marks:

- coordinates carrying posts of exactly two distinct elements whose
  directions through the point are colinear (exact integer cross product). An
  L corner or angled join stays unmarked (owner correction). Contributor
  counting, not raw post counting: a width-2 bus wire stacks two posts per
  end, and a collapsed placement carries both posts.
- moving posts lying on a static wire path or lead stub, tested with the same
  predicates the drop uses (`pointOnWireInterior`, `leadPostAt`). Under a post
  drag only the grabbed endpoint counts.

Gated on `editable` and move/place/dragpost; legibility only, a move still
connects nothing. `cachedDragHints` memoises on scene identity plus gesture.

## Bus wires

Wires wider than one bit draw at weight 5. Chip bus banks draw one lead at
width 5 labelled `name/width`.

## Embedded scope windows (403)

Config tokens decode through the `o` line walkers (cursor base 5, hex flags
before `ne val`, units scale after, man-scale pair last); plots resolve
through `idByFileIndex`, register per element id, and draw through `drawScope`
in the element box. Raw text is preserved; decoded state lives in a separate
`embedded` field never written back. The draw payload is hoisted once per
frame. The `$` header takes no element slot, so slot n is line n+2. Embedded
windows suppress the settings gear.
