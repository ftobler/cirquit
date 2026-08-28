import { describe, expect, it } from 'vitest';
import { resolveParam } from '../model/sliders';
import { sliderReadbackValue } from './SliderPanel';
import type { CircuitElement } from '../model/types';

/** A minimal voltage source with the timing params a duty-cycle / phase
 *  slider binds, matching the defaults upstream seeds. */
function voltage(params: Record<string, number>): CircuitElement {
  return {
    id: 1,
    kind: 'voltage',
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 32,
    flags: 0,
    params,
  };
}

describe('sliderReadbackValue', () => {
  it('reads a duty-cycle fraction as percent through fieldValue', () => {
    const element = voltage({ dutyCycle: 0.5, waveform: 5, frequency: 1 });
    const resolved = resolveParam('voltage', 0, 'Duty cycle');
    expect(resolved).not.toBeNull();
    expect(resolved!.name).toBe('dutyCycle');
    // 0.5 * 100 = 50, the display percent the dialog shows too.
    expect(sliderReadbackValue(element, resolved!)).toBeCloseTo(50, 6);
  });

  it('reads a phase-shift radian param as degrees through fieldValue', () => {
    const element = voltage({ phaseShift: Math.PI / 2, waveform: 0, frequency: 1 });
    const resolved = resolveParam('voltage', 0, 'Phase offset');
    expect(resolved).not.toBeNull();
    expect(resolved!.name).toBe('phaseShift');
    // (pi/2) * 180/pi = 90, the display degrees the dialog shows too.
    expect(sliderReadbackValue(element, resolved!)).toBeCloseTo(90, 6);
  });

  it('would have failed before the fix: a raw param read reports 0.5, not 50', () => {
    const element = voltage({ dutyCycle: 0.5, waveform: 5, frequency: 1 });
    const resolved = resolveParam('voltage', 0, 'Duty cycle')!;
    // The bug: reading the param directly gives the fraction, ignoring scale.
    expect(element.params[resolved.name]).toBeCloseTo(0.5, 6);
    expect(sliderReadbackValue(element, resolved)).not.toBe(element.params[resolved.name] ?? 0);
  });
});
