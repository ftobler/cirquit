/**
 * Bus-width resolution: wide pins seed widths and they flood through wire
 * chains and matching labels until stable, mirroring upstream's
 * detectBusWidths. Width disagreements surface as a mismatch set keyed on
 * "x,y", the coordinates upstream paints red.
 */

import { describe, expect, it } from 'vitest';
import {
  cachedBusMismatches,
  cachedBusWidths,
  postsForRender,
  resolveBusWidths,
} from './busWidths';
import { busValueLabel } from './registry/elements/wire';
import { WIRE_SHOW_BUS_VALUE, WIRE_SHOW_BUS_VALUE_HEX } from './registry/flags';
import { SimEngine } from '../engine/simulator';
import { DEFAULT_SETTINGS } from './types';
import type { CircuitElement } from './types';

let nextId = 1;

function make(kind: string, x1: number, y1: number, x2: number, y2: number, params: Record<string, number> = {}): CircuitElement {
  return { id: nextId++, kind, x1, y1, x2, y2, flags: 0, params };
}

function makeLabel(x: number, y: number, text: string): CircuitElement {
  return {
    id: nextId++,
    kind: 'labeledNode',
    x1: x,
    y1: y,
    x2: x,
    y2: y,
    flags: 0,
    params: {},
    text,
  };
}

describe('resolveBusWidths', () => {
  it('leaves plain wires out of the map', () => {
    const wire = make('wire', 0, 0, 64, 0);
    expect(resolveBusWidths([wire]).widths.get(wire.id)).toBeUndefined();
  });

  it('honours an explicit wire token', () => {
    const wire = make('wire', 0, 0, 64, 0, { busWidth: 4 });
    expect(resolveBusWidths([wire]).widths.get(wire.id)).toBe(4);
  });

  it('widens wires that touch a splitter bus side', () => {
    // A 2-bit splitter at (0,0): its two bus pins share (0,0). The wire drawn
    // away from that coordinate becomes a 2-bit bus.
    const splitter = make('busSplitter', 0, 0, 96, 0, { bits: 2 });
    const wire = make('wire', 0, 0, 128, 0);
    const widths = resolveBusWidths([splitter, wire]).widths;
    expect(widths.get(wire.id)).toBe(2);
  });

  it('floods widths down wire chains', () => {
    const splitter = make('busLogicInput', 0, 0, 64, 32, { busWidth: 4 });
    const a = make('wire', 0, 0, 64, 0);
    const b = make('wire', 64, 0, 160, 0);
    const c = make('wire', 160, 0, 256, 0);
    const widths = resolveBusWidths([splitter, a, b, c]).widths;
    expect(widths.get(a.id)).toBe(4);
    expect(widths.get(b.id)).toBe(4);
    expect(widths.get(c.id)).toBe(4);
  });

  it('takes the maximum when two widths claim one coordinate', () => {
    const input = make('busLogicInput', 0, 0, 64, 32, { busWidth: 2 });
    const splitter = make('busSplitter', 0, 0, 96, 0, { bits: 4 });
    const wire = make('wire', 0, 0, 64, 0);
    expect(resolveBusWidths([input, splitter, wire]).widths.get(wire.id)).toBe(4);
  });

  it('an isolated tokenised wire keeps its width without neighbours', () => {
    const wire = make('wire', 0, 0, 64, 0, { busWidth: 3 });
    expect(resolveBusWidths([wire]).widths.get(wire.id)).toBe(3);
  });
});

describe('labels in the width flood', () => {
  it('propagates width between coordinates joined only by label texts', () => {
    // Three labeled coordinates, one wire between two of them: the driver
    // seeds its own coordinate, the label there publishes 4 under its text,
    // and the text reaches the far coordinate through the other label even
    // where no wire runs.
    const input = make('busLogicInput', 0, 0, 64, 32, { busWidth: 4 });
    const near = makeLabel(0, 0, 'A');
    const mid = makeLabel(128, 0, 'A');
    const bridge = make('wire', 128, 0, 224, 0);
    const far = makeLabel(224, 0, 'A');
    const r = resolveBusWidths([input, near, mid, bridge, far]);
    expect(r.widths.get(near.id)).toBe(4);
    expect(r.widths.get(mid.id)).toBe(4);
    expect(r.widths.get(bridge.id)).toBe(4);
    expect(r.widths.get(far.id)).toBe(4);
  });

  it('a label inherits its coordinate width and passes it on', () => {
    const input = make('busLogicInput', 0, 0, 64, 32, { busWidth: 3 });
    const ln = makeLabel(0, 0, 'B');
    expect(resolveBusWidths([input, ln]).widths.get(ln.id)).toBe(3);
  });

  it('resolves narrow labels to one post and out of the map', () => {
    const ln = makeLabel(0, 0, 'plain');
    expect(resolveBusWidths([ln]).widths.get(ln.id)).toBeUndefined();
  });

  it('ignores empty-text labels', () => {
    const input = make('busLogicInput', 0, 0, 64, 32, { busWidth: 2 });
    const blank = makeLabel(0, 0, '');
    const r = resolveBusWidths([input, blank]);
    expect(r.widths.get(blank.id)).toBeUndefined();
  });
});

describe('width mismatches', () => {
  it('holds the exact key when two wide pins claim one coordinate', () => {
    const two = make('busLogicInput', 400, 300, 464, 332, { busWidth: 2 });
    const four = make('busLogicInput', 400, 300, 464, 332, { busWidth: 4 });
    const r = resolveBusWidths([two, four]);
    expect(r.mismatches).toEqual(new Set(['400,300']));
  });

  it('catches a disagreement the flood created down a wire chain', () => {
    // A 2-bit driver at one end, a 4-bit driver at the other, wires between:
    // the flood raises the near coordinate to 4, so the 2-bit pin's declared
    // width disagrees with what propagation settled on.
    const small = make('busLogicInput', 0, 0, 64, 32, { busWidth: 2 });
    const big = make('busLogicInput', 192, 0, 256, 32, { busWidth: 4 });
    const a = make('wire', 0, 0, 96, 0);
    const b = make('wire', 96, 0, 192, 0);
    const r = resolveBusWidths([small, big, a, b]);
    expect(r.mismatches).toEqual(new Set(['0,0']));
  });

  it('stays empty for clean single-driver buses', () => {
    const input = make('busLogicInput', 0, 0, 64, 32, { busWidth: 4 });
    const wire = make('wire', 0, 0, 128, 0);
    const ln = makeLabel(128, 0, 'A');
    const r = resolveBusWidths([input, wire, ln]);
    expect(r.mismatches.size).toBe(0);
  });
});

describe('postsForRender', () => {
  it('expands a tokenless wire to the propagated width', () => {
    // A 4-bit bus logic input seeds (0,0); the tokenless wire drawn away from
    // it becomes part of that bus, and the render terminal list must match
    // what the engine built: N terminals per endpoint, not the stored two.
    const input = make('busLogicInput', 0, 0, 64, 32, { busWidth: 4 });
    const wire = make('wire', 0, 0, 128, 0);
    const widths = resolveBusWidths([input, wire]).widths;
    const posts = postsForRender(wire, widths);
    expect(posts).toHaveLength(8);
    for (const p of posts.slice(0, 4)) expect(p).toEqual({ x: 0, y: 0 });
    for (const p of posts.slice(4)) expect(p).toEqual({ x: 128, y: 0 });
  });

  it('keeps a plain wire at its definition posts', () => {
    const wire = make('wire', 0, 0, 64, 0);
    expect(postsForRender(wire, resolveBusWidths([wire]).widths)).toHaveLength(2);
  });

  it('expands a wide labeled node to N copies of its anchor', () => {
    // Upstream's getPost(n) returns Point(x, y, n) once busWidth exceeds one
    // (LabeledNodeElm.java:130-135): every bit sits on the anchor. The far
    // label learns its width purely through the shared text.
    const input = make('busLogicInput', 0, 0, 64, 32, { busWidth: 3 });
    const near = makeLabel(0, 0, 'A');
    const far = makeLabel(96, 32, 'A');
    const r = resolveBusWidths([input, near, far]);
    expect(r.widths.get(far.id)).toBe(3);
    const posts = postsForRender(far, r.widths);
    expect(posts).toHaveLength(3);
    for (const p of posts) expect(p).toEqual({ x: 96, y: 32 });
  });

  it('keeps a narrow labeled node at its definition post', () => {
    const ln = makeLabel(96, 32, 'A');
    expect(postsForRender(ln, resolveBusWidths([ln]).widths)).toHaveLength(1);
  });
});

describe('resolution cache', () => {
  it('recomputes widths and mismatches on element-array identity', () => {
    const two = make('busLogicInput', 400, 300, 464, 332, { busWidth: 2 });
    const four = make('busLogicInput', 400, 300, 464, 332, { busWidth: 4 });
    const clashing = [two, four];
    expect(cachedBusMismatches(clashing)).toEqual(new Set(['400,300']));

    const clean = [four];
    expect(cachedBusMismatches(clean).size).toBe(0);

    // Back to the first array: the cache follows identity both ways.
    expect(cachedBusMismatches(clashing)).toEqual(new Set(['400,300']));
    expect(cachedBusWidths(clean).size).toBe(0);
  });
});

describe('busValueLabel', () => {
  it('forms the integer from every bit level, decimal and hex', () => {
    // Bits 0, 1 and 3 high: 0b1011 = 11.
    const voltages = [5, 5, 0, 5];
    expect(busValueLabel(voltages, WIRE_SHOW_BUS_VALUE, 4)).toBe('11');
    expect(busValueLabel(voltages, WIRE_SHOW_BUS_VALUE_HEX, 4)).toBe('0xB');
    expect(busValueLabel(voltages, WIRE_SHOW_BUS_VALUE | WIRE_SHOW_BUS_VALUE_HEX, 4)).toBe(
      '11 0xB',
    );
  });
});

describe('bus caption against the live engine', () => {
  it('reads all bits of a tokenless wire widened by a splitter-fed bus input', async () => {
    // The review finding, end to end: the wire carries no width token, so
    // only the propagation pass knows it is a 4-bit bus. The engine solves
    // word 0b0101 onto it, and the caption built from the render post list
    // must read 5, not a value truncated to the bits the stored width could
    // see.
    const engine = await SimEngine.create();
    const input = make('busLogicInput', 0, 0, 64, 32, { busWidth: 4, value: 5 });
    const wire = make('wire', 0, 0, 128, 0);
    // A real ground behind a small load on bit 0: without any ground symbol
    // the build falls back to referencing the first node, which would make
    // the driver's own bit-0 source degenerate.
    const load = make('resistor', 128, 0, 192, 0, { resistance: 100000 });
    const ground = make('ground', 192, 0, 192, 16);
    const elements = [input, wire, load, ground];
    expect(engine.setCircuit(elements, { ...DEFAULT_SETTINGS }, [])).toBeNull();
    engine.run(3);
    const widths = resolveBusWidths(elements).widths;
    const posts = postsForRender(wire, widths);
    const offset = engine.postOffset(wire.id);
    const nodes = engine.elementNodes();
    const voltages = posts.map((_, i) => {
      const node = nodes[(offset ?? 0) + i];
      return node === undefined ? 0 : (engine.nodeVoltages()[node] ?? 0);
    });
    expect(widths.get(wire.id)).toBe(4);
    expect(voltages).toHaveLength(8);
    expect(busValueLabel(voltages, WIRE_SHOW_BUS_VALUE, 4)).toBe('5');
  });

  it('joins two banks through same-named labels across the live engine', async () => {
    // Two 2-bit banks whose only link is a shared label text. The engine must
    // build each label with per-bit posts (the injected busWidth), so the far
    // bank reads every bit of the driven word; merging bit 0 alone would leave
    // bit 1 at its gmin pin instead of the driven low level.
    const engine = await SimEngine.create();
    const input = make('busLogicInput', 0, 0, 64, 32, {
      busWidth: 2,
      value: 1,
      hiV: 5,
      loV: 3,
    });
    const near = makeLabel(0, 0, 'A');
    const far = makeLabel(128, 64, 'A');
    const load = make('resistor', 128, 64, 192, 64, { resistance: 100000 });
    const ground = make('ground', 192, 64, 192, 80);
    const elements = [input, near, far, load, ground];
    expect(engine.setCircuit(elements, { ...DEFAULT_SETTINGS }, [])).toBeNull();
    engine.run(3);
    const offset = engine.postOffset(far.id);
    const nodes = engine.elementNodes();
    const v = (i: number) => engine.nodeVoltages()[nodes[(offset ?? 0) + i]] ?? 0;
    expect(v(0)).toBeCloseTo(5, 6);
    expect(v(1)).toBeCloseTo(3, 6);
  });
});
