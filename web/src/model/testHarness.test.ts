import { describe, expect, it } from 'vitest';
import {
  CHIP_BIT_ORDER_BUS,
  CHIP_FLIP_X,
  CHIP_FLIP_XY,
  CHIP_FLIP_Y,
} from './registry/elements/dFlipFlop';
import { FULL_ADDER_BITS } from './registry/elements/fullAdder';
import { WIRE_SHOW_BUS_VALUE } from './registry/flags';
import { chipPinsOf } from './registry/chips';
import { postsOf } from './registry';
import { createTestHarness, selectHarnessChip, type HarnessPin } from './testHarness';
import type { CircuitElement } from './types';

const GRID = 16;
const OUT = GRID * 4; // the harness lead length, TestCreator.java:53

describe('createTestHarness placement', () => {
  it('places a logic input or output one gridSize*4 outward from each post', () => {
    const pins: HarnessPin[] = [
      { side: 'W', output: false, post: { x: 32, y: 16 } },
      { side: 'E', output: true, post: { x: 128, y: 16 } },
      { side: 'S', output: false, post: { x: 80, y: 96 } },
      { side: 'N', output: true, post: { x: 80, y: 0 } },
    ];
    const placed = createTestHarness(pins, GRID);
    expect(placed).toHaveLength(4);
    // The terminal sits on the chip's post and the free end is OUT away.
    expect(placed[0]).toEqual({ kind: 'logicInput', x1: 32, y1: 16, x2: 32 - OUT, y2: 16 });
    expect(placed[1]).toEqual({ kind: 'logicOutput', x1: 128, y1: 16, x2: 128 + OUT, y2: 16 });
    expect(placed[2]).toEqual({ kind: 'logicInput', x1: 80, y1: 96, x2: 80, y2: 96 + OUT });
    expect(placed[3]).toEqual({ kind: 'logicOutput', x1: 80, y1: 0, x2: 80, y2: 0 - OUT });
  });

  it('maps an input pin to a logic input and an output pin to a logic output', () => {
    const placed = createTestHarness(
      [
        { side: 'W', output: false, post: { x: 0, y: 0 } },
        { side: 'E', output: true, post: { x: 64, y: 0 } },
      ],
      GRID,
    );
    expect(placed[0].kind).toBe('logicInput');
    expect(placed[1].kind).toBe('logicOutput');
  });

  it('turns every harness post away from the body under the flip flags', () => {
    // FLAG_FLIP_X mirrors the horizontal axis: a W pin's post now points east.
    expect(
      createTestHarness(
        [{ side: 'W', output: false, post: { x: 32, y: 16 } }],
        GRID,
        CHIP_FLIP_X,
      )[0],
    ).toEqual({
      kind: 'logicInput',
      x1: 32,
      y1: 16,
      x2: 32 + OUT,
      y2: 16,
    });
    // FLAG_FLIP_Y mirrors the vertical axis: an S pin's post now points north.
    expect(
      createTestHarness(
        [{ side: 'S', output: false, post: { x: 80, y: 96 } }],
        GRID,
        CHIP_FLIP_Y,
      )[0],
    ).toEqual({
      kind: 'logicInput',
      x1: 80,
      y1: 96,
      x2: 80,
      y2: 96 - OUT,
    });
    // FLAG_FLIP_XY swaps W/E with N/S before the mirror: a W pin becomes N.
    expect(
      createTestHarness(
        [{ side: 'W', output: false, post: { x: 32, y: 16 } }],
        GRID,
        CHIP_FLIP_XY,
      )[0],
    ).toEqual({
      kind: 'logicInput',
      x1: 32,
      y1: 16,
      x2: 32,
      y2: 16 - OUT,
    });
  });

  it('skips the duplicate pins of a bus, keeping one element per bus', () => {
    const placed = createTestHarness(
      [
        { side: 'E', output: true, post: { x: 64, y: 0 }, busWidth: 4, busZ: 0 },
        { side: 'E', output: true, post: { x: 64, y: 0 }, busWidth: 4, busZ: 1 },
        { side: 'E', output: true, post: { x: 64, y: 0 }, busWidth: 4, busZ: 3 },
      ],
      GRID,
    );
    expect(placed).toHaveLength(1);
  });

  it('puts a bus logic input on a wide input pin and a bus wire on a wide output pin', () => {
    // The four-way branch of TestCreator.java:60-93: width > 1 turns an input
    // into one BusLogicInputElm (79-86) and an output into one wire carrying
    // the show-bus-value flag (62-69); the geometry stays post plus OUT.
    const placed = createTestHarness(
      [
        { side: 'W', output: false, post: { x: 32, y: 16 }, busWidth: 8, busZ: 0 },
        { side: 'E', output: true, post: { x: 128, y: 16 }, busWidth: 2, busZ: 0 },
      ],
      GRID,
    );
    expect(placed).toEqual([
      {
        kind: 'busLogicInput',
        x1: 32,
        y1: 16,
        x2: 32 - OUT,
        y2: 16,
        busWidth: 8,
      },
      {
        kind: 'wire',
        x1: 128,
        y1: 16,
        x2: 128 + OUT,
        y2: 16,
        flags: WIRE_SHOW_BUS_VALUE,
      },
    ]);
  });

  it('leaves width-one pins as plain logic inputs and outputs', () => {
    const placed = createTestHarness(
      [
        { side: 'W', output: false, post: { x: 32, y: 16 }, busWidth: 1 },
        { side: 'E', output: true, post: { x: 128, y: 16 } },
      ],
      GRID,
    );
    expect(placed).toEqual([
      { kind: 'logicInput', x1: 32, y1: 16, x2: 32 - OUT, y2: 16 },
      { kind: 'logicOutput', x1: 128, y1: 16, x2: 128 + OUT, y2: 16 },
    ]);
  });

  it('harnesses a 4-bit bus-mode full adder with two bus inputs and one bus wire', () => {
    // Realistic metadata: fullAdderPins collapses each bank onto its anchor
    // row in bus mode, every bit carrying busWidth 4 and its own busZ
    // (fullAdder.ts bank()), exactly what a loaded td4-style circuit holds.
    const adder: CircuitElement = {
      id: 1,
      kind: 'fullAdder',
      x1: 0,
      y1: 0,
      x2: 96,
      y2: 0,
      flags: CHIP_BIT_ORDER_BUS | FULL_ADDER_BITS,
      params: { bits: 4 },
    };
    const pins = chipPinsOf(adder)!;
    const posts = postsOf(adder);
    expect(pins.filter((p) => (p.busWidth ?? 1) > 1)).toHaveLength(12);
    const placed = createTestHarness(
      pins.map((p, i) => ({
        side: p.side,
        output: p.output ?? false,
        post: posts[i],
        busWidth: p.busWidth,
        busZ: p.busZ,
      })),
      GRID,
    );
    // One element per collapsed bank, not one per bit: A and B become bus
    // inputs, S a bus-value wire; the narrow Cin and C stay plain. Five
    // placements from fourteen pins, nine of them busZ duplicates.
    expect(placed).toEqual([
      { kind: 'busLogicInput', x1: 0, y1: 0, x2: -OUT, y2: 0, busWidth: 4 },
      { kind: 'busLogicInput', x1: 0, y1: 32, x2: -OUT, y2: 32, busWidth: 4 },
      {
        kind: 'wire',
        x1: 96,
        y1: 64,
        x2: 96 + OUT,
        y2: 64,
        flags: WIRE_SHOW_BUS_VALUE,
      },
      { kind: 'logicInput', x1: 0, y1: 64, x2: -OUT, y2: 64 },
      { kind: 'logicOutput', x1: 96, y1: 0, x2: 96 + OUT, y2: 0 },
    ]);
  });
});

describe('selectHarnessChip guard', () => {
  const chip: CircuitElement = {
    id: 1,
    kind: 'dFlipFlop',
    x1: 0,
    y1: 0,
    x2: 96,
    y2: 0,
    flags: 0,
    params: { highVoltage: 5 },
  };
  const resistor: CircuitElement = {
    id: 2,
    kind: 'resistor',
    x1: 0,
    y1: 0,
    x2: 32,
    y2: 0,
    flags: 0,
    params: { resistance: 1000 },
  };

  it('returns the chip when exactly one chip-like element is selected', () => {
    expect(selectHarnessChip([chip, resistor], [chip.id])).toBe(chip);
  });

  it('returns null when nothing is selected', () => {
    expect(selectHarnessChip([chip], [])).toBeNull();
  });

  it('returns null when more than one element is selected', () => {
    expect(selectHarnessChip([chip, resistor], [chip.id, resistor.id])).toBeNull();
  });

  it('returns null when the selected element is not a chip', () => {
    expect(selectHarnessChip([chip, resistor], [resistor.id])).toBeNull();
  });

  it('returns null when the selection names a missing element', () => {
    expect(selectHarnessChip([chip], [999])).toBeNull();
  });
});
