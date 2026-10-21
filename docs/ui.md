# Application UI

React components, dialogs, menus, preferences and the static build.

## Testing UI code

`web/vite.config.ts` runs vitest with `environment: 'node'` and no jsdom or
React testing library, so `.tsx` files are untested by construction. Every
decision lives in a `.ts` module.

## Frame loop reads the store through a ref

The frame loop in `CircuitCanvas.tsx` reads the store through a ref, never
React state; anything it needs must be a ref or a store field. A 60 Hz
`setState` was rejected.

## Visual system

- The UI follows Material Design 3 while keeping the dense CAD look; no
  expressive reskin. `:root` carries the MD3 role set on the blue axis.
- `--md-outline-interactive` (`#7a8490`) clears 3:1 on the dialog surface;
  the decorative `--md-outline` does not need to.
- `--menu-surface` (`#1e1e1e`) is the one floating-surface grey for menus,
  popups, dialogs and scope properties. The tonal surface-container tokens
  were removed because their tint made dialogs read blue. Dialog buttons are a
  neutral `--text` wash, never a border.
- State layers come from `--md-state-*` opacities. Buttons have a CSS-only
  centre ripple (`button::after`), suppressed under reduced motion; `overflow:
  hidden` on buttons is safe because no button holds a positioned child.
- Pointer targets: 40 px on fine pointers, 44 px on coarse.
- Keep prettier's canonical wrapping for `calc(var(--md-state-*) * 100%)`.

## Two message channels

- `problem` / `unsupportedProblem`: sticky and dismissable, for what the user
  must act on (missing element types, clamp-on-load warnings, a failed build,
  convergence failure, a frame crash).
- `notice` / `unsupportedNotice`: transient, no close button, for what the
  port handled itself: preserved uninterpreted lines and everything
  `engine.warnings()` reports (no ground symbol, floating nodes pinned).
- `isMissingComponent` treats any all-digit head as a missing component, so an
  element code newer than the port (`999`) stays sticky.
- `buildReport` (`useFrameLoop.ts`) is the pure split; a build error drops
  that build's warnings. Notices dedupe on `${document}:${text}`.
- The notice's life is one CSS animation (`notice-flash`, `--notice-life`);
  `onAnimationEnd` unmounts it. Key it on the text, and under reduced motion
  swap to a flat `notice-hold` of the same length rather than
  `animation: none`, which would never fire `animationend`.
- Notice colour is dark grey (`#30363de6`), owner-corrected: MD3's inverted
  snackbar surface read as a silver slab here.

## Menus and dialogs

- Every menu command is a store action. Deferred rows render `disabled` with
  the reason in `title`.
- Dialog state lives in the store (`dialog: DialogName | null`,
  `openDialog`/`closeDialog`) so the menubar, App's dialog host and key paths
  share it. The `Dialog.tsx` shell handles Escape, backdrop click and a Tab
  focus trap, and does not focus its panel on mount so a child `autoFocus`
  wins.
- Ctrl+S and File > Save both open Save As. `markSaved` runs in the dialog's
  OK handler so exporting counts as clean for the F5 guard.
- `summarizeImport` (`web/src/io/importSummary.ts`) wording is pinned by tests:
  "N elements, N scope traces[, N unsupported type(s) (codes)]".
- The Circuits menu search is a pure filter, `filterLibrary` in
  `web/src/io/library.ts`: a title match keeps the whole group, otherwise
  entries filter, empty groups drop. `Menubar.tsx` owns the query state.
- Scopes menu "All" actions (`stackAllScopes`, `unstackAllScopes`,
  `combineAllScopes`, `separateAllScopes`) are each one commit, mirroring
  `ScopeManager.stackAll`..`separateAll`.

## Dialog layout

- Global settings live in the Other Options dialog
  (`OtherOptionsDialog.tsx`, upstream EditOptions.java). Changes apply live;
  only a Close button. Omitted on purpose: Change Language, Developer Mode,
  Minimum Target Frame Rate, Matrix Solver.
- Element properties live in `ElementPropertiesDialog.tsx` (upstream
  EditDialog), a modal whose rows come from `ElementFields` and apply live, so
  OK only closes. It closes itself if its element disappears (undo, load). It
  focuses its first field on mount (EditDialog.java:249-255).
- Load problems show as a full-width banner under the menubar.
- The undo/redo menubar buttons are disabled on empty stacks via
  `undoStack.length` selectors (commit/undo/redo replace arrays wholesale).

## Escape inside dialogs

`Dialog` registers its Escape listener on `window`, above the React root, so a
child's `stopPropagation` cannot reach it. A dialog with an inner editor passes
an `onEscape` override (`const handleEscape = onEscape ?? onClose`), so exactly
one action happens per press wherever focus is. Suspending the listener
instead left Escape dead once focus left the input. Layered dialogs claim
Escape through `dialogEscape`.

## Context menu

- Element rows track upstream's elmMenuBar. `contextMenu` stores the
  circuit-space click point, so location commands never need the canvas rect.
- `splitWireAt(id, point)` grid-snaps (upstream `doSplit`,
  MouseManager.java:586-593) then calls `splitWire`, which refuses endpoints
  and off-span points and bends routed wires.
- `addToScope(elementId, scopeId, value)` dedups per scope (unlike
  `addScope`'s global dedup); upstream's submenu is flattened to one row per
  scope (MouseManager.java:944-954).
- Sliders: `addSlider` creates upstream's canonical `38 e F0 editItem 1 1000 -1
  caption 0`; disabled for `varRail` and `potentiometer` and kinds with no
  adjustable field (`sliderItemEnabled`, MouseManager.java:994-1007).
  `adjustableFields(kind)` is the shared numeric-field list, so a UI-created
  `editItem` resolves back on reload.
- The empty-canvas menu is upstream's Draw menu with the toolbox palette
  (`paletteGroups` in `web/src/ui/contextMenuRows.ts`). Only Select/Drag Sel
  is offered as a mode: Drag Row/Column/All/Post are modifier gestures
  (Alt+Shift, Alt+Meta, Ctrl, Alt or middle) with no store mode.

## Context menu layout

Over empty canvas the menu is two columns (commands, palette). The shell is
`overflow: hidden` so the pinned search box cannot scroll away; only the list
scrolls. The parts sidebar uses the same split.

## Toolbox

- `renderToolIcon(toolId, canvas, dark, settings?)`
  (`web/src/render/toolIcon.ts`) draws a tool's own `def.draw` onto a 24 px
  canvas with a stub element and an empty `DrawContext`. A kind with no
  `defaultLength` uses 4 grid units inside the icon helper only: a zero-length
  stub collapses the body to a dot, and adding `defaultLength` to defs would
  change live placement. `iconFit` fits `bodyRect` plus posts with a 10-unit
  margin. Icons repaint on `dark` and settings changes (custom colours,
  euro symbols), once per change, never per render.
- The all-tools icon test draws every toolbox entry with an empty context;
  it catches a def indexing live sim data.
- `filterTools` (`web/src/model/search.ts`) keeps toolbox order and
  categories. There is no Find Component dialog; `/` opens the palette.
  `toolShortcut`: the entry's own shortcut wins over the kind's, case kept.

## Circuit library

`parseSetupList` builds a tree (upstream nests three deep). `filterLibrary`
recurses with an `inherited` flag so a matching group keeps its subtree.
The first `>`-marked entry is the default circuit (`lrc.txt`), loaded when no
`ctz`/`cct`/`startCircuit` is given (`Menus.processSetupList`); any failure
falls back to the inline starter circuit. `library.test.ts` reads the bundled
`setuplist.txt` to guard `just import-cirquits-upstream`. The index loads once
at startup.

## Startup URL

`startupSource(href)` in `web/src/io/urlShare.ts` is the pure precedence:
`ctz`/`cct` share link, else `startCircuit` (a bundled library file name
matching `/^[\w.-]+\.txt$/`), else the default. A failed library fetch loads
the starter with a status message.

## Loading

Malformed circuits surface the same way from every entry path (the sticky
banner, never the engine-fatal screen or an unhandled rejection). A refused
auto-save recovery leaves the document, dirty state, recovery slot and undo
untouched. Guarded file reads route failures to the notice channel.

## Clipboard and paste

The internal clipboard persists across tabs like upstream. Repeated Ctrl+V
fans copies out (CommandManager.java:560-601; the near-cursor branch is
skipped on purpose). Stored clipboard text is probed with `parsesToElements`
before menus enable Paste; garbage pastes are a silent no-op.

## File IO

`web/src/io/fileIO.ts` holds `saveCircuit`, `openCircuit` (a fresh hidden file
input per call) and `saveBlob`. DOM-bound, not unit tested.

## File fields

`FieldDef` `type: 'file'` with `fileLoad: 'audio' | 'data'` renders a file
input. Audio decodes channel 0 through `decodeAudioData`; data runs the pure
`parseDataFile`. The basename becomes `e.text` (AudioInputElm.java:160),
not part of the file format.

## Image export

Save As Image and Copy Circuit Image always render upstream's printable look:
white background, black wires, no grid, no current dots
(`renderCircuitToCanvas(..., dark = false)`). `exportGeometry` pins upstream's
canvas math (bounds*2 + 140/100 margins, scale = min of fitted ratios).
`dark` is UI-only state, absent from the undo `Snapshot`.

## Print

`web/src/render/print.ts`: a hidden overlay plus `window.print()`, like
upstream (ImageExporter.java:76), not a popup (popup blockers). The pure
`printStyle()` hides everything but the overlay on paper and the overlay on
screen. `printCircuit` waits for the image `onload` (printing before decode
gives a blank page), prints, and cleans up on `afterprint` with a 1 s fallback,
plus `img.onerror` cleanup.

## App preferences

`web/src/state/appPrefs.ts` stores `APP_PREF_KEYS` (crosshair, the five
colours, value font size, digit counts, wheel sensitivity) as one JSON blob
under `options.prefs.v1`, validated per key with ranges mirroring the
OptionsPanel controls, so garbage cannot reach `formatValue`'s `toFixed` and
throw in the frame loop. `newCircuit` resets only header-borne settings plus
`headerFlags`; app prefs and plain settings survive New and file loads.

## Storage

Every storage module reads through guarded accessors: a denied-storage
browser must still boot (default arguments that touch `localStorage` run
before any try/catch).

## Value formatting counts fraction digits

**Do not change this to significant figures.** It was tried and reverted
because it silently rewrote part values (6.8 uF drew as "7uF"). Upstream's
`NumberFormat` pattern `"####." + "#" * n` (CircuitElm.java:156-186) is a
maximum fraction digit count applied after prefix scaling, defaults
`decimalDigits = 3`, `shortDecimalDigits = 1`. `formatValue(123456, 'V', 3)`
is "123.456k V". The value font default is 12 (CircuitElm.java:53).

## Unit-number inputs

`parseUnits` accepts only ASCII `u` for micro, so edit boxes format with
`formatValueAscii`/`formatUnitsAscii` (`PREFIXES_ASCII` is derived from
`PREFIXES` so the tables cannot drift). Canvas labels and scopes keep the
micro glyph. `web/src/ui/UnitNumberInput.tsx` takes `positive`, `min`, `max`
and `integer` props: an invalid draft shows "Invalid value" and commits
nothing; `commit()` clamps and rounds on commit, never per keystroke. The box
shows the value without its unit (the unit is in the label), upstream's edit
form. Outside changes resync the draft only while blurred.

## Theme colours

`makeTheme(dark, colors?)` overlays exactly the five user colours
(selection, negative, neutral, positive, currentDot); every call site passes
the whole settings object so scope traces follow custom colours too.

## Conventional current

`settings.conventional` is a per-frame render argument; changing it never
reloads the engine.

## Wheel

- Wheel zoom is multiplicative: `exp(sign(deltaY) * -log(1.12) *
  wheelSensitivity)` into `zoomAbout`.
- The wheel value stepper counts notches, not pixels: a single event of 40 px
  or more is one notch in any deltaMode, smaller trackpad ticks accumulate per
  40 px, a sign flip resets. `wheelSensitivity` is steps per notch.
  **Diverges from upstream**, whose `scale = 6` division gave 8 to 17 steps per
  notch. `SCROLLABLE_PARAMS` maps each kind to `{ param, ladder }`: E12 ladders,
  `linearValues` for voltage sources and current sources (bounded +/-100 steps,
  negatives allowed). `extVoltage` is excluded.

## Touch input

- `web/src/ui/gestures.ts` `TouchGesture` is a pure state machine with an
  injectable clock (`DRAG_DELAY_MS = 150`, `LONG_PRESS_MS = 500`,
  `DOUBLE_TAP_MS = 300`, `TAP_MOVE_TOLERANCE = 8`). The component owns the
  timers and hands them back via `timerFired`, which drops stale ones.
- One finger or a pinch; a third finger is inert. Moving past tolerance
  cancels long-press but never the drag delay. A primary `up` is a tap when the
  hold was under the drag delay (upstream's time-only rule) or travel stayed
  within tolerance. Double-tap is decided at the second `up` (upstream decides
  at touchstart), so the second tap already ran `primaryDown`; on a running
  switch that is a double toggle. Lifting one pinch finger forgets every
  finger.
- Pinch is one `setView`: zoom about the previous midpoint, then pan by the
  midpoint delta. A pinch also suppresses the wheel value stepper for a
  second, as wheel zoom does.
- Long-press opens the context menu; double-tap edits (upstream
  `onDoubleClick -> doEdit`), never zooms.
- `requestEdit(id)` is the one edit entry point (double-click, double-tap,
  context menu): it moves the target to the front of `selectedIds` and keeps
  the rest selected, since the options panel reads `selectedIds[0]`; it sets
  `elementProperties` to open the dialog.
- Momentary switches are released by the pointer that pressed them
  (`heldMomentaryPointerRef`), from up, double-tap and pointercancel.
- Mobile layout: below 768 px the drawers are absolutely positioned in the
  workspace (not fixed) so they sit below a wrapping menubar. Coarse pointers
  get 44 px targets and 16 px input fonts (stops the iOS focus zoom).
  `user-scalable=no` is correct: the canvas owns zoom.

## Canvas DPR

Canvases size through `backingStoreSize` so fractional device pixel ratios do
not reset the backing store every frame; X-Y persistence canvases size at
device resolution and blit 1:1.

## Fullscreen

File > Toggle Full Screen feature-checks the optional APIs, swallows
rejections, centres immediately for the unsupported case, and refits once on
`fullscreenchange` (or `fullscreenerror`), because centring synchronously
races the async transition.

## Accessibility

- One global `:focus-visible` outline (never `:focus`, so clicks paint
  nothing).
- `web/src/ui/focusTrap.ts` (`nextFocusIndex`) and
  `web/src/ui/menuNavigation.ts` (`stepMenuCursor`) hold the pure logic;
  `useFocusTrap.ts` and `menuKeyboard.ts` are thin DOM wiring.
- `useFocusTrap` captures the restore target in a `useState` initializer, not
  an effect: a child `autoFocus` commits in the layout phase before effects,
  so an effect-time snapshot would record the child. Restore is guarded by
  `isConnected`.
- Flat menubar dropdowns are ARIA menus with ArrowUp/Down/Home/End; every
  handled key stops propagation so window nudge bindings do not fire.
  Left/Right are deliberately unhandled and still nudge. The Circuits dropdown
  is a `group`, not a menu. Context and scope menus have roles only (no
  keyboard opener).
- ScopeProperties is a real modal (focus trap, Escape); the App keydown guard
  covers it.
- `eslint-plugin-jsx-a11y` runs a curated rule set; `no-autofocus` and
  `click-events-have-key-events` are off on purpose.
  `control-has-associated-label` runs with `ignoreElements` because it cannot
  see wrapping `<label>`s.

## Auto-pause

`web/src/ui/autoPause.ts` pauses an untouched tab after 10 s. Inputs:
`pointerdown`, `keydown`, `wheel`, `touchstart`, `click` (not hover).
Listeners register at mount, before the engine loads. One-shot: the first
input or the deadline settles it for the session.

## Side pages (docs)

- Upstream's simulator-owned side pages are React pages on a Vite multi-page
  build. `web/src/docs/pages.ts` is the one registry (`{ id, file, title,
  group, menu? }`) driving Vite `rollupOptions.input`, the `data-page` HTML
  files, the nav, the docs index and the Help menu; `pages.test.ts` closes the
  registry-to-disk loop. `file` keeps upstream's names where they exist
  (`subcircuits.html`, `crystal.html`, `diodecalc.html`, `mosfet-beta.html`).
- Each `web/pages/<file>.html` sets `<body data-page="<id>">` and loads
  `/src/docs/main.tsx`, which adds a `docs-root` body class before first
  render (the app's `overflow: hidden` would clip prose).
- Vite emits these to `dist/pages/<file>`, so links carry a `pages/` prefix
  after `BASE_URL`.
- The footer keeps the GPL-2.0 attribution to CircuitJS1.
- Inline examples are raw netlists in `web/src/docs/examples.ts` decoded from
  upstream's `cct`/`ctz` blobs; `examples.test.ts` parses each with no
  unsupported lines and round-trips the compression. Calculator math is pure
  in `web/src/docs/calculators.ts`.
- Skipped on purpose: jsinterface, blink-test, iframe, about, font license,
  the Word-export articles, avr8js. The docs prose is hand-ported, not touched
  by `just import-cirquits-upstream`.

## Brand and favicon

`web/public/favicon.svg` is the op-amp glyph; `index.html` links it with
`%BASE_URL%favicon.svg` because the Pages deploy base is `/cirquit/`. Never
hardcode a root path. The brand text gradient is the fixed `BRAND_GRADIENT`
in `web/src/ui/brand.ts`.

## Static deployment zip

`pages.yml` builds twice: once with `BASE_PATH=/cirquit/` for Pages, once
with no base for `static-deployment.zip`. Run cd-based commands in subshells
(`(cd web && npx vite build)`). Zip the dist contents, not the directory.
`zip` exists on ubuntu-latest; do not add an install step. The About link
404s on the dev server by design.
