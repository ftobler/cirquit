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

import { FLAG_SWAP, defFor, MOSFET_FLIP, TRANSFORMER_FLIP, TRANSFORMER_VERTICAL, TAPPED_FLIP } from './registry';
import type { CircuitElement } from './types';

/** Whether the element can turn a quarter turn. One-post parts (ground, rails,
 *  annotations) have no axis to rotate about and their stray `x2,y2` must not
 *  be moved. */
export function canRotate(e: CircuitElement): boolean {
  return (defFor(e.kind)?.postCount ?? 0) >= 2;
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
  return (defFor(e.kind)?.postCount ?? 0) === 2;
}

const centre = (e: CircuitElement) => ({
  cx: (e.x1 + e.x2) / 2,
  cy: (e.y1 + e.y2) / 2,
});

/** A routed wire's polyline is valid only for its exact endpoints; once a
 *  transform moves those, the route is dropped. Upstream re-routes in
 *  setPoints instead (RoutedWireElm.java:86-123); the port clears, the same
 *  choice endpoint drags make, and the next Convert re-routes from the shape. */
const withoutRoute = (e: CircuitElement): CircuitElement => {
  const { route: _route, ...rest } = e;
  return rest;
};

/**
 * A 90 degree turn about the element's own midpoint, equivalent to upstream's
 * flipXY-then-flipY. The arithmetic is exact for grid-aligned input, but an
 * element whose endpoints have mismatched parity (e.g. from a hand-edited
 * netlist) would land on half coordinates, so each result is rounded to keep
 * the store invariant "every stored endpoint is an integer" intact. For
 * grid-aligned input the rounding is identity.
 */
export function rotateElement(e: CircuitElement): CircuitElement {
  if (!canRotate(e)) return e;
  const { cx, cy } = centre(e);
  const turn = (x: number, y: number): [number, number] => [
    Math.round(y + cx - cy),
    Math.round(cy + cx - x),
  ];
  const [x1, y1] = turn(e.x1, e.y1);
  const [x2, y2] = turn(e.x2, e.y2);
  return { ...withoutRoute(e), x1, y1, x2, y2, flags: rotateFlags(e) };
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
  if (e.kind === 'mosfet' || e.kind === 'relay') {
    let flags = e.flags ^ MOSFET_FLIP;
    if (e.x1 === e.x2) flags ^= MOSFET_FLIP;
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
 * toggles FLAG_FLIP exactly when the part is vertical.
 */
export function mirrorElement(e: CircuitElement): CircuitElement {
  if (!canMirror(e)) return e;
  const cx = (e.x1 + e.x2) / 2;
  const vertical = e.x1 === e.x2;
  let flipBit = 0;
  if (e.kind === 'mosfet' || e.kind === 'relay') flipBit = MOSFET_FLIP;
  else if (e.kind === 'transformer') flipBit = TRANSFORMER_FLIP;
  else if (e.kind === 'opamp' || e.kind === 'transistor') flipBit = FLAG_SWAP;
  else if (e.kind === 'tappedTransformer' || e.kind === 'customTransformer') flipBit = TAPPED_FLIP;
  const flags = vertical && flipBit !== 0 ? e.flags ^ flipBit : e.flags;
  return { ...withoutRoute(e), x1: 2 * cx - e.x1, y1: e.y1, x2: 2 * cx - e.x2, y2: e.y2, flags };
}

/** Exchange the two ends of a two-terminal part. */
export function swapTerminalOrder(e: CircuitElement): CircuitElement {
  if (!canSwap(e)) return e;
  return { ...withoutRoute(e), x1: e.x2, y1: e.y2, x2: e.x1, y2: e.y1 };
}
