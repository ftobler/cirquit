import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  escapeToken,
  parseCircuit,
  serializeCircuit,
  unescapeToken,
  type NetlistLine,
} from './netlist';
import { makeElement, useStore } from '../state/store';
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

  it('reports the non-element line types upstream dispatches on', () => {
    // `!` custom-logic model, `%`/`?` afilter, `.` subcircuit definition
    // (CircuitLoader.java:163-191). None is an element, but none is
    // interpreted either, so the load has to admit it.
    const parsed = parseCircuit('! model stuff\n% 1 2\n? 3 4\n. sub\n');
    expect(parsed.unsupported).toEqual(['!', '%', '?', '.']);
    expect(parsed.passthrough).toEqual(['! model stuff', '% 1 2', '? 3 4', '. sub']);
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

  it('covers the whole upstream escape set in one round trip', () => {
    // Every character CustomLogicModel.java:259-263 rewrites: a literal
    // backslash, a space, a newline, `+`, `=`, `#`, `&` and a carriage return.
    const text = 'a\\b c\nd+e=f#g&h\rtail';
    expect(escapeToken(text)).toBe('a\\\\b\\sc\\nd\\pe\\qf\\hg\\ah\\rtail');
    expect(unescapeToken(escapeToken(text))).toBe(text);
  });

  it('maps the empty string to the whole-token \\0 and back', () => {
    expect(escapeToken('')).toBe('\\0');
    expect(unescapeToken('\\0')).toBe('');
    // Only the whole token means empty; embedded, the backslash of an unknown
    // escape is simply dropped (CustomLogicModel.java:287-288).
    expect(unescapeToken('a\\0b')).toBe('a0b');
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

describe('capacitor file format', () => {
  /** Parses a single element line and re-emits it, returning that line. */
  const capLine = (line: string, code = 'c') => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith(`${code} `)) ?? '';
    return { e, out, elementLine };
  };

  it('capacitor line with FLAG_RESISTANCE round-trips', () => {
    // The flag is what says the fourth token exists (CapacitorElm.java:59-60),
    // and upstream's own dump always sets it (:70), so this is byte-identical.
    const line = 'c 384 352 176 352 4 0.000015 -9.86 -10 100';
    const { e, elementLine } = capLine(line);
    expect(e.params.seriesResistance).toBe(100);
    expect(e.flags).toBe(4);
    expect(elementLine).toBe(line);
  });

  it('capacitor line without FLAG_RESISTANCE still keeps its ESR token', () => {
    // Upstream reads the fourth token only under the flag
    // (CapacitorElm.java:59-60), but the flag is there to keep the stream
    // position unambiguous for PolarCapacitorElm; nothing follows on a plain
    // `c`, so honouring it here would only throw the value away. The three
    // four-token flagless lines in the corpus are all in cappar.txt, and one
    // of them carries a real 0.1 ohm that upstream's `validate()` put there.
    const { e, elementLine } = capLine('c 384 352 176 352 0 0.000015 -9.86 -10 100');
    expect(e.params.seriesResistance).toBe(100);
    expect(elementLine).toBe('c 384 352 176 352 4 0.000015 -9.86 -10 100');
  });

  it('keeps the ESR cappar.txt records from upstream validate()', () => {
    // cappar.txt:22 verbatim. Two 0.2 mF and 0.1 mF caps sit directly in
    // parallel with unequal restored charges, which is the ideal-capacitor
    // loop `CapacitorElm.validate()` (:274-291) damps by writing a 0.1 ohm
    // series resistance. Dropping the token made them ideal again and the
    // next save wrote a zero over the only record of it.
    const line = 'c 192 192 192 288 0 0.00019999999999999998 0.9251369906278213 0.001 0.1';
    const { e, elementLine } = capLine(line);
    expect(e.params.seriesResistance).toBe(0.1);
    expect(elementLine).toBe(
      'c 192 192 192 288 4 0.00019999999999999998 0.9251369906278213 0.001 0.1',
    );
  });

  it('capacitor back-euler flag survives a save', () => {
    // FLAG_BACK_EULER (2) is the integration rule and must not be lost when
    // the writer adds FLAG_RESISTANCE (4) on top of it.
    const { elementLine } = capLine('c 384 352 176 352 2 0.000015 -9.86 -10');
    expect(elementLine).toBe('c 384 352 176 352 6 0.000015 -9.86 -10 0');
  });

  it('a capacitor line with no initial voltage takes upstream 1e-3', () => {
    // 289 of the bundled `c` lines stop after voltDiff. Upstream's fallback is
    // 1e-3, not 0 (CapacitorElm.java:45), so the save has to write that or a
    // reload would quietly change the element's reset behaviour.
    const { e, elementLine } = capLine('c 384 352 176 352 0 0.000015 -9.86');
    expect(e.params.initialVoltage).toBe(1e-3);
    expect(elementLine).toBe('c 384 352 176 352 4 0.000015 -9.86 0.001 0');
  });

  it('a fresh capacitor dumps the upstream constructor defaults', () => {
    const e = makeElement('capacitor', 0, 0, 32, 0);
    expect(e.params.initialVoltage).toBe(1e-3);
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    expect(out).toContain('c 0 0 32 0 4 0.00001 0 0.001 0');
  });

  it('a polarised capacitor without FLAG_RESISTANCE reads its rating one token earlier', () => {
    // PolarCapacitorElm reads maxNegativeVoltage off the same token stream its
    // superclass left (PolarCapacitorElm.java:16), so the conditional ESR
    // token shifts it. Without the bit, `1` here is the rating, not an ESR.
    const { e } = capLine('209 384 352 176 352 0 0.000015 -9.86 -10 1', '209');
    expect(e.params.seriesResistance).toBe(0);
    expect(e.params.maxNegativeVoltage).toBe(1);
  });

  it('a polarised capacitor with FLAG_RESISTANCE round-trips', () => {
    const line = '209 384 352 176 352 4 0.000015 -9.86 -10 100 25';
    const { e, elementLine } = capLine(line, '209');
    expect(e.params.seriesResistance).toBe(100);
    expect(e.params.maxNegativeVoltage).toBe(25);
    expect(elementLine).toBe(line);
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

describe('varactor file format', () => {
  /** Parses a single `176` line and re-emits it, returning the `176` line. */
  const varactorLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('176 ')) ?? '';
    return { e, out, elementLine };
  };

  it('a bundled varactor line round-trips byte-for-byte', () => {
    // varactor.txt:3. Upstream's own dump() would drop the trailing two
    // tokens (see the registry comment), but this port's writer keeps them,
    // so a real file from the corpus reproduces exactly.
    const line = '176 560 256 560 352 1 0.805904783 -0.9415790148957013 4e-12';
    const { e, elementLine } = varactorLine(line);
    expect(e.params.forwardVoltage).toBe(0.805904783);
    expect(e.params.capVoltDiff).toBe(-0.9415790148957013);
    expect(e.params.baseCapacitance).toBe(4e-12);
    expect(elementLine).toBe(line);
  });

  it('a varactor line with a model name round-trips', () => {
    const { e, elementLine } = varactorLine('176 1 2 3 4 2 1N4001 -1.5 4e-12');
    expect(e.modelName).toBe('1N4001');
    expect(e.params.capVoltDiff).toBe(-1.5);
    expect(e.params.baseCapacitance).toBe(4e-12);
    expect(e.flags).toBe(2);
    expect(elementLine).toBe('176 1 2 3 4 2 1N4001 -1.5 4e-12');
  });

  it('a bare varactor line with neither flag still reads its own two tokens', () => {
    // Matches VaractorElm's own token constructor: DiodeElm reads nothing
    // when neither flag is set, but VaractorElm keeps reading capvoltdiff and
    // baseCapacitance regardless (VaractorElm.java:13-18).
    const { e, elementLine } = varactorLine('176 0 0 32 0 0 -1 4e-12');
    // No forwardVoltage token: falls back to the default, like a bare diode
    // line does.
    expect(e.params.forwardVoltage).toBe(0.805904783);
    expect(e.params.capVoltDiff).toBe(-1);
    expect(e.params.baseCapacitance).toBe(4e-12);
    // Saving falls back to the value form with the default forward drop.
    expect(elementLine).toBe('176 0 0 32 0 1 0.805904783 -1 4e-12');
  });

  it('a fresh varactor defaults to the upstream model values and 4 pF', () => {
    const e = makeElement('varactor', 0, 0, 32, 0);
    expect(e.params.forwardVoltage).toBe(0.805904783);
    expect(e.params.baseCapacitance).toBe(4e-12);
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    expect(out).toContain('176 0 0 32 0 1 0.805904783 0 4e-12');
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
    // Spaces are escaped on save and FLAG_ESCAPE (4) goes on to say so, so the
    // re-parsed text is the source of truth, not the literal line.
    expect(elementLine).toBe('x 100 200 0 0 4 12 hello\\sworld\\shere');
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
    expect(elementLine).toBe('x 100 200 0 0 4 24 hello');
  });
});

describe('the $ header', () => {
  const headerOf = (text: string, patch: Partial<typeof DEFAULT_SETTINGS> = {}) => {
    const parsed = parseCircuit(text);
    const out = serializeCircuit(
      parsed.elements,
      { ...DEFAULT_SETTINGS, ...parsed.settings, ...patch },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
    );
    return { parsed, line: out.split('\n')[0] };
  };

  it('round-trips every field, including the three it does not model', () => {
    const { parsed, line } = headerOf(SAMPLE);
    expect(parsed.settings.iterCount).toBe(10.20027730826997);
    expect(parsed.settings.powerRange).toBe(43);
    expect(parsed.settings.minTimeStep).toBe(5e-11);
    expect(parsed.settings.headerFlags).toBe(1);
    // Byte-identical: before this, iterCount became 10, powerRange 50 and
    // minTimeStep timeStep/100, and the flags collapsed to 0.
    expect(line).toBe('$ 1 0.000005 10.20027730826997 50 5 43 5e-11');
  });

  it('keeps the flag bits it does not model when an edit changes the one it does', () => {
    // Bits 1 (current dots) and 4 (volts) are nowhere decoded here, so turning
    // value labels off must not clear them.
    const { line } = headerOf('$ 5 1e-5 10 50 5 43 5e-11\n', { showValues: false });
    expect(line.split(' ')[1]).toBe(String(16 | 5));
  });

  it('a circuit with no loaded header writes the long-standing defaults', () => {
    const out = serializeCircuit([], { ...DEFAULT_SETTINGS });
    expect(out.split('\n')[0]).toBe('$ 0 0.000005 10 50 5 50 5e-11');
  });

  it('an old header that stops early gains the missing fields, as upstream writes them', () => {
    // CircuitLoader.java:263-266 reads powerRange and minTimeStep in a
    // try/catch precisely because files like this exist.
    const { parsed, line } = headerOf('$ 0 5.0E-6 1.5 50 5.0\nr 0 0 16 0 0 100\n');
    expect(parsed.settings.powerRange).toBeUndefined();
    expect(parsed.settings.minTimeStep).toBeUndefined();
    expect(line).toBe('$ 0 0.000005 1.5 50 5 50 5e-11');
  });
});

describe('line order, blank lines and comments', () => {
  const ORDERED = [
    '$ 0 0.000005 10 50 5 43 5e-11',
    'r 0 0 16 0 0 100',
    '38 3 0 0.000001 0.000101 Capacitance',
    'r 16 0 32 0 0 220',
    '',
  ].join('\n');

  const save = (parsed: ReturnType<typeof parseCircuit>, elements = parsed.elements) =>
    serializeCircuit(
      elements,
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
    );

  it('keeps blank lines and # comments where the author put them', () => {
    const text = '$ 0 0.000005 10 50 5 43 5e-11\n\n# a comment\nr 0 0 16 0 0 100\n\n';
    const parsed = parseCircuit(text);
    expect(save(parsed)).toBe(text);
  });

  it('keeps an unmodelled line between the elements it was written between', () => {
    const parsed = parseCircuit(ORDERED);
    expect(save(parsed).split('\n')).toEqual([
      '$ 0 0.000005 10 50 5 43 5e-11',
      'r 0 0 16 0 0 100',
      '38 3 0 0.000001 0.000101 Capacitance',
      'r 16 0 32 0 0 220',
      '',
    ]);
  });

  it('appends an element added after the load without disturbing the rest', () => {
    const parsed = parseCircuit(ORDERED);
    const added = { ...makeElement('resistor', 32, 0, 48, 0), id: 9999 };
    const lines = save(parsed, [...parsed.elements, added]).split('\n');
    expect(lines[2]).toBe('38 3 0 0.000001 0.000101 Capacitance');
    expect(lines[4]).toBe('r 32 0 48 0 0 1000');
  });

  it('lets a deleted element vacate its slot instead of shifting the file', () => {
    const parsed = parseCircuit(ORDERED);
    const lines = save(parsed, parsed.elements.slice(1)).split('\n');
    expect(lines).toEqual([
      '$ 0 0.000005 10 50 5 43 5e-11',
      '38 3 0 0.000001 0.000101 Capacitance',
      'r 16 0 32 0 0 220',
      '',
    ]);
  });

  it('splits on CRLF and on a bare CR, as upstream does', () => {
    // A classic-Mac file is all CRs. Splitting on `\n` alone would make the
    // whole circuit one unreadable line (CircuitLoader.java:133-140).
    const cr = parseCircuit('$ 0 5e-6 10 50 5 43 5e-11\rr 0 0 16 0 0 100\rr 16 0 32 0 0 220\r');
    const crlf = parseCircuit(
      '$ 0 5e-6 10 50 5 43 5e-11\r\nr 0 0 16 0 0 100\r\nr 16 0 32 0 0 220\r\n',
    );
    for (const parsed of [cr, crlf]) {
      expect(parsed.elements.map((e) => e.params.resistance)).toEqual([100, 220]);
      // Both come back as LF: the one normalisation the writer cannot avoid.
      expect(
        serializeCircuit(
          parsed.elements,
          { ...DEFAULT_SETTINGS, ...parsed.settings },
          parsed.scopes,
          parsed.passthrough,
          parsed.order,
        ),
      ).toBe('$ 0 0.000005 10 50 5 43 5e-11\nr 0 0 16 0 0 100\nr 16 0 32 0 0 220\n');
    }
  });

  it('falls back to the old layout for a subset dump with no order', () => {
    const parsed = parseCircuit(ORDERED);
    const out = serializeCircuit(parsed.elements, { ...DEFAULT_SETTINGS, ...parsed.settings });
    expect(out.split('\n').slice(1, 3)).toEqual(['r 0 0 16 0 0 100', 'r 16 0 32 0 0 220']);
  });
});

describe('bundled circuit round trips', () => {
  const files = readdirSync(CIRCUITS_DIR).filter(
    (f) => f.endsWith('.txt') && f !== 'setuplist.txt',
  );
  const read = (file: string) => readFileSync(join(CIRCUITS_DIR, file), 'utf8');

  /** Same classification as `corpus.ts`: the root can follow a BOM or a blank
   *  line, so it is the first non-blank line that decides. */
  const isXml = (text: string) =>
    (text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '').trimStart().startsWith('<cir ');

  /**
   * The `$` line is rebuilt from numbers, so a Java-written `5.0E-6` comes
   * back as `0.000005` and an old six-token header gains its seventh. What
   * must hold is that no field changes value and none is dropped, which is
   * what catches a field being replaced by a default.
   */
  const headerAnomaly = (before: string, after: string): string | null => {
    const a = before.split(/\s+/);
    const b = after.split(/\s+/);
    if (b.length !== 8) return `header has ${b.length - 1} fields, expected 7`;
    for (let i = 1; i < Math.min(a.length, 8); i++) {
      if (Number(a[i]) !== Number(b[i])) return `field ${i}: ${a[i]} -> ${b[i]}`;
    }
    return null;
  };

  /**
   * Compares a file with its own re-serialisation. Element lines re-render
   * their numbers too, so only their count is checked. Everything else,
   * comments, blank lines, scope lines and every line this build cannot read,
   * must come back byte-for-byte.
   */
  const compare = (file: string, text: string, out: string, order: NetlistLine[]) => {
    const anomalies: string[] = [];
    const before = text.split('\n');
    const after = out.split('\n');
    if (before.length !== after.length) {
      return [`${file}: ${before.length} lines in, ${after.length} out`];
    }
    order.forEach((entry, i) => {
      if (entry.kind === 'element') return;
      if (entry.kind === 'header') {
        const bad = headerAnomaly(before[i], after[i]);
        if (bad) anomalies.push(`${file}:${i + 1}: ${bad}`);
        return;
      }
      if (before[i] === after[i]) return;
      anomalies.push(
        `${file}:${i + 1}: ${JSON.stringify(before[i])} -> ${JSON.stringify(after[i])}`,
      );
    });
    return anomalies;
  };

  it('reproduces the line arrangement of every file, verbatim for the lines it cannot read', () => {
    const anomalies: string[] = [];
    let headers = 0;
    for (const file of files) {
      const text = read(file);
      const parsed = parseCircuit(text);
      const out = serializeCircuit(
        parsed.elements,
        { ...DEFAULT_SETTINGS, ...parsed.settings },
        parsed.scopes,
        parsed.passthrough,
        parsed.order,
      );
      headers += parsed.order.filter((l) => l.kind === 'header').length;
      anomalies.push(...compare(file, text, out, parsed.order));
    }
    expect(anomalies).toEqual([]);
    // Every non-XML file has exactly one `$` line, and `compare` byte-checks
    // each of them; without this the header claim would rest on one sample.
    expect(headers).toBe(files.length - files.filter((f) => isXml(read(f))).length);
  });

  it('round-trips every file through the store, which is how the app saves', () => {
    // `serializeCircuit` alone bypasses the scope mapping and the settings
    // merge, which is exactly where a save loses data.
    const anomalies: string[] = [];
    for (const file of files) {
      const text = read(file);
      useStore.getState().loadNetlist(text);
      const s = useStore.getState();
      anomalies.push(...compare(file, text, s.toNetlist(), s.order));
    }
    expect(anomalies).toEqual([]);
  });

  it('leaves the XML-format files exactly as they were', () => {
    // 38 of the bundled circuits are upstream's `<cir>` XML, which this build
    // does not import. Passing them through unchanged is the whole promise
    // until it does: a `$` line in front would stop upstream reading them.
    const xml = files.filter((f) => isXml(read(f)));
    expect(xml).toHaveLength(38);
    for (const file of xml) {
      useStore.getState().loadNetlist(read(file));
      expect(useStore.getState().toNetlist(), file).toBe(read(file));
    }
  });
});

describe('potentiometer slider text', () => {
  const potLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    return { e, elementLine: out.split('\n').find((l) => l.startsWith('174 ')) ?? '' };
  };

  it('reads a multi-word caption and writes it back as raw tokens', () => {
    // scractrig.txt:9. Upstream joins the remaining tokens with single spaces
    // and never escapes them, so `Trigger\sVoltage` would be wrong.
    const { e, elementLine } = potLine('174 320 352 384 96 1 1000.0 0.5 Trigger Voltage');
    expect(e.text).toBe('Trigger Voltage');
    expect(elementLine).toBe('174 320 352 384 96 1 1000 0.5 Trigger Voltage');
  });

  it('falls back to the constructor default when the file carries no caption', () => {
    const { e, elementLine } = potLine('174 320 352 384 96 0 1000.0 0.5');
    expect(e.text).toBeUndefined();
    expect(elementLine).toBe('174 320 352 384 96 0 1000 0.5 Resistance');
  });
});

describe('switch and SPDT labels', () => {
  const switchLine = (line: string, code = 's ') => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    return { e, elementLine: out.split('\n').find((l) => l.startsWith(code)) ?? '' };
  };

  it('round-trips a labelled switch (relays.txt:40)', () => {
    const { e, elementLine } = switchLine('s 1120 432 1232 432 6 1 false A');
    expect(e.flags).toBe(6);
    expect(e.text).toBe('A');
    expect(elementLine).toBe('s 1120 432 1232 432 6 1 false A');
  });

  it('writes no label token, and no FLAG_LABEL, without a label', () => {
    const { e, elementLine } = switchLine('s 384 80 448 80 0 1 false');
    expect(e.text).toBeUndefined();
    expect(elementLine).toBe('s 384 80 448 80 0 1 false');
  });

  it('does not let an SPDT label shift link and throwCount', () => {
    // Upstream consumes the label in super(...) before reading these two
    // (Switch2Elm.java:44-50); reading them one token early gave link NaN.
    const { e, elementLine } = switchLine('S 1120 432 1232 432 4 1 false A 3 4', 'S ');
    expect(e.text).toBe('A');
    expect(e.params.link).toBe(3);
    expect(e.params.throwCount).toBe(4);
    expect(elementLine).toBe('S 1120 432 1232 432 4 1 false A 3 4');
  });

  it('reads link and throwCount from an unlabelled legacy SPDT line', () => {
    const { e, elementLine } = switchLine('S 144 144 144 64 0 false false 1', 'S ');
    expect(e.params.link).toBe(1);
    expect(e.params.throwCount).toBe(2);
    // The `false` position normalises to 0, which is the same switch.
    expect(elementLine).toBe('S 144 144 144 64 0 0 false 1 2');
  });
});

describe('FLAG_ESCAPE on text and labeled nodes', () => {
  const lineFor = (e: CircuitElement, code: string) =>
    serializeCircuit([e], { ...DEFAULT_SETTINGS })
      .trim()
      .split('\n')
      .find((l) => l.startsWith(code)) ?? '';

  it('reads the escapes the port used to mangle (jkff.txt:51)', () => {
    const [e] = parseCircuit('x -101 151 0 154 4 12 JK\\q00:\\sNo\\sChange').elements;
    // `\q` is `=`; it used to come back as a bare `q`.
    expect(e.text).toBe('JK=00: No Change');
  });

  it('round-trips empty text as the whole-token \\0', () => {
    const [e] = parseCircuit('x 100 200 0 0 4 12 \\0').elements;
    expect(e.text).toBe('');
    expect(lineFor(e, 'x ')).toBe('x 100 200 0 0 4 12 \\0');
  });

  it('escapes a plus sign, which the upstream tokenizer would otherwise split on', () => {
    // CircuitLoader.java:142 tokenises on " +\t\n\r\f".
    const e = { ...makeElement('decoration', 0, 0, 0, 0), id: 1, text: 'a+b' };
    expect(lineFor(e, 'x ')).toBe('x 0 0 0 0 4 24 a\\pb');
    expect(parseCircuit(lineFor(e, 'x ')).elements[0].text).toBe('a+b');
  });

  it('recovers the plus sign an old-style dump URL-encoded (opint.txt:103)', () => {
    const [e] = parseCircuit('x 29 167 48 173 0 24 %2b').elements;
    expect(e.text).toBe('+');
    expect(lineFor(e, 'x ')).toBe('x 29 167 48 173 4 24 \\p');
  });

  it('sets FLAG_ESCAPE on a text element written by this build', () => {
    const base = makeElement('decoration', 0, 0, 0, 0);
    const e = { ...base, id: 1, params: { size: 12 }, text: 'hello world' };
    expect(lineFor(e, 'x ')).toBe('x 0 0 0 0 4 12 hello\\sworld');
  });

  it('sets FLAG_ESCAPE on a labeled node written by this build', () => {
    const e = { ...makeElement('labeledNode', 0, 0, 0, 0), id: 1, text: 'bus A' };
    expect(lineFor(e, '207 ')).toBe('207 0 0 0 0 4 bus\\sA');
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
