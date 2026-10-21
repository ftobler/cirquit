# Decisions

Owner policy decisions and the judgement calls still open. Dates mark when a decision was taken.

## Policies

Owner decisions that set how the port behaves. Each topic file marks the
related code with **Diverges from upstream** where it applies.

- **Scope.** A full port of CircuitJS1: Rust/WebAssembly engine, React +
  TypeScript + Vite frontend, static site, no server.
- **UI may diverge in form, never in function.** The look follows Material
  Design 3 with a dense CAD layout; commands and behaviour follow upstream.
  Font is Roboto. Resistors use the European symbol.
- **The bundled library is the acceptance corpus.** Every upstream example
  circuit must load with no missing components and simulate 100 steps.
- **XML documents convert to text on load** (2026-08-12, refined 2026-08-15).
  The port never edits XML; XML-only element classes either convert to port
  extension codes or ride as `#` comments.
- **Not ported:** Import From Dropbox (static site), a routed-wire placement
  key, Toggle Dev Tools, the Find Component dialog (`/` opens the palette
  instead), Change Language, Developer Mode, Minimum Target Frame Rate, the
  Matrix Solver option, scope Save as Default, multiplexer input mode 1.
- **Startup** opens upstream's default library circuit (the `>` entry in
  `setuplist.txt`, `lrc.txt`).
- **Editing does not restart the simulation.** Only Reset rewinds.
- **Messages about things the port handled itself flash and go**; only things
  the user must act on stick.
- **Values format by fraction digits, not significant figures** (short default
  1): a 6.8 uF part draws "6.8uF".
- **Wires.** Drawing a wire onto a wire splits it so it connects. A post drag
  splits like upstream; a whole-element or selection move never does. An end
  that touches without connecting shows a red bad-connection dot. Nothing is
  ever inserted at length 0. The wire tool has no ghost and draws 0, 1 or 2
  axis-aligned segments, the corner on the axis the drag first moved along.
- **Ground** has upstream's shape and two control points, one connectable.
- **Rotation is rigid and cyclic** (2026-10-02): a group turns as one body and
  four turns return it exactly; rotating mid-drag turns the group.
- **Mirror** (2026-10-02): Alt+H / Alt+V always; plain h / v only while dragging
  a selection (v otherwise places a voltage source). Group mirror is rigid and
  includes two-terminal parts.
- **Space rotates** (2026-08-20); Escape is select mode; run/pause has no key.
- **Ctrl-click is additive selection, Ctrl-drag moves one endpoint**; switch
  toggles by pointer are undoable.
- **Placement** (2026-08-20): click places a ghost, drag still works, the tool
  clears after one placement.
- **Parts with more than two posts stay axis-aligned.**
- **Counting fields are integer fields**, not sliders. Controlled sources ship
  with a default expression.
- **Dialogs** share the right-click menu's grey, with filled (never bordered)
  buttons. The right-click menu is two columns with a pinned search; search
  boxes sit outside their scroller. Documentation pages are two columns. The
  example library keeps upstream's three levels.
- **Scopes** (2026-10-02): extend freely as long as Falstad file
  compatibility holds. Undocking a scope means an in-app floating panel, never
  a browser popup window.
- **Voltmeter** (2026-10-02): keep file parity, but click-place vertically
  with + on top and mark the positive lead.

## Open owner calls

Judgement calls that came up in review and are deliberately not decided by
agents. Do not "fix" these without an owner decision.

- **DC motor spin direction.** The port negates both coupling sources for a
  conventional positive-speed machine; upstream (DCMotorElm.java:151-155)
  stamps the opposite sign and hides it behind `Math.abs` in its RPM readout.
  Fidelity means flipping the visual rotation and the angle tests.
- **Meter and rotor reset persistence.** The port clears ammeter and
  wattmeter accumulators and zeroes rotor angles on Reset; upstream keeps them.
  Decide as a pair.
- **Three-phase motor current readout.** The port reports stator phase U;
  upstream shows whichever source solved last.
- **Negative-ratio transformer saturation.** The port scales by |n| and
  saturates; upstream loses secondary saturation.
- **Scope trace count cap.** An absolute engine trace cap is a number to pick.
- **Comment quote injection.** A decoded `&quot;` re-emits unescaped into
  preserved-tag and trace comments; inert unless comments are ever re-parsed.
- **Bad-connection dot vs move auto-connect** (canvas F1), entangled with
  whether a move should ever auto-connect.
- **Pause on convergence failure** (F3).
- **Transformer DC dead-short intent** (R1).
- **Passive wheel listener** (I.m3): a native non-passive listener versus
  accepting platform zoom.
- **Always-on corpus simulation in CI**, a CI-time trade-off.
- Smaller items: three-phase motor sign (needs the upstream reference),
  logic-gate and BJT seeds, adaptive-step rollback of `start_iteration` state,
  scope trace wasm batching, embedded 403 scope re-encode, relay named models,
  scope phase-angle numeric readout, unlabeled-scope element caption, the
  FLAG_PULLDOWN / FLAG_RESET private name collision.
