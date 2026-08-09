import { describe, expect, it } from 'vitest';
import { E12, e12DecadeRange, e12Values, linearValues } from './e12';

describe('e12DecadeRange', () => {
  it('mirrors upstream ranges for the three scrollable kinds', () => {
    expect(e12DecadeRange('resistor')).toEqual([-1, 7]);
    expect(e12DecadeRange('capacitor')).toEqual([-11, -3]);
    expect(e12DecadeRange('inductor')).toEqual([-6, 0]);
  });

  it('returns an empty range for an unknown kind', () => {
    expect(e12DecadeRange('mosfet')).toEqual([0, 0]);
  });
});

describe('e12Values', () => {
  it('builds the full decade sweep with the current value in place', () => {
    const { values, index } = e12Values('resistor', 1000);
    // 10^-1 .. 10^7 is nine decades; the last contributes only 1.0.
    expect(values.length).toBe(8 * E12.length + 1);
    expect(values[0]).toBeCloseTo(0.1);
    expect(values[values.length - 1]).toBeCloseTo(1e7);
    // 1000 is the 1.0e3 step: four full decades (10^-1..10^2), then it.
    expect(values[index]).toBe(1000);
    expect(index).toBe(48);
  });

  it('stays on an E12 step without splicing a duplicate', () => {
    const { values, index } = e12Values('resistor', 2200);
    expect(values[index]).toBeCloseTo(2200);
    expect(values[index - 1]).toBeCloseTo(1800);
    expect(values[index + 1]).toBeCloseTo(2700);
    expect(values.length).toBe(8 * E12.length + 1);
  });

  it('splices an off-grid value at its sorted position', () => {
    const { values, index } = e12Values('resistor', 5000);
    expect(values[index]).toBe(5000);
    expect(values[index - 1]).toBeCloseTo(4700);
    expect(values[index + 1]).toBeCloseTo(5600);
    expect(values.length).toBe(8 * E12.length + 2);
  });

  it('splices a value below the range at the front and above it at the back', () => {
    const low = e12Values('resistor', 0.05);
    expect(low.index).toBe(0);
    expect(low.values[0]).toBe(0.05);
    expect(low.values[1]).toBeCloseTo(0.1);
    const high = e12Values('resistor', 1e8);
    expect(high.index).toBe(high.values.length - 1);
    expect(high.values[high.index]).toBe(1e8);
    expect(high.values[high.index - 1]).toBeCloseTo(1e7);
  });

  it('points the index at the current value', () => {
    const onGrid = e12Values('inductor', 1.5e-3);
    expect(onGrid.values[onGrid.index]).toBeCloseTo(1.5e-3);
    expect(onGrid.index).toBe(onGrid.values.indexOf(onGrid.values[onGrid.index]));
    const offGrid = e12Values('inductor', 1.7e-3);
    expect(offGrid.values[offGrid.index]).toBe(1.7e-3);
    expect(offGrid.values[offGrid.index - 1]).toBeCloseTo(1.5e-3);
    expect(offGrid.values[offGrid.index + 1]).toBeCloseTo(1.8e-3);
  });

  it('truncates the last decade to 1.0 only', () => {
    const resistor = e12Values('resistor', 1000);
    expect(resistor.values[resistor.values.length - 1]).toBeCloseTo(1e7);
    expect(resistor.values[resistor.values.length - 2]).toBeCloseTo(8.2e6);
    const capacitor = e12Values('capacitor', 1e-5);
    expect(capacitor.values[capacitor.values.length - 1]).toBeCloseTo(1e-3);
    const inductor = e12Values('inductor', 1e-3);
    expect(inductor.values[inductor.values.length - 1]).toBeCloseTo(1);
  });

  it('returns an empty list for an unknown kind', () => {
    expect(e12Values('mosfet', 1000)).toEqual({ values: [], index: 0 });
  });
});

describe('linearValues', () => {
  it('builds a +/-100 step ladder centred on the current value', () => {
    const { values, index } = linearValues(1, 5);
    expect(values.length).toBe(201);
    expect(values[0]).toBe(-95);
    expect(values[values.length - 1]).toBe(105);
    expect(values[index]).toBe(5);
    expect(index).toBe(100);
  });

  it('centres on the snapped grid point and splices an off-grid current', () => {
    const { values, index } = linearValues(1, 4.7);
    expect(values.length).toBe(202);
    expect(values[index]).toBe(4.7);
    expect(values[index - 1]).toBe(4);
    expect(values[index + 1]).toBe(5);
  });

  it('steps a current source by 1 mA', () => {
    const { values, index } = linearValues(1e-3, 0.01);
    expect(values.length).toBe(201);
    expect(values[index]).toBeCloseTo(0.01);
    expect(values[index + 1]).toBeCloseTo(0.011);
    expect(values[index - 1]).toBeCloseTo(0.009);
  });

  it('allows negative values deliberately', () => {
    const { values, index } = linearValues(1, -5);
    expect(values[index]).toBe(-5);
    expect(values[0]).toBe(-105);
    expect(values[values.length - 1]).toBe(95);
  });

  it('stays on a grid point without splicing a duplicate', () => {
    const { values, index } = linearValues(1, 6);
    expect(values[index]).toBe(6);
    expect(values.length).toBe(201);
  });
});
