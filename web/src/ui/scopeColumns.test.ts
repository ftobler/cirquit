import { describe, expect, it } from 'vitest';
import { MIN_COLUMN_PX, columnWeights, dragSplitter } from './scopeColumns';

describe('scope column shares', () => {
  it('keeps stored weights only while the column count matches', () => {
    expect(columnWeights([2, 1], 2)).toEqual([2, 1]);
    expect(columnWeights([2, 1], 3)).toEqual([1, 1, 1]);
    expect(columnWeights(null, 2)).toEqual([1, 1]);
    expect(columnWeights([0, 1], 2)).toEqual([1, 1]);
  });

  it('moves width between the two neighbours only', () => {
    // Three equal columns in 900 px: 300 each. Drag the first splitter 100 px.
    const w = dragSplitter([1, 1, 1], 0, 100, 900);
    const px = w.map((x) => (x / w.reduce((a, b) => a + b, 0)) * 900);
    expect(px[0]).toBeCloseTo(400);
    expect(px[1]).toBeCloseTo(200);
    expect(px[2]).toBeCloseTo(300);
  });

  it('stops at the minimum column width', () => {
    const w = dragSplitter([1, 1], 0, 10000, 600);
    const px = w.map((x) => (x / (w[0] + w[1])) * 600);
    expect(px[1]).toBeCloseTo(MIN_COLUMN_PX);
    const back = dragSplitter([1, 1], 0, -10000, 600);
    expect((back[0] / (back[0] + back[1])) * 600).toBeCloseTo(MIN_COLUMN_PX);
  });

  it('splits a pair too narrow for two minimums in half at most', () => {
    const w = dragSplitter([1, 1], 0, 500, 100);
    expect(w[0]).toBeCloseTo(w[1]);
  });

  it('ignores a splitter that does not exist or an unmeasured strip', () => {
    expect(dragSplitter([1, 1], 1, 50, 600)).toEqual([1, 1]);
    expect(dragSplitter([1, 1], 0, 50, 0)).toEqual([1, 1]);
  });
});
