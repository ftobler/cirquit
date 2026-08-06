import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { escapeToken, parseCircuit, serializeCircuit, unescapeToken } from './netlist';
import { makeElement } from '../state/store';
import { DEFAULT_SETTINGS, type CircuitElement } from '../model/types';
import { parseSetupList } from './library';
import { compressCircuit, decompressCircuit } from './urlShare';

const CIRCUITS_DIR = fileURLToPath(new URL('../../public/circuits', import.meta.url));

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

describe('subset dump', () => {
  const dropId = (e: CircuitElement) => {
    const { id, ...rest } = e;
    void id;
    return rest;
  };

  it('dumps two elements out of the whole circuit and reparses them equal apart from ids', () => {
    const parsed = parseCircuit(SAMPLE);
    const subset = parsed.elements.slice(0, 2);
    const text = serializeCircuit(subset, { ...DEFAULT_SETTINGS, ...parsed.settings });

    const back = parseCircuit(text);
    // Exactly the two selected, none of the other five.
    expect(back.elements).toHaveLength(2);
    expect(back.elements.map((e) => e.kind)).toEqual(['resistor', 'switch']);
    expect(back.scopes).toHaveLength(0);
    expect(back.elements.map(dropId)).toEqual(subset.map(dropId));
  });
});

describe('token escaping', () => {
  it('round-trips text containing spaces', () => {
    const text = 'a label with spaces';
    expect(unescapeToken(escapeToken(text))).toBe(text);
    expect(escapeToken(text)).not.toContain(' ');
  });
});

describe('diode file format', () => {
  /** Parses a single `d` line and re-emits it, returning the `d` line. */
  const diodeLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('d ')) ?? '';
    return { e, out, elementLine };
  };

  it('diode line with a model name round-trips', () => {
    const { e, elementLine } = diodeLine('d 176 80 384 80 2 1N4148');
    expect(e.modelName).toBe('1N4148');
    expect(e.flags).toBe(2);
    expect(elementLine).toBe('d 176 80 384 80 2 1N4148');
  });

  it('diode line with legacy fwdrop round-trips', () => {
    const { e, elementLine } = diodeLine('d 272 176 320 128 1 0.805904783');
    expect(e.params.forwardVoltage).toBe(0.805904783);
    expect(elementLine).toBe('d 272 176 320 128 1 0.805904783');
  });

  it('escaped model names survive', () => {
    const { e, elementLine } = diodeLine('d 1 2 3 4 2 fwdrop\\q0.805904783');
    expect(e.modelName).toBe('fwdrop=0.805904783');
    expect(elementLine).toBe('d 1 2 3 4 2 fwdrop\\q0.805904783');
  });

  it('a bare diode line saves with the upstream forward drop', () => {
    const { e, elementLine } = diodeLine('d 176 80 384 80 0');
    // No tokens: the element falls back to its defaults, which are the
    // upstream default model's values.
    expect(e.params.forwardVoltage).toBe(0.805904783);
    expect(elementLine).toBe('d 176 80 384 80 1 0.805904783');
  });

  it('a fresh diode defaults to the upstream model values', () => {
    const e = makeElement('diode', 0, 0, 32, 0);
    expect(e.params.forwardVoltage).toBe(0.805904783);
    expect(e.params.emissionCoefficient).toBe(2);
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    // Only the forward drop survives the value form; seriesResistance and
    // emissionCoefficient are engine params, as upstream's one-token dump.
    expect(out).toContain('d 0 0 32 0 1 0.805904783');
  });
});

describe('zener file format', () => {
  /** Parses a single `z` line and re-emits it, returning the `z` line. */
  const zenerLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('z ')) ?? '';
    return { e, out, elementLine };
  };

  it('a library zener line loads its real voltage', () => {
    // The bundled form (zenerref.txt:3). The misparse read the fwdrop token
    // into breakdownVoltage and dropped the 5.6 entirely, so the UI showed a
    // 0.806 V zener.
    const { e } = zenerLine('z 336 288 336 160 1 0.805904783 5.6');
    expect(e.params.forwardVoltage).toBe(0.805904783);
    expect(e.params.breakdownVoltage).toBe(5.6);
    expect(e.flags).toBe(1);
  });

  it('a library zener line round-trips', () => {
    // Byte-identical, so upstream re-reads it instead of throwing on the
    // missing zvoltage token and dropping the element.
    const { elementLine } = zenerLine('z 336 288 336 160 1 0.805904783 5.6');
    expect(elementLine).toBe('z 336 288 336 160 1 0.805904783 5.6');
  });

  it('a zener model name round-trips', () => {
    const { e, elementLine } = zenerLine('z 100 100 100 0 2 default-zener');
    expect(e.modelName).toBe('default-zener');
    expect(e.flags).toBe(2);
    expect(elementLine).toBe('z 100 100 100 0 2 default-zener');
  });

  it('an escaped zener model name round-trips', () => {
    // What upstream writes for a legacy zener after one save: the generated
    // model name carries `=` and a space.
    const line = 'z 100 100 100 0 2 fwdrop\\q0.805904783\\szvoltage\\q5.6';
    const { e, elementLine } = zenerLine(line);
    expect(e.modelName).toBe('fwdrop=0.805904783 zvoltage=5.6');
    expect(elementLine).toBe(line);
  });

  it('a legacy bare zener line saves with both tokens', () => {
    const { e, elementLine } = zenerLine('z 100 100 100 0 0 5.6');
    expect(e.params.breakdownVoltage).toBe(5.6);
    expect(e.params.forwardVoltage).toBe(0.805904783);
    // Not byte-identical but semantically the same to upstream:
    // getModelWithParameters(0.805904783, 5.6) is the default-zener model.
    expect(elementLine).toBe('z 100 100 100 0 1 0.805904783 5.6');
  });

  it('a fresh zener defaults to the upstream default-zener model', () => {
    const e = makeElement('zener', 0, 0, 32, 0);
    expect(e.params.breakdownVoltage).toBe(5.6);
    expect(e.params.forwardVoltage).toBe(0.805904783);
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    expect(out).toContain('z 0 0 32 0 1 0.805904783 5.6');
  });
});

describe('transistor file format', () => {
  /** Parses a single element line and re-emits it, returning the `t` line. */
  const transistorLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('t ')) ?? '';
    return { e, out, elementLine };
  };

  it('transistor_pnp_token_round_trips_as_a_sign', () => {
    const { e, elementLine } = transistorLine(
      't 208 336 256 336 0 -1 0 -0.631032106406004 100',
    );
    expect(e.params.pnp).toBe(-1);
    expect(elementLine).toBe('t 208 336 256 336 0 -1 0 -0.631032106406004 100');
  });

  it('round-trips a pnp = 1 NPN line byte-for-byte', () => {
    const { e, elementLine } = transistorLine(
      't 400 304 464 304 0 1 0.647542643140423 0.6813812722941772 100',
    );
    expect(e.params.pnp).toBe(1);
    expect(elementLine).toBe('t 400 304 464 304 0 1 0.647542643140423 0.6813812722941772 100');
  });

  it('transistor_model_name_token_is_preserved', () => {
    const { e, elementLine } = transistorLine(
      't 496 256 560 256 0 1 -3.1354863883836575 0.6928898087953951 100 early',
    );
    expect(e.params.pnp).toBe(1);
    expect(e.text).toBe('early');
    expect(elementLine.endsWith(' early')).toBe(true);
    const [again] = parseCircuit(elementLine).elements;
    expect(again.text).toBe('early');
    expect(again.params.pnp).toBe(1);
  });

  it('drops a non-finite token to its default instead of storing NaN', () => {
    const { e, elementLine } = transistorLine('t 100 100 200 100 0 1 abc 0.5 100');
    expect(e.params.lastVbe).toBeUndefined();
    expect(e.params.lastVbc).toBe(0.5);
    expect(e.params.beta).toBe(100);
    expect(elementLine).toBe('t 100 100 200 100 0 1 0 0.5 100');
  });

  it('legacy_zero_pnp_normalizes_to_npn', () => {
    const { e, elementLine } = transistorLine('t 100 100 200 100 0 0 -0.5 0.6 100');
    expect(e.params.pnp).toBe(1);
    expect(elementLine).toContain(' 1 -0.5 0.6 100');
  });

  it('three_token_transistor_line_keeps_default_beta', () => {
    const { e, elementLine } = transistorLine(
      't 240 208 336 208 0 1 -10.980847640834186 0.5689504449104646',
    );
    expect(e.params.beta).toBe(100);
    expect(elementLine).toBe(
      't 240 208 336 208 0 1 -10.980847640834186 0.5689504449104646 100',
    );
    const [again] = parseCircuit(elementLine).elements;
    expect(again.params.pnp).toBe(1);
    expect(again.params.beta).toBe(100);
  });
});

describe('transistor corpus parity', () => {
  it('every bundled t line parses to +1 or -1 and survives a round trip', () => {
    const files = readdirSync(CIRCUITS_DIR).filter((f) => f.endsWith('.txt'));
    let lines = 0;
    let npn = 0;
    let pnp = 0;
    let withModel = 0;
    const anomalies: string[] = [];
    for (const file of files) {
      const parsed = parseCircuit(readFileSync(join(CIRCUITS_DIR, file), 'utf8'));
      for (const e of parsed.elements) {
        if (e.kind !== 'transistor') continue;
        lines += 1;
        if (e.params.pnp === -1) pnp += 1;
        else if (e.params.pnp === 1) npn += 1;
        else anomalies.push(`${file}: pnp=${e.params.pnp}`);
        if (e.text !== undefined) withModel += 1;
        const [again] = parseCircuit(
          serializeCircuit([e], { ...DEFAULT_SETTINGS, ...parsed.settings }),
        ).elements;
        if (again.params.pnp !== e.params.pnp) {
          anomalies.push(`${file}: pnp changed on round trip`);
        }
        if (again.text !== e.text) {
          anomalies.push(`${file}: model name changed on round trip`);
        }
      }
    }
    console.log(`t lines ${lines}: npn ${npn}, pnp ${pnp}, model names ${withModel}`);
    expect(anomalies).toEqual([]);
    expect(lines).toBeGreaterThan(0);
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

  it('defaults a missing size token to 24, the upstream constructor size', () => {
    const { e } = roundTrip('x 100 200 0 0 0');
    expect(e.params.size).toBe(24);
    expect(e.text).toBe('');
  });

  it('treats a size of 0 in a file as 24', () => {
    const { e, elementLine } = roundTrip('x 100 200 0 0 0 0 hello');
    expect(e.params.size).toBe(24);
    expect(e.text).toBe('hello');
    // The clamp at draw time must not change the file format.
    expect(elementLine).toBe('x 100 200 0 0 0 24 hello');
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
      ['### comment', '+Basics', "ohms.txt Ohm's Law", '>lrc.txt LRC Circuit', '-'].join('\n'),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe('Basics');
    expect(groups[0].entries).toEqual([
      { file: 'ohms.txt', title: "Ohm's Law" },
      { file: 'lrc.txt', title: 'LRC Circuit' },
    ]);
  });
});
