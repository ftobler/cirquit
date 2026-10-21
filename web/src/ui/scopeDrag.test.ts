import { describe, expect, it } from 'vitest';
import { dropDecisionAt, type ColumnBox } from './scopeDrag';

const strip = { left: 0, right: 1160, top: 600, bottom: 750 };
// Two 500 px columns, then the 160 px info area.
const cols: ColumnBox[] = [
  { ids: [1, 2], left: 0, right: 500 },
  { ids: [3], left: 500, right: 1000 },
];
const y = 680;

describe('scope drop zones', () => {
  it('floats a drop outside the strip, or with no strip at all', () => {
    expect(dropDecisionAt(300, 200, 3, strip, cols)).toEqual({ kind: 'float' });
    expect(dropDecisionAt(300, y, 3, null, [])).toEqual({ kind: 'float' });
  });

  it('stacks onto the middle of a column', () => {
    expect(dropDecisionAt(250, y, 3, strip, cols)).toMatchObject({
      kind: 'dock',
      target: { kind: 'stack', withId: 1 },
      marker: { type: 'column', index: 0 },
    });
  });

  it('names its own stack by another scope, so it moves to the bottom', () => {
    expect(dropDecisionAt(250, y, 1, strip, cols)).toMatchObject({
      target: { kind: 'stack', withId: 2 },
    });
  });

  it('opens a new column at either edge of a column', () => {
    expect(dropDecisionAt(10, y, 3, strip, cols)).toMatchObject({
      target: { kind: 'column', beforeId: 1 },
      marker: { type: 'gap', x: 0 },
    });
    expect(dropDecisionAt(490, y, 3, strip, cols)).toMatchObject({
      target: { kind: 'column', beforeId: 3 },
      marker: { type: 'gap', x: 500 },
    });
    expect(dropDecisionAt(990, y, 1, strip, cols)).toMatchObject({
      target: { kind: 'column', beforeId: null },
    });
  });

  it('names a column by another scope when the dragged one heads it', () => {
    // Dragging 1 out of its own stack [1, 2] to the stack's left edge.
    expect(dropDecisionAt(10, y, 1, strip, cols)).toMatchObject({
      target: { kind: 'column', beforeId: 2 },
    });
    // And to the right edge of a column whose right neighbour it heads.
    const headed: ColumnBox[] = [
      { ids: [5], left: 0, right: 500 },
      { ids: [1, 2], left: 500, right: 1000 },
    ];
    expect(dropDecisionAt(490, y, 1, strip, headed)).toMatchObject({
      target: { kind: 'column', beforeId: 2 },
    });
  });

  it('opens a last column over the info area', () => {
    expect(dropDecisionAt(1100, y, 1, strip, cols)).toMatchObject({
      target: { kind: 'column', beforeId: null },
      marker: { type: 'gap', x: 1000 },
    });
  });

  it('keeps a usable edge on a narrow column', () => {
    const narrow: ColumnBox[] = [{ ids: [1], left: 0, right: 60 }];
    expect(dropDecisionAt(12, y, 2, strip, narrow)).toMatchObject({ target: { kind: 'column' } });
    expect(dropDecisionAt(30, y, 2, strip, narrow)).toMatchObject({ target: { kind: 'stack' } });
  });

  describe('wrap layouts', () => {
    // Two rows of two columns, each 500 px wide and 75 px tall.
    const wrapped: ColumnBox[] = [
      { ids: [1], left: 0, right: 500, top: 600, bottom: 675 },
      { ids: [2], left: 500, right: 1000, top: 600, bottom: 675 },
      { ids: [3], left: 0, right: 500, top: 675, bottom: 750 },
      { ids: [4], left: 500, right: 1000, top: 675, bottom: 750 },
    ];

    it('stacks onto the column under the pointer, whatever the row', () => {
      expect(dropDecisionAt(250, 700, 2, strip, wrapped, 'wrap')).toMatchObject({
        kind: 'dock',
        target: { kind: 'stack', withId: 3 },
        marker: { type: 'column', index: 2 },
      });
      expect(dropDecisionAt(750, 620, 3, strip, wrapped, 'wrap')).toMatchObject({
        target: { kind: 'stack', withId: 2 },
      });
    });

    it('falls back to the nearest column past the last one', () => {
      // x past every column but still inside the strip (the info area).
      expect(dropDecisionAt(1100, 680, 1, strip, wrapped, 'wrap')).toMatchObject({
        target: { kind: 'stack', withId: 2 },
      });
    });

    it('still floats outside the strip', () => {
      expect(dropDecisionAt(300, 200, 1, strip, wrapped, 'wrap')).toEqual({ kind: 'float' });
    });
  });
});
