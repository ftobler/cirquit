import { describe, expect, it } from 'vitest';
import { makeGhostElement } from '../../../state/helpers';
import { rotateElement } from '../../transform';
import { probePlusPoint } from './probe';
import type { CircuitElement } from '../../types';

describe('voltmeter polarity', () => {
  it('is placed vertically with the positive post 0 on top', () => {
    const e = makeGhostElement('probe', 0, 0, 0);
    expect(e.x1).toBe(e.x2);
    expect(e.y1).toBeLessThan(e.y2);
  });

  it('marks + beside post 0 in every orientation', () => {
    // Placed, then turned a quarter at a time: the mark must always sit on the
    // post-0 half of the body, never the post-1 half.
    let e: CircuitElement = { ...makeGhostElement('probe', 0, 0, 0), id: 1 };
    for (let turn = 0; turn < 4; turn++) {
      const p1 = { x: e.x1, y: e.y1 };
      const p2 = { x: e.x2, y: e.y2 };
      const dn = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const plus = probePlusPoint(p1, p2, dn);
      const d1 = Math.hypot(plus.x - p1.x, plus.y - p1.y);
      const d2 = Math.hypot(plus.x - p2.x, plus.y - p2.y);
      expect(d1, `turn ${turn}`).toBeLessThan(d2);
      e = rotateElement(e);
    }
  });

  it('puts + above the circle on a freshly placed meter', () => {
    const e = makeGhostElement('probe', 0, 0, 0);
    const p1 = { x: e.x1, y: e.y1 };
    const p2 = { x: e.x2, y: e.y2 };
    const plus = probePlusPoint(p1, p2, Math.hypot(p2.x - p1.x, p2.y - p1.y));
    expect(plus.y).toBeLessThan((e.y1 + e.y2) / 2 - 12);
  });
});
