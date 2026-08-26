import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCircuit, serializeCircuit } from './index';
import { makeElement } from '../../state/store';
import { postsOf, defFor } from '../../model/registry';
import { DEFAULT_SETTINGS, type CircuitElement } from '../../model/types';
import { CIRCUITS_DIR } from './fixtures';

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

  it('keeps position 2 of a centre-off SPDT on load and saves it back byte-for-byte', () => {
    // FLAG_CENTER_OFF (bit 1) widens the position range to 0..2, so a file
    // saved with the lever on the open middle stop must reload with state 2
    // (the engine's open request) instead of clamping it onto a throw.
    const { e, elementLine } = switchLine('S 144 144 144 64 1 2 false 0 2', 'S ');
    expect(e.flags & 1).toBe(1);
    expect(e.state).toBe(2);
    expect(e.params.position).toBe(2);
    expect(e.params.throwCount).toBe(2);
    expect(elementLine).toBe('S 144 144 144 64 1 2 false 0 2');
  });
});

/** Parse results carry a session-wide id that depends on call order, so
 *  equality is asserted on everything but it. Shared by both boolean-token
 *  suites below. */
const withoutId = (e: CircuitElement): Omit<CircuitElement, 'id'> => {
  const { id: _id, ...rest } = e;
  return rest;
};

describe('momentary token case', () => {
  // Upstream reads the momentary token through `new Boolean(String)`, true for
  // the word in any case (SwitchElm.java:63), and every switch-family reader
  // inherits that constructor. A load accepts any case and must land on the
  // same element its lowercase twin produces, while the save keeps writing
  // lowercase so files this port wrote stay byte-stable. The position token
  // beside it is a different story: upstream compares it case-sensitively
  // (SwitchElm.java:56-62), so only the momentary slot is varied here.
  const cases: Array<[string, string]> = [
    ['switch', 's 96 80 160 80 0 1 true'],
    ['switch2', 'S 96 144 160 64 0 0 true 0 2'],
    ['crossSwitch', '430 96 80 160 80 0 0 true'],
    ['dpdtSwitch', '429 96 80 176 80 0 0 true 2'],
    ['mbbSwitch', '416 96 80 160 80 0 0 true 0'],
    ['logicInput', 'L 0 0 100 0 0 0 true 5 0'],
  ];

  /** The file line with the momentary slot (token 7) rewritten. */
  const retokened = (line: string, word: string): string => {
    const tokens = line.split(' ');
    tokens[7] = word;
    return tokens.join(' ');
  };

  const savedLine = (text: string): string => {
    const [e] = parseCircuit(text).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    return out.split('\n').find((l) => l.startsWith(`${text.split(' ')[0]} `)) ?? '';
  };

  it.each(cases)('%s parses True and TRUE like lowercase and saves back lowercase', (kind, line) => {
    const [lower] = parseCircuit(line).elements;
    expect(lower.kind).toBe(kind);
    for (const word of ['True', 'TRUE']) {
      const [e] = parseCircuit(retokened(line, word)).elements;
      expect(withoutId(e)).toEqual(withoutId(lower));
    }
    expect(savedLine(retokened(line, 'True'))).toBe(line);
  });

  it.each(cases)('%s keeps a mixed-case false non-momentary', (_kind, line) => {
    const [off] = parseCircuit(retokened(line, 'false')).elements;
    const [e] = parseCircuit(retokened(line, 'False')).elements;
    expect(e.params.momentary).toBe(0);
    expect(withoutId(e)).toEqual(withoutId(off));
    expect(savedLine(retokened(line, 'False'))).toBe(retokened(line, 'false'));
  });
});

describe('boolean token case', () => {
  // Outside the switch family several defs carry the same kind of literal
  // `true`/`false` token, read upstream through `new Boolean(String)`
  // (MonostableElm.java:41 retriggerable, MotorProtectionSwitchElm.java:53 and
  // FuseElm.java:46 blown) or `Boolean.parseBoolean` (TriacElm.java:55 latch
  // state, CounterElm.java:42 reset polarity), both true for the word ignoring
  // case. Each reader shares boolToken now, so loads accept any case while
  // saves keep writing lowercase.
  const cases: Array<[string, Record<string, number>, Record<string, number>]> = [
    ['monostable', { retriggerable: 1 }, {}],
    ['motorProtectionSwitch', { blown: 1 }, {}],
    ['triac', { state: 1 }, {}],
    ['counter', { invertreset: 1 }, { invertreset: 0 }],
    ['fuse', { blown: 1 }, {}],
  ];

  /** A fresh element with params layered over the kind defaults. The third
   *  column exists because the counter's fresh default is invertreset on. */
  const built = (kind: string, params: Record<string, number>): CircuitElement => {
    const el = makeElement(kind, 96, 80, 160, 80);
    return { ...el, id: 1, params: { ...el.params, ...params } };
  };

  /** Serializes one element and returns its own line from the file. */
  const elementLineOf = (e: CircuitElement): string => {
    const out = serializeCircuit([{ ...e }], { ...DEFAULT_SETTINGS }).trim();
    return out.split('\n').find((l) => l.startsWith(`${defFor(e.kind)?.dumpCode} `)) ?? '';
  };

  /** The line with its boolean word rewritten. It is the only literal
   *  true/false token these kinds write. */
  const retokened = (line: string, word: string): string => {
    const tokens = line.split(' ');
    tokens[tokens.findIndex((t) => t === 'true' || t === 'false')] = word;
    return tokens.join(' ');
  };

  it.each(cases)('%s parses True and TRUE like lowercase and saves back lowercase', (kind, onParams) => {
    const base = elementLineOf(built(kind, onParams));
    expect(base).toContain(' true');
    const [lower] = parseCircuit(base).elements;
    for (const word of ['True', 'TRUE']) {
      const [e] = parseCircuit(retokened(base, word)).elements;
      expect(withoutId(e)).toEqual(withoutId(lower));
    }
    expect(elementLineOf(parseCircuit(retokened(base, 'True')).elements[0])).toBe(base);
  });

  it.each(cases)('%s keeps a mixed-case false non-set', (kind, _onParams, offParams) => {
    const base = elementLineOf(built(kind, offParams));
    expect(base).toContain(' false');
    const [off] = parseCircuit(base).elements;
    for (const word of ['False', 'FALSE']) {
      const [e] = parseCircuit(retokened(base, word)).elements;
      expect(withoutId(e)).toEqual(withoutId(off));
    }
    expect(elementLineOf(parseCircuit(retokened(base, 'False')).elements[0])).toBe(base);
  });
});

describe('electromechanical batch E file formats', () => {
  /** Parses a single line and re-emits it, returning the element and its line. */
  const elementLine = (text: string, code: string) => {
    const [e] = parseCircuit(text).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    return { e, line: out.split('\n').find((l) => l.startsWith(`${code} `)) ?? '' };
  };

  it('round-trips the DC motor eight tokens', () => {
    // DCMotorElm.java:40-47: inductance resistance K Kb J b gearRatio tau.
    const { e, line } = elementLine('415 0 0 96 0 0 0.5 1 0.15 0.15 0.02 0.05 1 0', '415');
    expect(e.params.inductance).toBe(0.5);
    expect(e.params.resistance).toBe(1);
    expect(e.params.K).toBe(0.15);
    expect(e.params.Kb).toBe(0.15);
    expect(e.params.J).toBe(0.02);
    expect(e.params.b).toBe(0.05);
    expect(e.params.gearRatio).toBe(1);
    expect(e.params.tau).toBe(0);
    expect(line).toBe('415 0 0 96 0 0 0.5 1 0.15 0.15 0.02 0.05 1 0');
  });

  it('round-trips the three-phase motor seven tokens', () => {
    // ThreePhaseMotorElm.java:43-51: Rs Rr Ls Lr lm b J. The values are
    // 3motor.txt's line gridded; upstream's class never overrides dump(), so
    // this port's writer is what keeps all seven on a save.
    const { e, line } = elementLine(
      '427 160 320 480 320 0 0.067 0.032 0.0294 0.0297 0.0287 0.05 0.067',
      '427',
    );
    expect(e.params.Rs).toBe(0.067);
    expect(e.params.Rr).toBe(0.032);
    expect(e.params.Ls).toBe(0.0294);
    expect(e.params.Lr).toBe(0.0297);
    expect(e.params.lm).toBe(0.0287);
    expect(e.params.b).toBe(0.05);
    expect(e.params.J).toBe(0.067);
    expect(line).toBe('427 160 320 480 320 0 0.067 0.032 0.0294 0.0297 0.0287 0.05 0.067');
  });

  it('round-trips the motor protection switch four tokens', () => {
    // MotorProtectionSwitchElm.java:48-64: resistance i2t blown label, blown
    // a literal true/false and the label one escaped token, empty as \0.
    // motorprotect.txt's values, gridded with an empty label.
    const { e, line } = elementLine('428 160 320 224 320 0 0.0613 6.73 false \\0', '428');
    expect(e.params.resistance).toBe(0.0613);
    expect(e.params.i2t).toBe(6.73);
    expect(e.params.blown).toBe(0);
    expect(e.text ?? '').toBe('');
    expect(line).toBe('428 160 320 224 320 0 0.0613 6.73 false \\0');
  });

  it('the time delay relay round-trips its four tokens', () => {
    // TimeDelayRelayElm.java:44-47: onDelay offDelay onResistance offResistance.
    const { e, line } = elementLine('414 0 0 96 0 0 0.5 0.2 10 1000000', '414');
    expect(e.params.onDelay).toBe(0.5);
    expect(e.params.offDelay).toBe(0.2);
    expect(e.params.onResistance).toBe(10);
    expect(e.params.offResistance).toBe(1000000);
    expect(line).toBe('414 0 0 96 0 0 0.5 0.2 10 1000000');
  });

  it('the MBB switch round-trips the SwitchElm base plus the link', () => {
    // MBBSwitchElm.java:44-49: position momentary [label] link.
    const { e, line } = elementLine('416 0 0 64 0 0 0 false 2', '416');
    expect(e.params.position).toBe(0);
    expect(e.params.link).toBe(2);
    expect(e.state).toBe(0);
    expect(line).toBe('416 0 0 64 0 0 0 false 2');
  });

  it('an MBB label shifts the link one token along', () => {
    const { e, line } = elementLine('416 0 0 64 0 4 1 false A 3', '416');
    expect(e.text).toBe('A');
    expect(e.params.link).toBe(3);
    expect(line).toBe('416 0 0 64 0 4 1 false A 3');
  });

  it('the DPDT switch round-trips the SwitchElm base plus the pole count', () => {
    // DPDTSwitchElm.java:38-45: position momentary [label] poleCount.
    const { e, line } = elementLine('429 0 0 64 0 0 1 false 3', '429');
    expect(e.params.position).toBe(1);
    expect(e.params.poleCount).toBe(3);
    expect(postsOf(e)).toHaveLength(9);
    expect(line).toBe('429 0 0 64 0 0 1 false 3');
  });

  it('a DPDT label shifts the pole count one token along', () => {
    const { e, line } = elementLine('429 0 0 64 0 4 0 false B 2', '429');
    expect(e.text).toBe('B');
    expect(e.params.poleCount).toBe(2);
    expect(postsOf(e)).toHaveLength(6);
    expect(line).toBe('429 0 0 64 0 4 0 false B 2');
  });

  it('a DPDT pole count out of the engine range clamps to 2..10', () => {
    const low = parseCircuit('429 0 0 64 0 0 0 false 1').elements[0];
    expect(low.params.poleCount).toBe(2);
    expect(postsOf(low)).toHaveLength(6);
    const high = parseCircuit('429 0 0 64 0 0 0 false 12').elements[0];
    expect(high.params.poleCount).toBe(10);
    expect(postsOf(high)).toHaveLength(30);
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

  it('a fresh coil and contact save the upstream "label" default', () => {
    // The label is the link key, so a fresh pair must carry it or the pair
    // never connects (RelayCoilElm.java:88, RelayContactElm.java:62).
    const coil = makeElement('relayCoil', 0, 0, 0, 64);
    expect(coil.text).toBe('label');
    const coilOut = serializeCircuit([{ ...coil, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    expect(coilOut.split('\n').find((l) => l.startsWith('425 '))).toBe(
      '425 0 0 0 64 0 label 0.2 0 0.02 20 0.015 0.005 0 0 0',
    );

    const contact = makeElement('relayContact', 0, 0, 64, 0);
    expect(contact.text).toBe('label');
    const contactOut = serializeCircuit([{ ...contact, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    expect(contactOut.split('\n').find((l) => l.startsWith('426 '))).toBe(
      '426 0 0 64 0 4 label 0.05 1000000 0',
    );
  });

  it('an empty relay label round-trips as the empty \\0 token, not the default', () => {
    // Clearing the field saves the empty escape, and a reload must keep it
    // empty: the engine treats an empty label as unlabelled, so restoring it
    // to "label" would re-pair a coil the user deliberately unlinked.
    const line = '425 0 0 0 64 0 \\0 0.2 0 0.02 20 0.015 0.005 0 0 0';
    const { e, elementLine } = relayLine(line, '425');
    expect(e.text).toBe('');
    expect(elementLine).toBe(line);
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
