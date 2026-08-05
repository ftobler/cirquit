import { describe, expect, it } from 'vitest';
import { escapeToken, parseCircuit, serializeCircuit, unescapeToken } from './netlist';
import { DEFAULT_SETTINGS, type CircuitElement } from '../model/types';
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

describe('text element', () => {
  // The line layout is `x x1 y1 x2 y2 flags size text...`; the text is every
  // token after the size and may contain spaces.
  const LINE = 'x 100 200 0 0 0 12 hello world here';

  const roundTrip = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const [again] = parseCircuit(out).elements;
    const elementLine = out.split('\n').find((l) => l.startsWith('x ')) ?? '';
    return { e, out, again, elementLine };
  };

  it('parses the text after the size token and re-emits it losslessly', () => {
    const { e, elementLine, again } = roundTrip(LINE);
    expect(e.text).toBe('hello world here');
    expect(e.params.size).toBe(12);
    // Spaces are escaped on save, so the re-parsed text is the source of
    // truth, not the literal line.
    expect(elementLine).toBe('x 100 200 0 0 0 12 hello\\sworld\\shere');
    expect(again.text).toBe('hello world here');
    expect(again.params.size).toBe(12);
  });

  it('round-trips empty text as empty, not a literal undefined', () => {
    const { e, again } = roundTrip('x 100 200 0 0 0 12');
    expect(e.text).toBe('');
    expect(again.text).toBe('');
  });

  it('never writes a raw newline into the file', () => {
    const e: CircuitElement = {
      id: 1,
      kind: 'decoration',
      x1: 100,
      y1: 200,
      x2: 0,
      y2: 0,
      flags: 0,
      params: { size: 12 },
      text: 'line1\nline2',
    };
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    // The element stays on one line because the newline is escaped, and the
    // escape survives a load.
    const lines = out.split('\n').filter((l) => l.startsWith('x '));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('line1\\nline2');
    expect(parseCircuit(out).elements[0].text).toBe('line1\nline2');
  });

  it('keeps non-ASCII characters intact', () => {
    const { again } = roundTrip('x 100 200 0 0 0 12 µ 5 Ω hér');
    expect(again.text).toBe('µ 5 Ω hér');
  });

  it('defaults a missing size token to 12', () => {
    const { e } = roundTrip('x 100 200 0 0 0');
    expect(e.params.size).toBe(12);
    expect(e.text).toBe('');
  });

  it('treats a size of 0 in a file as 12', () => {
    const { e, elementLine } = roundTrip('x 100 200 0 0 0 0 hello');
    expect(e.params.size).toBe(12);
    expect(e.text).toBe('hello');
    // The clamp at draw time must not change the file format.
    expect(elementLine).toBe('x 100 200 0 0 0 12 hello');
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
