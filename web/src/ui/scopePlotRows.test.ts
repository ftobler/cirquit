import { describe, expect, it } from 'vitest';
import type { ScopePlot } from '../engine/scopeModel';
import { canRemovePlot, isVceIcRow, plotAxisLabel, plotValueRows } from './scopePlotRows';

/** A row's plot value, skipping the compound Vce-vs-Ic action row. */
const valuesOf = (kind: string | null) =>
  plotValueRows(kind).flatMap((r) => (isVceIcRow(r) ? [] : [r.value]));

describe('plotValueRows', () => {
  it('gives a transistor its six pin plots in place of voltage and current', () => {
    // ScopePropertiesDialog.java:556-571: the transistor grid swaps Show
    // Voltage/Show Current for Ib..Vce.
    const rows = plotValueRows('transistor');
    expect(rows.map((r) => r.label)).toEqual([
      'Show Ib',
      'Show Ic',
      'Show Ie',
      'Show Vbe',
      'Show Vbc',
      'Show Vce',
      'Show Power Consumed',
      'Show Resistance',
      'Show Vce vs Ic',
    ]);
    expect(valuesOf('transistor')).toContain('vce');
    expect(valuesOf('transistor')).not.toContain('voltage');
    // The compound action rides last, marked as its own thing.
    expect(rows.at(-1)).toMatchObject({ label: 'Show Vce vs Ic', special: 'vceIc' });
  });

  it('keeps voltage and current first for every other kind', () => {
    expect(valuesOf('resistor').slice(0, 2)).toEqual(['voltage', 'current']);
    expect(plotValueRows('resistor').some(isVceIcRow)).toBe(false);
  });

  it('shows charge only for a capacitor', () => {
    expect(valuesOf('capacitor')).toContain('charge');
    expect(valuesOf('polarizedCapacitor')).toContain('charge');
    expect(valuesOf('resistor')).not.toContain('charge');
  });

  it('renders resistance for everyone but enables it only where VAL_R is real', () => {
    // Upstream adds the box unconditionally and disables it where
    // canShowResistance() fails (ScopePropertiesDialog.java:577-578, 821-822).
    // A lamp, memristor and ohmmeter answer getScopeValue(VAL_R)
    // (LampElm.java:218-219, MemristorElm.java:144-146, OhmMeterElm.java:
    // 40-42), so the box stays enabled for exactly those three.
    for (const kind of ['lamp', 'memristor', 'ohmmeter']) {
      expect(plotValueRows(kind).find((r) => !isVceIcRow(r) && r.value === 'resistance')?.disabled).toBe(false);
    }
    for (const kind of ['resistor', 'transistor', 'capacitor', null]) {
      expect(
        plotValueRows(kind).find((r) => !isVceIcRow(r) && r.value === 'resistance')?.disabled,
      ).toBe(true);
    }
  });
});

describe('plotAxisLabel', () => {
  it('labels a transistor pin plot "kind, name (unit)" like getScopeText', () => {
    expect(plotAxisLabel('transistor', 'ic')).toBe('Transistor (BJT), Ic (A)');
    expect(plotAxisLabel('transistor', 'vce')).toBe('Transistor (BJT), Vce (V)');
  });

  it('labels a generic plot with the element name and unit alone', () => {
    expect(plotAxisLabel('resistor', 'voltage')).toBe('Resistor (V)');
    expect(plotAxisLabel('lamp', 'resistance')).toBe('Lamp, R (Ω)');
  });

  it('degrades an unknown element or value without throwing', () => {
    expect(plotAxisLabel(null, null)).toBe('Plot (?)');
    expect(plotAxisLabel('mysteryKind', 'voltage')).toBe('mysteryKind (V)');
  });
});

describe('canRemovePlot', () => {
  /** A minimal plot shape standing in for a loaded or created one. */
  const plot = (id: number, overrides: Partial<ScopePlot> = {}): ScopePlot =>
    ({
      id,
      elementId: 7,
      value: 'voltage',
      manScale: null,
      manVPosition: 0,
      acCoupled: false,
      measurements: null,
      ...overrides,
    }) as ScopePlot;

  it('allows a real samplable plot while others remain', () => {
    const plots = [plot(1), plot(2)];
    expect(canRemovePlot(plots, 2)).toBe(true);
  });

  it('refuses a stale id so the disabled item explains the no-op', () => {
    // The menu can outlive its plot; a dead id must read as unavailable.
    expect(canRemovePlot([plot(1), plot(2)], 3)).toBe(false);
  });

  it('refuses a raw-only plot that only preserves the o line tokens', () => {
    const plots = [plot(1), { ...plot(2, { value: null }) }];
    expect(canRemovePlot(plots, 2)).toBe(false);
  });

  it('refuses the last plot in the panel', () => {
    expect(canRemovePlot([plot(1)], 1)).toBe(false);
  });
});
