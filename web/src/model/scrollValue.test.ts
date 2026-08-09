import { describe, expect, it } from 'vitest';
import { e12Values } from './e12';
import {
  NOTCH_THRESHOLD,
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

  it('maps the sources onto their amplitude fields', () => {
    expect(scrollableParam('voltage')).toBe('maxVoltage');
    expect(scrollableParam('rail')).toBe('maxVoltage');
    expect(scrollableParam('current')).toBe('current');
    // varRail's maxVoltage is a plain editable ceiling, so it is scrollable
    // too; extVoltage is externally driven, so scrolling it is meaningless.
    expect(scrollableParam('varRail')).toBe('maxVoltage');
    expect(scrollableParam('extVoltage')).toBeUndefined();
  });

  it('excludes kinds upstream handles with a different popup', () => {
    expect(scrollableParam('mosfet')).toBeUndefined();
    expect(scrollableParam('transistor')).toBeUndefined();
    expect(scrollableParam('wire')).toBeUndefined();
  });
});

describe('openScrollValue', () => {
  it('captures the original value and the current index', () => {
    const s = openScrollValue('resistor', 3, 1000);
    expect(s.id).toBe(3);
    expect(s.param).toBe('resistance');
    expect(s.original).toBe(1000);
    expect(s.values[s.index]).toBe(1000);
    expect(selectionIndex(s)).toBe(s.index);
    expect(selectionValue(s)).toBe(1000);
  });

  it('keeps the E12 candidate lists byte-identical to e12Values', () => {
    const cases: Array<[string, number]> = [
      ['resistor', 1000],
      ['capacitor', 1e-5],
      ['inductor', 1e-3],
    ];
    for (const [kind, current] of cases) {
      const s = openScrollValue(kind, 1, current);
      const e12 = e12Values(kind, current);
      expect(s.values).toEqual(e12.values);
      expect(s.index).toBe(e12.index);
    }
  });
});

describe('stepScrollValue / selectionIndex', () => {
  it('moves exactly one step per notch, in every browser and deltaMode', () => {
    // Chrome sends about 100-120 px per notch (deltaMode 0); Firefox sends 3
    // lines per notch (deltaMode 1), which wheelPixels normalizes to 48 px.
    const s = openScrollValue('resistor', 3, 1000);
    const chrome = stepScrollValue(s, wheelPixels(100, 0));
    expect(selectionIndex(chrome)).toBe(s.index + 1);
    const chrome120 = stepScrollValue(s, wheelPixels(120, 0));
    expect(selectionIndex(chrome120)).toBe(s.index + 1);
    const firefox = stepScrollValue(s, wheelPixels(3, 1));
    expect(selectionIndex(firefox)).toBe(s.index + 1);
  });

  it('accumulates trackpad ticks into a step per threshold, not per event', () => {
    let s = openScrollValue('resistor', 3, 1000);
    // Twenty 4 px ticks are 80 px of travel: two notch thresholds, two steps.
    for (let i = 0; i < 20; i++) s = stepScrollValue(s, wheelPixels(4, 0));
    expect(selectionIndex(s)).toBe(s.index + 2);
  });

  it('moves back one step immediately after a direction change', () => {
    let s = openScrollValue('resistor', 3, 1000);
    s = stepScrollValue(s, 100);
    s = stepScrollValue(s, 100);
    s = stepScrollValue(s, 100);
    expect(selectionIndex(s)).toBe(s.index + 3);
    s = stepScrollValue(s, -100);
    expect(selectionIndex(s)).toBe(s.index + 2);
  });

  it('steps wheelSensitivity steps per notch', () => {
    const s = openScrollValue('resistor', 3, 1000);
    expect(selectionIndex(stepScrollValue(s, 100, 2))).toBe(s.index + 2);
    expect(selectionIndex(stepScrollValue(s, 100, 1))).toBe(s.index + 1);
  });

  it('clamps at both ends of the list', () => {
    let down = openScrollValue('resistor', 3, 1000);
    for (let i = 0; i < 100; i++) down = stepScrollValue(down, -NOTCH_THRESHOLD);
    expect(selectionIndex(down)).toBe(0);
    let up = openScrollValue('resistor', 3, 1000);
    for (let i = 0; i < 100; i++) up = stepScrollValue(up, NOTCH_THRESHOLD);
    expect(selectionIndex(up)).toBe(up.values.length - 1);
  });

  it('reverts to the original value', () => {
    const s = openScrollValue('resistor', 3, 4700);
    const stepped = stepScrollValue(s, 100);
    expect(selectionValue(stepped)).not.toBe(s.original);
    expect(s.original).toBe(4700);
  });

  it('keeps the candidate list sorted while stepping', () => {
    const s = openScrollValue('resistor', 3, 5000);
    stepScrollValue(s, 100);
    for (let i = 1; i < s.values.length; i++) {
      expect(s.values[i]).toBeGreaterThanOrEqual(s.values[i - 1]);
    }
  });
});

describe('source value ladders', () => {
  it('voltage and rail step 1 V per notch', () => {
    const v = openScrollValue('voltage', 5, 5);
    const one = stepScrollValue(v, 100);
    expect(selectionValue(one)).toBe(6);
    const two = stepScrollValue(one, 100);
    expect(selectionValue(two)).toBe(7);
    const r = openScrollValue('rail', 5, 5);
    expect(selectionValue(stepScrollValue(r, 100))).toBe(6);
  });

  it('current source steps 1 mA per notch', () => {
    const s = openScrollValue('current', 6, 0.01);
    expect(selectionValue(stepScrollValue(s, 100))).toBeCloseTo(0.011);
  });

  it('allows scrolling a source to a negative value', () => {
    const s = openScrollValue('voltage', 5, 0);
    expect(selectionValue(stepScrollValue(s, -100))).toBe(-1);
  });

  it('clamps at the ladder ends instead of wrapping', () => {
    let s = openScrollValue('voltage', 5, 5);
    for (let i = 0; i < 200; i++) s = stepScrollValue(s, 100);
    expect(selectionIndex(s)).toBe(s.values.length - 1);
    expect(selectionValue(s)).toBe(s.values[s.values.length - 1]);
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
