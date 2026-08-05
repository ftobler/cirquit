import { describe, expect, it } from 'vitest';
import { escapeToken, parseCircuit, serializeCircuit, unescapeToken } from './netlist';
import { DEFAULT_SETTINGS } from '../model/types';
import { parseSetupList } from './library';
import { compressCircuit, decompressCircuit } from './urlShare';

/** A circuit in the original format, exercising several element types. */
const SAMPLE = `$ 1 0.000005 10.20027730826997 50 5 43 5e-11
r 176 80 384 80 0 10
s 384 80 448 80 0 1 false
w 176 80 176 352 0
c 384 352 176 352 0 0.000015 -9.86 -10
l 384 80 384 352 0 1 0.03 0
v 448 352 448 80 0 0 40 5 0 0 0.5
g 176 352 176 384 0
o 4 64 0 4099 20 0.05 0 2 4 3
38 3 0 0.000001 0.000101 Capacitance
`;

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
});

describe('token escaping', () => {
  it('round-trips text containing spaces', () => {
    const text = 'a label with spaces';
    expect(unescapeToken(escapeToken(text))).toBe(text);
    expect(escapeToken(text)).not.toContain(' ');
  });
});

describe('url sharing', () => {
  it('round-trips a circuit through the compressed form', () => {
    expect(decompressCircuit(compressCircuit(SAMPLE))).toBe(SAMPLE);
  });

  it('produces URI-safe output', () => {
    const token = compressCircuit(SAMPLE);
    expect(encodeURIComponent(token)).toBe(token);
  });
});

describe('circuit library index', () => {
  it('groups entries under their headings', () => {
    const groups = parseSetupList(
      ['### comment', '+Basics', 'ohms.txt Ohm\'s Law', '>lrc.txt LRC Circuit', '-'].join('\n'),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe('Basics');
    expect(groups[0].entries).toEqual([
      { file: 'ohms.txt', title: "Ohm's Law" },
      { file: 'lrc.txt', title: 'LRC Circuit' },
    ]);
  });
});
