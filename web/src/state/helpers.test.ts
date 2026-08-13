import { describe, expect, it } from 'vitest';
import { sliderFromSteps, stepsFromSlider } from './helpers';

describe('stepsFromSlider', () => {
  it('lands exactly on the range endpoints', () => {
    expect(stepsFromSlider(1, 1, 1000)).toBe(1);
    expect(stepsFromSlider(1000, 1, 1000)).toBe(1000);
  });

  it('is monotonic non-decreasing across the whole slider', () => {
    let prev = 0;
    for (let bar = 1; bar <= 1000; bar++) {
      const n = stepsFromSlider(bar, 1, 1000);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });

  it('returns integers', () => {
    for (let bar = 1; bar <= 1000; bar++) {
      expect(Number.isInteger(stepsFromSlider(bar, 1, 1000))).toBe(true);
    }
  });

  it('spreads the small step counts across the low end of the slider', () => {
    // Linearly, bar=100 would be 100 steps; on the log scale it is ~2, so the
    // 1..1000 range does not cram into the first per cent of the slider.
    expect(stepsFromSlider(100, 1, 1000)).toBeLessThan(10);
    // Halfway (bar=500) is sqrt(1000) ~ 31.6 on a log scale.
    expect(stepsFromSlider(500, 1, 1000)).toBe(32);
  });

  it('clamps positions outside the range to the endpoints', () => {
    expect(stepsFromSlider(0, 1, 1000)).toBe(1);
    expect(stepsFromSlider(-50, 1, 1000)).toBe(1);
    expect(stepsFromSlider(5000, 1, 1000)).toBe(1000);
  });
});

describe('sliderFromSteps', () => {
  it('returns the endpoints for the endpoints', () => {
    expect(sliderFromSteps(1, 1, 1000)).toBe(1);
    expect(sliderFromSteps(1000, 1, 1000)).toBe(1000);
  });

  it('clamps a step count outside the range to the endpoints', () => {
    expect(sliderFromSteps(0, 1, 1000)).toBe(1);
    expect(sliderFromSteps(2000, 1, 1000)).toBe(1000);
  });

  it('round-trips a stored step count to its slider position and back', () => {
    for (const n of [1, 2, 10, 32, 100, 160, 320, 500, 999, 1000]) {
      const bar = sliderFromSteps(n, 1, 1000);
      expect(bar).toBeGreaterThanOrEqual(1);
      expect(bar).toBeLessThanOrEqual(1000);
      expect(stepsFromSlider(bar, 1, 1000)).toBe(n);
    }
  });

  it('restores the default 160 into the upper part of the slider', () => {
    const bar = sliderFromSteps(160, 1, 1000);
    expect(bar).toBeGreaterThan(700);
    expect(bar).toBeLessThan(800);
  });
});
