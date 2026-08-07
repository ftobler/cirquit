import { describe, expect, it } from 'vitest';
import {
  scopeColumnCount,
  timeToX,
  visibleColumnRange,
  windowSeconds,
  xToTime,
} from './geometry';

describe('scope geometry', () => {
  it('scopeColumnCount is a power of two >= the width, clamped', () => {
    expect(scopeColumnCount(300)).toBe(512);
    expect(scopeColumnCount(500)).toBe(512);
    expect(scopeColumnCount(600)).toBe(1024);
    expect(scopeColumnCount(0)).toBe(16);
    expect(scopeColumnCount(-5)).toBe(16);
    expect(scopeColumnCount(100000)).toBe(8192);
  });

  it('windowSeconds spans the buffer, and the display window is width*speed*timeStep', () => {
    // The buffer holds scopeColumnCount(500) = 512 columns.
    expect(windowSeconds(512, 64, 5e-6)).toBeCloseTo(0.16384, 12);
    // The visible window is the pixel width, one column per pixel.
    expect(windowSeconds(500, 64, 5e-6)).toBeCloseTo(64 * 5e-6 * 500, 12);
    expect(64 * 5e-6 * 500).toBeCloseTo(0.16, 12);
  });

  it('xToTime/timeToX round-trip against engine.time', () => {
    const simT = 0.123456;
    const widthPx = 500;
    const speed = 64;
    const ts = 5e-6;
    // Right edge maps to simT, left edge to simT - width*speed*ts.
    expect(xToTime(widthPx, simT, widthPx, speed, ts)).toBeCloseTo(simT, 12);
    expect(xToTime(0, simT, widthPx, speed, ts)).toBeCloseTo(
      simT - widthPx * speed * ts,
      12,
    );
    // Round trip through both directions.
    for (const x of [0, 100, 250, 499]) {
      const t = xToTime(x, simT, widthPx, speed, ts);
      expect(timeToX(t, simT, widthPx, speed, ts)).toBeCloseTo(x, 9);
    }
  });

  it('a fired trigger anchors time at the window centre, not the right edge', () => {
    const anchor = { time: 1.0 };
    const simT = 9;  // irrelevant once anchored
    const widthPx = 500;
    const speed = 64;
    const ts = 5e-6;
    // The trigger time sits at the centre pixel; the right edge is
    // trigger.time + speed*timeStep*w/2 and the left trigger.time - that
    // (Scope.java:825, 910-915).
    expect(xToTime(widthPx / 2, simT, widthPx, speed, ts, anchor)).toBeCloseTo(1.0, 12);
    expect(xToTime(widthPx, simT, widthPx, speed, ts, anchor)).toBeCloseTo(
      1.0 + (speed * ts * widthPx) / 2,
      12,
    );
    expect(xToTime(0, simT, widthPx, speed, ts, anchor)).toBeCloseTo(
      1.0 - (speed * ts * widthPx) / 2,
      12,
    );
    // Round trip through both directions under the anchor.
    for (const x of [0, 100, 250, 499]) {
      const t = xToTime(x, simT, widthPx, speed, ts, anchor);
      expect(timeToX(t, simT, widthPx, speed, ts, anchor)).toBeCloseTo(x, 9);
    }
  });

  it('maps columns to pixels: left-aligned until the ring wraps, then the most recent width one per pixel', () => {
    const widthPx = 4;
    // Not wrapped: fewer columns than pixels draw left-aligned.
    expect(visibleColumnRange(3, widthPx)).toEqual({ start: 0, count: 3 });
    // Wrapped: the most recent widthPx columns fill the canvas.
    expect(visibleColumnRange(8, widthPx)).toEqual({ start: 4, count: 4 });
    expect(visibleColumnRange(6, widthPx)).toEqual({ start: 2, count: 4 });
    // Empty window draws nothing.
    expect(visibleColumnRange(0, widthPx)).toEqual({ start: 0, count: 0 });
  });
});
