import { describe, expect, it } from 'vitest';
import { buildCsv } from './csv';
import { average, dutyCycle, estimateFrequency, iterateCycles, maxValue, minValue, rms } from './measure';

/** A 50%-duty 1 kHz square as a column stream: speed 4, timeStep 5e-6 makes
 *  each column 20 us, so a 50-column period (25 low + 25 high) is 1 ms. */
function squareStream(count = 200): { min: number[]; max: number[] } {
  const min: number[] = [];
  const max: number[] = [];
  for (let i = 0; i < count; i++) {
    const high = i % 50 >= 25;
    min.push(high ? 1.2 : 0);
    max.push(high ? 1.2 : 0);
  }
  return { min, max };
}

describe('measurement overlays', () => {
  it('estimateFrequency on a 1 kHz square returns 1000 +- 1%', () => {
    const { min, max } = squareStream();
    const freq = estimateFrequency(min, max, min.length, 4, 5e-6);
    expect(freq).toBeGreaterThan(990);
    expect(freq).toBeLessThan(1010);
  });

  it('rms, average and dutyCycle match the analytic values', () => {
    const { min, max } = squareStream();
    // The cycle walk runs from the first rising edge for one period, so the
    // window is exactly 25 high + 25 low columns.
    const mid = (maxValue(min, max, min.length) + minValue(min, max, min.length)) / 2;
    expect(mid).toBe(0.6);
    // The cycle window is exactly 25 high + 25 low columns: 25*1.2^2 for the
    // rms square, 25*1.2 for the average.
    expect(rms(min, max, min.length, mid)).toBeCloseTo(Math.sqrt(36 / 50), 9);
    expect(average(min, max, min.length, mid)).toBeCloseTo(30 / 50, 9);
    expect(dutyCycle(min, max, min.length, mid)).toBeCloseTo(50, 9);
  });

  it('max, min and P-P are plain scans', () => {
    const { min, max } = squareStream();
    expect(maxValue(min, max, min.length)).toBe(1.2);
    expect(minValue(min, max, min.length)).toBe(0);
    expect(maxValue(min, max, min.length) - minValue(min, max, min.length)).toBe(1.2);
  });

  it('a stream whose period varies trips the stability guard and returns 0', () => {
    const min: number[] = [];
    const max: number[] = [];
    // Irregular run lengths: the rising-edge intervals vary, so periodstd
    // exceeds 2 and frequency is rejected.
    const runs = [20, 30, 20, 40, 20, 30, 20, 40, 20, 30, 20, 40, 20, 30];
    let high = false;
    for (const len of runs) {
      for (let k = 0; k < len; k++) {
        min.push(high ? 1.2 : 0);
        max.push(high ? 1.2 : 0);
      }
      high = !high;
    }
    expect(estimateFrequency(min, max, min.length, 4, 5e-6)).toBe(0);
  });

  it('a flat DC line has no cycle, so rms, average and dutyCycle return null', () => {
    // Upstream guards every readout on span > 0 (ScopeOverlays.java:107-108,
    // 120-121, 133-134) and draws nothing for a trace that never crosses mid.
    const min = new Array(100).fill(1.2);
    const max = new Array(100).fill(1.2);
    expect(rms(min, max, min.length, 0.6)).toBeNull();
    expect(average(min, max, min.length, 0.6)).toBeNull();
    expect(dutyCycle(min, max, min.length, 0.6)).toBeNull();
  });

  it('an all-zero trace is unmeasurable too', () => {
    const zeros = new Array(50).fill(0);
    expect(rms(zeros, zeros, zeros.length, 0)).toBeNull();
    expect(average(zeros, zeros, zeros.length, 0)).toBeNull();
    expect(dutyCycle(zeros, zeros, zeros.length, 0)).toBeNull();
  });

  it('iterateCycles spans the first to last rising edge', () => {
    const { min, max } = squareStream(150);
    let cycles = 0;
    let samples = 0;
    const span = iterateCycles(
      min,
      max,
      min.length,
      0.6,
      () => {},
      () => {
        samples++;
      },
      () => {
        cycles++;
      },
    );
    // Rising edges at i=75 and i=125, one full period apart.
    expect(span).toBe(50);
    expect(cycles).toBe(1);
    expect(samples).toBeGreaterThan(0);
  });
});

describe('csv export', () => {
  it('buildCsv writes width data rows after the header, skipping t < 0', () => {
    const { min, max } = squareStream(20);
    // ts = 2 * 5e-6 = 10 us; simT = 50 us gives t < 0 for the first 5 pixels.
    const csv = buildCsv([{ name: 'resistor', unit: 'V', min, max }], 2, 5e-6, 50e-6, 10);
    const lines = csv.trim().split('\n');
    // Header plus 5 non-negative rows.
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe('time,"resistor V min","resistor V max"');
    // First row is t = 0 (the first non-negative pixel).
    expect(lines[1].split(',')[0]).toBe('0');
  });

  it('a multi-plot export interleaves each plot pair in order', () => {
    const { min, max } = squareStream(20);
    const v = { name: 'resistor', unit: 'V', min, max };
    const i2 = { name: 'resistor', unit: 'A', min: max, max: min };
    const csv = buildCsv([v, i2], 2, 5e-6, 1, 10);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('time,"resistor V min","resistor V max","resistor A min","resistor A max"');
    // Row 1: t, then v.min[1], v.max[1], i2.min[1], i2.max[1].
    expect(lines[1].split(',')).toHaveLength(5);
    expect(lines[1].split(',')[1]).toBe(String(min[1]));
    expect(lines[1].split(',')[4]).toBe(String(max[1]));
  });
});
