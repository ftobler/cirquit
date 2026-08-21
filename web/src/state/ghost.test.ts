import { describe, expect, it } from 'vitest';
import { postsOf, TOOLBOX, toolDef } from '../model/registry';
import { rotateElement } from '../model/transform';
import { GRID_SIZE } from '../model/types';
import type { CircuitElement } from '../model/types';
import { DEFAULT_PLACEMENT_LENGTH, makeGhostElement, makeToolElement } from './helpers';

/** The geometry the placement press built inline before `makeGhostElement`
 *  existed (pointerDown.ts's tool branch), kept here as the no-regression
 *  reference: a click must still put the declared-length kinds exactly where
 *  they landed before. */
function legacyPlacement(tool: string, x: number, y: number): Omit<CircuitElement, 'id'> {
  const def = toolDef(tool);
  const len = (def?.defaultLength ?? 0) * GRID_SIZE;
  const x2 = def?.vertical ? x : x + len;
  const y2 = def?.vertical ? y + len : y;
  return makeToolElement(tool, x, y, x2, y2);
}

const onGrid = (v: number) => v % GRID_SIZE === 0;

describe('makeGhostElement', () => {
  it('falls back to four grid squares, horizontal, for a kind with no defaultLength', () => {
    // `text` declares no defaultLength: before the fallback it placed as a
    // point and finishPlacement deleted it again, so the click did nothing.
    expect(toolDef('text')?.defaultLength).toBeUndefined();
    const e = makeGhostElement('text', 32, 32, 0);
    expect([e.x1, e.y1, e.x2, e.y2]).toEqual([32, 32, 32 + DEFAULT_PLACEMENT_LENGTH * GRID_SIZE, 32]);
  });

  it('keeps a declared defaultLength rather than the fallback', () => {
    const wire = makeGhostElement('wire', 0, 0, 0);
    expect(wire.x2 - wire.x1).toBe((toolDef('wire')?.defaultLength ?? 0) * GRID_SIZE);
    const timer = makeGhostElement('timer', 0, 0, 0);
    expect(timer.x2 - timer.x1).toBe((toolDef('timer')?.defaultLength ?? 0) * GRID_SIZE);
  });

  it('drops the vertical kinds downward, at their own declared length', () => {
    const g = makeGhostElement('ground', 48, 48, 0);
    const len = (toolDef('ground')?.defaultLength ?? 0) * GRID_SIZE;
    expect([g.x1, g.y1, g.x2, g.y2]).toEqual([48, 48, 48, 48 + len]);
  });

  it('turns about the anchor: one turn points up, two point back, four is the identity', () => {
    const len = DEFAULT_PLACEMENT_LENGTH * GRID_SIZE;
    const flat = makeGhostElement('resistor', 64, 64, 0);
    expect(makeGhostElement('resistor', 64, 64, 1)).toMatchObject({
      x1: 64,
      y1: 64,
      x2: 64,
      y2: 64 - len,
    });
    expect(makeGhostElement('resistor', 64, 64, 2)).toMatchObject({
      x1: 64,
      y1: 64,
      x2: 64 - len,
      y2: 64,
    });
    expect(makeGhostElement('resistor', 64, 64, 3)).toMatchObject({
      x1: 64,
      y1: 64,
      x2: 64,
      y2: 64 + len,
    });
    expect(makeGhostElement('resistor', 64, 64, 4)).toEqual(flat);
  });

  it('takes the turn count mod 4, negatives included', () => {
    expect(makeGhostElement('resistor', 0, 0, 5)).toEqual(makeGhostElement('resistor', 0, 0, 1));
    expect(makeGhostElement('resistor', 0, 0, -1)).toEqual(makeGhostElement('resistor', 0, 0, 3));
  });

  it('pins (x1,y1): the anchor is the point the click lands on', () => {
    for (let turns = 0; turns < 4; turns++) {
      const e = makeGhostElement('opAmp', 96, -32, turns);
      expect([e.x1, e.y1]).toEqual([96, -32]);
    }
  });

  it('keeps every coordinate on the grid, for the fallback and every declared length', () => {
    // The reason DEFAULT_PLACEMENT_LENGTH is 4 and not 3: the ghost's anchor
    // turn is exact for any length, but the midpoint rotate that follows a
    // click-place is not, so the fallback length has to halve onto the grid.
    for (const t of TOOLBOX) {
      for (let turns = 0; turns < 4; turns++) {
        const e = makeGhostElement(t.id, 5 * GRID_SIZE, 7 * GRID_SIZE, turns);
        expect(
          [e.x1, e.y1, e.x2, e.y2].every(onGrid),
          `${t.id} at ${turns} turns: ${e.x1},${e.y1} ${e.x2},${e.y2}`,
        ).toBe(true);
      }
    }
  });

  it('survives the midpoint rotate that follows a click-place, odd lengths too', () => {
    // A click-place leaves the part selected with the tool cleared, so the
    // very next Space is a settled-selection rotate about the part's own
    // midpoint. The ten odd-`defaultLength` kinds (the 3-grid chips, the
    // 9-grid three-phase motor, the 11-grid PISO shift register) have that
    // midpoint half a square off the grid; `rotateElement` snaps the turn axis
    // the way upstream does, so they stay reachable by a wire instead of
    // landing between grid lines.
    const odd = TOOLBOX.filter((t) => ((toolDef(t.id)?.defaultLength ?? 0) % 2) === 1);
    expect(odd.length).toBeGreaterThan(0);

    const oddIds = new Set(odd.map((t) => t.id));
    for (const t of TOOLBOX) {
      let e: CircuitElement = { ...makeGhostElement(t.id, 5 * GRID_SIZE, 7 * GRID_SIZE, 0), id: 1 };
      for (let turns = 1; turns <= 4; turns++) {
        e = rotateElement(e);
        expect(
          [e.x1, e.y1, e.x2, e.y2].every(onGrid),
          `${t.id} after ${turns} turns: ${e.x1},${e.y1} ${e.x2},${e.y2}`,
        ).toBe(true);
        // The odd kinds are all chips, whose pins sit at whole grid steps off
        // the body, so a turned one has to stay wire-reachable. Not asserted
        // for every kind: the OTA's inputs straddle its axis by half a square
        // in upstream too, turned or not.
        if (!oddIds.has(t.id)) continue;
        expect(
          postsOf(e).every((p) => onGrid(p.x) && onGrid(p.y)),
          `${t.id} posts after ${turns} turns`,
        ).toBe(true);
      }
    }
  });

  it('carries the orientation flag the rotate command would have set', () => {
    // The turn goes through rotateElement, so a pre-turned op-amp is
    // indistinguishable from one placed flat and rotated after the fact.
    for (const tool of ['opAmp', 'mosfet', 'dpdtSwitch']) {
      const flat: CircuitElement = { ...makeGhostElement(tool, 128, 128, 0), id: 1 };
      const turned = makeGhostElement(tool, 128, 128, 1);
      const rotated = rotateElement(flat, { x: 128, y: 128 });
      expect(turned.flags, tool).toBe(rotated.flags);
      expect(turned.state, tool).toBe(rotated.state);
      expect(turned.params, tool).toEqual(rotated.params);
    }
  });

  it('reproduces the press geometry for every tool that declares a length', () => {
    for (const t of TOOLBOX) {
      if (toolDef(t.id)?.defaultLength === undefined) continue;
      expect(makeGhostElement(t.id, 3 * GRID_SIZE, 2 * GRID_SIZE, 0), t.id).toEqual(
        legacyPlacement(t.id, 3 * GRID_SIZE, 2 * GRID_SIZE),
      );
    }
  });

  it('gives every toolbox kind a non-zero length, so no click places a dead point', () => {
    for (const t of TOOLBOX) {
      const e = makeGhostElement(t.id, 0, 0, 0);
      expect(e.x1 === e.x2 && e.y1 === e.y2, t.id).toBe(false);
    }
  });
});
