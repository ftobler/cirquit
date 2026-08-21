/**
 * Bus-width resolution: wide pins seed widths and they flood through wire
 * chains until stable, mirroring upstream's detectBusWidths.
 */

import { describe, expect, it } from 'vitest';
import { postsForRender, resolveBusWidths } from './busWidths';
import { busValueLabel } from './registry/elements/wire';
import { WIRE_SHOW_BUS_VALUE, WIRE_SHOW_BUS_VALUE_HEX } from './registry/flags';
import { SimEngine } from '../engine/simulator';
import { DEFAULT_SETTINGS } from './types';
import type { CircuitElement } from './types';

let nextId = 1;

function make(kind: string, x1: number, y1: number, x2: number, y2: number, params: Record<string, number> = {}): CircuitElement {
  return { id: nextId++, kind, x1, y1, x2, y2, flags: 0, params };
}

describe('resolveBusWidths', () => {
  it('leaves plain wires out of the map', () => {
    const wire = make('wire', 0, 0, 64, 0);
    expect(resolveBusWidths([wire]).get(wire.id)).toBeUndefined();
  });

  it('honours an explicit wire token', () => {
    const wire = make('wire', 0, 0, 64, 0, { busWidth: 4 });
    expect(resolveBusWidths([wire]).get(wire.id)).toBe(4);
  });

  it('widens wires that touch a splitter bus side', () => {
    // A 2-bit splitter at (0,0): its two bus pins share (0,0). The wire drawn
    // away from that coordinate becomes a 2-bit bus.
    const splitter = make('busSplitter', 0, 0, 96, 0, { bits: 2 });
    const wire = make('wire', 0, 0, 128, 0);
    const widths = resolveBusWidths([splitter, wire]);
    expect(widths.get(wire.id)).toBe(2);
  });

  it('floods widths down wire chains', () => {
    const splitter = make('busLogicInput', 0, 0, 64, 32, { busWidth: 4 });
    const a = make('wire', 0, 0, 64, 0);
    const b = make('wire', 64, 0, 160, 0);
    const c = make('wire', 160, 0, 256, 0);
    const widths = resolveBusWidths([splitter, a, b, c]);
    expect(widths.get(a.id)).toBe(4);
    expect(widths.get(b.id)).toBe(4);
    expect(widths.get(c.id)).toBe(4);
  });

  it('takes the maximum when two widths claim one coordinate', () => {
    const input = make('busLogicInput', 0, 0, 64, 32, { busWidth: 2 });
    const splitter = make('busSplitter', 0, 0, 96, 0, { bits: 4 });
    const wire = make('wire', 0, 0, 64, 0);
    expect(resolveBusWidths([input, splitter, wire]).get(wire.id)).toBe(4);
  });

  it('an isolated tokenised wire keeps its width without neighbours', () => {
    const wire = make('wire', 0, 0, 64, 0, { busWidth: 3 });
    expect(resolveBusWidths([wire]).get(wire.id)).toBe(3);
  });
});

describe('postsForRender', () => {
  it('expands a tokenless wire to the propagated width', () => {
    // A 4-bit bus logic input seeds (0,0); the tokenless wire drawn away from
    // it becomes part of that bus, and the render terminal list must match
    // what the engine built: N terminals per endpoint, not the stored two.
    const input = make('busLogicInput', 0, 0, 64, 32, { busWidth: 4 });
    const wire = make('wire', 0, 0, 128, 0);
    const widths = resolveBusWidths([input, wire]);
    const posts = postsForRender(wire, widths);
    expect(posts).toHaveLength(8);
    for (const p of posts.slice(0, 4)) expect(p).toEqual({ x: 0, y: 0 });
    for (const p of posts.slice(4)) expect(p).toEqual({ x: 128, y: 0 });
  });

  it('keeps a plain wire at its definition posts', () => {
    const wire = make('wire', 0, 0, 64, 0);
    expect(postsForRender(wire, resolveBusWidths([wire]))).toHaveLength(2);
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
    const widths = resolveBusWidths(elements);
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
});

