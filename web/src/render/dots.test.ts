import { describe, expect, it } from 'vitest';
import { DOT_SPACING, dotPhaseStep, TOO_FAST, wrapPhase } from './dots';

const dt = 1 / 60;

describe('dotPhaseStep', () => {
  it('accumulates phase rather than multiplying it by elapsed time', () => {
    const current = 1e-3;
    const step = dotPhaseStep(current, 50, dt);
    let phase = 0;
    for (let f = 0; f < 10; f++) phase += dotPhaseStep(current, 50, dt);
    expect(phase).toBeCloseTo(10 * step, 12);
  });

  it('changes speed midway without a phase jump', () => {
    const current = 1e-3;
    let phase = 0;
    for (let f = 0; f < 5; f++) phase += dotPhaseStep(current, 50, dt);
    const first = phase;
    for (let f = 0; f < 5; f++) phase += dotPhaseStep(current, 75, dt);
    // The total is the sum of the two constant-speed segments, not the rate at
    // the new speed scaled by all ten frames of elapsed time. Under the old
    // `t * rate` code the second segment was t * rate75, hence the check.
    expect(phase).toBeCloseTo(first + 5 * dotPhaseStep(current, 75, dt), 12);
    expect(phase).not.toBeCloseTo(10 * dt * (dotPhaseStep(current, 75, dt) / dt), 6);
  });

  it('is strictly increasing in currentSpeed', () => {
    const steps = [0, 25, 50, 75, 100].map((s) => dotPhaseStep(1e-3, s, dt));
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]).toBeGreaterThan(steps[i - 1]);
    }
  });

  it('scales by 1.08 per slider step', () => {
    for (const current of [1e-6, 1e-3, 1]) {
      expect(dotPhaseStep(current, 51, dt) / dotPhaseStep(current, 50, dt)).toBeCloseTo(1.08, 12);
    }
  });

  it('reverses when the current reverses', () => {
    expect(dotPhaseStep(-1e-3, 50, dt)).toBeCloseTo(-dotPhaseStep(1e-3, 50, dt), 12);
  });

  it('returns 0 for zero and non-finite currents', () => {
    for (const current of [0, NaN, Infinity, -Infinity]) {
      expect(dotPhaseStep(current, 50, dt)).toBe(0);
    }
  });

  it('returns 0 for a non-finite currentSpeed', () => {
    for (const speed of [NaN, Infinity, -Infinity]) {
      expect(dotPhaseStep(1e-3, speed, dt)).toBe(0);
    }
  });

  it('stays finite after a diverging solve', () => {
    let phase = 0;
    for (let f = 0; f < 100; f++) {
      phase += dotPhaseStep(f === 50 ? NaN : 1e-3, 50, dt);
    }
    expect(Number.isFinite(phase)).toBe(true);
  });

  it('flags phases that would alias backwards', () => {
    // At speed 50 the rate is 8 * log1p(current * 1e4); with dt = 1 the step
    // exceeds DOT_SPACING / 2 just above current = (e^0.5 - 1) / 1e4.
    expect(dotPhaseStep(1e-4, 50, 1)).toBe(TOO_FAST);
    expect(dotPhaseStep(1e-6, 50, 1)).not.toBe(TOO_FAST);
  });
});

describe('wrapPhase', () => {
  it('always lands in [0, DOT_SPACING)', () => {
    for (const v of [-1e6, -123.45, -0.5, 0, 0.001, 7.999, 8, 123.45, 1e6]) {
      const w = wrapPhase(v);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThan(DOT_SPACING);
    }
  });

  it('maps negatives forward so reversed current animates smoothly', () => {
    expect(wrapPhase(-0.5)).toBeCloseTo(DOT_SPACING - 0.5, 12);
    expect(wrapPhase(-0.1)).toBeCloseTo(DOT_SPACING - 0.1, 12);
    expect(wrapPhase(0)).toBe(0);
    expect(wrapPhase(DOT_SPACING)).toBe(0);
  });
});

describe('long-run stability', () => {
  it('keeps the phase bounded and precise over 100k frames', () => {
    // A high but legal rate: just under the aliasing threshold.
    let phase = 0;
    for (let f = 0; f < 100_000; f++) {
      phase = wrapPhase(phase + dotPhaseStep(1e-6, 100, 1));
    }
    expect(Number.isFinite(phase)).toBe(true);
    expect(phase).toBeGreaterThanOrEqual(0);
    expect(phase).toBeLessThan(DOT_SPACING);

    // One more frame still advances by the frame's step, or one full spacing
    // on either side of it when the wrap is crossed.
    const step = dotPhaseStep(1e-6, 100, 1);
    const before = phase;
    const delta = wrapPhase(before + step) - before;
    expect(
      Math.abs(delta - step) < 1e-9 || Math.abs(Math.abs(delta - step) - DOT_SPACING) < 1e-9,
    ).toBe(true);
  });
});
