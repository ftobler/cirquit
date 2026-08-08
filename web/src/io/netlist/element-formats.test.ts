import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCircuit, serializeCircuit } from './index';
import { makeElement, makeToolElement } from '../../state/store';
import { postsOf } from '../../model/registry';
import { DEFAULT_SETTINGS, type CircuitElement } from '../../model/types';

const CIRCUITS_DIR = fileURLToPath(new URL('../../../public/circuits', import.meta.url));

describe('ground file format', () => {
  /** Parses a single `g` line and re-emits it, returning that line. */
  const groundLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('g ')) ?? '';
    return { e, out, elementLine };
  };

  it('keeps the two-point span and the symbol type', () => {
    // A chassis ground with a real stem, the shape upstream draws the symbol
    // at the far end of (GroundElm.java:63-92).
    const { e } = groundLine('g 176 320 208 320 0 1');
    expect([e.x1, e.y1]).toEqual([176, 320]);
    expect([e.x2, e.y2]).toEqual([208, 320]);
    expect(e.params.symbolType).toBe(1);
  });

  it('round-trips a chassis ground byte-for-byte', () => {
    const { elementLine } = groundLine('g 176 320 208 320 0 1');
    expect(elementLine).toBe('g 176 320 208 320 0 1');
  });

  it('connects only at the first endpoint, never at the free end', () => {
    // One connectable post: wires land on (176,320), never on (208,320) where
    // the symbol hangs.
    const { e } = groundLine('g 176 320 208 320 0 1');
    expect(postsOf(e)).toEqual([{ x: 176, y: 320 }]);
  });

  it('a ground without a symbol token saves as the earth symbol', () => {
    const { elementLine } = groundLine('g 176 352 176 384 0');
    expect(elementLine).toBe('g 176 352 176 384 0 0');
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

describe('inductor file format', () => {
  /** Parses a single `l` line and re-emits it, returning that line. */
  const inductorLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('l ')) ?? '';
    return { e, out, elementLine };
  };

  it('inductor line round-trips all four tokens', () => {
    // InductorElm.java dumps inductance, current, initialCurrent then
    // saturationCurrent (:50-52), and its token constructor reads them in the
    // same order (:41-46), so this is byte-identical.
    const line = 'l 384 80 384 352 0 1 0.03 0.05 0.02';
    const { e, elementLine } = inductorLine(line);
    expect(e.params.inductance).toBe(1);
    expect(e.params.current).toBe(0.03);
    expect(e.params.initialCurrent).toBe(0.05);
    expect(e.params.saturationCurrent).toBe(0.02);
    expect(elementLine).toBe(line);
  });

  it('inductor tolerates a missing saturation token', () => {
    // The SAMPLE form and older saves stop after initialCurrent; the fourth
    // token defaults to 0 (no saturation). The save then writes all four
    // tokens, exactly as upstream's dump() does.
    const { e, elementLine } = inductorLine('l 384 80 384 352 0 1 0.03 0');
    expect(e.params.current).toBe(0.03);
    expect(e.params.initialCurrent).toBe(0);
    expect(e.params.saturationCurrent).toBe(0);
    expect(elementLine).toBe('l 384 80 384 352 0 1 0.03 0 0');
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

  it('a legacy non-default forward drop loads and round-trips byte-for-byte', () => {
    // The value form with a real 0.7 V drop. The zener field now exposes
    // forwardVoltage, and this is the data the field reads.
    const line = 'z 336 288 336 160 1 0.7 6.2';
    const { e, elementLine } = zenerLine(line);
    expect(e.params.forwardVoltage).toBe(0.7);
    expect(e.params.breakdownVoltage).toBe(6.2);
    expect(elementLine).toBe(line);
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

describe('diode model line parsing', () => {
  it('an upstream-saved 6.2 V legacy zener resolves its model parameters', () => {
    // The generated-name form upstream writes after one save: the `z` line
    // carries FLAG_MODEL plus the escaped name, and the `34` line carries the
    // model parameters (DiodeModel.dump, DiodeModel.java:338-341). Today the
    // name is preserved but the parameters are ignored, so breakdownVoltage
    // stays on the 5.6 default-zener value.
    const text = [
      'z 100 100 100 0 2 fwdrop\\q0.805904783\\szvoltage\\q6.2',
      '34 fwdrop\\q0.805904783\\szvoltage\\q6.2 0 1.7143528192808883e-7 0 2 6.2 0',
    ].join('\n');
    const [e] = parseCircuit(text).elements;
    expect(e.params.breakdownVoltage).toBe(6.2);
    expect(e.params.saturationCurrent).toBe(1.7143528192808883e-7);
    expect(e.params.emissionCoefficient).toBe(2);
    expect(e.params.seriesResistance).toBe(0);
    // Derived from Is and n (DiodeModel.java:332-336); the default model's
    // own 0.805904783 comes out of this exact line.
    expect(e.params.forwardVoltage).toBeCloseTo(0.805904783, 10);
  });

  it('a legacy diode with a non-default forward drop resolves it', () => {
    // 1.328e-6 is 1/(exp(0.7/(2*0.025865))-1), the getModelWithParameters
    // value for a 0.7 V drop (DiodeModel.java:149).
    const text = ['d 1 2 3 4 2 fwdrop\\q0.7', '34 fwdrop\\q0.7 0 1.328e-6 0 2 0 0'].join('\n');
    const [e] = parseCircuit(text).elements;
    // Re-derived from Is and n, not the 0.805904783 default, so a later
    // value-form save writes the real drop.
    expect(e.params.forwardVoltage).toBeCloseTo(0.7, 5);
  });

  it('round-trips the 34 line byte-for-byte in its original position', () => {
    // The `$` line is rebuilt from numbers, so include the header to make the
    // whole file a true byte-for-byte round trip.
    const text = [
      '$ 1 0.000005 10 50 5 50 5e-11',
      'z 100 100 100 0 2 fwdrop\\q0.805904783\\szvoltage\\q6.2',
      'r 0 0 16 0 0 100',
      '34 fwdrop\\q0.805904783\\szvoltage\\q6.2 0 1.7143528192808883e-7 0 2 6.2 0',
      'w 16 0 32 0 0',
    ].join('\n');
    const parsed = parseCircuit(text);
    const out = serializeCircuit(
      parsed.elements,
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
    );
    expect(out).toBe(text + '\n');
  });

  it('a model name without a 34 line falls back to the element defaults', () => {
    // Upstream never dumps a `34` line for a built-in model, and an unknown
    // name falls back via getModelWithNameOrCopy (DiodeModel.java:62-76).
    const [e] = parseCircuit('z 100 100 100 0 2 default-zener').elements;
    expect(e.modelName).toBe('default-zener');
    expect(e.params.breakdownVoltage).toBe(5.6);
    expect(e.params.forwardVoltage).toBe(0.805904783);
    const [d] = parseCircuit('d 1 2 3 4 2 1N4148').elements;
    expect(d.modelName).toBe('1N4148');
    expect(d.params.forwardVoltage).toBe(0.805904783);
  });

  it('series resistance and emission coefficient resolve from a 34 line', () => {
    // The 1N4148 values from DiodeModel.java:108.
    const text = ['d 1 2 3 4 2 x', '34 x 0 4.352e-9 0.6458 1.906 75 0'].join('\n');
    const [e] = parseCircuit(text).elements;
    expect(e.params.seriesResistance).toBe(0.6458);
    expect(e.params.emissionCoefficient).toBe(1.906);
    // Dropping the name writes the value form, whose single token is the
    // forward drop derived from the model, not the 0.805904783 default.
    expect(e.params.forwardVoltage).toBeCloseTo(0.9491294544092825, 10);
    delete e.modelName;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const line = out.split('\n').find((l) => l.startsWith('d ')) ?? '';
    expect(line).toBe('d 1 2 3 4 1 0.9491294544092825');
  });

  it('a 34 line does not consume a scope index', () => {
    const text = [
      'r 0 0 16 0 0 100',
      '34 someModel 0 1.7143528192808883e-7 0 2 0 0',
      'r 16 0 32 0 0 220',
      'o 1 64 0 4099 20 0.05 0 1',
    ].join('\n');
    const parsed = parseCircuit(text);
    expect(parsed.scopes[0].plots[0].elementIndex).toBe(1);
    expect(parsed.scopes[0].plots[0].elementId).toBe(parsed.elements[1].id);
    expect(parsed.unsupported).not.toContain('34');
  });

  it('a bare 34 line loads, round-trips and resolves nothing', () => {
    // A hand-edited file can stop right after the head. It must not throw out
    // of parseCircuit: it degrades to preserved-but-unresolvable, like a line
    // missing any of the numeric fields.
    const text = ['z 100 100 100 0 2 someModel', '34'].join('\n');
    const parsed = parseCircuit(text);
    const [e] = parsed.elements;
    expect(e.params.breakdownVoltage).toBe(5.6);
    const out = serializeCircuit(
      parsed.elements,
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
    );
    expect(out).toContain('\n34\n');
    expect(parsed.unsupported).not.toContain('34');
  });

  it('a non-positive saturation current is not a resolvable model', () => {
    // A zero or negative Is would make ln(1/Is + 1) Infinity in the derived
    // forward drop, which a value-form save would then write as an Infinity
    // token. Such a line is preserved but does not resolve, so the element
    // stays on its defaults.
    const zero = ['z 100 100 100 0 2 bad', '34 bad 0 0 0 2 6.2 0'].join('\n');
    const [ez] = parseCircuit(zero).elements;
    expect(ez.params.breakdownVoltage).toBe(5.6);
    expect(Number.isFinite(ez.params.forwardVoltage)).toBe(true);
    const negative = ['z 100 100 100 0 2 bad', '34 bad 0 -1e-7 0 2 6.2 0'].join('\n');
    const [en] = parseCircuit(negative).elements;
    expect(en.params.breakdownVoltage).toBe(5.6);
    expect(Number.isFinite(en.params.forwardVoltage)).toBe(true);
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

describe('mosfet file format', () => {
  /** Parses a single element line and re-emits it, returning the `f` line. */
  const mosfetLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('f ')) ?? '';
    return { e, out, elementLine };
  };

  it('mosfet_full_line_round_trips_byte_for_byte', () => {
    const { e, elementLine } = mosfetLine('f 240 176 320 176 0 1.5 0.02');
    expect(e.params.pnp).toBe(1);
    expect(e.params.threshold).toBe(1.5);
    expect(e.params.beta).toBe(0.02);
    expect(elementLine).toBe('f 240 176 320 176 0 1.5 0.02');
  });

  it('mosfet_flag_pnp_reads_as_p_channel', () => {
    // FLAG_PNP (bit 1) is the channel type; it lives in the flags, not a
    // token, so flags 1 must load as pnp = -1 and save the bit back.
    const { e, elementLine } = mosfetLine('f 240 176 320 176 1 1.5 0.02');
    expect(e.params.pnp).toBe(-1);
    expect(e.flags).toBe(1);
    expect(elementLine).toBe('f 240 176 320 176 1 1.5 0.02');
  });

  it('mosfet_flip_flag_and_pnp_survive_a_save', () => {
    // FLAG_FLIP (bit 8) rides alongside the pnp bit; the writer must not
    // clear it when synthesising the pnp bit from the params.
    const { elementLine } = mosfetLine('f 320 176 240 176 9 1.5 0.02');
    expect(elementLine).toBe('f 320 176 240 176 9 1.5 0.02');
  });

  it('bare_mosfet_line_loads_the_default_model', () => {
    // The two legacy tokens are optional (MosfetElm.java:96-99); a bare line
    // takes the default model. The writer appends the defaults so a save
    // never loses them, matching how a bare capacitor gains its ESR tokens.
    const { e, elementLine } = mosfetLine('f 240 176 320 176 0');
    expect(e.params.pnp).toBe(1);
    expect(e.params.threshold).toBe(1.5);
    expect(e.params.beta).toBe(0.02);
    expect(elementLine).toBe('f 240 176 320 176 0 1.5 0.02');
  });

  it('a_fresh_n_mosfet_dumps_the_default_model', () => {
    const e = makeElement('mosfet', 0, 0, 32, 0);
    expect(e.params.pnp).toBe(1);
    expect(e.params.threshold).toBe(1.5);
    expect(e.params.beta).toBe(0.02);
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    expect(out).toContain('f 0 0 32 0 0 1.5 0.02');
  });

  it('a_fresh_p_mosfet_dumps_the_pnp_flag', () => {
    const e = makeToolElement('pmos', 0, 0, 32, 0);
    expect(e.kind).toBe('mosfet');
    expect(e.params.pnp).toBe(-1);
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    // The pnp bit is written from the params even though a freshly placed
    // element carries no flags of its own.
    expect(out).toContain('f 0 0 32 0 1 1.5 0.02');
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

describe('voltage source file format', () => {
  /** Parses a single `v` line and re-emits it, returning the `v` line. */
  const voltageLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('v ')) ?? '';
    return { e, out, elementLine };
  };

  it('a legacy FLAG_COS line loads as a cosine', () => {
    // indmultfreq.txt's shape: flags 2, sine waveform, no phase token.
    // Upstream clears the bit and materialises phaseShift = pi/2
    // (VoltageElm.java:80-83).
    const { e } = voltageLine('v 176 96 176 32 2 1 30.0 5.0 0.0');
    expect(e.params.phaseShift).toBe(Math.PI / 2);
    expect(e.flags & 2).toBe(0);
  });

  it('a legacy pulse line without the duty flag takes 1/(2*pi)', () => {
    // ladder.txt's shape: flags 0, pulse waveform, no duty token. Upstream
    // forces the legacy duty whenever FLAG_PULSE_DUTY is absent
    // (VoltageElm.java:85-88), and the stored flags then record the duty as
    // authoritative so a rebuild does not re-apply it to a later edit.
    const { e } = voltageLine('v 64 128 64 48 0 5 40.0 5.0 0.0');
    expect(e.params.dutyCycle).toBeCloseTo(1 / (2 * Math.PI), 12);
    expect(e.flags & 4).toBe(4);
  });

  it('a pulse line carrying FLAG_PULSE_DUTY keeps its duty token', () => {
    const { e } = voltageLine('v 1 2 3 4 4 5 40.0 5.0 0.0 0.0 0.5');
    expect(e.params.dutyCycle).toBe(0.5);
    expect(e.flags & 4).toBe(4);
  });

  it('clears a stray pulse-duty flag on a non-pulse line', () => {
    // A non-pulse line must not carry bit 4: a save would otherwise claim a
    // duty token it has nothing to do with.
    const { e, elementLine } = voltageLine('v 1 2 3 4 4 1 40.0 5.0 0.0');
    expect(e.flags & 4).toBe(0);
    expect(elementLine).toBe('v 1 2 3 4 0 1 40 5 0 0 0.5');
  });

  it('round-trips a legacy FLAG_COS line to the canonical upstream form', () => {
    // The flag is cleared and the pi/2 phase is written out in radians, the
    // form a save from upstream's own load would produce.
    const { elementLine } = voltageLine('v 176 96 176 32 2 1 30.0 5.0 0.0');
    expect(elementLine).toBe('v 176 96 176 32 0 1 30 5 0 1.5707963267948966 0.5');
  });
});

describe('current source file format', () => {
  /** Parses a single `i` line and re-emits it, returning the `i` line. */
  const currentLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('i ')) ?? '';
    return { e, out, elementLine };
  };

  it('forces a zero current token to upstream 0.01 on load', () => {
    // CurrentElm.java:43-44: the file constructor replaces 0 with 0.01, so the
    // line a legacy save wrote as `0` comes back as a working 0.01 A source.
    const { e, elementLine } = currentLine('i 100 100 200 100 0 0.0 0');
    expect(e.params.current).toBe(0.01);
    expect(elementLine).toBe('i 100 100 200 100 0 0.01 0');
  });

  it('keeps a nonzero current and its maxVoltage token', () => {
    const { e, elementLine } = currentLine('i 100 100 200 100 0 0.5 3.0');
    expect(e.params.current).toBe(0.5);
    expect(e.params.maxVoltage).toBe(3);
    expect(elementLine).toBe('i 100 100 200 100 0 0.5 3');
  });

  it('maxVoltage survives a save/load round-trip', () => {
    // `maxVoltage` used to be parsed but never carried, so a save wrote 0 and
    // a reload lost the compliance. Now the registry field and engine carry it.
    const { e, elementLine } = currentLine('i 100 100 200 100 0 0.5 3.0');
    expect(e.params.maxVoltage).toBe(3);
    expect(elementLine.endsWith(' 3')).toBe(true);
    const [again] = parseCircuit(elementLine).elements;
    expect(again.params.maxVoltage).toBe(3);
    expect(again.params.current).toBe(0.5);
  });
});

describe('probe file format', () => {
  const probeLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    return { e, elementLine: out.split('\n').find((l) => l.startsWith('p ')) ?? '' };
  };

  it('a fresh probe dumps the upstream constructor defaults', () => {
    const e = makeElement('probe', 0, 0, 32, 0);
    expect(e.flags).toBe(3);
    expect(e.params).toEqual({ meter: 0, scale: 0, resistance: 1e7 });
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    expect(out).toContain('p 0 0 32 0 3 0 0 10000000');
  });

  it('a legacy probe line without the resistance token stays ideal', () => {
    // peak-detect.txt's exact shape. Upstream's file constructor defaults the
    // resistance to 0 and only the third token overrides it (ProbeElm.java:61),
    // so the 10 M `defaults` above must not leak into a tokenless line: 31
    // corpus probes stop after 6 or 7 tokens and would all load with a 10 M
    // load across what they measure.
    const { e, elementLine } = probeLine('p 80 64 80 288 0');
    expect(e.flags).toBe(0);
    expect(e.params.resistance).toBe(0);
    // A save writes all three tokens, exactly as upstream's dump() does.
    expect(elementLine).toBe('p 80 64 80 288 0 0 0 0');
  });

  it('a full probe line keeps its meter and resistance tokens', () => {
    const line = 'p 80 64 80 288 3 1 0 10000000';
    const { e, elementLine } = probeLine(line);
    expect(e.flags).toBe(3);
    expect(e.params.meter).toBe(1);
    expect(e.params.scale).toBe(0);
    expect(e.params.resistance).toBe(1e7);
    expect(elementLine).toBe(line);
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

describe('relay file formats', () => {
  /** Parses a single relay line and re-emits it, returning that line. */
  const relayLine = (line: string, code: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    return { e, elementLine: out.split('\n').find((l) => l.startsWith(`${code} `)) ?? '' };
  };

  it('relay_178_round_trips byte-for-byte', () => {
    // relay.txt:2 verbatim. The 178 format is poleCount inductance coilCurrent
    // r_on r_off onCurrent coilR offCurrent switchingTime position.
    const line =
      '178 240 176 384 176 22 1 0.2 0.0416666666666663 0.05 1000000 0.02 20 0.02 0.005 1';
    const { e, elementLine } = relayLine(line, '178');
    expect(e.params.poleCount).toBe(1);
    expect(e.params.inductance).toBe(0.2);
    expect(e.params.coilCurrent).toBe(0.0416666666666663);
    expect(e.params.r_on).toBe(0.05);
    expect(e.params.r_off).toBe(1e6);
    expect(e.params.onCurrent).toBe(0.02);
    expect(e.params.coilR).toBe(20);
    expect(e.params.offCurrent).toBe(0.02);
    expect(e.params.switchingTime).toBe(0.005);
    expect(e.params.position).toBe(1);
    expect(elementLine).toBe(line);
  });

  it('relay_178_position_2_mid_throw_round_trips', () => {
    // relayosc.txt:2 has a relay caught mid-throw; the position token must
    // survive so the engine restores the intermediate state.
    const line =
      '178 624 304 752 304 22 1 0.2 -0.020210235015409483 0.05 1000000 0.02 20 0.015 0.005 2';
    const { e, elementLine } = relayLine(line, '178');
    expect(e.params.position).toBe(2);
    expect(elementLine).toBe(line);
  });

  it('relay_425_426_label_link_round_trips', () => {
    // relays.txt:2 (coil) and :15 (contact), both labelled Q1. The label is
    // the link key, and the contact's i_position token must survive.
    const text = readFileSync(join(CIRCUITS_DIR, 'relays.txt'), 'utf8');
    const lines = text.split('\n');
    const coilLine = lines[1].trim();
    const contactLine = lines[14].trim();
    expect(coilLine.startsWith('425 ')).toBe(true);
    expect(contactLine.startsWith('426 ')).toBe(true);

    const coil = relayLine(coilLine, '425');
    expect(coil.e.text).toBe('Q1');
    expect(coil.e.params.type).toBe(0);
    expect(coil.e.params.state).toBe(0);
    expect(coil.e.params.switchPosition).toBe(0);
    expect(coil.elementLine).toBe(coilLine);

    const contact = relayLine(contactLine, '426');
    expect(contact.e.text).toBe('Q1');
    expect(contact.e.params.r_on).toBe(0.05);
    expect(contact.e.params.r_off).toBe(1e6);
    expect(contact.e.params.i_position).toBe(1);
    expect(contact.e.flags).toBe(4);  // FLAG_IEC
    expect(contact.elementLine).toBe(contactLine);
  });

  it('every relay line in the bundled corpus parses and round-trips', () => {
    let count = 0;
    for (const file of readdirSync(CIRCUITS_DIR).filter((f) => f.endsWith('.txt'))) {
      const text = readFileSync(join(CIRCUITS_DIR, file), 'utf8');
      for (const raw of text.split('\n')) {
        const head = raw.trim().split(/\s+/)[0];
        if (head !== '178' && head !== '425' && head !== '426') continue;
        count += 1;
        const tail = raw.trim().split(/\s+/).length - 6;
        if (head === '178') expect(tail, raw).toBe(10);
        // The 425 format is label plus nine parameters (RelayCoilElm.java:
        // 97-106), so ten trailing tokens.
        if (head === '425') expect(tail, raw).toBe(10);
        if (head === '426') expect(tail, raw).toBeGreaterThanOrEqual(3);
        const [e] = parseCircuit(raw).elements;
        const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
        const elementLine = out.split('\n').find((l) => l.startsWith(`${head} `)) ?? '';
        expect(elementLine, raw).toBe(raw.trim());
      }
    }
    expect(count).toBeGreaterThan(0);
  });
});

describe('transformer file formats', () => {
  /** Parses a single transformer line and re-emits it, returning that line. */
  const transformerLine = (line: string, code: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    return { e, elementLine: out.split('\n').find((l) => l.startsWith(`${code} `)) ?? '' };
  };

  it('T line round-trips byte-for-byte (longdist.txt:4)', () => {
    // inductance ratio current0 current1 couplingCoef, exactly as the bundled
    // file carries it: no saturation token is invented on the way out.
    const line = 'T 160 128 240 128 0 0.5 1000 0 0 0.999';
    const { e, elementLine } = transformerLine(line, 'T');
    expect(e.params.inductance).toBe(0.5);
    expect(e.params.ratio).toBe(1000);
    expect(e.params.couplingCoef).toBe(0.999);
    expect(elementLine).toBe(line);
  });

  it('a four-token T line round-trips without inventing tokens', () => {
    // Older files stop after current1; the coupling coefficient must not be
    // appended on save, or the line would change length.
    const line = 'T 272 192 352 192 0 100 1 0 0';
    const { e, elementLine } = transformerLine(line, 'T');
    expect(e.params.ratio).toBe(1);
    expect(e.params.couplingCoef).toBeUndefined();
    expect(elementLine).toBe(line);
  });

  it('T line with a saturation token round-trips (satcore-transformer.txt:4)', () => {
    // The saturation current is parsed and preserved even though the engine
    // defers modelling it.
    const line = 'T 272 192 352 192 0 4 1 0 0 0.999 0.5';
    const { e, elementLine } = transformerLine(line, 'T');
    expect(e.params.saturationCurrent).toBe(0.5);
    expect(elementLine).toBe(line);
  });

  it('a real 169 line round-trips its four tokens (ringmod.txt:6)', () => {
    // Four trailing tokens: inductance ratio current0 current1. Nothing is
    // invented on dump. The ratio's `1.0` normalises to `1` like every other
    // numeric token this port writes, so the assertion is on structure and
    // values rather than the exact spelling of that one token.
    const line = '169 144 144 208 144 0 0.1 1.0 0.36188085234266 -0.10938222138187827';
    const { e, elementLine } = transformerLine(line, '169');
    expect(e.params.inductance).toBe(0.1);
    expect(e.params.ratio).toBe(1);
    expect(e.params.current0).toBe(0.36188085234266);
    expect(e.params.current1).toBe(-0.10938222138187827);
    const tail = elementLine.split(/\s+/).slice(6);
    expect(tail).toHaveLength(4);
    expect(tail[0]).toBe('0.1');
    expect(tail[1]).toBe('1');
    expect(tail[2]).toBe('0.36188085234266');
    expect(tail[3]).toBe('-0.10938222138187827');
  });

  it('a fresh transformer dumps the full upstream field list', () => {
    const e = makeElement('transformer', 0, 0, 32, 0);
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    const line = out.split('\n').find((l) => l.startsWith('T ')) ?? '';
    expect(line).toBe('T 0 0 32 0 0 4 1 0 0 0.999 0');
  });

  it('custom description escaping round-trips', () => {
    // The description is one escaped token (CustomLogicModel.escape): `+` and
    // spaces survive as `\p` and `\s`, and `,`/`:` need no escaping.
    const lines = [
      '406 160 128 240 128 0 4 0.999 1,1:1 3 0 0 0',
      '406 160 128 240 128 0 4 0.999 1\\p1:1 3 0 0 0',
      '406 160 128 240 128 0 4 0.999 1\\s1:1 2 0 0',
    ];
    for (const line of lines) {
      const { elementLine } = transformerLine(line, '406');
      expect(elementLine).toBe(line);
    }
    // The unescaped description is what the model and geometry see.
    const [tapped] = parseCircuit(lines[1]).elements;
    expect(tapped.text).toBe('1+1:1');
    const [spaced] = parseCircuit(lines[2]).elements;
    expect(spaced.text).toBe('1 1:1');
  });

  it('a malformed description round-trips byte-for-byte', () => {
    // The description is preserved verbatim even when it does not parse: the
    // geometry falls back to the engine's default layout, but the text must
    // survive a save so nothing is lost.
    const lines = [
      '406 160 128 240 128 0 4 0.999 x:1 3 0 0 0',
      '406 160 128 240 128 0 4 0.999 garbage 3 0 0 0',
    ];
    for (const line of lines) {
      const { elementLine } = transformerLine(line, '406');
      expect(elementLine).toBe(line);
    }
    const [bad] = parseCircuit(lines[1]).elements;
    expect(bad.text).toBe('garbage');
  });
});
