import { describe, expect, it } from 'vitest';
import { MAX_CUSTOM_COILS, CUSTOM_TRANSFORMER_DEF, customCoilCount } from './transformer';
import type { CircuitElement, DrawContext } from '../../types';

function mk(text: string, coilCount?: number): CircuitElement {
  const params: Record<string, number> = {
    inductance: 4,
    couplingCoef: 0.999,
  };
  if (coilCount !== undefined) {
    params.coilCount = coilCount;
    for (let i = 0; i < coilCount; i++) params[`coilCurrent${i}`] = 0;
  }
  return {
    id: 1,
    kind: 'customTransformer',
    x1: 160,
    y1: 128,
    x2: 240,
    y2: 128,
    flags: 0,
    text,
    params,
  } as unknown as CircuitElement;
}

/** A canvas stub answering any method call; draw must simply do nothing. */
const anyCtx: DrawContext['ctx'] = new Proxy({} as DrawContext['ctx'], {
  get: () => () => undefined,
  set: () => true,
});

const ctx = (): DrawContext => ({
  ctx: anyCtx,
  theme: { background: '#101010' } as never,
  voltages: [],
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

describe('custom transformer coil cap', () => {
  it('carries the port policy cap the engine enforces', () => {
    // The usual kind-joined dual definition: the engine's
    // MAX_CUSTOM_COILS (engine/core/src/elements/transformer.rs) is the
    // authority at build time; this constant only bounds derived geometry.
    expect(MAX_CUSTOM_COILS).toBe(32);
  });

  it('the constructor-default description keeps its six posts', () => {
    expect(customCoilCount('1,1:1')).toBe(3);
    expect(CUSTOM_TRANSFORMER_DEF.posts!(mk('1,1:1', 3))).toHaveLength(6);
  });

  it('a past-cap description yields no geometry, like the malformed case', () => {
    const desc = Array.from({ length: MAX_CUSTOM_COILS + 1 }, () => '1').join(',');
    const e = mk(desc);
    expect(customCoilCount(desc)).toBe(33);
    expect(CUSTOM_TRANSFORMER_DEF.posts!(e)).toHaveLength(0);
    expect(() => CUSTOM_TRANSFORMER_DEF.draw!(ctx(), e)).not.toThrow();
  });

  it('a description at the cap still lays out one node pair per coil', () => {
    const desc = Array.from({ length: MAX_CUSTOM_COILS }, () => '1').join(',');
    expect(CUSTOM_TRANSFORMER_DEF.posts!(mk(desc))).toHaveLength(64);
  });

  it('parse drops a lying coil-count token instead of looping over it', () => {
    // A hostile file claims a billion coils with no trailing tokens; the
    // claim is not kept, so the read loop and any later save stay bounded
    // and re-derive from the description.
    const e = mk('1,1:1');
    e.params.coilCount = 1000000000;
    CUSTOM_TRANSFORMER_DEF.parse!([], e);
    expect(e.params.coilCount).toBeUndefined();
    expect(Object.keys(e.params).filter((k) => k.startsWith('coilCurrent'))).toHaveLength(3); // what "1,1:1" actually describes
    const out = CUSTOM_TRANSFORMER_DEF.dump!(e) as unknown[];
    expect(out[3]).toBe(3);
    expect(out).toHaveLength(4 + 3);
  });
});
