import { describe, expect, it } from 'vitest';
import {
  DOT_SPACING,
  dotPhaseAfter,
  dotPhaseStep,
  TOO_FAST,
  wrapPhase,
} from './dots';

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
    // A tiny current so both speeds stay under the too-fast threshold (at
    // 1e-3 the speed-75 step alone is ~39 circuit units).
    const current = 1e-9;
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
    // Small enough that even speed 100 stays below the too-fast threshold.
    const steps = [0, 25, 50, 75, 100].map((s) => dotPhaseStep(1e-9, s, dt));
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]).toBeGreaterThan(steps[i - 1]);
    }
  });

  it('is linear in current', () => {
    // The law is current * currentMult (UIManager.java:611-615), so doubling
    // the current doubles the step exactly, with no log term.
    expect(dotPhaseStep(2e-3, 50, dt)).toBeCloseTo(2 * dotPhaseStep(1e-3, 50, dt), 12);
  });

  it('computes the exact step at the default speed', () => {
    // 1e-3 * 1.7 * (1000/60) * exp(50/3.5 - 14.2). Pinned so a change to the
    // constants is noticed.
    expect(dotPhaseStep(1e-3, 50, dt)).toBeCloseTo(0.030869, 6);
  });

  it('scales by exp(1/3.5) per slider step', () => {
    // Currents below the too-fast threshold at speed 51 (where the ratio is
    // well-defined), spanning the practical range.
    for (const current of [1e-9, 1e-6, 1e-3]) {
      expect(dotPhaseStep(current, 51, dt) / dotPhaseStep(current, 50, dt)).toBeCloseTo(
        Math.exp(1 / 3.5),
        12,
      );
    }
  });

  it('is linear in the wall-clock interval', () => {
    // currentMult is 1.7 * inc * c with `inc` the wall-clock milliseconds, so
    // halving dt halves the step.
    expect(dotPhaseStep(1e-3, 50, dt) / dotPhaseStep(1e-3, 50, dt / 2)).toBeCloseTo(2, 12);
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

  it('flags phases too fast to follow', () => {
    // At speed 50 and dt = 1 (1000 ms) currentMult is 1.7 * 1000 *
    // exp(50/3.5 - 14.2) = 1852.1, so |current| > 6 / 1852.1 = 3.24e-3 trips
    // the threshold. The boundary values are kept off the exact crossover so
    // float rounding of current * currentMult cannot flip the strict `>`.
    expect(dotPhaseStep(3.2e-3, 50, 1)).not.toBe(TOO_FAST);
    expect(dotPhaseStep(3.3e-3, 50, 1)).toBe(TOO_FAST);
    expect(dotPhaseStep(-3.3e-3, 50, 1)).toBe(TOO_FAST);
  });

  it('flips the sign in electron-flow mode after the magnitude check', () => {
    const current = 1e-3;
    expect(dotPhaseStep(current, 50, dt, false)).toBeCloseTo(-dotPhaseStep(current, 50, dt, true), 12);
    // A too-fast current is still too fast in electron-flow mode, not negated
    // out of the threshold.
    expect(dotPhaseStep(3.3e-3, 50, 1, false)).toBe(TOO_FAST);
    // Non-finite and zero currents still return 0 either way.
    for (const current of [0, NaN, Infinity, -Infinity]) {
      expect(dotPhaseStep(current, 50, dt, false)).toBe(0);
    }
  });
});

describe('wrapPhase', () => {
  it('always lands in [0, DOT_SPACING)', () => {
    for (const v of [-1e6, -123.45, -0.5, 0, 0.001, 7.999, 8, 15.999, 16, 123.45, 1e6]) {
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

describe('dotPhaseAfter', () => {
  it('keeps a run going after a segment of the same path', () => {
    expect(dotPhaseAfter(2, 16)).toBe(2);  // a full spacing returns to the same phase
    expect(dotPhaseAfter(2, 17)).toBe(3);
    expect(dotPhaseAfter(2, -1)).toBe(1);
    expect(dotPhaseAfter(0, 48)).toBe(0);
    for (const p of [dotPhaseAfter(2, 16), dotPhaseAfter(2, 17), dotPhaseAfter(2, -1), dotPhaseAfter(0, 48)]) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(DOT_SPACING);
    }
  });

  it('passes a too-fast phase through so the chain keeps drawing the stream', () => {
    // Wrapping TOO_FAST would make NaN (Infinity % 16), blanking every
    // segment after the first in a path. Upstream's addCurCount returns the
    // sentinel unchanged (CircuitElm.java:514-518).
    const p = dotPhaseAfter(TOO_FAST, 16);
    expect(p).toBe(TOO_FAST);
    expect(Number.isNaN(p)).toBe(false);
  });
});

describe('long-run stability', () => {
  it('keeps the phase bounded and precise over 100k frames', () => {
    // A high but legal rate: at speed 100 and dt = 1 the step is ~2.96,
    // under the too-fast threshold and under one spacing.
    let phase = 0;
    for (let f = 0; f < 100_000; f++) {
      phase = wrapPhase(phase + dotPhaseStep(1e-9, 100, 1));
    }
    expect(Number.isFinite(phase)).toBe(true);
    expect(phase).toBeGreaterThanOrEqual(0);
    expect(phase).toBeLessThan(DOT_SPACING);

    // One more frame still advances by the frame's step, or one full spacing
    // on either side of it when the wrap is crossed.
    const step = dotPhaseStep(1e-9, 100, 1);
    const before = phase;
    const delta = wrapPhase(before + step) - before;
    expect(
      Math.abs(delta - step) < 1e-9 || Math.abs(Math.abs(delta - step) - DOT_SPACING) < 1e-9,
    ).toBe(true);
  });
});
