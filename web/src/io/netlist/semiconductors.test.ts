import { describe, expect, it } from 'vitest';
import { parseCircuit, serializeCircuit } from './index';
import { makeElement, makeToolElement } from '../../state/store';
import { postsOf } from '../../model/registry';
import { OPAMP_SWAP } from '../../model/registry/flags';
import { DEFAULT_SETTINGS, type CircuitElement } from '../../model/types';

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

  it('a model name without a 34 line resolves from the built-in table', () => {
    // Upstream never dumps a `34` line for a built-in model, but the built-in
    // table resolves the name at load (DiodeModel.java:62-76). The 1N4148 row
    // (DiodeModel.java:108) writes its saturation current, series resistance
    // and emission coefficient, and the derived forward drop, not the
    // 0.805904783 default.
    const [d] = parseCircuit('d 1 2 3 4 2 1N4148').elements;
    expect(d.modelName).toBe('1N4148');
    expect(d.params.forwardVoltage).toBeCloseTo(0.9491294544092825, 10);
    expect(d.params.saturationCurrent).toBe(4.352e-9);
    expect(d.params.emissionCoefficient).toBe(1.906);
    expect(d.params.seriesResistance).toBe(0.6458);
    // default-zener (DiodeModel.java:84) resolves its breakdown voltage and
    // the default-model drop.
    const [z] = parseCircuit('z 100 100 100 0 2 default-zener').elements;
    expect(z.modelName).toBe('default-zener');
    expect(z.params.breakdownVoltage).toBe(5.6);
    expect(z.params.forwardVoltage).toBe(0.805904783);
  });

  it('a 34 line wins over the built-in table for a name both hold', () => {
    // The file's own model line takes precedence over the built-in row of the
    // same name, exactly as upstream's modelMap lookup returns the file entry
    // first (getModelWithNameOrCopy, DiodeModel.java:62-76).
    const text = ['d 1 2 3 4 2 1N4148', '34 1N4148 0 1e-9 0 2 0 0'].join('\n');
    const [e] = parseCircuit(text).elements;
    expect(e.params.saturationCurrent).toBe(1e-9);
    expect(e.params.seriesResistance).toBe(0);
    expect(e.params.emissionCoefficient).toBe(2);
    // The derived drop follows the file's saturation current, not the built-in.
    expect(e.params.forwardVoltage).toBeCloseTo(1.0720145417969678, 10);
  });

  it('an unknown model name keeps today\'s fallback: defaults, no throw', () => {
    // A name in neither the file's `34` lines nor the built-in table falls
    // back via getModelWithNameOrCopy's oldmodel == null branch: the element
    // stays on its defaults and the name round-trips, never an error.
    const [e] = parseCircuit('d 1 2 3 4 2 2N3906').elements;
    expect(e.modelName).toBe('2N3906');
    expect(e.params.forwardVoltage).toBe(0.805904783);
    const [other] = parseCircuit('d 1 2 3 4 2 not-a-model').elements;
    expect(other.modelName).toBe('not-a-model');
    expect(other.params.forwardVoltage).toBe(0.805904783);
  });

  it('a resolved built-in name still saves FLAG_MODEL plus the name', () => {
    // Resolution is a load-time param write only; the serialized line keeps
    // the model name, so a named model round-trips byte-for-byte.
    const [e] = parseCircuit('d 1 2 3 4 2 1N4148').elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const line = out.split('\n').find((l) => l.startsWith('d ')) ?? '';
    expect(line).toBe('d 1 2 3 4 2 1N4148');
    // Deleting the name writes the value form with the real derived drop.
    delete e.modelName;
    const after = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const valueLine = after.split('\n').find((l) => l.startsWith('d ')) ?? '';
    expect(valueLine).toBe('d 1 2 3 4 1 0.9491294544092825');
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
    expect(e.modelName).toBe('early');
    expect(elementLine.endsWith(' early')).toBe(true);
    const [again] = parseCircuit(elementLine).elements;
    expect(again.modelName).toBe('early');
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

describe('LED file format', () => {
  /** Parses a single `162` line and re-emits it, returning that line. */
  const ledLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('162 ')) ?? '';
    return { e, out, elementLine };
  };

  it('the bundled model form round-trips byte-for-byte', () => {
    // FLAG_MODEL (2): one escaped model-name token, then the colour and
    // brightness tail (LEDElm.java:37-53).
    const line = '162 0 0 100 0 2 default-led 1 0 0 0.01';
    const { e, elementLine } = ledLine(line);
    expect(e.modelName).toBe('default-led');
    expect(e.params.colorR).toBe(1);
    expect(e.params.colorG).toBe(0);
    expect(e.params.colorB).toBe(0);
    expect(e.params.maxBrightnessCurrent).toBe(0.01);
    expect(elementLine).toBe(line);
  });

  it('the forward-drop form round-trips byte-for-byte', () => {
    // FLAG_FWDROP (1): the drop token leads, then the same colour tail.
    // 2.1024259 V is upstream's own default drop (LEDElm.java:41).
    const line = '162 0 0 100 0 1 2.1024259 1 0 0 0.01';
    const { e, elementLine } = ledLine(line);
    expect(e.params.forwardVoltage).toBe(2.1024259);
    expect(e.params.colorR).toBe(1);
    expect(e.params.colorG).toBe(0);
    expect(e.params.colorB).toBe(0);
    expect(e.params.maxBrightnessCurrent).toBe(0.01);
    expect(elementLine).toBe(line);
  });

  it('a flagless line reads the default drop and saves the value form', () => {
    // With neither flag the colour tokens start the tail and the drop falls
    // back to the 2.1024259 default. The save writes the value form, which
    // must carry exactly FLAG_FWDROP so a reload does not misread it as a
    // model name (the dumpFlags comment in led.ts).
    const { e, elementLine } = ledLine('162 0 0 100 0 0 1.0 0.0 0.0');
    expect(e.params.forwardVoltage).toBe(2.1024259);
    expect(e.params.colorR).toBe(1);
    expect(e.params.colorG).toBe(0);
    expect(e.params.colorB).toBe(0);
    expect(e.params.maxBrightnessCurrent).toBe(0.01);
    expect(elementLine).toBe('162 0 0 100 0 1 2.1024259 1 0 0 0.01');
  });

  it('a fresh LED dumps the upstream constructor defaults', () => {
    const e = makeElement('led', 0, 0, 32, 0);
    expect(e.params.forwardVoltage).toBe(2.1024259);
    expect(e.params.maxBrightnessCurrent).toBe(0.01);
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    expect(out).toContain('162 0 0 32 0 1 2.1024259 1 0 0 0.01');
  });

  it('a default-led name resolves the built-in model while the colour tail round-trips', () => {
    // avr8js-strobe.txt's five LEDs. The built-in `default-led` row
    // (DiodeModel.java:90) resolves its saturation current, series resistance
    // and emission coefficient; the colour and brightness tail stays untouched
    // and the line round-trips byte-for-byte (resolution never mutates the
    // serialized line).
    const line = '162 0 0 100 0 2 default-led 1 0 0 0.01';
    const { e, elementLine } = ledLine(line);
    expect(e.modelName).toBe('default-led');
    expect(e.params.saturationCurrent).toBe(93.2e-12);
    expect(e.params.seriesResistance).toBe(0.042);
    expect(e.params.emissionCoefficient).toBe(3.73);
    expect(e.params.forwardVoltage).toBeCloseTo(2.2281, 3);
    expect(e.params.colorR).toBe(1);
    expect(e.params.colorG).toBe(0);
    expect(e.params.colorB).toBe(0);
    expect(e.params.maxBrightnessCurrent).toBe(0.01);
    expect(elementLine).toBe(line);
  });
});

describe('op-amp file format and the swapped variant', () => {
  const lineFor = (e: CircuitElement) =>
    serializeCircuit([e], { ...DEFAULT_SETTINGS })
      .trim()
      .split('\n')
      .find((l) => l.startsWith('a ')) ?? '';

  it('reads an unswapped op-amp with the inverting input on top (allpass2.txt:2)', () => {
    const [e] = parseCircuit('a 320 224 416 224 0 15.0 -15.0').elements;
    expect(e.kind).toBe('opamp');
    expect(e.flags & OPAMP_SWAP).toBe(0);
    // Inverting, non-inverting, output. The unswapped part is upstream's
    // "- on top" menu entry, so the inverting post sits 16 above the axis of
    // a left-to-right body (OpAmpElm.java:127-133).
    expect(postsOf(e)).toEqual([
      { x: 320, y: 208 },
      { x: 320, y: 240 },
      { x: 416, y: 224 },
    ]);
  });

  it('reads a swapped op-amp and moves only the input posts (amp-follower.txt:5)', () => {
    // OpAmpSwapElm is a subclass that sets FLAG_SWAP and dumps as OpAmpElm,
    // so the plus-on-top variant arrives as an ordinary `a` line with flag 1.
    const [e] = parseCircuit('a 192 160 320 160 1 15.0 -15.0').elements;
    expect(e.kind).toBe('opamp');
    expect(e.flags & OPAMP_SWAP).toBe(OPAMP_SWAP);
    // The corpus wires the feedback to (192,176) and the drive to (192,144),
    // so the inverting post must be the lower one here.
    expect(postsOf(e)).toEqual([
      { x: 192, y: 176 },
      { x: 192, y: 144 },
      { x: 320, y: 160 },
    ]);
  });

  it('round-trips both variants under the same dump code', () => {
    // One dump type for both menu entries, the swap living in the flags
    // field, is what keeps a saved file readable by upstream.
    for (const flags of [0, 1]) {
      const line = `a 192 160 320 160 ${flags} 15 -15 1000000 0 0 100000`;
      const [e] = parseCircuit(line).elements;
      expect(lineFor(e)).toBe(line);
    }
  });

  it('an upstream line without the trailing tokens saves with the defaults', () => {
    // The old two-token form carries no gbw, no seed voltages and no gain;
    // the writer fills in the constructor values so the reload is stable.
    const [e] = parseCircuit('a 192 160 320 160 1 15.0 -15.0').elements;
    expect(lineFor(e)).toBe('a 192 160 320 160 1 15 -15 1000000 0 0 100000');
  });

  it('the Swap Inputs toggle is the only bit that moves', () => {
    // The property edit is a plain flag flip, so a swapped op-amp saved here
    // is byte-for-byte the line upstream writes for OpAmpSwapElm.
    const e = makeElement('opamp', 192, 160, 320, 160);
    const swapped = { ...e, id: 1, flags: e.flags | OPAMP_SWAP };
    expect(lineFor({ ...e, id: 1 })).toBe('a 192 160 320 160 8 15 -15 1000000 0 0 100000');
    expect(lineFor(swapped)).toBe('a 192 160 320 160 9 15 -15 1000000 0 0 100000');
    expect(postsOf(swapped)[0]).toEqual({ x: 192, y: 176 });
  });
});

describe('jfet file format', () => {
  /** Parses a single `j` line and re-emits it, returning that line. */
  const jfetLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('j ')) ?? '';
    return { e, elementLine };
  };

  it('round-trips a p-channel line byte-for-byte', () => {
    // The channel type lives in FLAG_PNP (bit 1); the two trailing tokens are
    // threshold then beta, the legacy `vt beta` pair the mosfet base reads
    // (MosfetElm.java:96-99).
    const line = 'j 240 176 272 176 1 -4 0.00125';
    const { e, elementLine } = jfetLine(line);
    expect(e.params.pnp).toBe(-1);
    expect(e.params.threshold).toBe(-4);
    expect(e.params.beta).toBe(0.00125);
    expect(e.flags).toBe(1);
    expect(elementLine).toBe(line);
  });

  it('an n-channel line clears the pnp bit through the round trip', () => {
    const { e, elementLine } = jfetLine('j 240 224 272 224 0 -4 0.00125');
    expect(e.params.pnp).toBe(1);
    expect(elementLine).toBe('j 240 224 272 224 0 -4 0.00125');
  });
});

describe('tunnel diode file format', () => {
  it('round-trips a tokenless 175 line byte-for-byte', () => {
    // The curve is hardcoded in the engine model, so no tokens follow the
    // common fields and there is nothing to decode beyond the kind.
    const line = '175 240 176 320 176 0';
    const [e] = parseCircuit(line).elements;
    expect(e.kind).toBe('tunnelDiode');
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    expect(out.split('\n').find((l) => l.startsWith('175 ')) ?? '').toBe(line);
  });
});

describe('diac file format', () => {
  /** Parses a single `203` line and re-emits it, returning that line. */
  const diacLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('203 ')) ?? '';
    return { e, elementLine };
  };

  it('round-trips the triacdimmer corpus line byte-for-byte', () => {
    // r_on r_off breakdown holdcurrent (DiacElm.java:45-48).
    const line = '203 1264 432 1328 432 0 500 100000000 30 0.01';
    const { e, elementLine } = diacLine(line);
    expect(e.params.r_on).toBe(500);
    expect(e.params.r_off).toBe(1e8);
    expect(e.params.breakdown).toBe(30);
    expect(e.params.holdcurrent).toBe(0.01);
    expect(elementLine).toBe(line);
  });
});

describe('scr file format', () => {
  /** Parses a single `177` line and re-emits it, returning that line. */
  const scrLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('177 ')) ?? '';
    return { e, elementLine };
  };

  it('round-trips the operating point and model tokens byte-for-byte', () => {
    // lastvac lastvag triggerI holdingI gResistance (SCRElm.java:51-59). The
    // first two are saved junction state, the rest the model.
    const line = '177 384 160 368 288 0 0.5 -0.25 0.01 0.0082 50';
    const { e, elementLine } = scrLine(line);
    expect(e.params.lastvac).toBe(0.5);
    expect(e.params.lastvag).toBe(-0.25);
    expect(e.params.triggerI).toBe(0.01);
    expect(e.params.holdingI).toBe(0.0082);
    expect(e.params.gResistance).toBe(50);
    expect(elementLine).toBe(line);
  });

  it('a scr.txt line truncated after lastvag gains the model tokens on save', () => {
    // The corpus files stop after the two operating-point voltages; the
    // try/catch around upstream's reads (SCRElm.java:51-60) leaves the model
    // on its defaults, which the save then records explicitly.
    const { e, elementLine } = scrLine('177 384 160 368 288 0 0.0 0.0');
    expect(e.params.lastvac).toBe(0);
    expect(e.params.triggerI).toBe(0.01);
    expect(e.params.holdingI).toBe(0.0082);
    expect(e.params.gResistance).toBe(50);
    expect(elementLine).toBe('177 384 160 368 288 0 0 0 0.01 0.0082 50');
  });
});

describe('triac file format', () => {
  /** Parses a single `206` line and re-emits it, returning that line. */
  const triacLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('206 ')) ?? '';
    return { e, elementLine };
  };

  it.each(['false', 'true'])('round-trips the corpus shape with a %s latch state', (state) => {
    // triggerI holdingI cresistance state (TriacElm.java:52-56); the latch
    // state is a Java-style boolean token, not a number.
    const line = `206 1360 272 1312 528 0 0.011 0.008 100 ${state}`;
    const { e, elementLine } = triacLine(line);
    expect(e.params.triggerI).toBe(0.011);
    expect(e.params.holdingI).toBe(0.008);
    expect(e.params.cresistance).toBe(100);
    expect(e.params.state).toBe(state === 'true' ? 1 : 0);
    expect(elementLine).toBe(line);
  });
});

describe('triode file format', () => {
  /** Parses a single `173` line and re-emits it, returning that line. */
  const triodeLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('173 ')) ?? '';
    return { e, elementLine };
  };

  it('round-trips mu and kg1 byte-for-byte', () => {
    // mu kg1 (TriodeElm.java's token constructor). Numeric normalisation
    // turns the corpus's 93.0/1360.0 spellings into integers on save, so the
    // canonical line below already uses the integer form.
    const line = '173 304 240 368 240 0 93 680';
    const { e, elementLine } = triodeLine(line);
    expect(e.params.mu).toBe(93);
    expect(e.params.kg1).toBe(680);
    expect(elementLine).toBe(line);
  });

  it('a triodeamp corpus spelling normalises its trailing zeros on save', () => {
    const { elementLine } = triodeLine('173 272 224 368 224 0 93.0 1360.0');
    expect(elementLine).toBe('173 272 224 368 224 0 93 1360');
  });
});
