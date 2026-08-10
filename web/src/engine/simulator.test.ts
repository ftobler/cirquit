import { describe, expect, it } from 'vitest';
import { SimEngine } from './simulator';
import { DEFAULT_SETTINGS } from '../model/types';
import type { CircuitElement } from '../model/types';
import { overlayLiveState } from '../io/liveState';

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
    expect(engine.postOffset(1)).toBe(0); // resistor leads the array
    expect(engine.postOffset(2)).toBe(2); // one resistor post per entry
    expect(engine.postOffset(3)).toBe(3); // resistor + ground posts

    const postCurrents = engine.elementPostCurrents();
    const elementNodes = engine.elementNodes();
    expect(postCurrents.length).toBe(6); // 2 + 1 + 3
    expect(postCurrents.length).toBe(elementNodes.length);
  });
});

describe('SimEngine live state read-back', () => {
  const RC: CircuitElement[] = [
    { id: 1, kind: 'voltage', x1: 0, y1: 100, x2: 0, y2: 0, flags: 0, params: { maxVoltage: 10 } },
    {
      id: 2,
      kind: 'resistor',
      x1: 0,
      y1: 0,
      x2: 100,
      y2: 0,
      flags: 0,
      params: { resistance: 1000 },
    },
    {
      id: 3,
      kind: 'capacitor',
      x1: 100,
      y1: 0,
      x2: 100,
      y2: 100,
      flags: 0,
      params: { capacitance: 1e-6, voltDiff: 5 },
    },
    { id: 4, kind: 'wire', x1: 100, y1: 100, x2: 0, y2: 100, flags: 0, params: {} },
    { id: 5, kind: 'ground', x1: 0, y1: 100, x2: 0, y2: 132, flags: 0, params: {} },
  ];

  it('elementStateTokens reports the live charge and a rebuild keeps it', async () => {
    const engine = await SimEngine.create();
    expect(engine.setCircuit(RC, DEFAULT_SETTINGS, [])).toBeNull();

    // Five time constants at the default 5e-6 step: the cap charges from the
    // seeded 5 V to near the 10 V supply.
    engine.run(1000);
    const live = engine.elementStateTokens();
    expect(live[3]).toBeDefined();
    const voltDiff = live[3].voltDiff;
    expect(voltDiff).toBeDefined();
    expect(voltDiff).toBeGreaterThan(8);
    expect(voltDiff).toBeLessThan(9.99);

    // Rebuild with the overlay: the engine reads the live voltDiff straight
    // off the param, so the charge survives the first step of the new build.
    const overlaid = overlayLiveState(RC, live);
    expect(engine.setCircuit(overlaid, DEFAULT_SETTINGS, [])).toBeNull();
    engine.run(1);
    const idx = engine.indexOf(3);
    expect(idx).toBeDefined();
    const v = engine.elementVoltages()[idx!];
    expect(v).toBeGreaterThan(8);
  });

  it('elementStateTokens is empty for an element set with no operating tokens', async () => {
    const engine = await SimEngine.create();
    expect(
      engine.setCircuit(
        [
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
        ],
        DEFAULT_SETTINGS,
        [],
      ),
    ).toBeNull();
    engine.run(10);
    const live = engine.elementStateTokens();
    expect(live[1]).toEqual({});
  });
});
