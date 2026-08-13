import { describe, expect, it, vi } from 'vitest';
import { drawGrid } from './grid';
import { GRID_SIZE } from '../model/types';

describe('drawGrid', () => {
  // The 1x1 dot is anchored half a pixel up-left of each grid intersection so
  // its centre sits on the wire centreline. With the viewport exactly covering
  // the first four intersections per axis, the dots land at (-0.5, -0.5),
  // (GRID_SIZE-0.5, -0.5), ... and so on through the grid.
  it('anchors each dot half a pixel up-left of the grid intersection', () => {
    const fillRect = vi.fn();
    const ctx = { fillStyle: '', fillRect } as unknown as CanvasRenderingContext2D;
    drawGrid(ctx, 0, 0, GRID_SIZE * 4, GRID_SIZE * 4, '#000');
    const origins = fillRect.mock.calls.map((c) => [c[0], c[1]]);
    expect(origins).toContainEqual([-0.5, -0.5]);
    expect(origins).toContainEqual([GRID_SIZE - 0.5, GRID_SIZE - 0.5]);
    expect(origins).toContainEqual([GRID_SIZE * 3 - 0.5, GRID_SIZE * 3 - 0.5]);
    expect(origins).toHaveLength(16);
    for (const [x, y] of origins) {
      expect(x).toBeCloseTo(Math.round(x + 0.5) - 0.5);
      expect(y).toBeCloseTo(Math.round(y + 0.5) - 0.5);
    }
  });
});
