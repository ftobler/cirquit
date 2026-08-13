import { describe, expect, it } from 'vitest';
import { parseCircuit } from '../io/netlist';
import { parseUnits } from '../model/units';
import {
  crystalFrequencies,
  crystalNetlist,
  diodeEmissionCoefficient,
  diodeNetlist,
  mosfetBeta,
} from './calculators';

describe('crystal calculator', () => {
  const cp = 29e-12;
  const cs = 0.1e-12;
  const l = 2.5e-3;
  const r = 6.4;

  it('computes series and parallel resonance and Q from the upstream defaults', () => {
    const { fs, fp, q } = crystalFrequencies(cp, cs, l, r);
    // The tolerance is relative: fs and fp sit near 1e7, far beyond an
    // absolute digit count, so the values are scaled before the comparison.
    expect(fs / 1e7).toBeCloseTo(1.0066, 4);
    expect(fp / 1e7).toBeCloseTo(1.0083, 4);
    expect(q / 1e4).toBeCloseTo(2.475, 3);
  });

  it('generates a 412 netlist that re-parses to the four parameters', () => {
    const parsed = parseCircuit(crystalNetlist(cp, cs, l, r));
    const crystal = parsed.elements.find((e) => e.kind === 'crystal');
    expect(crystal).toBeDefined();
    expect(crystal?.params.parallelCapacitance).toBeCloseTo(cp, 15);
    expect(crystal?.params.seriesCapacitance).toBeCloseTo(cs, 15);
    expect(crystal?.params.inductance).toBeCloseTo(l, 15);
    expect(crystal?.params.resistance).toBeCloseTo(r, 15);
  });
});

describe('diode/LED calculator', () => {
  it('computes the emission coefficient from the upstream defaults', () => {
    const ecoef = diodeEmissionCoefficient(0.6, 0.018, 171e-9);
    expect(ecoef).toBeCloseTo(2.006, 2);
  });

  it('generates a circuit whose 34 line and d element read the model params', () => {
    const ecoef = diodeEmissionCoefficient(0.6, 0.018, 171e-9);
    const parsed = parseCircuit(diodeNetlist(0.6, 0.018, 171e-9, 'my model'));
    const diode = parsed.elements.find((e) => e.kind === 'diode');
    expect(diode).toBeDefined();
    expect(diode?.params.saturationCurrent).toBeCloseTo(171e-9, 15);
    expect(diode?.params.emissionCoefficient).toBeCloseTo(ecoef, 12);
    // The rail drives the forward voltage across the diode.
    const rail = parsed.elements.find((e) => e.kind === 'rail');
    expect(rail?.params.maxVoltage).toBeCloseTo(0.6, 12);
  });

  it('strips whitespace from the model name', () => {
    const text = diodeNetlist(0.6, 0.018, 171e-9, 'my  model');
    expect(text).toContain('34 mymodel 0');
    expect(text).toContain('d 352 112 352 224 2 mymodel');
  });
});

describe('MOSFET beta worksheet', () => {
  it('computes beta from Rds(on) and the gate data point', () => {
    expect(mosfetBeta(0.1, 10, 2)).toBeCloseTo(1.25, 10);
  });
});

describe('unit parsing agrees with the calculators', () => {
  it('accepts every sample the pages use', () => {
    const samples = ['29p', '2.5m', '18m', '171n', '0.1p', '6.4'];
    for (const s of samples) {
      expect(Number.isFinite(parseUnits(s)), s).toBe(true);
      expect(parseUnits(s), s).toBeGreaterThan(0);
    }
  });
});
