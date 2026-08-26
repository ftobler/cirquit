import { describe, expect, it } from 'vitest';
import { parseCircuit, serializeCircuit } from './index';
import { makeElement } from '../../state/store';
import { postsOf } from '../../model/registry';
import { DEFAULT_SETTINGS } from '../../model/types';

describe('controlled source file formats', () => {
  /** Parses a single element line and re-emits it, returning that line. */
  const csLine = (line: string, code: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    return { e, elementLine: out.split('\n').find((l) => l.startsWith(`${code} `)) ?? '' };
  };

  it('a CCII+ conveyor line round-trips byte-for-byte (cc2.txt:2)', () => {
    // The single gain token (CC2Elm.java:29-33). `1.0` normalises to `1` like
    // every numeric token this port writes, so the assertion is on values.
    const line = '179 272 224 304 224 0 1.0';
    const { e, elementLine } = csLine(line, '179');
    expect(e.params.gain).toBe(1);
    expect(elementLine).toBe('179 272 224 304 224 0 1');
  });

  it('a CCII- conveyor line round-trips its negative gain', () => {
    // The corpus cc2n.txt line; a negative gain is the whole point of the
    // CCII- flavour.
    const line = '179 272 224 304 224 0 -1.0';
    const { e, elementLine } = csLine(line, '179');
    expect(e.params.gain).toBe(-1);
    expect(elementLine).toBe('179 272 224 304 224 0 -1');
  });

  it('a VCVS line with the qam-256 expression round-trips byte-for-byte', () => {
    // qam-256.txt:52. The `\p` escape decodes to `+` on load and the save
    // writes it back, so the line is byte-identical.
    const line = '212 624 368 672 368 0 5 (a*2-d)*b\\p(e*2-d)*c';
    const { e, elementLine } = csLine(line, '212');
    expect(e.params.inputCount).toBe(5);
    expect(e.text).toBe('(a*2-d)*b+(e*2-d)*c');
    expect(elementLine).toBe(line);
  });

  it('a VCCS line round-trips byte-for-byte (qam-256.txt:24)', () => {
    // The shared VCCS/VCVS token layout: inputCount then the expression.
    const line = '213 976 528 1008 528 0 2 a*b*2/1000';
    const { e, elementLine } = csLine(line, '213');
    expect(e.params.inputCount).toBe(2);
    expect(e.text).toBe('a*b*2/1000');
    expect(elementLine).toBe(line);
  });

  it('a bare unijunction line round-trips byte-for-byte (ujtosc.txt:11)', () => {
    // No tokens follow the common fields (dumpWithMask(0),
    // UnijunctionElm.java:49-52); the flags still ride through.
    const line = '417 416 176 496 176 1';
    const { e, elementLine } = csLine(line, '417');
    expect(e.flags).toBe(1);
    expect(elementLine).toBe(line);
  });

  it('the expression escape set survives a round trip', () => {
    // `+`, `=`, `#`, `&` and space are all in the shared escape set
    // (CustomLogicModel.java:259-263), so an expression containing them is
    // one token on the line and the unescaped string on the element.
    const line = '213 0 0 32 0 2 2 a\\pb\\qc\\hd\\ae\\sf';
    const { e, elementLine } = csLine(line, '213');
    expect(e.text).toBe('a+b=c#d&e f');
    expect(elementLine).toBe(line);
    const [again] = parseCircuit(elementLine).elements;
    expect(again.text).toBe('a+b=c#d&e f');
  });

  it('a fresh VCVS dumps the upstream constructor expression', () => {
    const e = makeElement('vcvs', 0, 0, 32, 0);
    expect(e.params.inputCount).toBe(2);
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    // The fresh constructor's expression (VCCSElm.java:45); none of its
    // characters are in the escape set, so the token is verbatim.
    expect(out).toContain('212 0 0 32 0 0 2 .1*(a-b)');
  });

  it('a fresh CCVS dumps the upstream constructor expression', () => {
    const e = makeElement('ccvs', 0, 0, 32, 0);
    expect(e.params.inputCount).toBe(2);
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    expect(out).toContain('214 0 0 32 0 0 2 2*a');
  });

  it('a fresh CCCS dumps the upstream constructor expression', () => {
    const e = makeElement('cccs', 0, 0, 32, 0);
    expect(e.params.inputCount).toBe(2);
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    expect(out).toContain('215 0 0 32 0 0 2 2*a');
  });

  it('a CCVS line round-trips byte-for-byte (cccs.txt:1)', () => {
    // The current-controlled sources share the VCCS token layout: inputCount
    // then the expression (VCCSElm.java:37-38).
    const line = '214 416 272 432 272 0 2 i*2';
    const { e, elementLine } = csLine(line, '214');
    expect(e.params.inputCount).toBe(2);
    expect(e.text).toBe('i*2');
    expect(elementLine).toBe(line);
  });

  it('a CCCS line round-trips byte-for-byte (cccs.txt:1)', () => {
    const line = '215 416 272 432 272 0 2 i*2';
    const { e, elementLine } = csLine(line, '215');
    expect(e.params.inputCount).toBe(2);
    expect(e.text).toBe('i*2');
    expect(elementLine).toBe(line);
  });

  it('a fractional VCVS input count normalises on load to the engine integer', () => {
    // A hand-edited 2.5 would draw 5 posts with `Math.round` but build 4 with
    // the engine's `(2.5 as i64)` truncation, so the spec fails the post-count
    // guard. Parse clamps to the integer the engine derives, the same clamp
    // the gate applies on its own input count (gate.ts:306).
    const { e, elementLine } = csLine('212 0 0 96 0 0 2.5 a*2', '212');
    expect(e.params.inputCount).toBe(2);
    expect(elementLine).toBe('212 0 0 96 0 0 2 a*2');
  });

  it('a boundary VCVS input count clamps to the engine 1..8 range on load', () => {
    const low = csLine('212 0 0 96 0 0 0.5 a*2', '212');
    expect(low.e.params.inputCount).toBe(1);
    const high = csLine('212 0 0 96 0 0 9.5 a*2', '212');
    expect(high.e.params.inputCount).toBe(8);
  });

  it('a fractional multiplexer select count normalises on load to the engine integer', () => {
    // A hand-edited 2.5 would draw 8 inputs with `Math.round` but build 4 with
    // the engine's `(2.5 as usize)` truncation, so the spec fails the
    // post-count guard. Parse clamps to the integer the engine derives, the
    // same clamp the store applies on edit (store.ts:setParam).
    const { e, elementLine } = csLine('184 0 0 128 0 0 2.5', '184');
    expect(e.params.bits).toBe(2);
    expect(elementLine).toBe('184 0 0 128 0 0 2');
  });

  it('a fractional demultiplexer select count normalises on load to the engine integer', () => {
    // The engine rounds the demultiplexer's count (de_multiplexer.rs:42), so
    // a 2.5 token loads as 3, the value a save re-emits.
    const { e, elementLine } = csLine('185 0 0 128 0 0 2.5', '185');
    expect(e.params.selectBits).toBe(3);
    expect(elementLine).toBe('185 0 0 128 0 0 3');
  });

  it.each([
    ['167', 'adc', 'adc', 2],
    ['166', 'dac', 'dac', 2],
    ['419', 'decimalDisplay', 'decimalDisplay', 2],
    ['168', 'latch', 'latch', 2],
    ['164', 'counter', 'counter', 3],
    ['163', 'ringCounter', 'ringCounter', 2],
  ])('a fractional %s %s bit count normalises on load to the engine integer', (code, kind, _name, n) => {
    // A hand-edited fraction would draw `Math.round` pins but build the
    // engine's `(x as usize)` truncation and floor (a counter's 2.5 round-trips
    // as 3 both ways, so the probe token is 3.9, where round gives 4), so the
    // spec fails the post-count guard. Parse clamps to the integer the engine
    // derives, the same clamp the store applies on edit (store.ts:setParam).
    const token = kind === 'counter' ? '3.9' : '2.5';
    const { e } = csLine(`${code} 0 0 128 0 0 ${token}`, code);
    expect(e.kind).toBe(kind);
    expect(e.params.bits).toBe(n);
  });

  it('an out-of-range counter bit count clamps on load to the engine ceiling', () => {
    // A hand-edited file can carry any "bits" value; 65 used to pass straight
    // through the frontend's floor-only normalizeChipBits(value, 3) and reach
    // the engine unclamped, where execute()'s per-bit i64 shift could panic
    // once i reached 64. Both sides now clamp to 62 (counter.rs:27,
    // counter.ts's normalizeCounterBits).
    const { e } = csLine('164 0 0 128 0 0 65', '164');
    expect(e.params.bits).toBe(62);
  });

  it('a fractional adc bit count re-emits the engine integer', () => {
    // The ADC's token stream is just `bits` then the optional high voltage, so
    // a save writes the normalised integer back in place (ADCElm.java:36).
    const { elementLine } = csLine('167 0 0 128 0 0 2.5', '167');
    expect(elementLine).toBe('167 0 0 128 0 0 2');
  });

  it('a fractional dac bit count re-emits the engine integer', () => {
    const { elementLine } = csLine('166 0 0 128 0 0 2.5', '166');
    expect(elementLine).toBe('166 0 0 128 0 0 2');
  });

  it('an out-of-range dac bit count clamps on load to the engine ceiling', () => {
    // A hand-edited file can carry any "bits" value; 65 used to pass straight
    // through the frontend's floor-only normalizeChipBits(value, 1) and reach
    // the engine unclamped, where output_v() computes `1usize << bits` on
    // every Newton iteration and could panic once bits reached usize's width.
    // Both sides now clamp to 30 (dac.rs:36, dac.ts's normalizeDacBits).
    const { e, elementLine } = csLine('166 0 0 128 0 0 65', '166');
    expect(e.params.bits).toBe(30);
    expect(elementLine).toBe('166 0 0 128 0 0 30');
  });

  it('an oversized chip width warns on load instead of rewriting silently', () => {
    // The same clamp-on-load policy as the gate: a hand-edited 65-bit DAC
    // loads at the engine's 30-bit ceiling and the save would rewrite it, so
    // the parse reports the loss through `warnings`.
    const parsed = parseCircuit('166 0 0 128 0 0 65\n');
    expect(parsed.elements[0].params.bits).toBe(30);
    expect(parsed.warnings).toEqual(['DAC with 65 bits loaded as 30 bits']);
  });

  it('an in-range chip width loads clean with no warning', () => {
    const parsed = parseCircuit('166 0 0 128 0 0 4\n');
    expect(parsed.elements[0].params.bits).toBe(4);
    expect(parsed.warnings).toEqual([]);
  });

  it('an out-of-range latch bit count clamps on load to the engine ceiling', () => {
    // A hand-edited file can carry any "bits" value; 1e9 used to pass straight
    // through the frontend's floor-only normalizeChipBits(value, 2) and reach
    // the engine unclamped, where Vec::with_capacity and vec![false; bits]
    // panic on the allocation. Both sides now clamp to 32 (latch.rs:42,
    // latch.ts's normalizeLatchBits).
    const { e } = csLine('168 0 0 128 0 0 1e9', '168');
    expect(e.params.bits).toBe(32);
  });

  it('an out-of-range ring counter bit count clamps on load to the engine ceiling', () => {
    // Same allocation panic as the latch; both sides now clamp to 32
    // (ring_counter.rs:28, ringCounter.ts's normalizeRingBits).
    const { e } = csLine('163 0 0 128 0 0 1e9', '163');
    expect(e.params.bits).toBe(32);
  });

  it('an out-of-range counter 2 bit count clamps on load to the engine ceiling', () => {
    // Same allocation panic as the latch; both sides now clamp to 32
    // (counter2.rs:27, counter2.ts's normalizeCounter2Bits).
    const { e } = csLine('421 0 0 128 0 0 1e9', '421');
    expect(e.params.bits).toBe(32);
  });

  it('an out-of-range sipo shift bit count clamps on load to the engine ceiling', () => {
    // Same allocation panic as the latch; both sides now clamp to 32
    // (sipo_shift.rs:20, sipoShift.ts's normalizeSipoBits).
    const { e } = csLine('189 0 0 128 0 0 1e9', '189');
    expect(e.params.bits).toBe(32);
  });

  it('an out-of-range piso shift bit count clamps on load to the engine ceiling', () => {
    // Same allocation panic as the latch; both sides now clamp to 32
    // (piso_shift.rs:32, pisoShift.ts's normalizePisoBits).
    const { e } = csLine('186 0 0 128 0 0 1e9', '186');
    expect(e.params.bits).toBe(32);
  });

  it('a fractional decimal display bit count re-emits the engine integer', () => {
    // The decimal display reads its own `bitCount displayMode` after the
    // optional high voltage, and the 2.5 lands on the bit count
    // (DecimalDisplayElm.java:78).
    const { elementLine } = csLine('419 0 0 128 0 0 2.5 0', '419');
    expect(elementLine).toBe('419 0 0 128 0 0 2 0');
  });

  it('a CCCS with one pair lands its posts where the cccs.txt wires connect', () => {
    // reference tests/cccs.txt:1 spans (416,272)-(432,272): A+ at the first
    // endpoint, A- below it, and the O+ output on the east at (512,272),
    // where the file's `w 512 272 560 272` leads to the next source's A+.
    const e = parseCircuit('215 416 272 432 272 0 2 i*2').elements[0];
    expect(postsOf(e)).toEqual([
      { x: 416, y: 272 },
      { x: 416, y: 304 },
      { x: 512, y: 272 },
      { x: 512, y: 304 },
    ]);
  });

  it('a fresh CCII dumps gain 1', () => {
    const e = makeElement('cc2', 0, 0, 32, 0);
    const out = serializeCircuit([{ ...e, id: 1 }], { ...DEFAULT_SETTINGS }).trim();
    expect(out).toContain('179 0 0 32 0 0 1');
  });

  it('the conveyor posts land where the corpus wires connect', () => {
    // ccvccs.txt:2 spans (208,192)-(336,192); the corpus wires hang off
    // (208,192) to the west (the X output post) and (304,224) on the east
    // (the Z post), with the Y input at (208,256) under the X.
    const e = parseCircuit('179 208 192 336 192 0 1').elements[0];
    expect(postsOf(e)).toEqual([
      { x: 208, y: 192 },
      { x: 208, y: 256 },
      { x: 304, y: 224 },
    ]);
  });

  it('a VCVS with five inputs spaces its posts over the 5-row chip', () => {
    // qam-256.txt:52 spans (624,368)-(672,368); input B connects at
    // (624,400), V+ at (720,368) and V- at (720,400).
    const e = parseCircuit('212 624 368 672 368 0 5 (a*2-d)*b\\p(e*2-d)*c').elements[0];
    expect(postsOf(e)).toEqual([
      { x: 624, y: 368 },
      { x: 624, y: 400 },
      { x: 624, y: 432 },
      { x: 624, y: 464 },
      { x: 624, y: 496 },
      { x: 720, y: 368 },
      { x: 720, y: 400 },
    ]);
  });

  it('a VCCS with two inputs keeps the 2-row chip height', () => {
    const e = parseCircuit('213 976 528 1008 528 0 2 a*b*2/1000').elements[0];
    expect(postsOf(e)).toEqual([
      { x: 976, y: 528 },
      { x: 976, y: 560 },
      { x: 1072, y: 528 },
      { x: 1072, y: 560 },
    ]);
  });

  it('the unijunction posts match the ujtosc.txt wires', () => {
    // ujtosc.txt:11 spans (416,176)-(496,176): the emitter hangs at the first
    // endpoint, B1 below the axis and B2 above it (UnijunctionElm.java:
    // 126-128), where the file's resistors connect.
    const e = parseCircuit('417 416 176 496 176 1').elements[0];
    expect(postsOf(e)).toEqual([
      { x: 416, y: 176 },
      { x: 496, y: 208 },
      { x: 496, y: 176 },
    ]);
  });
});
