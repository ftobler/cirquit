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

import { FLAG_SWAP, defFor, MOSFET_FLIP, TRANSFORMER_FLIP, TRANSFORMER_VERTICAL, TAPPED_FLIP, TRIODE_DSIGN_FIX, TRIODE_FLIP, TRI_STATE_FLIP, UJT_FLIP, postCountOf } from './registry';
import { COMPARATOR_SWAP, OPAMPREAL_SWAP } from './registry/flags';
import type { CircuitElement, Point } from './types';

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

/** Whether Mirror is offered. Only the asymmetric three-post bodies declare it;
 *  a two-post part mirrored about its own centre is just a terminal swap,
 *  which has its own command. */
export function canMirror(e: CircuitElement): boolean {
  return defFor(e.kind)?.canMirror ?? false;
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

const centre = (e: CircuitElement): Point => ({
  x: (e.x1 + e.x2) / 2,
  y: (e.y1 + e.y2) / 2,
});

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
 * A 90 degree turn about `pivot`, the element's own midpoint by default,
 * equivalent to upstream's flipXY-then-flipY. A placement drag passes its
 * press anchor instead, so Space turns the part about the point the user
 * pressed on rather than dragging that anchor away from under the cursor.
 * `rotateFlags` is pivot-independent: its vertical test reads the pre-turn
 * endpoints. The arithmetic is exact for grid-aligned input, but an
 * element whose endpoints have mismatched parity (e.g. from a hand-edited
 * netlist) would land on half coordinates, so each result is rounded to keep
 * the store invariant "every stored endpoint is an integer" intact. For
 * grid-aligned input the rounding is identity.
 */
export function rotateElement(e: CircuitElement, pivot: Point = centre(e)): CircuitElement {
  if (!canRotate(e)) return e;
  const p1 = turnPointAbout({ x: e.x1, y: e.y1 }, pivot, 1);
  const p2 = turnPointAbout({ x: e.x2, y: e.y2 }, pivot, 1);
  const base = {
    ...withoutRoute(e),
    x1: p1.x,
    y1: p1.y,
    x2: p2.x,
    y2: p2.y,
    flags: rotateFlags(e),
  };
  // The DPDT's flips invert the throw pairing (DPDTSwitchElm.java:256-277), so
  // a turned DPDT throws to each pole's other throw, like every flip().
  return e.kind === 'dpdtSwitch' ? flipDpdtPosition(base) : base;
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
  if (e.kind === 'comparator' || e.kind === 'opampReal') {
    // The same flipXY-then-flipY sequence as the op-amp, with each type's own
    // swap bit (ComparatorElm.java:109-112, OpAmpRealElm.java:319-320): a
    // horizontal part toggles once, a vertical one twice, which cancels.
    const bit = e.kind === 'comparator' ? COMPARATOR_SWAP : OPAMPREAL_SWAP;
    let flags = e.flags ^ bit;
    if (e.x1 === e.x2) flags ^= bit;
    return flags;
  }
  if (e.kind !== 'opamp' && e.kind !== 'transistor') return e.flags;
  let flags = e.flags ^ FLAG_SWAP;
  if (e.x1 === e.x2) flags ^= FLAG_SWAP;
  return flags;
}
/**
 * Reflect across the vertical axis through the element's midpoint. A mirror
 * reverses the axis direction, so for a horizontal part the `dsign` term alone
 * moves the hanging terminals to the true mirror side; only a vertical part
 * (whose axis direction is unchanged) needs its orientation flag flipped. The
 * transformers follow upstream's `flipX` (TransformerElm.java:385-389), which
 * toggles FLAG_FLIP exactly when the part is vertical. The triode differs: a
 * legacy (no FLAG_DSIGN_FIX) horizontal part needs the flip too, because
 * without the bit its electrode side is a fixed 1 rather than dsign
 * (TriodeElm.java:251-255).
 */
export function mirrorElement(e: CircuitElement): CircuitElement {
  if (!canMirror(e)) return e;
  const cx = (e.x1 + e.x2) / 2;
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
    // reflects the shifted endpoints about the element's own midpoint.
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
      x1: e.x2 - shiftX,
      y1: e.y1 + shiftY,
      x2: e.x1 - shiftX,
      y2: e.y2 + shiftY,
    });
  }
  let flipBit = 0;
  if (e.kind === 'mosfet' || e.kind === 'relay') flipBit = MOSFET_FLIP;
  else if (e.kind === 'transformer') flipBit = TRANSFORMER_FLIP;
  else if (e.kind === 'opamp' || e.kind === 'transistor') flipBit = FLAG_SWAP;
  else if (e.kind === 'comparator') flipBit = COMPARATOR_SWAP;
  else if (e.kind === 'opampReal') flipBit = OPAMPREAL_SWAP;
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
