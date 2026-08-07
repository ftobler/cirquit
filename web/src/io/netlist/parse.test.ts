import { describe, expect, it } from 'vitest';
import { parseCircuit, serializeCircuit } from './index';
import { SAMPLE } from './fixtures';
import { DEFAULT_SETTINGS } from '../../model/types';

describe('netlist parsing', () => {
  it('reads every supported element on the line', () => {
    const parsed = parseCircuit(SAMPLE);
    expect(parsed.elements.map((e) => e.kind)).toEqual([
      'resistor',
      'switch',
      'wire',
      'capacitor',
      'inductor',
      'voltage',
      'ground',
    ]);
  });

  it('reads coordinates, flags and parameters', () => {
    const [resistor, , , capacitor, , voltage] = parseCircuit(SAMPLE).elements;
    expect(resistor).toMatchObject({ x1: 176, y1: 80, x2: 384, y2: 80, flags: 0 });
    expect(resistor.params.resistance).toBe(10);
    expect(capacitor.params.capacitance).toBe(0.000015);
    // waveform, frequency, amplitude
    expect(voltage.params.waveform).toBe(0);
    expect(voltage.params.frequency).toBe(40);
    expect(voltage.params.maxVoltage).toBe(5);
  });

  it('reads global settings from the header', () => {
    const parsed = parseCircuit(SAMPLE);
    expect(parsed.settings.timeStep).toBe(0.000005);
    expect(parsed.settings.currentSpeed).toBe(50);
    expect(parsed.settings.voltageRange).toBe(5);
  });

  it('reads iterCount and minTimeStep from the header', () => {
    const parsed = parseCircuit('$ 1 0.000005 10.20027730826997 50 5 43 5e-11\n');
    expect(parsed.settings.iterCount).toBe(10.20027730826997);
    expect(parsed.settings.minTimeStep).toBe(5e-11);
    expect(parsed.settings.adaptiveTimeStep).toBe(false);
  });

  it('decodes header flag bit 64 into adaptiveTimeStep', () => {
    expect(parseCircuit('$ 64 0.000005 10 50 5 50 5e-11\n').settings.adaptiveTimeStep).toBe(true);
    expect(parseCircuit('$ 0 0.000005 10 50 5 50 5e-11\n').settings.adaptiveTimeStep).toBe(false);
  });

  it('decodes header flag bit 128 into autoDC', () => {
    expect(parseCircuit('$ 128 0.000005 10 50 5 43 5e-11\n').settings.autoDC).toBe(true);
    expect(parseCircuit('$ 1 0.000005 10 50 5 43 5e-11\n').settings.autoDC).toBe(false);
  });

  it('keeps scope lines and unmodelled lines instead of dropping them', () => {
    const parsed = parseCircuit(SAMPLE);
    expect(parsed.scopes).toHaveLength(1);
    expect(parsed.scopes[0].elementIndex).toBe(4);
    // The `38` slider line is not modelled but must survive a save.
    expect(parsed.passthrough.some((l) => l.startsWith('38 '))).toBe(true);
  });

  it('round-trips element lines byte-for-byte', () => {
    const parsed = parseCircuit(SAMPLE);
    const out = serializeCircuit(parsed.elements, {
      ...DEFAULT_SETTINGS,
      ...parsed.settings,
    });
    const lines = out.trim().split('\n');
    expect(lines).toContain('r 176 80 384 80 0 10');
    expect(lines).toContain('w 176 80 176 352 0');
    expect(lines).toContain('v 448 352 448 80 0 0 40 5 0 0 0.5');
  });

  it('reparses its own output to the same circuit', () => {
    const first = parseCircuit(SAMPLE);
    const text = serializeCircuit(first.elements, { ...DEFAULT_SETTINGS, ...first.settings });
    const second = parseCircuit(text);
    expect(second.elements.map((e) => e.kind)).toEqual(first.elements.map((e) => e.kind));
    expect(second.elements.map((e) => [e.x1, e.y1, e.x2, e.y2])).toEqual(
      first.elements.map((e) => [e.x1, e.y1, e.x2, e.y2]),
    );
  });

  it('ignores unknown element types without failing the load', () => {
    const parsed = parseCircuit('$ 1 0.000005 10 50 5 43 5e-11\n999 1 2 3 4 0\nr 0 0 16 0 0 100\n');
    expect(parsed.elements).toHaveLength(1);
    expect(parsed.unsupported).toContain('999');
  });

  it('reports the non-element line types upstream dispatches on', () => {
    // `!` custom-logic model, `%`/`?` afilter, `.` subcircuit definition
    // (CircuitLoader.java:163-191). None is an element, but none is
    // interpreted either, so the load has to admit it.
    const parsed = parseCircuit('! model stuff\n% 1 2\n? 3 4\n. sub\n');
    expect(parsed.unsupported).toEqual(['!', '%', '?', '.']);
    expect(parsed.passthrough).toEqual(['! model stuff', '% 1 2', '? 3 4', '. sub']);
  });
});
