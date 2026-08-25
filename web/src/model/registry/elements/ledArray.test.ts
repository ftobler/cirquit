import { describe, expect, it } from 'vitest';
import { LED_ARRAY_DEF } from './ledArray';
import type { CircuitElement, DrawContext } from '../../types';

function mk(params: Record<string, number>): CircuitElement {
  return {
    id: 1,
    kind: 'ledArray',
    x1: 0,
    y1: 0,
    x2: 128,
    y2: 128,
    flags: 0,
    params: { ...params },
  };
}

/** A canvas stub answering any method call, enough to prove draw runs its
 *  clamped loop without throwing rather than to inspect pixels. */
const anyCtx: DrawContext['ctx'] = new Proxy({} as DrawContext['ctx'], {
  get: () => () => undefined,
  set: () => true,
});

const ctx = (voltages: number[] = []): DrawContext => ({
  ctx: anyCtx,
  theme: { background: '#101010' } as never,
  voltages,
  current: 0,
  voltage: 0,
  power: 0,
  value: 0,
  state: 0,
  wave: [],
  dotPhase: 0,
  postCurrents: [],
  postDotPhases: [],
  showCurrent: false,
  showValues: false,
  showVoltageColor: false,
  showPowerColor: false,
  conventional: true,
  euroResistors: true,
  euroGates: false,
  selected: false,
  hovered: false,
  onHighlightedNet: false,
  voltageRange: 5,
  powerRange: 50,
  scale: 1,
  valueDigits: 1,
  valueFontSize: 12,
});

describe('ledArray geometry clamps', () => {
  it('the dialog bounds are inclusive', () => {
    // 2x2 and 16x16 are the legal extremes; posts match the engine model.
    expect(LED_ARRAY_DEF.posts!(mk({ sizeX: 2, sizeY: 2 }))).toHaveLength(4);
    expect(LED_ARRAY_DEF.posts!(mk({ sizeX: 16, sizeY: 16 }))).toHaveLength(32);
  });

  it('a hostile stored size clamps instead of blowing up the layout', () => {
    // The engine refuses this grid by name; here it must merely stay
    // bounded so nothing unbounded is laid out while the banner shows.
    const e = mk({ sizeX: 100000, sizeY: 8 });
    expect(e.params.sizeX).toBe(100000);
    expect(LED_ARRAY_DEF.posts!(e)).toHaveLength(24); // 16 clamped + 8
    expect(() => LED_ARRAY_DEF.draw!(ctx(), e)).not.toThrow();
  });

  it('zero, negative and non-finite sizes keep the eight-by-eight fallback', () => {
    // LEDArrayElm.java:60-64, unchanged by the clamp.
    const cases: Record<string, number>[] = [
      {},
      { sizeX: 0, sizeY: 0 },
      { sizeX: -4, sizeY: 8 },
      { sizeX: Number.NaN, sizeY: Number.NaN },
    ];
    for (const params of cases) {
      expect(LED_ARRAY_DEF.posts!(mk(params)), JSON.stringify(params)).toHaveLength(16);
    }
  });

  it('a just-above-clamp size draws within the clamped bounds', () => {
    // 17 sits just above GRID_MAX; draw must run its clamped 16-wide loop.
    const e = mk({ sizeX: 17, sizeY: 8 });
    expect(() => LED_ARRAY_DEF.draw!(ctx([5, 5]), e)).not.toThrow();
  });
});

describe('ledArray dump keeps raw tokens', () => {
  it('writes the hostile stored size back untouched', () => {
    // The engine rejects the document; saving it must not silently rewrite
    // the user's numbers.
    const e = mk({ sizeX: 17, sizeY: 8 });
    const out = LED_ARRAY_DEF.dump!(e);
    expect(out[out.length - 2]).toBe(17);
    expect(out[out.length - 1]).toBe(8);
  });
});
