import { describe, expect, it } from 'vitest';
import { parseCircuit, serializeCircuit } from './index';
import { dropId, SAMPLE } from './fixtures';
import { makeElement } from '../../state/store';
import { DEFAULT_SETTINGS } from '../../model/types';

describe('subset dump', () => {
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

  it('round-trips every field, including the one it does not model', () => {
    const { parsed, line } = headerOf(SAMPLE);
    expect(parsed.settings.iterCount).toBe(10.20027730826997);
    expect(parsed.settings.powerRange).toBe(43);
    expect(parsed.settings.minTimeStep).toBe(5e-11);
    expect(parsed.settings.headerFlags).toBe(1);
    expect(parsed.settings.adaptiveTimeStep).toBe(false);
    // Byte-identical: before this, iterCount became 10, powerRange 50 and
    // minTimeStep timeStep/100, and the flags collapsed to 0.
    expect(line).toBe('$ 1 0.000005 10.20027730826997 50 5 43 5e-11');
  });

  it('minTimeStep and iterCount survive a round trip', () => {
    // Regression for the writer that used to fabricate minTimeStep as
    // timeStep/100 and iterCount as a hardcoded 10.
    const { line } = headerOf('$ 0 0.000005 7 50 5 50 1e-9\n');
    expect(line.split(' ')[3]).toBe('7');
    expect(line.split(' ')[7]).toBe('1e-9');
  });

  it('defaults match upstream', () => {
    expect(DEFAULT_SETTINGS.minTimeStep).toBe(50e-12);
    expect(DEFAULT_SETTINGS.iterCount).toBe(10);
    // Upstream's adjustTimeStep defaults off; only the header flag bit 64 (or
    // UnijunctionElm) turns it on (CircuitLoader.java:277).
    expect(DEFAULT_SETTINGS.adaptiveTimeStep).toBe(false);
    const out = serializeCircuit([], { ...DEFAULT_SETTINGS });
    expect(Number(out.split('\n')[0].split(' ')[7])).toBe(50e-12);
  });

  it('keeps the flag bits it does not model when an edit changes the one it does', () => {
    // Bits 1 (current dots) and 4 (volts) are nowhere decoded here, so turning
    // value labels off must not clear them.
    const { line } = headerOf('$ 5 1e-5 10 50 5 43 5e-11\n', { showValues: false });
    expect(line.split(' ')[1]).toBe(String(16 | 5));
  });

  it('a circuit with no loaded header writes the long-standing defaults', () => {
    // A fresh circuit is fixed-step, like upstream's off-by-default
    // adjustTimeStep, so the header carries flag 0 (16 is only set when value
    // labels are off).
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
