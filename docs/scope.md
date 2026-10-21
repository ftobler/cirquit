# Scopes

Scope capture, the `o` line, drawing and the scope UI.

## `o` line codec

`web/src/io/scopeLine.ts` is pure: `decodeScopeLine` reads a loaded line into
display fields, `encodeScopeLine` writes a new-style line, and
`scopeLineMatches` decides at save time whether an untouched scope's `raw`
rides through byte-for-byte or is regenerated. The walk must agree
token-for-token with `parseScopeLine` and upstream `undump`
(ScopeSerializer.java:188-289), sharing the flag constants and value-token
helpers in `web/src/io/netlist/valueTokens.ts`.

- Flag bits: 1 showI, 2 showV, 4 inverted showMax, 8 showFreq, 16
  manualScale, 64 plotXY, 256 showMin, 512 showScale, 1024 fftPlot, 4096
  PLOTS, 8192 maxScale, 16384 showRMS, 32768 showDutyCycle, 65536
  logSpectrum, 1<<17 showAverage, 1<<18 PERPLOTFLAGS, 1<<19
  PERPLOT_MAN_SCALE, 1<<21 DIVISIONS, 1<<22 showP2P. FLAG_TRIGGER (1<<24) is
  not read. The encoder writes both 2D bits (64|128) for X-Y.
- Old-style lines carry optional yElm (bit 32) and ivalue (bit 2048) tokens.
  New-style lines skip manDivisions, a per-unit scale token when `unitsOf` > 1
  (power, lamp ohms, capacitor charge), per-plot flags and
  manScale/manVPosition pairs. If the walk desyncs, every later token is
  wrong, so `unitsOf` must be preserved on re-encode.
- A missing or negative position token means "own column"
  (`positionFromToken`, ScopeManager.java:335-336); load and save share it, or
  every old-style corpus line would regenerate.
- `scopeLineMatches` ignores speed (patched onto raw separately), so a zoom
  never forces regeneration.
- `showI`, `showV`, `scaleV`, `scaleA` are carried for fidelity; UI-created
  scopes default to true/true/20/0.05.

## Upstream behaviours matched

- `speed` clamps 1..1024 (Scope.java:1129-1136).
- `showNegative` is not a user toggle upstream; the port's per-plot sticky
  `ScaleState.showNegative` matches the formula
  (`min < (mx+mn)*.5 - (mx-mn)*.55`). **Diverges**: upstream resets it on a
  speed zoom, the port keeps it.
- Charge plots: `ScopeValue::Charge`, `Element::charge()` (capacitor
  `capacitance * v_prev`), token 8, C-scale token.
- Power, charge and ohm plots default `manVPosition` to -100, the bottom of
  manual mode (ScopePlot.java:62-66), in both `makePlot` and the decoder so a
  loaded line still matches.
- `manDivisions` (default 8) is real state, written with FLAG_DIVISIONS only
  in manual mode, like upstream `getFlags`.
- Per-plot manScale pairs are written only in manual mode
  (ScopeSerializer.java:29-30). Round-trip tests assert the second encode is
  a fixed point.
- showV/showI hide plots (`visiblePlotsOf`, Scope.java:289-315); CSV export,
  hit-testing and Remove Plot use the visible list. Enabling a value with no
  plot adds one (`setScopeShowValue`).
- `manVPosition` clamps to +/-200 (`V_POSITION_STEPS`).
- Trigger status text keys off the tracker's `waiting` flag
  (ScopeTrigger.java:198-204). The `fired` latch survives re-arm in both, so
  the display stays trigger-anchored.
- Scope wheel zoom multiplies by `wheelSensitivity` before the +/-5
  threshold (Scope.java:1379).
- FLAG_TRIGGER (1<<24) is not read: the text format carries no trigger state
  and upstream never restores it.
- Save as Default (`scopeDefaults`) is not ported.

## Readout and draw parity

- RMS, Average and Duty hide when the span is 0, like upstream; RMS shows
  only for voltage and current units, degrading per trace per frame rather
  than mutating saved flags. Duty truncates.
- Zero relocation and shared gridlines follow upstream's `allPlotsSameUnits`,
  comparing unit families (not plotted values). Max Scale `/div` uses the
  drawn span.
- `valid_data_count` counts only written columns, so stale pre-trigger data
  never paints after a trigger.
- Scope captures reset when the nominal step changes (Scope.java:598-600),
  not on adaptive halving; a columns-only resize copies samples across.
- Overlays lay out through one pure `layoutHeader` with an injected measurer,
  so embedded windows do not paint headers over neighbours.
  `selectPlotAt` scores each plot against its own samples. The trigger glyph
  is upstream's `#FF8000`.
- Sticky auto-scale state is keyed by (scope id, units family)
  (`web/src/scope/units.ts`), like upstream's `scale[]`; removing a plot keeps
  a family entry its siblings share. Transistor pin currents collapse onto
  amps and seed at 0.1. Test peaks must be float32-exact (0.25, not 0.2):
  Float32Array rounds 0.2 up and the doubling takes an extra step.
- Raw-only plots (null value or element) are never removed by Remove Plot,
  so their tokens survive save; the last plot cannot be removed. Edited scope
  lines keep original tokens for plots live state cannot reinterpret.
- Memristor and ohmmeter resistance plots sample real ohms.
- Per frame, each live array crosses the wasm boundary once
  (`useLiveSimReadout` cache), and the scope id set is memoised on
  `allScopes` identity.
- Show Extended Info draws the element's full `infoLines`
  (`web/src/render/infoBox.ts`) at 15 px pitch, docked, undocked and embedded,
  through one `elmInfoResolver`.
- `drawGridLines` routes manual-scale grid lines through `yOf`, so they
  include the position offset.

## Trace colours

`plotColors(scope, theme)` (`web/src/scope/draw.ts`) ports
`calcVisiblePlots`' three counters (Scope.java:291-311): each visible plot is
coloured by its ordinal within its own category, the first being the theme
green, yellow or white, the rest walking upstream's eight `PLOT_COLORS`
(ScopePlot.java:139-142). Colour is a function of position, never of the
session-unique `plot.id`, so a saved circuit repaints identically. Grid,
cursor and X-Y locus route through the theme so White Background works; the
FFT draws in upstream's `#FF0000`.

Scope readouts use the long-format `decimalDigits`.

## Per-element value plots and X-Y axes

- `Element::scope_value(value)` answers `Resistance`, `Ib`, `Ic`, `Ie`,
  `Vbe`, `Vbc`, `Vce`. The transistor returns its polarity-scaled `ib`/`ic`
  with `ie = -(ic+ib)` and raw terminal differences for the voltages, exactly
  upstream's table including its missing polarity scaling
  (TransistorElm.java:582-593); the lamp returns this step's resistance
  (LampElm.java:218-222). Values ride the ordinary trace rings; nothing new
  crosses the boundary.
- Token mapping: transistor 1..6 -> ib..vce, 7 power; lamp 2 -> resistance;
  capacitor 8 -> charge. **Diverges from upstream:** a transistor token outside
  the table maps to null and rides raw only (upstream draws 0), token 0 on a
  transistor is voltage (upstream 0), and token 8 on a non-capacitor is
  voltage (upstream falls through the same way). Do not "fix" these blindly.
- **The encoder's scale-token decision is kind-aware**
  (`encodeScopeLine(scope, indexOf, kinds)`): a kind-blind decision put a
  legacy power scale token after Ib's token 1, shifting the whole per-plot
  walk.
- X-Y axes and modulators (`plotX`, `plotY`, `plotBrightness`,
  `plotColorR/G/B`) round-trip as a six-integer block emitted only when
  non-default, so default and non-X-Y scopes stay byte-stable (a default X-Y
  label with six or more words is ambiguous; no corpus file has one). XML
  `xy2x`... attributes are read too. `xyPairFor` returns the first two
  samplable plots while axes hold their defaults; set indexes are positions in
  the full plot list including null plots (upstream's model). A brightness
  index past the end counts as unset (ScopePlot2d.java:171-173). If a plot is
  ever inserted mid-list, stored indexes shift silently.
- X-Y auto-scale only ever doubles (ScopePlot2d.java:151-152), and `drawXY`
  honours manual scale.
- "Show Vce vs Ic" (`setScopeVceIc`) replaces the plots with the VCE/IC pair
  and turns X-Y on (Scope.java:1312-1317). **Diverges**: unchecking turns X-Y
  off and keeps the pair; upstream re-applies either way.

## Per-trace measurements

**Port extension.** Upstream's readout flags are scope-level and its per-plot
token holds only the AC bit.

- `ScopePlot.measurements: PlotMeasurements | null`; null inherits the scope
  word. A mask is all nine bits or none. `PLOT_MEASUREMENT_KEYS` is the one
  ordering every consumer derives from: adding a readout touches only it.
- Per-plot hex token under FLAG_PERPLOTFLAGS: bit 0 FLAG_AC; bits 1..9 the
  keys in order (set means on; the scope word's inverted showMax is not
  inherited); bit 10 (`MEASUREMENT_SENTINEL`) marks mask presence, so an
  all-off mask (`400`) does not collapse into inherit. Never reuse bit 0 or
  move the sentinel; bits 11+ are free.
- `setPlotMeasurementFlag` seeds the mask from the inherited word, so a first
  override on a default scope writes `424`. Clearing the override (not
  flipping bits back) returns to inheritance and restores an untouched line
  byte-for-byte.
- Each visible trace draws its own measurement block in its colour, side by
  side. Phase Angle draws when any visible trace enables it (it reads V and I
  together).

## Stacked scopes and channels

The properties dialog shows one tab per scope sharing a column (`stackTabs`,
`web/src/ui/scopeTabs.ts`), keyed by scope id so a tab switch remounts the
text inputs. The Channels fieldset selects a trace; coupling and manual scale
edits target it.

## Floating scopes

**Owner decision 2026-10-02:** undocking a scope from the dock means an
in-app floating panel over the schematic, never a browser popup. Store
`floating` (`floatScope`, `dockScope`, `setFloatRect`, `raiseFloatingScope`),
geometry in `web/src/ui/floatingScopes.ts`, components `FloatingScope` /
`FloatingScopeLayer` in `ScopePanel.tsx`, `dockedScopes(scopes, floating)` in
`scopeStrip.ts`. The canvas info box draws when nothing is docked. The strip
height (`web/src/ui/scopeStrip.ts`) clamps to 80 px .. 85% of `.centre` and
persists under `scopeStrip.height`. The separate popup window above belongs
to the element context menu's View in New Undocked Scope only.

## Undocked scope window

**Diverges from upstream.** Upstream's View in New Undocked Scope
(`viewInFloatScope`, CommandManager.java:192-198) drops a floating ScopeElm
on the schematic; its separate-window command is File > New Window, a whole
second simulator. The port opens one scope in a display-only second window:
a second render target, never a second engine.

- `web/pages/scopewin.html` is a second Vite entry with no React and no wasm.
- **Push protocol** (`web/src/undocked/protocol.ts`): the child posts
  `undocked-hello` once; then the opener pushes one `undocked-frame` per frame
  carrying everything (sim time, the whole `Scope`, theme, `elmInfo` lines,
  title, one trace snapshot per plot). No separate spec message and no change
  detection, so dialog edits arrive next frame by construction. Trigger info
  only when not free-run; X-Y samples only when plotXY. Buffers are `slice()`
  copies sent via `transfer` (engine arrays are wasm memory views).
- **One draw path.** `scope/draw.ts` takes the narrow `ScopeDrawSource`
  (`web/src/engine/simulator.ts`); `SimEngine` satisfies it and the child implements it
  from snapshots (`SnapshotScopeSource`).
- Store: `undocked: { scopeId, windowRef } | null`, transient (never in
  Snapshot). `openUndockedScope(elementId)` always creates a fresh scope (no
  global dedup), like upstream's command. A second open or a blocked popup
  goes to the notice channel.
- `pushUndockedScopeFrame` in `useFrameLoop.ts` also reaps a closed window and
  closes the popup when its scope vanished. App owns the only DOM listeners:
  `message` (hellos accepted only when `ev.source` is the attached window) and
  `pagehide` (not `beforeunload`, which fires before a cancellable leave
  dialog).
- Width: trigger state is computed against the docked width; the popup opens
  at that width so they align at open time, and drift after a resize (the
  wire format deliberately carries no child size).
- The docked panel stays visible (editing lives there). Frame payloads are
  validated per item and installed only when fully built, since a detached
  buffer throws. Sticky auto-scale state is per JS heap, so dock and child
  converge independently.
