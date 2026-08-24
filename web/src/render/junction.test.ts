import { describe, expect, it } from 'vitest';
import type { CircuitElement } from '../model/types';
import { badConnectionPoints, postDotPoints, shouldDrawDot } from './junction';

const el = (kind: string, x1: number, y1: number, x2: number, y2: number): CircuitElement => ({
  id: 1,
  kind,
  x1,
  y1,
  x2,
  y2,
  flags: 0,
  params: {},
});

describe('junction dots', () => {
  it('hides a pass-through connection and draws the two dead ends', () => {
    // A resistor and a wire share one post: the shared coordinate counts 2 and
    // draws no dot, the two free endpoints count 1 and draw.
    const wire = el('wire', 0, 0, 80, 0);
    const resistor = el('resistor', 80, 0, 160, 0);
    const counts = postDotPoints([wire, resistor]);

    expect(counts.get('80,0')).toBe(2);
    expect(shouldDrawDot(counts.get('80,0')!)).toBe(false);
    expect(shouldDrawDot(counts.get('0,0')!)).toBe(true);
    expect(shouldDrawDot(counts.get('160,0')!)).toBe(true);
  });

  it('draws a dot at a three-wire junction and at a floating end', () => {
    const a = el('wire', 0, 0, 80, 0);
    const b = el('wire', 80, 0, 80, 80);
    const c = el('wire', 80, 0, 160, 0);
    const counts = postDotPoints([a, b, c]);

    // The T-junction counts three posts, so it draws; the dangling ends count 1.
    expect(counts.get('80,0')).toBe(3);
    expect(shouldDrawDot(counts.get('80,0')!)).toBe(true);
    expect(counts.get('0,0')).toBe(1);
    expect(shouldDrawDot(counts.get('0,0')!)).toBe(true);
  });

  it('ignores a routed wire bend vertices: only the two endpoints count', () => {
    const routed = el('wire', 0, 0, 160, 0);
    routed.route = [
      [0, 0],
      [80, 80],
      [160, 0],
    ];
    const counts = postDotPoints([routed]);

    expect(counts.has('80,80')).toBe(false);
    expect(counts.get('0,0')).toBe(1);
    expect(counts.get('160,0')).toBe(1);
  });

  it('a junction where four wires meet counts 4 and draws one dot', () => {
    const wires = [
      el('wire', 0, 0, 80, 0),
      el('wire', 80, 0, 160, 0),
      el('wire', 80, 0, 80, 80),
      el('wire', 80, 0, 80, -80),
    ];
    const counts = postDotPoints(wires);
    expect(counts.get('80,0')).toBe(4);
    expect(shouldDrawDot(counts.get('80,0')!)).toBe(true);
  });
});

describe('bad connections', () => {
  it('flags a wire end dropped on another wire\'s middle', () => {
    // The move that started this: the vertical wire's lower end lands on the
    // horizontal wire's interior, which splits nothing, so it does not connect.
    const across = el('wire', 0, 0, 160, 0);
    const dropped = el('wire', 80, 0, 80, 80);
    dropped.id = 2;

    expect(badConnectionPoints([across, dropped])).toEqual([{ x: 80, y: 0 }]);
  });

  it('leaves a real junction alone: a third post at the coordinate connects', () => {
    // Two collinear wires meeting end to end plus a stub is a T-junction, not a
    // bad connection: the coordinate carries three posts.
    const left = el('wire', 0, 0, 80, 0);
    const right = el('wire', 80, 0, 160, 0);
    right.id = 2;
    const stub = el('wire', 80, 0, 80, 80);
    stub.id = 3;

    expect(badConnectionPoints([left, right, stub])).toEqual([]);
  });

  it('leaves a dangling end in empty space alone', () => {
    const a = el('wire', 0, 0, 80, 0);
    const b = el('wire', 0, 80, 80, 80);
    b.id = 2;

    expect(badConnectionPoints([a, b])).toEqual([]);
  });

  it('flags an end on a routed wire segment and on a bend vertex', () => {
    const routed = el('wire', 0, 0, 160, 0);
    routed.route = [
      [0, 0],
      [0, 80],
      [160, 80],
      [160, 0],
    ];
    const onSegment = el('wire', 80, 80, 80, 160);
    onSegment.id = 2;
    const onBend = el('wire', 0, 80, -80, 80);
    onBend.id = 3;

    const bad = badConnectionPoints([routed, onSegment, onBend]);
    expect(bad).toContainEqual({ x: 80, y: 80 });
    expect(bad).toContainEqual({ x: 0, y: 80 });
    // The routed wire's own endpoints touch nothing else.
    expect(bad).not.toContainEqual({ x: 0, y: 0 });
    expect(bad).not.toContainEqual({ x: 160, y: 0 });
  });

  it('flags an end landing on another element\'s body, not just on a wire', () => {
    // Upstream tests every non-graphic element by its bounding box, so a wire
    // end parked on a resistor's axis is just as unconnected.
    const resistor = el('resistor', 0, 0, 160, 0);
    const stub = el('wire', 80, 0, 80, 80);
    stub.id = 2;

    expect(badConnectionPoints([resistor, stub])).toEqual([{ x: 80, y: 0 }]);
  });

  it('ignores the decorative parts: a box has no posts and nothing to connect to', () => {
    const box = el('box', 0, 0, 160, 160);
    const stub = el('wire', 80, 80, 80, 160);
    stub.id = 2;

    expect(badConnectionPoints([box, stub])).toEqual([]);
  });

  it('reuses a caller-supplied post count map', () => {
    const across = el('wire', 0, 0, 160, 0);
    const dropped = el('wire', 80, 0, 80, 80);
    dropped.id = 2;
    const elements = [across, dropped];

    expect(badConnectionPoints(elements, postDotPoints(elements))).toEqual([{ x: 80, y: 0 }]);
  });

  it('never treats a rail free end as a connection point', () => {
    // A rail's free end is a control point, not a post, so it cannot join the
    // wire it lies on: the wire end there is still a bad connection. The
    // rail's own box covers the point too, which is the same answer.
    const across = el('wire', 160, 0, 160, 160);
    const dropped = el('wire', 0, 32, 160, 32);
    dropped.id = 2;
    const rail = el('rail', 0, 0, 160, 32);
    rail.id = 3;

    expect(badConnectionPoints([across, dropped, rail])).toContainEqual({ x: 160, y: 32 });
  });

  it('unions bus-width mismatch coordinates with the classic dots', () => {
    // Upstream folds its busMismatchList into badConnectionList
    // (SimulationManager.java:1109), so a coordinate where a 2-bit driver and
    // a 4-bit driver claim one net paints red exactly like a dropped end. Two
    // anchor-post drivers share (400,300); their widths disagree there.
    const across = el('wire', 0, 0, 160, 0);
    const dropped = el('wire', 80, 0, 80, 80);
    dropped.id = 2;
    const two = el('busLogicInput', 400, 300, 464, 332);
    two.id = 3;
    two.params.busWidth = 2;
    const four = el('busLogicInput', 400, 300, 464, 332);
    four.id = 4;
    four.params.busWidth = 4;

    const bad = badConnectionPoints([across, dropped, two, four]);
    expect(bad).toContainEqual({ x: 80, y: 0 });
    expect(bad).toContainEqual({ x: 400, y: 300 });
  });
});

describe('collapsed bus banks', () => {
  // A 4-bit bus splitter at (400,300)-(496,300): all four west pins hang off
  // the single coordinate "400,300", each tagged with its bit, while the four
  // individual east pins sit at (496, 300 + 32 * pos). Upstream keys its
  // post-draw list on whole Points including that bit axis
  // (SimulationManager.makePostDrawList), so a label's post pairs with a bank
  // bit and nothing paints; this port counts flat "x,y" keys, so it counts
  // only the bank pin drawing actually paints, exactly the drawChip busZ skip.
  const splitter = (): CircuitElement => {
    const s = el('busSplitter', 400, 300, 496, 300);
    s.params.bits = 4;
    return s;
  };
  const labelAt = (id: number, text: string): CircuitElement => ({
    ...el('labeledNode', 400, 300, 400, 300),
    id,
    text,
  });

  it('hides a wide labeled node anchored on the bank: bank plus label is 2', () => {
    const parts = [
      splitter(),
      labelAt(2, 'DBUS'),
      { ...el('wire', 496, 300, 560, 300), id: 3 },  // the bus continues elsewhere
    ];
    const counts = postDotPoints(parts);

    expect(counts.get('400,300')).toBe(2);
    expect(shouldDrawDot(counts.get('400,300')!)).toBe(false);
    expect(badConnectionPoints(parts)).toEqual([]);
  });

  it('hides the reported narrow-label repro the same way', () => {
    // Upstream stacks stray ovals here for the bank bits its z-keyed count
    // leaves unpaired at the coordinate; the port deliberately does not
    // import that quirk and paints nothing, like the paired bits.
    const parts = [splitter(), labelAt(2, 'A')];
    const counts = postDotPoints(parts);

    expect(counts.get('400,300')).toBe(2);
    expect(shouldDrawDot(counts.get('400,300')!)).toBe(false);
    expect(badConnectionPoints(parts)).toEqual([]);
  });

  it('hides a lone wire end landing on the bank', () => {
    const parts = [splitter(), { ...el('wire', 320, 300, 400, 300), id: 2 }];
    const counts = postDotPoints(parts);

    expect(counts.get('400,300')).toBe(2);
    expect(shouldDrawDot(counts.get('400,300')!)).toBe(false);
    // The wire's free end stays an ordinary dead end.
    expect(counts.get('320,300')).toBe(1);
    expect(shouldDrawDot(counts.get('320,300')!)).toBe(true);
    expect(badConnectionPoints(parts)).toEqual([]);
  });

  it('keeps an untouched bank a visible dead end', () => {
    const parts = [splitter()];
    const counts = postDotPoints(parts);

    expect(counts.get('400,300')).toBe(1);
    expect(shouldDrawDot(counts.get('400,300')!)).toBe(true);
    // The individual east pins count one each, like any dead end.
    expect(counts.get('496,300')).toBe(1);
    expect(counts.get('496,332')).toBe(1);
    expect(badConnectionPoints(parts)).toEqual([]);
  });

  it('draws one dot when a wire end and a label share the bank', () => {
    const parts = [splitter(), { ...el('wire', 320, 300, 400, 300), id: 2 }, labelAt(3, 'DBUS')];
    const counts = postDotPoints(parts);

    expect(counts.get('400,300')).toBe(3);
    expect(shouldDrawDot(counts.get('400,300')!)).toBe(true);
    // A three-post coordinate connects, so nothing is flagged red either.
    expect(badConnectionPoints(parts)).toEqual([]);
  });

  it('collapses an anchor-bank driver onto one counted post too', () => {
    // The bus logic input declares no pin table: every post is one bit parked
    // on the anchor coordinate (upstream getPost(n) = new Point(x, y, n)), so
    // it must count once like the tagged banks do.
    const bli = el('busLogicInput', 400, 300, 464, 332);
    bli.id = 2;
    bli.params.busWidth = 4;
    const counts = postDotPoints([bli]);

    expect(counts.get('400,300')).toBe(1);
    expect(shouldDrawDot(counts.get('400,300')!)).toBe(true);

    const labelled = [bli, labelAt(3, 'IR')];
    const withLabel = postDotPoints(labelled);
    expect(withLabel.get('400,300')).toBe(2);
    expect(shouldDrawDot(withLabel.get('400,300')!)).toBe(false);
    expect(badConnectionPoints(labelled)).toEqual([]);
  });
});
