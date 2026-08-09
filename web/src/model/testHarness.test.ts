import { describe, expect, it } from 'vitest';
import { CHIP_FLIP_X, CHIP_FLIP_XY, CHIP_FLIP_Y } from './registry/elements/dFlipFlop';
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
