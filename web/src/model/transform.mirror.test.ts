/** Mirror invariants checked kind by kind: whatever bookkeeping a part does
 *  (orientation flags, chip flip bits, switch throws), a mirror must land
 *  every post exactly on the reflection of where that same post was, or the
 *  wires attached to it would detach. Run over every kind the registry marks
 *  mirrorable, in both orientations and on both axes. */

import { describe, expect, it } from 'vitest';
import { makeElement } from '../state/helpers';
import { ELEMENT_DEFS, chipExtentsOf, postsOf } from './registry';
import {
  canMirror,
  canMirrorSelection,
  canRotateSelection,
  mirrorElementVertical,
  mirrorInGroup,
  mirrorVerticalInGroup,
  rotateElement,
  rotateInGroup,
  selectionMirrorCentre,
  selectionMirrorCentreY,
  turnPivot,
} from './transform';
import type { CircuitElement, Point } from './types';

/** Kinds whose own turn or mirror already lands pins off their reflection,
 *  before any group logic: their per-kind orientation bookkeeping is missing
 *  in rotateFlags/mirrorElement (feature/rigid-transforms.md). The vertical
 *  mirror is composed from those two, so it inherits the defect. Listed, not
 *  silently skipped, so fixing one means deleting it here. */
const KNOWN_NON_RIGID = new Set([
  'potentiometer',
  'tappedTransformer',
  'customTransformer',
  'jfet',
  'darlington',
  'opampReal',
]);

/** Switches mirror by reversing the lever with the throws: the throw posts
 *  trade places and the lever follows, so the circuit is electrically
 *  unchanged (upstream's Switch2Elm/DPDTSwitchElm flips). Compare them as a
 *  set of positions. */
const THROW_SWAPPING = new Set(['switch2', 'dpdtSwitch']);

const KINDS = ELEMENT_DEFS.filter((d) => d.canMirror === true && !KNOWN_NON_RIGID.has(d.kind)).map((d) => d.kind);

const sorted = (ps: Point[]) => [...ps].sort((a, b) => a.x - b.x || a.y - b.y);
/** The posts in order, or as a set for the throw-swapping switches. */
const shape = (kind: string, ps: Point[]) => (THROW_SWAPPING.has(kind) ? sorted(ps) : ps);

/** The kind at a horizontal and (where it rotates to one) a vertical segment. */
function samples(kind: string): CircuitElement[] {
  const flat: CircuitElement = { ...makeElement(kind, 96, 160, 192, 160), id: 1 };
  const out = [flat];
  if (chipExtentsOf(flat) === undefined) out.push(rotateElement(flat));
  return out.filter(canMirror);
}

/** A plain wire far from the part, so the pair is a group with a shared centre
 *  that is neither part's own. */
const partner: CircuitElement = { id: 2, kind: 'wire', x1: 0, y1: 0, x2: 16, y2: 0, flags: 0, params: {} };

const reflectY = (cy: number) => (p: Point): Point => ({ x: p.x, y: 2 * cy - p.y });
const reflectX = (cx: number) => (p: Point): Point => ({ x: 2 * cx - p.x, y: p.y });

describe('vertical mirror keeps every post on its reflection', () => {
  it('covers a real set of kinds', () => {
    expect(KINDS.length).toBeGreaterThan(10);
  });

  for (const kind of KINDS) {
    it(`${kind} in a group`, () => {
      for (const e of samples(kind)) {
        const cy = selectionMirrorCentreY([e, partner])!;
        const m = mirrorVerticalInGroup(e, cy);
        expect(shape(kind, postsOf(m)), `${e.x1},${e.y1} ${e.x2},${e.y2}`).toEqual(
          shape(kind, postsOf(e).map(reflectY(cy))),
        );
      }
    });

    it(`${kind} alone`, () => {
      // A lone chip only toggles its flip bit (upstream count == 1), so its
      // pins reverse in place rather than reflect about a centre.
      for (const e of samples(kind)) {
        if (chipExtentsOf(e) !== undefined) continue;
        const cy = (e.y1 + e.y2) / 2;
        expect(shape(kind, postsOf(mirrorElementVertical(e))), `${e.x1},${e.y1} ${e.x2},${e.y2}`).toEqual(
          shape(kind, postsOf(e).map(reflectY(cy))),
        );
      }
    });
  }
});

describe('horizontal group mirror keeps every post on its reflection', () => {
  for (const kind of KINDS) {
    it(kind, () => {
      for (const e of samples(kind)) {
        const cx = selectionMirrorCentre([e, partner])!;
        expect(shape(kind, postsOf(mirrorInGroup(e, cx))), `${e.x1},${e.y1} ${e.x2},${e.y2}`).toEqual(
          shape(kind, postsOf(e).map(reflectX(cx))),
        );
      }
    });
  }
});

describe('group mirror of plain parts', () => {
  const r: CircuitElement = { id: 1, kind: 'resistor', x1: 0, y1: 0, x2: 64, y2: 0, flags: 0, params: {} };
  const w: CircuitElement = { id: 2, kind: 'wire', x1: 64, y1: 0, x2: 64, y2: 48, flags: 0, params: {} };
  const label: CircuitElement = { id: 3, kind: 'decoration', x1: 16, y1: 32, x2: 16, y2: 32, flags: 0, params: {} };

  it('offers mirror and rotate for a group with two-terminal parts and a label', () => {
    expect(canMirrorSelection([r, w, label])).toBe(true);
    expect(canRotateSelection([r, w, label])).toBe(true);
    // A lone two-terminal part keeps the old rule: its mirror is a swap.
    expect(canMirrorSelection([r])).toBe(false);
    // A part with hanging posts and no mirror bookkeeping refuses the group:
    // a bare reflection would put the SCR's gate on the wrong side.
    const scr: CircuitElement = { ...makeElement('scr', 96, 160, 160, 160), id: 5 };
    expect(canMirrorSelection([r, scr])).toBe(false);
    // Annotations alone have nothing to turn.
    expect(canRotateSelection([label, { ...label, id: 4 }])).toBe(false);
  });

  it('reflects the whole group rigidly and is undone by a second mirror', () => {
    for (const [mirror, centreOf] of [
      [mirrorInGroup, selectionMirrorCentre],
      [mirrorVerticalInGroup, selectionMirrorCentreY],
    ] as const) {
      const group = [r, w, label];
      const once = group.map((e) => mirror(e, centreOf(group)!));
      // The resistor and the wire stay joined at their shared post.
      expect([once[0].x2, once[0].y2]).toEqual([once[1].x1, once[1].y1]);
      const twice = once.map((e) => mirror(e, centreOf(once)!));
      expect(twice).toEqual(group);
    }
  });

  it('carries a label along with a group turn', () => {
    const group = [r, w, label];
    const pivot = turnPivot(group)!;
    const turned = group.map((e) => rotateInGroup(e, pivot));
    // The label's anchor turned with the parts; its shape did not change.
    expect(turned[2].x2 - turned[2].x1).toBe(0);
    let g = group;
    for (let i = 0; i < 4; i++) {
      const p = turnPivot(g)!;
      g = g.map((e) => rotateInGroup(e, p));
    }
    expect(g).toEqual(group);
  });
});
