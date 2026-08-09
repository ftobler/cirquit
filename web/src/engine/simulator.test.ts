import { describe, expect, it } from 'vitest';
import { SimEngine } from './simulator';
import { DEFAULT_SETTINGS } from '../model/types';
import type { CircuitElement } from '../model/types';

describe('SimEngine per-post arrays', () => {
  it('postOffset indexes elementPostCurrents slices for mixed post counts', async () => {
    // The engine flattens per-post currents in element order, so the
    // postOffset map must slice the right element's entries when post counts
    // differ: resistor 2, ground 1, transistor 3.
    const engine = await SimEngine.create();
    const elements: CircuitElement[] = [
      {
        id: 1,
        kind: 'resistor',
        x1: 0,
        y1: 0,
        x2: 100,
        y2: 0,
        flags: 0,
        params: { resistance: 1000 },
      },
      { id: 2, kind: 'ground', x1: 100, y1: 0, x2: 100, y2: 32, flags: 0, params: {} },
      { id: 3, kind: 'transistor', x1: 0, y1: 0, x2: 100, y2: 0, flags: 0, params: { pnp: 1 } },
    ];
    expect(engine.setCircuit(elements, DEFAULT_SETTINGS, [])).toBeNull();
    expect(engine.postOffset(1)).toBe(0);  // resistor leads the array
    expect(engine.postOffset(2)).toBe(2);  // one resistor post per entry
    expect(engine.postOffset(3)).toBe(3);  // resistor + ground posts

    const postCurrents = engine.elementPostCurrents();
    const elementNodes = engine.elementNodes();
    expect(postCurrents.length).toBe(6);  // 2 + 1 + 3
    expect(postCurrents.length).toBe(elementNodes.length);
  });
});
