import { describe, expect, it } from 'vitest';
import {
  WHEEL_STEP_DIVISOR,
  ZOOM_ONLY_WINDOW_MS,
  isZoomOnly,
  openScrollValue,
  scrollableParam,
  selectionIndex,
  selectionValue,
  stepScrollValue,
  wheelPixels,
} from './scrollValue';

describe('scrollableParam', () => {
  it('maps the three physical fields', () => {
    expect(scrollableParam('resistor')).toBe('resistance');
    expect(scrollableParam('capacitor')).toBe('capacitance');
    expect(scrollableParam('inductor')).toBe('inductance');
  });

  it('excludes kinds upstream handles with a different popup', () => {
    expect(scrollableParam('mosfet')).toBeUndefined();
    expect(scrollableParam('transistor')).toBeUndefined();
    expect(scrollableParam('wire')).toBeUndefined();
  });
});

describe('openScrollValue', () => {
  it('captures the original value and the current index', () => {
    const s = openScrollValue('resistor', 3, 'resistance', 1000);
    expect(s.id).toBe(3);
    expect(s.param).toBe('resistance');
    expect(s.original).toBe(1000);
    expect(s.values[s.index]).toBe(1000);
    expect(selectionIndex(s)).toBe(s.index);
    expect(selectionValue(s)).toBe(1000);
  });
});

describe('stepScrollValue / selectionIndex', () => {
  it('moves the selection by wheel distance over the divisor', () => {
    const s = openScrollValue('resistor', 3, 'resistance', 1000);
    const stepped = stepScrollValue(s, WHEEL_STEP_DIVISOR);
    expect(selectionIndex(stepped)).toBe(s.index + 1);
    expect(selectionValue(stepped)).toBe(s.values[s.index + 1]);
  });

  it('accumulates wheel travel across ticks', () => {
    const s = openScrollValue('resistor', 3, 'resistance', 1000);
    const stepped = stepScrollValue(stepScrollValue(s, 2 * WHEEL_STEP_DIVISOR), WHEEL_STEP_DIVISOR);
    expect(selectionIndex(stepped)).toBe(s.index + 3);
  });

  it('clamps at both ends of the list', () => {
    const s = openScrollValue('resistor', 3, 'resistance', 1000);
    const down = stepScrollValue(s, -1e9);
    expect(selectionIndex(down)).toBe(0);
    const up = stepScrollValue(s, 1e9);
    expect(selectionIndex(up)).toBe(s.values.length - 1);
  });

  it('reverts to the original value', () => {
    const s = openScrollValue('resistor', 3, 'resistance', 4700);
    const stepped = stepScrollValue(s, WHEEL_STEP_DIVISOR);
    expect(selectionValue(stepped)).not.toBe(s.original);
    expect(s.original).toBe(4700);
  });

  it('keeps the candidate list sorted while stepping', () => {
    const s = openScrollValue('resistor', 3, 'resistance', 5000);
    stepScrollValue(s, WHEEL_STEP_DIVISOR);
    for (let i = 1; i < s.values.length; i++) {
      expect(s.values[i]).toBeGreaterThanOrEqual(s.values[i - 1]);
    }
  });
});

describe('wheelPixels', () => {
  it('passes pixel mode through and scales line and page modes', () => {
    expect(wheelPixels(100, 0)).toBe(100);
    expect(wheelPixels(3, 1)).toBe(48);
    expect(wheelPixels(1, 2)).toBe(100);
  });
});

describe('isZoomOnly', () => {
  it('allows the value stepper when nothing has zoomed', () => {
    expect(isZoomOnly(null, 1000)).toBe(false);
  });

  it('holds the wheel zoom-only within the window after a zoom', () => {
    expect(isZoomOnly(0, ZOOM_ONLY_WINDOW_MS - 1)).toBe(true);
  });

  it('releases the guard once the window has elapsed', () => {
    expect(isZoomOnly(0, ZOOM_ONLY_WINDOW_MS)).toBe(false);
    expect(isZoomOnly(0, ZOOM_ONLY_WINDOW_MS + 1)).toBe(false);
  });
});
