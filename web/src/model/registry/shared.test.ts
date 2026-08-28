import { describe, expect, it } from 'vitest';
import { meterCaption } from './shared';
import { formatValueShort } from '../../render/draw';

// The per-meter-mode value caption maps the engine's `meter` integer to the
// on-schematic unit suffix. Every case arm is reachable from a loaded file
// (probe, voltmeter and test point share this switch), and the mapping is the
// only thing that decides what unit a meter draws, so it is pinned here rather
// than left to a red-less mislabel. The probe/voltmeter's `Scale` field is
// deliberately ignored (the caption auto-scales), which is why there is no
// Scale argument to test, only the three the helper takes.
describe('meterCaption', () => {
  // Each mode the engine emits maps to exactly one unit suffix through
  // formatValueShort, so the caption must equal a direct formatValueShort call.
  const cases: Array<[mode: number, unit: string]> = [
    [0, 'V'],
    [1, 'V(rms)'],
    [10, 'V(avg)'],
    [2, 'Vpk'],
    [3, 'Vmin'],
    [4, 'Vp2p'],
    [5, ''],
    [6, 'Hz'],
    [8, 's'],
    [9, ''],
  ];

  for (const [mode, unit] of cases) {
    it(`mode ${mode} renders the ${JSON.stringify(unit) || 'bare'} unit`, () => {
      expect(meterCaption(mode, 3.5, 1)).toBe(formatValueShort(3.5, unit, 1));
    });
  }

  // Concrete regression pins: a typo in any arm would change these strings.
  it('mode 1 is V(rms)', () => {
    expect(meterCaption(1, 3.5, 1)).toBe('3.5V(rms)');
  });

  it('mode 6 is Hz', () => {
    expect(meterCaption(6, 60, 1)).toBe('60Hz');
  });

  it('mode 8 is seconds', () => {
    expect(meterCaption(8, 2, 1)).toBe('2s');
  });

  // The binary/duty modes (5, 9) carry no unit, matching upstream's
  // TestPointElm.java:204-206 / ProbeElm.java:209-211, which leave the value
  // string unset and render the bare reading.
  it('mode 5 draws a bare value with no unit', () => {
    expect(meterCaption(5, 12, 1)).toBe('12');
  });

  it('mode 9 draws a bare value with no unit', () => {
    expect(meterCaption(9, 0.5, 1)).toBe('500m');
  });

  // The default arm falls back to V, so an unknown or future meter mode can
  // never crash the draw and stays visibly a voltage caption.
  it('unknown mode falls back to V', () => {
    expect(meterCaption(99, 3.5, 1)).toBe('3.5V');
  });

  it('negative unknown mode falls back to V', () => {
    expect(meterCaption(-1, 1.25, 1)).toBe('1.3V');
  });

  // digits is forwarded unchanged: the auto-scaled caption honours the callers
  // digit count, so the helper does not hard-code a precision.
  it('forwards the digits argument', () => {
    expect(meterCaption(6, 60, 0)).toBe('60Hz');
    expect(meterCaption(0, 0.0555, 1)).toBe('55.5mV');
  });
});
