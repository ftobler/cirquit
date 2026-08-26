import { describe, expect, it } from 'vitest';
import { exportGeometry, drawAllElements } from './export';
import { SvgRecorder } from './svg';
import { makeTheme } from './draw';
import { DEFAULT_SETTINGS, type CircuitElement } from '../model/types';

const wire = (
  id: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): CircuitElement => ({ id, kind: 'wire', x1, y1, x2, y2, flags: 0, params: {} });

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

describe('drawAllElements junction dots', () => {
  const theme = makeTheme(false, DEFAULT_SETTINGS);

  it('strokes junction dots like the live canvas, after the element loop', () => {
    // Upstream's exporter strokes postDrawList after the element loop
    // (ImageExporter.java:220-223), each dot a 7 px filled circle
    // (CircuitElm.java:851-854). The T junction at (64,0) counts three posts
    // and the five bare wire ends one each, so six dots follow the traces.
    const elements = [
      wire(1, 0, 0, 128, 0),
      wire(2, 64, 0, 64, 64),
      wire(3, 192, 0, 256, 0),
    ];
    const rec = new SvgRecorder();
    drawAllElements(rec, theme, elements, DEFAULT_SETTINGS, null, 1);
    const svg = rec.toString(400, 200);
    // Each 7 px dot is a full circle: two A segments of radius 3.5.
    expect(svg.match(/A3\.5 3\.5 0 1 1 /g)).toHaveLength(12);
    expect(svg).toContain(`fill="${theme.wire}"`);
    // The dot pass comes after every element stroke, like upstream's.
    expect(svg.indexOf('A3.5 3.5')).toBeGreaterThan(svg.indexOf('<path d="M192 0L256 0"'));
  });

  it('a plain pass-through connection yields no dots', () => {
    // A closed triangle puts exactly two posts on every coordinate, the quiet
    // case, so the export must stay clean.
    const elements = [
      wire(1, 0, 0, 128, 0),
      wire(2, 128, 0, 64, 64),
      wire(3, 64, 64, 0, 0),
    ];
    const rec = new SvgRecorder();
    drawAllElements(rec, theme, elements, DEFAULT_SETTINGS, null, 1);
    expect(rec.toString(400, 200)).not.toContain('A3.5 3.5');
  });

  it('an empty circuit iterates nothing', () => {
    const rec = new SvgRecorder();
    drawAllElements(rec, theme, [], DEFAULT_SETTINGS, null, 1);
    expect(rec.toString(10, 10)).not.toContain('A3.5 3.5');
  });
});
