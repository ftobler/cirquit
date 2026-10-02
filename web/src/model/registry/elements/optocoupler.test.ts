import { describe, expect, it } from 'vitest';
import { makeElement } from '../../../state/helpers';
import { CHIP_FLIP_X, CHIP_FLIP_Y } from './dFlipFlop';
import { optoGeometry } from './optocoupler';
import type { CircuitElement } from '../../types';

const opto = (flags: number): CircuitElement => ({ ...makeElement('optocoupler', 0, 0, 32, 0), flags, id: 1 });

describe('optocoupler symbol geometry', () => {
  for (const [name, flags] of [
    ['plain', 0],
    ['flipX', CHIP_FLIP_X],
    ['flipY', CHIP_FLIP_Y],
    ['flipXY', CHIP_FLIP_X | CHIP_FLIP_Y],
  ] as const) {
    it(`wires every post straight across to its inner part (${name})`, () => {
      const { posts, led, phototransistor, inner } = optoGeometry(opto(flags));
      // The LED is a vertical diode from the post-0 row to the post-1 row, so
      // its anode faces post 0 whichever way the body is flipped. The
      // horizontal one the symbol used to draw could not reach both rows.
      expect(led.x1).toBe(led.x2);
      expect([led.y1, led.y2]).toEqual([posts[0].y, posts[1].y]);
      // The phototransistor is horizontal and its collector and emitter sit
      // level with posts 2 and 3, so the stubs are straight lines.
      expect(phototransistor.y1).toBe(phototransistor.y2);
      for (let i = 0; i < 4; i++) expect(inner[i].y, `post ${i}`).toBe(posts[i].y);
      // Each inner terminal lies between its post and the opposite bank.
      const west = Math.min(...posts.map((p) => p.x));
      const east = Math.max(...posts.map((p) => p.x));
      for (const p of inner) {
        expect(p.x).toBeGreaterThan(west);
        expect(p.x).toBeLessThan(east);
      }
      // The LED sits on the input side, the transistor on the output side.
      expect(Math.abs(led.x1 - posts[0].x)).toBeLessThan(Math.abs(led.x1 - posts[2].x));
      expect(Math.abs(phototransistor.x2 - posts[2].x)).toBeLessThan(Math.abs(phototransistor.x2 - posts[0].x));
    });

    it(`keeps the light arrows clear of the LED and the transistor bar (${name})`, () => {
      const { led, phototransistor, light } = optoGeometry(opto(flags));
      // The LED triangle and cathode bar reach 8 either side of its axis; the
      // transistor's base bar runs 3 units in from its first endpoint.
      const ledReach = 8;
      const bar = phototransistor.x1;
      for (const [from, tip] of light) {
        const lo = Math.min(from.x, tip.x);
        const hi = Math.max(from.x, tip.x);
        expect(lo > led.x1 + ledReach || hi < led.x1 - ledReach).toBe(true);
        expect(Math.abs(from.x - led.x1)).toBeGreaterThan(ledReach);
        // The arrow lies wholly between the LED and the bar, pointing at it.
        expect(Math.abs(tip.x - bar)).toBeLessThan(Math.abs(from.x - bar));
        expect(Math.min(Math.abs(from.x - bar), Math.abs(tip.x - bar))).toBeGreaterThan(0);
        expect((tip.x - led.x1) * (bar - led.x1)).toBeGreaterThan(0);
        expect(Math.abs(tip.x - led.x1)).toBeLessThan(Math.abs(bar - led.x1));
      }
    });
  }
});
