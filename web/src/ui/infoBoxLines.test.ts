import { describe, expect, it } from 'vitest';
import type { SimEngine } from '../engine/simulator';
import type { CircuitElement } from '../model/types';
import { infoBoxLines } from './infoBoxLines';

const el = (id: number, kind: string, params: Record<string, number>): CircuitElement => ({
  id,
  kind,
  x1: 0,
  y1: 0,
  x2: 160,
  y2: 0,
  flags: 0,
  params,
});

const engine: SimEngine = {
  indexOf: (id: number) => (id === 1 ? 0 : undefined),
  elementCurrents: () => new Float64Array([-0.05]),
  elementVoltages: () => new Float64Array([-2.5]),
  elementPowers: () => new Float64Array([0.125]),
  elementScopeValues: () => new Float64Array(),
  time: 0.01,
} as unknown as SimEngine;

/** A biased NPN stage's live readout: the flat-array triple plus the
 *  scope-value table [ib, ic, ie, vbe, vbc, vce] in the engine's declared
 *  order, active region at beta 100 into a 1 k load. The power entry is
 *  upstream's getPower, Vbe*Ib + Vce*Ic = 0.65*9µ + 4.65*920µ. */
const transistorEngine: SimEngine = {
  indexOf: (id: number) => (id === 1 ? 0 : undefined),
  elementCurrents: () => new Float64Array([9.2e-4]),
  elementVoltages: () => new Float64Array([-4]),
  elementPowers: () => new Float64Array([0.00428385]),
  elementScopeValues: () => new Float64Array([9e-6, 9.2e-4, -9.29e-4, 0.65, -4, 4.65]),
  time: 0.01,
} as unknown as SimEngine;

const settings = { timeStep: 5e-6, iterCount: 10 };

describe('infoBoxLines', () => {
  it('shows the sim stats when nothing is hovered', () => {
    expect(infoBoxLines(null, [], engine, settings)).toEqual([
      't = 10m s',
      'time step = 5µ s',
    ]);
  });

  it('swaps to the hovered element readout, reading live engine arrays', () => {
    expect(infoBoxLines(1, [el(1, 'resistor', { resistance: 1000 })], engine, settings)).toEqual([
      'resistor',
      'I = 50m A',
      'Vd = 2.5 V',
      'R = 1k Ω',
      'P = 125m W',
    ]);
  });

  it('builds the full transistor table through the scope-value readback', () => {
    const t = { ...el(1, 'transistor', { pnp: 1, beta: 100 }), modelName: '2N2222' };
    expect(infoBoxLines(1, [t], transistorEngine, settings)).toEqual([
      'transistor (NPN)',
      '2N2222, β=100',
      'fwd active',
      'Ic = 920µ A',
      'Ib = 9µ A',
      'Vbe = 650m V',
      'Vbc = -4 V',
      'Vce = 4.65 V',
      'P = 4.284m W',
    ]);
  });

  it('does not cross the scope-value boundary for kinds without a table', () => {
    // The on-demand channel exists so only the read-out kind pays; a
    // resistor hover must leave it silent.
    const calls: number[] = [];
    const spying = {
      ...engine,
      elementScopeValues: (id: number) => {
        calls.push(id);
        return new Float64Array();
      },
    } as unknown as SimEngine;
    expect(infoBoxLines(1, [el(1, 'resistor', { resistance: 1000 })], spying, settings)).toEqual([
      'resistor',
      'I = 50m A',
      'Vd = 2.5 V',
      'R = 1k Ω',
      'P = 125m W',
    ]);
    expect(calls).toEqual([]);
  });

  it('ignores a hovered id that no longer exists', () => {
    expect(infoBoxLines(99, [], engine, settings)).toEqual(['t = 10m s', 'time step = 5µ s']);
  });

  it('reads a null engine as t = 0', () => {
    expect(infoBoxLines(null, [], null, settings)).toEqual(['t = 0 s', 'time step = 5µ s']);
  });

  it('appends the bad-connection tally under the sim stats', () => {
    // The vertical wire's lower end sits on the horizontal wire's interior,
    // which splits nothing: one bad connection, reported singular.
    const across = el(1, 'wire', {});
    const dropped = { ...el(2, 'wire', {}), x1: 80, y1: 0, x2: 80, y2: 80 };

    expect(infoBoxLines(null, [across, dropped], engine, settings)).toEqual([
      't = 10m s',
      'time step = 5µ s',
      '1 bad connection',
    ]);
  });

  it('pluralises the tally and keeps it under a hovered element readout', () => {
    const across = el(1, 'wire', {});
    const dropped = { ...el(2, 'wire', {}), x1: 80, y1: 0, x2: 80, y2: 80 };
    const alsoDropped = { ...el(3, 'wire', {}), x1: 40, y1: 0, x2: 40, y2: 80 };
    const elements = [across, dropped, alsoDropped];

    expect(infoBoxLines(null, elements, engine, settings).at(-1)).toBe('2 bad connections');
    expect(infoBoxLines(1, elements, engine, settings)).toEqual([
      'wire',
      'I = 50m A',
      'Vd = 2.5 V',
      '2 bad connections',
    ]);
  });

  it('counts classic dots and bus-width mismatches in one tally', () => {
    // One dropped end plus one coordinate where a 2-bit and a 4-bit driver
    // disagree: upstream merges both lists into the same red-dot count
    // (SimulationManager.java:1109).
    const across = el(1, 'wire', {});
    const dropped = { ...el(2, 'wire', {}), x1: 80, y1: 0, x2: 80, y2: 80 };
    const two = {
      ...el(3, 'busLogicInput', {}),
      x1: 400,
      y1: 300,
      x2: 464,
      y2: 332,
      params: { busWidth: 2 },
    };
    const four = {
      ...el(4, 'busLogicInput', {}),
      x1: 400,
      y1: 300,
      x2: 464,
      y2: 332,
      params: { busWidth: 4 },
    };

    expect(infoBoxLines(null, [across, dropped, two, four], engine, settings).at(-1)).toBe(
      '2 bad connections',
    );
  });
});
