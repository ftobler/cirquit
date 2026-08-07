import { describe, expect, it } from 'vitest';
import { exportGeometry } from './export';

describe('exportGeometry', () => {
  it('matches the upstream canvas arithmetic', () => {
    // ImageExporter.java:145-146, 205-206: width = 176*2 + 140, height =
    // 96*2 + 100, scale = min(492/316, 292/196) = 1.4898.
    const g = exportGeometry({ minX: 0, minY: 0, width: 176, height: 96 });
    expect(g.width).toBe(492);
    expect(g.height).toBe(292);
    expect(g.scale).toBeCloseTo(1.4898, 4);
  });

  it('returns finite numbers for a null bounds (empty circuit)', () => {
    const g = exportGeometry(null);
    expect([g.width, g.height, g.scale].every(Number.isFinite)).toBe(true);
    expect(g.scale).toBeGreaterThan(0);
  });
});
