import { describe, expect, it } from 'vitest';
import { parseCircuit, serializeCircuit } from './index';
import { makeElement } from '../../state/store';
import { postsOf } from '../../model/registry';
import { SimEngine } from '../../engine/simulator';
import { DEFAULT_SETTINGS, type CircuitElement } from '../../model/types';

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

  it('treats a non-breaking space as part of the token, not a separator', () => {
    // The file format splits tokens on space and tab only; a \u00A0 inside a
    // value must survive a save then load byte for byte, not be torn into two
    // tokens that rejoin on a regular space.
    const NBSP = ' ';
    const { e, again, elementLine } = roundTrip(`x 100 200 0 0 0 12 a${NBSP}b`);
    expect(e.text).toBe(`a${NBSP}b`);
    expect(elementLine).toContain(`a${NBSP}b`);
    expect(again.text).toBe(`a${NBSP}b`);
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

  it('a fresh text saves as an escaped hello line', () => {
    // The placement seed rides def.defaultText (TextElm.java:41,44), so a
    // dropped-and-saved part writes a real caption, not an empty token.
    const e = { ...makeElement('decoration', 0, 0, 0, 0), id: 1 };
    expect(e.text).toBe('hello');
    expect(lineFor(e, 'x ')).toBe('x 0 0 0 0 4 24 hello');
  });

  it('a fresh labeled node saves as a 207 label line', () => {
    const e = { ...makeElement('labeledNode', 0, 0, 0, 0), id: 1 };
    expect(lineFor(e, '207 ')).toBe('207 0 0 0 0 4 label');
  });

  it('two freshly placed labeled nodes share one net through their default name', async () => {
    // The behavioural half of the seed: upstream joins same-named labels, so
    // two parts both seeded "label" must land on one node without any edit.
    const engine = await SimEngine.create();
    const nextId = (() => {
      let n = 1;
      return () => n++;
    })();
    const mk = (kind: string, x1: number, y1: number, x2: number, y2: number) => ({
      ...makeElement(kind, x1, y1, x2, y2),
      id: nextId(),
    });
    // 5 V DC onto the near label, the far label feeding a load: the only
    // connection between the halves is the shared default text. The source
    // points up so its plus terminal lands on the wire row.
    const source = mk('voltage', 0, 64, 0, 0);
    const sourceGround = mk('ground', 0, 64, 0, 80);
    const wire = mk('wire', 0, 0, 128, 0);
    const near = mk('labeledNode', 128, 0, 128, 0);
    const far = mk('labeledNode', 256, 0, 256, 0);
    const load = mk('resistor', 256, 0, 320, 0);
    const loadGround = mk('ground', 320, 0, 320, 16);
    const elements = [source, sourceGround, wire, near, far, load, loadGround];
    for (const e of elements) if (e.kind === 'labeledNode') expect(e.text).toBe('label');
    expect(engine.setCircuit(elements, { ...DEFAULT_SETTINGS }, [])).toBeNull();
    engine.run(3);
    const offset = engine.postOffset(load.id)!;
    const nodes = engine.elementNodes();
    const v = engine.nodeVoltages()[nodes[offset]] ?? 0;
    expect(v).toBeCloseTo(5, 6);
  });
});

describe('annotation line format (423)', () => {
  it('a bare annotation line survives parse and save untouched', () => {
    // unishiftreg.txt:200's shape. LineElm reads nothing past the flags
    // (LineElm.java:31-37): the endpoints are drawing geometry, there are no
    // terminals and no tokens, so the line is its own round trip.
    const line = '423 21 260 20 369 0';
    const [e] = parseCircuit(line).elements;
    expect(e.kind).toBe('line');
    expect([e.x1, e.y1, e.x2, e.y2]).toEqual([21, 260, 20, 369]);
    expect(e.flags).toBe(0);
    expect(postsOf(e)).toHaveLength(0);
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    expect(out.split('\n').find((l) => l.startsWith('423 '))).toBe(line);
  });
});
