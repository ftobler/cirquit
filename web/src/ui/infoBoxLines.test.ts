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

  it('ignores a hovered id that no longer exists', () => {
    expect(infoBoxLines(99, [], engine, settings)).toEqual(['t = 10m s', 'time step = 5µ s']);
  });

  it('reads a null engine as t = 0', () => {
    expect(infoBoxLines(null, [], null, settings)).toEqual(['t = 0 s', 'time step = 5µ s']);
  });
});