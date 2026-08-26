import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCircuit, serializeCircuit } from './index';
import { makeElement } from '../../state/store';
import { postsOf } from '../../model/registry';
import { DEFAULT_SETTINGS, type CircuitElement } from '../../model/types';
import { CIRCUITS_DIR } from './fixtures';

describe('ota file format', () => {
  /** ota-gain.txt:2 verbatim, the composite's full 18-child dump. */
  const otaLine = readFileSync(join(CIRCUITS_DIR, 'ota-gain.txt'), 'utf8').split('\n')[1].trim();

  /** Serialises one element and returns its `402` line. */
  const lineFor = (e: CircuitElement): string => {
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    return out.split('\n').find((l) => l.startsWith('402 ')) ?? '';
  };

  /** The child dump tokens of a `402` line, everything after the flags. */
  const childTokens = (line: string): string[] => line.split(/\s+/).slice(6);

  it('parses the corpus 402 line and re-emits it byte-for-byte', () => {
    const [e] = parseCircuit(otaLine).elements;
    expect(e.kind).toBe('ota');
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('402 ')) ?? '';
    expect(elementLine).toBe(otaLine);
  });

  it('carries the raw child-dump tokens in e.model as a JSON array', () => {
    const [e] = parseCircuit(otaLine).elements;
    const tokens = otaLine.split(/\s+/).slice(6);
    expect(tokens).toHaveLength(18);  // two rails plus sixteen transistors
    // The OTA's model payload is the raw token array, unlike the custom-logic
    // model object.
    const model = e.model as string[];
    expect(model).toEqual(tokens);
    // The shape the engine parses: a JSON array of the `_`-joined strings.
    expect(JSON.stringify(model)).toBe(JSON.stringify(tokens));
    // The first two tokens are the rails, the next the transistors.
    expect(model[0]).toBe('0_0_40_-9_0_0_0.5');
    expect(model[1]).toBe('0_0_40_9_0_0_0.5');
    expect(model[2]).toMatch(/^0_1_/);
  });

  /** The corpus line with both rails raised to a +15/-15 supply, the shape a
   *  file saved upstream after editing the OTA's supply voltages carries. */
  const ota15 = (() => {
    const f = otaLine.split(/\s+/);
    f[6] = '0_0_40_-15_0_0_0.5';
    f[7] = '0_0_40_15_0_0_0.5';
    return f.join(' ');
  })();

  it('reads the supply voltages back off the two rail tokens', () => {
    // Upstream reads negVolt off rail child 0 and posVolt off child 1 after a
    // load (OTAElm.java:39-43): the saved maxVoltage fields ARE the supplies.
    // Without this read-back a +15/-15 part reloads at the +/-9 V defaults
    // and clips about 40% lower than where it was saved.
    const [e] = parseCircuit(ota15).elements;
    expect(e.params.negVolt).toBe(-15);
    expect(e.params.posVolt).toBe(15);
  });

  it('re-emits the original child tokens verbatim even with non-default rails', () => {
    // Save now rewrites the two rail slots from posVolt/negVolt, but the
    // re-derivation reproduces identical bytes for canonical tokens.
    const [e] = parseCircuit(ota15).elements;
    expect(lineFor(e)).toBe(ota15);
  });

  it('a fresh OTA dumps the eighteen child tokens upstream demands', () => {
    // `CompositeElm.loadComposite` calls `stIn.nextToken()` once per
    // modelString child (CompositeElm.java:85-91) and the OTA's has eighteen
    // (OTAElm.java:8): two rails, then five N, six P and five more N
    // transistors. A line that stops after the flags makes that throw, and
    // `CircuitLoader` silently drops the element (CircuitLoader.java:207-211).
    const e = makeElement('ota', 0, 0, 128, 0);
    const tokens = childTokens(lineFor({ ...e, id: 1 }));
    expect(tokens).toHaveLength(18);
    expect(tokens[0]).toBe('0_0_40_-9_0_0_0.5');  // rail 0 carries negVolt
    expect(tokens[1]).toBe('0_0_40_9_0_0_0.5');  // rail 1 carries posVolt
    // Fresh transistors: zero junction state, beta 100, pnp the only
    // difference (TransistorElm.java:53-54).
    expect(tokens.slice(2)).toEqual([
      ...Array<string>(5).fill('0_1_0_0_100'),
      ...Array<string>(6).fill('0_-1_0_0_100'),
      ...Array<string>(5).fill('0_1_0_0_100'),
    ]);
  });

  it('an edited supply voltage reaches the two rail tokens', () => {
    // Upstream reads negVolt back off child 0 and posVolt off child 1
    // (OTAElm.java:41-42), so the params have to be re-derived into those two
    // tokens on every save or an edited supply never survives the file.
    const e = makeElement('ota', 0, 0, 128, 0);
    e.params.posVolt = 12;
    e.params.negVolt = -12;
    const tokens = childTokens(lineFor({ ...e, id: 1 }));
    expect(tokens[0]).toBe('0_0_40_-12_0_0_0.5');
    expect(tokens[1]).toBe('0_0_40_12_0_0_0.5');
  });

  it('an edited supply on a loaded OTA rewrites only its own rail token', () => {
    // The crystal precedent (OVERVIEW row 412): a carried child dump that a
    // param owns is re-derived from it on save, so a live supply edit reaches
    // the file instead of being swallowed by the verbatim token list. The
    // sixteen transistor saves have no param owner and stay byte-for-byte.
    const [e] = parseCircuit(otaLine).elements;
    e.params.posVolt = 20;
    const tokens = childTokens(lineFor(e));
    expect(tokens[1]).toBe('0_0_40_20_0_0_0.5');
    expect(tokens[0]).toBe('0_0_40_-9_0_0_0.5');
    expect(tokens.slice(2)).toEqual(otaLine.split(/\s+/).slice(8));
  });

  it('an empty rail supply field keeps the +/-9 V defaults', () => {
    // A trailing underscore leaves the maxVoltage field '', which Number('')
    // would happily turn into 0 V. An empty string is a missing value here,
    // not a zero-volt supply.
    const f = otaLine.split(/\s+/);
    f[6] = '0_0_40__0_0_0.5';
    f[7] = '0_0_40__0_0_0.5';
    const [e] = parseCircuit(f.join(' ')).elements;
    expect(e.params.negVolt).toBe(-9);
    expect(e.params.posVolt).toBe(9);
  });

  it('guards a non-finite supply back to the defaults', () => {
    // A param edited to NaN must not write `NaN` into the rail token: upstream
    // would parse it as a NaN supply and the rail would never settle
    // (otaChildTokens, railToken).
    const e = makeElement('ota', 0, 0, 128, 0);
    e.params.posVolt = Number.NaN;
    e.params.negVolt = Number.POSITIVE_INFINITY;
    const tokens = childTokens(lineFor({ ...e, id: 1 }));
    expect(tokens[0]).toBe('0_0_40_-9_0_0_0.5');
    expect(tokens[1]).toBe('0_0_40_9_0_0_0.5');
  });

  it('repairs a bare 402 line on save rather than preserving it', () => {
    // A knowing exception to "never lose data on a round trip": the preserved
    // bytes are a file upstream cannot open, and the tokens written back are
    // the defaults upstream would have constructed anyway, so nothing is lost
    // and the line becomes loadable.
    const [e] = parseCircuit('402 512 528 624 528 0').elements;
    expect(e.model).toEqual([]);
    // No rail tokens to read, so the LM13700 defaults survive untouched.
    expect(e.params.posVolt).toBe(9);
    expect(e.params.negVolt).toBe(-9);
    const line = lineFor(e);
    expect(line.split(/\s+/).slice(0, 6)).toEqual(['402', '512', '528', '624', '528', '0']);
    expect(childTokens(line)).toHaveLength(18);
  });

  it('places the five posts where the ota-gain wires connect', () => {
    // The corpus wires hang off (512,496) and (512,560) to the west (the two
    // inputs), (512,528) to the collector load, (608,496) to Iabc and
    // (624,528) to the output.
    const [e] = parseCircuit(otaLine).elements;
    expect(postsOf(e)).toEqual([
      { x: 512, y: 496 },
      { x: 512, y: 560 },
      { x: 512, y: 528 },
      { x: 608, y: 496 },
      { x: 624, y: 528 },
    ]);
  });
});

describe('built-in composite file formats (batch C)', () => {
  const lineFor = (e: CircuitElement) =>
    serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim().split('\n').join('\n');

  it('401 comparator round-trips its three child dump tokens', () => {
    // One `_`-joined dump per composite child: the op-amp (flags, maxOut,
    // minOut, gbw, volts0, volts1, gain), the analog switch (flags, r_on,
    // r_off, threshold) and the old-style ground (flags, symbolType). The
    // tokens are opaque and carried raw, exactly the OTA's shape.
    const line =
      '401 80 64 208 64 0 8_15_-15_1000000_0_0_100000 2_20_10000000000_2.5 1_0';
    const [e] = parseCircuit(line).elements;
    expect(e.kind).toBe('comparator');
    expect(e.model).toEqual(['8_15_-15_1000000_0_0_100000', '2_20_10000000000_2.5', '1_0']);
    expect(lineFor(e)).toContain(line);
  });

  it('a fresh comparator dumps the three child tokens upstream demands', () => {
    // Three children (ComparatorElm.java:7), three mandatory tokens
    // (CompositeElm.java:85-91). The values are the children's own
    // constructor defaults: op-amp FLAG_GAIN with 15/-15/1e6/0/0/100000
    // (OpAmpElm.java:32-40), analog switch FLAG_PULLDOWN with 20/1e10/2.5
    // (AnalogSwitchElm.java:37-44), old-style ground with symbol 0
    // (CompositeElm.java:98-99, GroundElm.java:46-48).
    const e = makeElement('comparator', 0, 0, 64, 0);
    expect(lineFor({ ...e, id: 1 })).toContain(
      '401 0 0 64 0 0 8_15_-15_1000000_0_0_100000 2_20_10000000000_2.5 1_0',
    );
  });

  it('repairs a bare 401 line on save, keeping its flags', () => {
    // The reported unloadable line: legal FLAG_SWAP, no child tokens, so
    // upstream's `nextToken()` throws and the element is dropped
    // (CircuitLoader.java:207-211). Saving it again has to add the children.
    const [e] = parseCircuit('401 208 64 320 64 4').elements;
    expect(e.model).toEqual([]);
    expect(lineFor(e)).toContain(
      '401 208 64 320 64 4 8_15_-15_1000000_0_0_100000 2_20_10000000000_2.5 1_0',
    );
  });

  it('409 realistic op-amp round-trips slew rate, cap value, limit and model', () => {
    // OpAmpRealElm.java:79-86.
    const line = '409 80 64 208 64 0 0.6 0 0.0231 0';
    const [e] = parseCircuit(line).elements;
    expect(e.kind).toBe('opampReal');
    expect(e.params.slewRate).toBe(0.6);
    expect(e.params.capValue).toBe(0);
    expect(e.params.currentLimit).toBe(0.0231);
    expect(e.params.modelType).toBe(0);
    expect(lineFor(e)).toContain(line);
  });

  it('409 round-trips the LM324 and LM324v2 modelType tokens', () => {
    // modelType 1 (LM324) and 2 (324v2) load as their own netlists and keep
    // their token on save, so a file naming a 324 stays a 324
    // (OpAmpRealElm.java:82-86).
    for (const line of [
      '409 80 64 208 64 0 0.6 0 0.0231 1',
      '409 80 64 208 64 0 0.6 0 0.0231 2',
    ]) {
      const [e] = parseCircuit(line).elements;
      expect(e.kind).toBe('opampReal');
      expect(e.params.modelType).toBe(Number(line.split(' ').at(-1)));
      expect(lineFor(e)).toContain(line);
    }
  });

  it('a fresh realistic op-amp dumps the 741 constructor defaults', () => {
    const e = makeElement('opampReal', 0, 0, 64, 0);
    expect(e.params).toEqual({ slewRate: 0.6, capValue: 0, currentLimit: 0.0231, modelType: 0 });
    expect(lineFor({ ...e, id: 1 })).toContain('409 0 0 64 0 0 0.6 0 0.0231 0');
  });

  it('407 optocoupler round-trips its child dumps and the appended ctr scale', () => {
    // Three child dumps (the LED model, the CCCS, the phototransistor) then
    // the port's appended ctr scale token. The children are rebuilt from
    // defaults upstream (OptocouplerElm.java:29-34), so the dumps are opaque.
    const line = '407 80 64 208 64 0 2_default-optocoupler-led 0 0_1_0_0_700 1.5';
    const [e] = parseCircuit(line).elements;
    expect(e.kind).toBe('optocoupler');
    expect(e.model).toEqual(['2_default-optocoupler-led', '0', '0_1_0_0_700']);
    expect(e.params.ctr).toBe(1.5);
    expect(lineFor(e)).toContain(line);
  });

  it('an upstream 407 line without ctr keeps the default and appends it on save', () => {
    // Upstream's own text dump never writes the ctr scale, so the port reads
    // a bare child-dump line with the default 1.0 and saves the scale back,
    // the stop-trigger `count` precedent.
    const line = '407 80 64 208 64 0 2_default-optocoupler-led 0 0_1_0_0_700';
    const [e] = parseCircuit(line).elements;
    expect(e.params.ctr).toBe(1);
    expect(e.model).toEqual(['2_default-optocoupler-led', '0', '0_1_0_0_700']);
    expect(lineFor(e)).toContain(`${line} 1`);
  });

  it('a tokenless 407 line keeps the default ctr instead of parsing 0', () => {
    // No child dumps at all means there is no trailing token to read;
    // `Number('')` is 0, which would have built a dead optocoupler with
    // ctr 0. A missing token must fall through to the default 1.0.
    const line = '407 80 64 208 64 0';
    const [e] = parseCircuit(line).elements;
    expect(e.kind).toBe('optocoupler');
    expect(e.params.ctr).toBe(1);
    expect(e.model).toEqual([]);
    expect(lineFor(e)).toContain(`${line} 1`);
  });

  it('412 crystal round-trips its four motional child dumps', () => {
    // The four children in model order: parallel cap, series cap, inductor,
    // resistor, each `_`-joined (flags first, then the value). The value
    // tokens are re-derived from the params on save, so the loaded values
    // land in the fields and the save stays byte-for-byte.
    const line = '412 80 64 208 64 0 4_2.87e-11_0_0.001_0 4_1e-13_0_0.001_0 0_0.0025_0_0_0 0_6.4';
    const [e] = parseCircuit(line).elements;
    expect(e.kind).toBe('crystal');
    expect(e.params.parallelCapacitance).toBeCloseTo(28.7e-12, 20);
    expect(e.params.seriesCapacitance).toBeCloseTo(1e-13, 25);
    expect(e.params.inductance).toBe(0.0025);
    expect(e.params.resistance).toBe(6.4);
    expect(lineFor(e)).toContain(line);
  });

  it('a fresh crystal dumps the four default motional values', () => {
    // The fresh constructor sets FLAG_SHOW_FREQ (CrystalElm.java:36), so the
    // flags field is 2, not 0.
    const e = makeElement('crystal', 0, 0, 64, 0);
    expect(e.flags).toBe(2);
    const out = lineFor({ ...e, id: 1 });
    expect(out).toContain('412 0 0 64 0 2 4_2.87e-11_0_0.001_0 4_1e-13_0_0.001_0 0_0.0025_0_0_0 0_6.4');
  });
});

describe('darlington file format', () => {
  const lineFor = (e: CircuitElement) =>
    serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim().split('\n').find((l) => l.startsWith('400 ')) ?? '';

  it('a 400 line round-trips its two child tokens and the pnp sign', () => {
    // ota-ringmod.txt:3 verbatim: two `_`-joined transistor state tokens,
    // carried raw, then the pnp sign (DarlingtonElm.java:31-33, :46-48). The
    // port parks the child dumps in text and modelName, spare string slots.
    const line =
      '400 592 496 656 496 0 0_1_-9.186007259168688_0.47278136193663833_100 ' +
      '0_1_-9.658788621105327_0.5881593748591852_100 1';
    const [e] = parseCircuit(line).elements;
    expect(e.kind).toBe('darlington');
    expect(e.text).toBe('0_1_-9.186007259168688_0.47278136193663833_100');  // Q1's carried dump
    expect(e.modelName).toBe('0_1_-9.658788621105327_0.5881593748591852_100');  // Q2's
    expect(e.params.pnp).toBe(1);
    // Base at point1, collector and emitter hanging 16 units off the far end,
    // NPN toward negative y (DarlingtonElm.java:128-134, :155-157).
    expect(postsOf(e)).toEqual([
      { x: 592, y: 496 },
      { x: 656, y: 480 },
      { x: 656, y: 512 },
    ]);
    expect(lineFor(e)).toBe(line);
  });

  it('a PNP darlington keeps its -1 token and mirrors the hanging posts', () => {
    const line = '400 80 64 208 64 0 0_1_0_0_100 0_1_0_0_100 -1';
    const [e] = parseCircuit(line).elements;
    expect(e.params.pnp).toBe(-1);
    expect(postsOf(e)).toEqual([
      { x: 80, y: 64 },
      { x: 208, y: 80 },
      { x: 208, y: 48 },
    ]);
    expect(lineFor(e)).toBe(line);
  });

  it('a fresh darlington dumps the two default child tokens plus pnp', () => {
    const e = makeElement('darlington', 0, 0, 128, 0);
    expect(e.params.pnp).toBe(1);
    expect(lineFor({ ...e, id: 1 })).toBe('400 0 0 128 0 0 0_1_0_0_100 0_1_0_0_100 1');
  });
});

describe('every composite dumps the child tokens upstream demands', () => {
  // The regression guard for the whole family. `CompositeElm.loadComposite`
  // calls `stIn.nextToken()` once per modelString child
  // (CompositeElm.java:85-91); one token short and the call throws,
  // `CircuitLoader`'s per-line catch logs and `break`s
  // (CircuitLoader.java:207-211), and the element is silently missing from the
  // loaded circuit. Any composite added without child dumps fails here.
  const COMPOSITES: { code: string; kind: string; children: number }[] = [
    { code: '400', kind: 'darlington', children: 3 },  // DarlingtonElm.java:31-33, two children plus pnp
    { code: '401', kind: 'comparator', children: 3 },  // ComparatorElm.java:7, undumped at :25
    { code: '402', kind: 'ota', children: 18 },  // OTAElm.java:8, undumped at :38-39
    // The optocoupler passes `st = null` into loadComposite
    // (OptocouplerElm.java:29-31), so upstream never reads a child token and
    // rebuilds the children from defaults. It is the one exempt composite,
    // which is also why the port's appended `ctr` token is harmless.
    { code: '407', kind: 'optocoupler', children: 0 },
    { code: '412', kind: 'crystal', children: 4 },  // CrystalElm.java:44-45
  ];

  /** The tokens a serialised line carries after the flags field. */
  const childTokens = (e: CircuitElement, code: string): string[] => {
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const line = out.split('\n').find((l) => l.startsWith(`${code} `)) ?? '';
    expect(line).not.toBe('');
    return line.split(/\s+/).slice(6);
  };

  for (const { code, kind, children } of COMPOSITES) {
    it(`a freshly placed ${kind} writes its ${children} child tokens`, () => {
      const e = makeElement(kind, 0, 0, 128, 0);
      expect(childTokens({ ...e, id: 1 }, code).length).toBeGreaterThanOrEqual(children);
    });

    it(`a bare ${code} line gains its ${children} child tokens on save`, () => {
      const [e] = parseCircuit(`${code} 0 0 128 0 0`).elements;
      expect(e.kind).toBe(kind);
      expect(childTokens(e, code).length).toBeGreaterThanOrEqual(children);
    });
  }
});
