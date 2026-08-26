/**
 * Geometry transforms for the rotate, mirror and swap-terminals commands.
 *
 * Each transform is a pure function over one stored element, so the store
 * actions stay one-liners and the math is unit-testable without a DOM. Derived
 * posts are never stored: a quarter turn of `(x1,y1,x2,y2)` is all any element
 * needs, because the registry's `posts()` functions re-derive op-amp inputs,
 * pot wipers, transistor collector/emitter and SPDT throws from the new axis
 * and its perpendicular. The remaining per-type work is the op-amp and
 * transistor orientation flag, kept in step with upstream's `dsign` term so a
 * rotated or mirrored part's terminal coordinates match the original exactly.
 */

import { FLAG_SWAP, chipExtentsOf, defFor, MOSFET_FLIP, TRANSFORMER_FLIP, TRANSFORMER_VERTICAL, TAPPED_FLIP, TRIODE_DSIGN_FIX, TRIODE_FLIP, TRI_STATE_FLIP, UJT_FLIP, postCountOf } from './registry';
import { CHIP_FLIP_X, CHIP_FLIP_XY } from './registry/elements/dFlipFlop';
import { COMPARATOR_SWAP, SWITCH2_CENTER_OFF } from './registry/flags';
import { GRID_SIZE, type CircuitElement, type Point } from './types';

/** Whether the element can turn a quarter turn. A stem-bearing one-post part
 *  (ground, rails, logic inputs) rotates about its own midpoint like any
 *  two-point element: its free end is a draggable control point, and
 *  `rotateElement`'s arithmetic already operates on the stored `(x1,y1,x2,y2)`
 *  with no post assumptions. Only the post-only annotations (text, readouts),
 *  whose stray second point is meaningless, stay a single-point no-op. */
export function canRotate(e: CircuitElement): boolean {
  const def = defFor(e.kind);
  return (def?.draggablePosts ?? postCountOf(e)) >= 2;
}

/** Whether Mirror is offered. Only the asymmetric three-post bodies and the
 *  chip families declare it; a two-post part mirrored about its own centre is
 *  just a terminal swap, which has its own command. A chip stored on a
 *  strictly vertical segment is the port's own rotated representation:
 *  upstream carries portrait chips as flags on a horizontal segment and has
 *  no vertical-segment form, so there is no upstream answer to reproduce and
 *  the command declines through the usual gates. */
export function canMirror(e: CircuitElement): boolean {
  if (defFor(e.kind)?.canMirror !== true) return false;
  if (chipExtentsOf(e) !== undefined && e.x1 === e.x2 && e.y1 !== e.y2) return false;
  return true;
}

/** Whether the element can swap posts 0 and 1. Meaningful only on two-terminal
 *  parts; on a three-post body it would swap the input side with the output. */
export function canSwap(e: CircuitElement): boolean {
  return postCountOf(e) === 2;
}

/** One DPDT pole's fan spacing, `OPEN_HS*3` (DPDTSwitchElm.java:89), the
 *  distance upstream's `flip()` shifts the body along the perpendicular so the
 *  pole fan stays on the same physical side of the axis after a mirror. */
const DPDT_POLE_GAP = 48;

/** A DPDT's throw pairing moves with its position, and every flip inverts it
 *  (`position = 1-position`, DPDTSwitchElm.flip(), :256-262). The stored
 *  `state` and `params.position` must stay in step: the draw reads
 *  `state ?? params.position` and the engine handoff re-serialises `state`
 *  into `params.position`. */
function flipDpdtPosition(e: CircuitElement): CircuitElement {
  const position = (e.state ?? e.params.position ?? 0) === 1 ? 0 : 1;
  return { ...e, state: position, params: { ...e.params, position } };
}

/** The lever stops a switch2 walks: `throwCount`, plus the centre-off open
 *  middle when the flag is set and there are exactly two throws
 *  (Switch2Elm.java:83, :226). Shared by the flip reversal here and the
 *  linked-toggle fan-out in the store, so both agree on where a position can
 *  land. */
export function switch2PosCount(e: CircuitElement): number {
  const throws = Math.max(2, e.params.throwCount ?? 2);
  const centreOff = (e.flags & SWITCH2_CENTER_OFF) !== 0 && throws === 2;
  return throws + (centreOff ? 1 : 0);
}

/** Upstream's switch2 flips reverse the lever and toggle the runtime
 *  `positionFlipped` flag on every flipX/flipY/flipXY (Switch2Elm.java:241-259):
 *  after a mirror the stored endpoints swap order, which reverses the fan's
 *  perpendicular direction, so without the reversal the lever would land on
 *  the other physical side. The parity is session-only, exactly as upstream
 *  never writes `positionFlipped`; the port parks it in `params.flipParity`,
 *  which the dump never lists. */
function flipSwitch2(e: CircuitElement): CircuitElement {
  const posCount = switch2PosCount(e);
  const position = posCount - 1 - (e.state ?? e.params.position ?? 0);
  return {
    ...e,
    state: position,
    params: {
      ...e.params,
      position,
      flipParity: ((e.params.flipParity ?? 0) + 1) % 2,
    },
  };
}

/** Upstream's grid snap, `(v + gridSize/2 - 1) & ~(gridSize - 1)`
 *  (UIManager.java:989-991, CirSim.java:536-538). It floors rather than
 *  rounds, so an exact half square lands on the lower grid line and a negative
 *  coordinate snaps the same way; `state/helpers.ts`'s `snap` rounds instead,
 *  which is what a cursor wants but would not reproduce this axis. */
function snapGrid(v: number): number {
  return Math.floor((v + GRID_SIZE / 2 - 1) / GRID_SIZE) * GRID_SIZE;
}

/**
 * The quarter turn a settled selection gets: upstream's rotate, a diagonal
 * flip about the snapped axis `x - y = xmy` followed by a vertical flip about
 * the element's centre line (CommandManager.java:419-431, `flipXY` then
 * `flipY`, CircuitElm.java:688-703). Composed, the two are exactly the turn
 * `turnPointAbout` performs about the element's midpoint, with one difference
 * that is the whole point of doing it this way: the axis is snapped to the
 * grid first.
 *
 * That snap is what keeps an odd-length part on the grid. A 3-grid chip or the
 * 9-grid three-phase motor has its midpoint half a square off the grid, and a
 * turn about that point lands both endpoints between grid lines, where no wire
 * can reach them. Snapping the axis translates the turned part by up to one
 * grid square instead, which is what upstream does and what the placement
 * kinds with odd `defaultLength` need. For an even-length part the snap is
 * identity and the result is bit-for-bit the old midpoint turn.
 *
 * The centres truncate because Java's integer division does (`(minx+maxx)/2`),
 * and both flips read the truncated value.
 */
function upstreamTurn(e: CircuitElement): (p: Point) => Point {
  const cx = Math.trunc((e.x1 + e.x2) / 2);
  const cy = Math.trunc((e.y1 + e.y2) / 2);
  const xmy = snapGrid(cx - cy);
  return (p) => ({ x: p.y + xmy, y: 2 * cy - (p.x - xmy) });
}

/** The prepareFlip walk (CommandManager.java:385-405): min and max over both
 *  endpoints of every selected element, then one centre per axis. The centres
 *  truncate because Java's integer division does, and rounding here instead
 *  would drift every odd-span selection by a grid square. */
function flipCentres(selected: CircuitElement[]): { cx: number; cy: number } {
  let minx = Infinity;
  let maxx = -Infinity;
  let miny = Infinity;
  let maxy = -Infinity;
  for (const e of selected) {
    minx = Math.min(e.x1, e.x2, minx);
    maxx = Math.max(e.x1, e.x2, maxx);
    miny = Math.min(e.y1, e.y2, miny);
    maxy = Math.max(e.y1, e.y2, maxy);
  }
  return { cx: Math.trunc((minx + maxx) / 2), cy: Math.trunc((miny + maxy) / 2) };
}

/**
 * One shared pivot for a whole selection's quarter turn. Upstream computes a
 * single pivot from the selection bounding box and turns every part about it
 * (prepareFlip plus CommandManager.java:419-431), so a multi-select comes out
 * as a rigid body instead of each part circling its own midpoint and
 * scrambling the group. The returned point is exactly the one that makes
 * `turnPointAbout(p, pivot, 1)` reproduce upstream's composed
 * flipXY-then-flipY: its `x - y` is the snapped axis `snapGrid(cx - cy)` and
 * its `x + y` is `2*cy + xmy`.
 *
 * Undefined for fewer than two elements on purpose: the single-element
 * command keeps `upstreamTurn`, whose axis shift for odd-defaultLength kinds
 * is deliberate (c8912da: the snapped axis is what holds such a part to the
 * grid, at the cost of drifting up to one square per turn).
 */
export function selectionTurnPivot(selected: CircuitElement[]): Point | undefined {
  if (selected.length < 2) return undefined;
  const { cx, cy } = flipCentres(selected);
  const xmy = snapGrid(cx - cy);
  return { x: cy + xmy, y: cy };
}

/**
 * One shared axis for a whole selection's mirror: the bounding box centre
 * upstream's mirror command reflects every selected part across
 * (CommandManager.java:408-417), truncated like the turn's, so the group
 * mirrors as a body instead of each part folding about its own centre.
 * Undefined for fewer than two elements, leaving the single-element command
 * exactly as it was.
 */
export function selectionMirrorCentre(selected: CircuitElement[]): number | undefined {
  if (selected.length < 2) return undefined;
  return flipCentres(selected).cx;
}

/**
 * One quarter turn per unit about `pivot`, the same sense as `rotateElement`:
 * relative to the pivot, `(dx,dy)` becomes `(dy,-dx)`. `turns` is taken mod 4
 * and a negative count turns the other way. The turns are accumulated exactly
 * and rounded once at the end, so a half-coordinate pivot (an element's own
 * midpoint) cannot compound its rounding error across turns.
 *
 * Shared by `rotateElement` and the canvas placement drag, which re-applies
 * the turns Space has banked to the cursor-derived endpoint every move.
 */
export function turnPointAbout(p: Point, pivot: Point, turns: number): Point {
  let { x, y } = p;
  const n = ((turns % 4) + 4) % 4;
  for (let i = 0; i < n; i++) {
    const nx = y + pivot.x - pivot.y;
    const ny = pivot.y + pivot.x - x;
    x = nx;
    y = ny;
  }
  return { x: Math.round(x), y: Math.round(y) };
}

/** A routed wire's polyline is valid only for its exact endpoints; once a
 *  transform moves those, the route is dropped. Upstream re-routes in
 *  setPoints instead (RoutedWireElm.java:86-123); the port clears, the same
 *  choice endpoint drags make, and the next Convert re-routes from the shape. */
const withoutRoute = (e: CircuitElement): CircuitElement => {
  const { route: _route, ...rest } = e;
  return rest;
};

/**
 * A 90 degree turn. With no pivot it is upstream's rotate about the element's
 * own snapped axis (`upstreamTurn`), the settled-selection command. A
 * placement drag passes its press anchor as the pivot instead, so Space turns
 * the part about the point the user pressed on rather than dragging that
 * anchor away from under the cursor; that path stays on the exact
 * `turnPointAbout`, which is already grid-exact because the anchor is a
 * snapped grid point.
 *
 * `rotateFlags` is pivot-independent: its vertical test reads the pre-turn
 * endpoints. The pivot path's arithmetic is exact for grid-aligned input, but
 * an element whose endpoints have mismatched parity (e.g. from a hand-edited
 * netlist) would land on half coordinates, so `turnPointAbout` rounds to keep
 * the store invariant "every stored endpoint is an integer" intact. For
 * grid-aligned input the rounding is identity.
 */
export function rotateElement(e: CircuitElement, pivot?: Point): CircuitElement {
  if (!canRotate(e)) return e;
  const turn = pivot
    ? (p: Point) => turnPointAbout(p, pivot, 1)
    : upstreamTurn(e);
  const p1 = turn({ x: e.x1, y: e.y1 });
  const p2 = turn({ x: e.x2, y: e.y2 });
  const base = {
    ...withoutRoute(e),
    x1: p1.x,
    y1: p1.y,
    x2: p2.x,
    y2: p2.y,
    flags: rotateFlags(e),
  };
  // Upstream's rotate composes flipXY and flipY, and both switch families
  // override each of those with a throw reversal (Switch2Elm.java:241-259,
  // DPDTSwitchElm.java:264-277), so the two reversals cancel and a quarter
  // turn leaves every position untouched: a rigid turn needs no compensation.
  // The DPDT's two flip() body shifts cancel under the composed turn the same
  // way. Only the single-reversal mirror below reverses anything.
  return base;
}

/**
 * The op-amp, transistor and mosfet carry an orientation flag that upstream's
 * flipXY then flipY toggle in sequence. A horizontal part flips it once; a
 * vertical part flips it twice, so the two cancel. Either way the flag stays
 * in step with the `dsign` term in `opAmpPosts`, `transistorPosts` and
 * `mosfetPosts`, which is what keeps a rotated part's terminal coordinates
 * identical to upstream's. The mosfet's flag is bit 8 (FLAG_FLIP), not the
 * shared bit 1 the other two use, so a rotate must never touch its bit 1:
 * that bit means P-channel there.
 *
 * The triode's rotate (TriodeElm.java:251-268) is the same flipXY-then-flipY
 * sequence, but its flipXY toggles FLAG_FLIP unconditionally and its flipY
 * then toggles it again for a part horizontal after the turn and for a legacy
 * (no FLAG_DSIGN_FIX) part that was horizontal before it. A fresh horizontal
 * part ends up toggled once; a vertical part twice, so the two cancel; a
 * legacy horizontal part twice as well.
 *
 * The basic transformer is upstream's flipXY then flipY too
 * (TransformerElm.java:385-400): flipXY toggles FLAG_VERTICAL, and flipY
 * toggles FLAG_FLIP only when the part is now horizontal, i.e. when it was
 * vertical before the turn. The tapped and custom transformers toggle
 * FLAG_FLIP twice through the same two flips, so a rotate leaves them alone.
 */
function rotateFlags(e: CircuitElement): number {
  if (e.kind === 'transformer') {
    let flags = e.flags ^ TRANSFORMER_VERTICAL;
    if ((e.flags & TRANSFORMER_VERTICAL) !== 0) flags ^= TRANSFORMER_FLIP;
    return flags;
  }
  if (e.kind === 'tappedTransformer' || e.kind === 'customTransformer') return e.flags;
  if (e.kind === 'triode') {
    let flags = e.flags ^ TRIODE_FLIP;  // flipXY toggles unconditionally
    if (e.x1 === e.x2) flags ^= TRIODE_FLIP;  // vertical part: flipY cancels
    else if ((e.flags & TRIODE_DSIGN_FIX) === 0) flags ^= TRIODE_FLIP;  // legacy horizontal part
    return flags;
  }
  if (e.kind === 'mosfet' || e.kind === 'relay') {
    let flags = e.flags ^ MOSFET_FLIP;
    if (e.x1 === e.x2) flags ^= MOSFET_FLIP;
    return flags;
  }
  if (e.kind === 'unijunction') {
    // flipXY toggles FLAG_FLIP unconditionally, flipY toggles it again when
    // the part is now horizontal, so a horizontal part ends toggled once and
    // a vertical one twice, which cancels (UnijunctionElm.java:141-156).
    let flags = e.flags ^ UJT_FLIP;
    if (e.x1 === e.x2) flags ^= UJT_FLIP;
    return flags;
  }
  if (e.kind === 'comparator') {
    // The comparator overrides both flips with its own swap bit
    // (ComparatorElm.java:97-112): a horizontal part toggles once, a vertical
    // one twice, which cancels. The realistic op-amp has no such overrides:
    // OpAmpRealElm.java:319-320 are canFlipX/canFlipY only, so its swap bit
    // rides every transform untouched and falls through to the generic
    // return below.
    let flags = e.flags ^ COMPARATOR_SWAP;
    if (e.x1 === e.x2) flags ^= COMPARATOR_SWAP;
    return flags;
  }
  if (e.kind !== 'opamp' && e.kind !== 'transistor') return e.flags;
  let flags = e.flags ^ FLAG_SWAP;
  if (e.x1 === e.x2) flags ^= FLAG_SWAP;
  return flags;
}
/** One chip-family mirror, upstream's `flipX` (ChipElm.java:620-628,
 *  OptocouplerElm.java:165-172, CustomCompositeElm.java:123-131): toggle
 *  FLAG_FLIP_X and reflect the stored endpoints, shifting the anchor left by
 *  one body width when a whole selection shares one centre. The shift is what
 *  makes the two pin banks land on the reflected columns: with anchor A they
 *  sit at A and A+(fsx+1)*cspc2 and the bit swaps those columns exactly.
 *
 *  Without a shared centre (a single-element command, upstream's count == 1)
 *  no shift happens, and upstream toggles only FLAG_FLIP_X there
 *  (ChipElm.java:620-628): the stored fields do not move. Reflecting about the
 *  own midpoint then swapping is exactly identity on those fields, so this
 *  branch is byte-exact with upstream too; the reflect-plus-swap shape exists
 *  so the port's stored state always comes out of the one ordered-fields path
 *  rather than assuming the caller handed back the same numbers.
 *
 *  Nothing else moves: a chip flip reorders no pins and reverses no switch
 *  state, so unlike SPDT/DPDT nothing needs compensating. */
function mirrorChip(e: CircuitElement, cx: number, sharedCentre: boolean): CircuitElement {
  const ext = chipExtentsOf(e)!;
  const fsx = (e.flags & CHIP_FLIP_XY) !== 0 ? ext.sy : ext.sx;
  let x1 = 2 * cx - e.x1;
  if (sharedCentre) x1 -= (fsx + 1) * ext.cspc2;
  let x2 = 2 * cx - e.x2;
  // The port's chip frame anchors at the leftmost endpoint, so keep the
  // fields ordered; posts stay a pure function of the stored segment.
  if (x1 > x2) [x1, x2] = [x2, x1];
  return { ...withoutRoute(e), x1, y1: e.y1, x2, y2: e.y2, flags: e.flags ^ CHIP_FLIP_X };
}

/**
 * Reflect across the vertical axis through the element's midpoint, or through
 * `centre` when a selection hands in the shared bounding box centre. A mirror
 * reverses the axis direction, so for a horizontal part the `dsign` term alone
 * moves the hanging terminals to the true mirror side; only a vertical part
 * (whose axis direction is unchanged) needs its orientation flag flipped. The
 * transformers follow upstream's `flipX` (TransformerElm.java:385-389), which
 * toggles FLAG_FLIP exactly when the part is vertical. The triode differs: a
 * legacy (no FLAG_DSIGN_FIX) horizontal part needs the flip too, because
 * without the bit its electrode side is a fixed 1 rather than dsign
 * (TriodeElm.java:251-255).
 */
export function mirrorElement(e: CircuitElement, centre?: number): CircuitElement {
  if (!canMirror(e)) return e;
  if (chipExtentsOf(e) !== undefined) {
    return mirrorChip(e, centre ?? (e.x1 + e.x2) / 2, centre !== undefined);
  }
  const cx = centre ?? (e.x1 + e.x2) / 2;
  const vertical = e.x1 === e.x2;
  // The tri-state's control offset is absolute (a fixed sign, TriStateElm.java:
  // 122), so a mirror must flip FLAG_FLIP unconditionally, unlike the
  // dsign-driven parts where a horizontal mirror only needs dsign to move the
  // hanging posts (TriStateElm.java:319-322).
  if (e.kind === 'triState') {
    return {
      ...withoutRoute(e),
      x1: 2 * cx - e.x1,
      y1: e.y1,
      x2: 2 * cx - e.x2,
      y2: e.y2,
      flags: e.flags ^ TRI_STATE_FLIP,
    };
  }
  if (e.kind === 'triode') {
    // Upstream flipX toggles FLAG_FLIP for a vertical part and for a legacy
    // (no FLAG_DSIGN_FIX) horizontal part (TriodeElm.java:251-255). A fresh
    // horizontal part keeps the bit: the dsign term alone moves the plate and
    // cathode posts to the true mirror side.
    const legacy = (e.flags & TRIODE_DSIGN_FIX) === 0;
    const flags = vertical || legacy ? e.flags ^ TRIODE_FLIP : e.flags;
    return {
      ...withoutRoute(e),
      x1: 2 * cx - e.x1,
      y1: e.y1,
      x2: 2 * cx - e.x2,
      y2: e.y2,
      flags,
    };
  }
  if (e.kind === 'dpdtSwitch') {
    // Upstream DPDTSwitchElm.flipX runs its own flip() first: the throw
    // pairing inverts (`position = 1-position`) and the body shifts one pole
    // gap along the perpendicular so the pole fan stays on the same physical
    // side of the axis (DPDTSwitchElm.java:89, :256-267). The base mirror then
    // reflects the shifted endpoints, about the shared centre when a
    // selection provides one.
    const dx = e.x2 - e.x1;
    const dy = e.y2 - e.y1;
    const dn = Math.hypot(dx, dy);
    let shiftX = 0;
    let shiftY = 0;
    if (dn > 0) {
      if (dx === 0) shiftX = -((dy / dn) * DPDT_POLE_GAP); // dpx1*openhs*3
      else shiftY = (dx / dn) * DPDT_POLE_GAP; // -dpy1*openhs*3
    }
    return flipDpdtPosition({
      ...withoutRoute(e),
      x1: 2 * cx - (e.x1 + shiftX),
      y1: e.y1 + shiftY,
      x2: 2 * cx - (e.x2 + shiftX),
      y2: e.y2 + shiftY,
    });
  }
  if (e.kind === 'switch2') {
    // Upstream's switch2 flips reverse the lever too (Switch2Elm.java:241-245):
    // the generic reflection swaps the endpoints and with them the fan's
    // perpendicular direction, so the reversal keeps the lever on the same
    // physical side. No body shift, unlike the DPDT.
    return flipSwitch2({
      ...withoutRoute(e),
      x1: 2 * cx - e.x1,
      y1: e.y1,
      x2: 2 * cx - e.x2,
      y2: e.y2,
    });
  }
  let flipBit = 0;
  if (e.kind === 'mosfet' || e.kind === 'relay') flipBit = MOSFET_FLIP;
  else if (e.kind === 'transformer') flipBit = TRANSFORMER_FLIP;
  else if (e.kind === 'opamp' || e.kind === 'transistor') flipBit = FLAG_SWAP;
  else if (e.kind === 'comparator') flipBit = COMPARATOR_SWAP;
  else if (e.kind === 'tappedTransformer' || e.kind === 'customTransformer') flipBit = TAPPED_FLIP;
  else if (e.kind === 'unijunction') flipBit = UJT_FLIP;
  const flags = vertical && flipBit !== 0 ? e.flags ^ flipBit : e.flags;
  return { ...withoutRoute(e), x1: 2 * cx - e.x1, y1: e.y1, x2: 2 * cx - e.x2, y2: e.y2, flags };
}

/** Exchange the two ends of a two-terminal part. */
export function swapTerminalOrder(e: CircuitElement): CircuitElement {
  if (!canSwap(e)) return e;
  return { ...withoutRoute(e), x1: e.x2, y1: e.y2, x2: e.x1, y2: e.y1 };
}
