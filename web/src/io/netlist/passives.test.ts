import { describe, expect, it } from 'vitest';
import { parseCircuit, serializeCircuit } from './index';
import { makeElement } from '../../state/store';
import { postsOf } from '../../model/registry';
import { DEFAULT_SETTINGS } from '../../model/types';

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

  it('a fresh inductor dumps the upstream toolbar default of 1 H', () => {
    // InductorElm(xx, yy) winds one henry (InductorElm.java:34); the engine's
    // file-side fallback stays at the old seed, but nothing fresh may reach it.
    const e = makeElement('inductor', 0, 0, 64, 0);
    expect(e.params.inductance).toBe(1);
    expect(e.flags).toBe(0);
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    expect(out).toContain('l 0 0 64 0 0 1 0 0 0');
  });
});

describe('fuse file format', () => {
  /** Parses a single `404` line and re-emits it, returning that line. */
  const fuseLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('404 ')) ?? '';
    return { e, out, elementLine };
  };

  it('round-trips resistance, i2t, heat and the blown token', () => {
    const { e, elementLine } = fuseLine('404 0 0 160 0 0 0.0613 6.73 1.5 true');
    expect(e.params.resistance).toBe(0.0613);
    expect(e.params.i2t).toBe(6.73);
    expect(e.params.heat).toBe(1.5);
    expect(e.params.blown).toBe(1);
    // The parse seeds the live state from the file, switch-style.
    expect(e.state).toBe(1);
    expect(elementLine).toBe('404 0 0 160 0 0 0.0613 6.73 1.5 true');
  });

  it('a fuse that popped in-session saves blown true and reloads blown', () => {
    // The frame loop syncs the engine's live blown into `e.state`, exactly as
    // a switch throw lands there, so serialization must read that live copy
    // rather than the stale file token the element was loaded with.
    const { e } = fuseLine('404 0 0 160 0 0 0.0613 6.73 0 false');
    expect(e.state).toBe(0);
    e.state = 1;
    const again = parseCircuit(
      serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim(),
    ).elements[0];
    expect(again.state).toBe(1);
    expect(again.params.blown).toBe(1);
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

  it('a past-cap description round-trips byte-for-byte with no posts', () => {
    // Just above MAX_CUSTOM_COILS: the engine rejects the line at build, and
    // until then nothing lays out one node pair per coil. The text and every
    // current token still survive a save untouched.
    const desc = Array.from({ length: 33 }, () => '1').join(',');
    const line = `406 160 128 240 128 0 4 0.999 ${desc} 33 ${Array.from({ length: 33 }, () => '0').join(' ')}`;
    const { e, elementLine } = transformerLine(line, '406');
    expect(e.text).toBe(desc);
    expect(postsOf(e)).toHaveLength(0);
    expect(elementLine).toBe(line);
  });
});

describe('memristor file format', () => {
  /** Parses a single `m` line and re-emits it, returning that line. */
  const memLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('m ')) ?? '';
    return { e, out, elementLine };
  };

  it('a five-token line round-trips with the saved current defaulted to 0', () => {
    // The optional sixth token is the saved operating-point current
    // (MemristorElm.java:41-48). A line without it loads current 0, and the
    // save writes the token back, as every dump() in this port does.
    const { e, elementLine } = memLine('m 0 0 100 0 0 100 16000 0 1e-8 1e-10');
    expect(e.params.r_on).toBe(100);
    expect(e.params.r_off).toBe(16000);
    expect(e.params.dopeWidth).toBe(0);
    expect(e.params.totalWidth).toBe(1e-8);
    expect(e.params.mobility).toBe(1e-10);
    expect(e.params.current).toBe(0);
    expect(elementLine).toBe('m 0 0 100 0 0 100 16000 0 1e-8 1e-10 0');
  });

  it('a six-token line round-trips byte-for-byte', () => {
    const line = 'm 0 0 100 0 0 100 16000 0 1e-8 1e-10 0.005';
    const { e, elementLine } = memLine(line);
    expect(e.params.current).toBe(0.005);
    expect(elementLine).toBe(line);
  });
});

describe('thermistor file format', () => {
  /** Parses a single `350` line and re-emits it, returning that line. */
  const thermistorLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('350 ')) ?? '';
    return { e, elementLine };
  };

  it('round-trips the five values and the escaped slider text byte-for-byte', () => {
    // r25 r50 minTempr maxTempr position sliderText (ThermistorNTCElm.java:
    // 60-70). Upstream's own text dump would drop all six tokens (the base
    // CircuitElm.dump quirk the registry row documents), so the canonical
    // form below is what a save from this port produces.
    const line = '350 96 64 208 64 0 4700 1800 -25 125 0.5 Panel\\sTemp';
    const { e, elementLine } = thermistorLine(line);
    expect(e.params.r25).toBe(4700);
    expect(e.params.r50).toBe(1800);
    expect(e.params.minTempr).toBe(-25);
    expect(e.params.maxTempr).toBe(125);
    expect(e.params.position).toBe(0.5);
    expect(e.text).toBe('Panel Temp');
    expect(elementLine).toBe(line);
  });

  it('a slider text-less line saves the upstream Temperature caption', () => {
    // The writer falls back to the constructor default when the text is
    // empty, so a reload never loses the slider label.
    const { e, elementLine } = thermistorLine('350 96 64 208 64 0');
    expect(e.params.r25).toBe(10000);
    expect(e.params.position).toBe(0.34);
    expect(e.text).toBeUndefined();
    expect(elementLine).toBe('350 96 64 208 64 0 10000 3605 -40 150 0.34 Temperature');
  });
});

describe('LDR file format', () => {
  /** Parses a single `374` line and re-emits it, returning that line. */
  const ldrLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('374 ')) ?? '';
    return { e, elementLine };
  };

  it('round-trips the slider position and the escaped slider text byte-for-byte', () => {
    // position then sliderText, the LDR's whole token stream. The same
    // base-dump quirk as the thermistor applies: this port writes what
    // upstream's text save never did.
    const line = '374 96 64 208 64 0 0.62 Light\\sLevel';
    const { e, elementLine } = ldrLine(line);
    expect(e.params.position).toBe(0.62);
    expect(e.text).toBe('Light Level');
    expect(elementLine).toBe(line);
  });

  it('a bare LDR line saves the Light Brightness caption', () => {
    const { e, elementLine } = ldrLine('374 96 64 208 64 0');
    expect(e.params.position).toBe(0.34);
    expect(e.text).toBeUndefined();
    // The caption is one escaped token on the line, like any slider text.
    expect(elementLine).toBe('374 96 64 208 64 0 0.34 Light\\sBrightness');
  });
});

describe('spark gap file format', () => {
  /** Parses a single `187` line and re-emits it, returning that line. */
  const sparkGapLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('187 ')) ?? '';
    return { e, elementLine };
  };

  it('round-trips its four tokens byte-for-byte', () => {
    // r_on r_off breakdown holdcurrent (SparkGapElm.java:41-51). The tesla.txt
    // family carries exactly this shape; numeric tokens normalise like every
    // other element, so 1.0E9 writes back expanded.
    const line = '187 256 144 352 256 0 1000 1000000000 4000 0.0015';
    const { e, elementLine } = sparkGapLine(line);
    expect(e.params.r_on).toBe(1000);
    expect(e.params.r_off).toBe(1e9);
    expect(e.params.breakdown).toBe(4000);
    expect(e.params.holdcurrent).toBe(0.0015);
    expect(elementLine).toBe(line);
  });

  it('a bare spark gap loads the constructor defaults', () => {
    const { e } = sparkGapLine('187 256 144 352 256 0');
    expect(e.params.r_on).toBe(1000);
    expect(e.params.r_off).toBe(1e9);
    expect(e.params.breakdown).toBe(1000);
    expect(e.params.holdcurrent).toBe(0.001);
  });
});

describe('lamp file format', () => {
  /** Parses a single `181` line and re-emits it, returning that line. */
  const lampLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('181 ')) ?? '';
    return { e, elementLine };
  };

  it('round-trips its five tokens byte-for-byte', () => {
    // temp nomPower nomVoltage warmTime coolTime (LampElm.java:43-54); the
    // temperature is saved operating state like the fuse's heat.
    const line = '181 688 208 688 496 0 293 100 120 0.4 0.4';
    const { e, elementLine } = lampLine(line);
    expect(e.params.temp).toBe(293);
    expect(e.params.nomPower).toBe(100);
    expect(e.params.nomVoltage).toBe(120);
    expect(e.params.warmTime).toBe(0.4);
    expect(e.params.coolTime).toBe(0.4);
    expect(elementLine).toBe(line);
  });

  it('the triacdimmer corpus line keeps its warm filament state', () => {
    // triacdimmer.txt:10 verbatim: a lamp saved hot, at 1325 K against a
    // 100 W / 120 V rating. Losing temp would restart the bulb cold on
    // every load.
    const line = '181 1184 272 1264 272 0 1325.2174570769737 100 120 0.4 0.4';
    const { e, elementLine } = lampLine(line);
    expect(e.params.temp).toBeCloseTo(1325.2174570769737, 15);
    expect(elementLine).toBe(line);
  });
});
