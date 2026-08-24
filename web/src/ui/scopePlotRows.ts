/**
 * The scope properties dialog's per-element decision tables, kept out of the
 * component so they stay testable without a DOM: which Plots boxes a kind
 * earns (ScopePropertiesDialog.java:544-607) and how an X-Y axis list entry is
 * labelled (populatePlotListBox, ScopePropertiesDialog.java:731-741).
 */

import type { ScopePlot, ScopeValue } from '../engine/simulator';
import { UNIT } from '../scope/draw';
import { defFor } from '../model/registry';

/** One checkbox row of the Plots section. A plain row toggles one plot value;
 *  the vceIc row is upstream's compound "Show Vce vs Ic" action instead
 *  (handleMenu's showvcevsic branch, Scope.java:1312-1317): it seeds the
 *  VCE/IC pair, turns the 2D plot on and resets the X-Y axes. */
export type PlotValueRow =
  | { label: string; value: ScopeValue; disabled: boolean }
  | { label: string; special: 'vceIc'; disabled: boolean };

/** The Plots rows for one scope's element kind, in upstream's order: a
 *  transistor swaps Show Voltage/Show Current for its six pin plots, then
 *  power, then charge for a capacitor, then resistance for everyone and the
 *  Vce-vs-Ic action (ScopePropertiesDialog.java:544-607). Voltage and current
 *  ride the showV/showI flags (setScopeShowValue); every other value toggles
 *  its plot directly, upstream's showPlotValue (Scope.java:145-165). */
export function plotValueRows(kind: string | null): PlotValueRow[] {
  const rows: PlotValueRow[] = [];
  if (kind === 'transistor') {
    const pin: [string, ScopeValue][] = [
      ['Ib', 'ib'],
      ['Ic', 'ic'],
      ['Ie', 'ie'],
      ['Vbe', 'vbe'],
      ['Vbc', 'vbc'],
      ['Vce', 'vce'],
    ];
    for (const [name, value] of pin) {
      rows.push({ label: `Show ${name}`, value, disabled: false });
    }
  } else {
    rows.push(
      { label: 'Show Voltage', value: 'voltage', disabled: false },
      { label: 'Show Current', value: 'current', disabled: false },
    );
  }
  rows.push({ label: 'Show Power Consumed', value: 'power', disabled: false });
  if (kind === 'capacitor' || kind === 'polarizedCapacitor') {
    rows.push({ label: 'Show Charge', value: 'charge', disabled: false });
  }
  rows.push({
    label: 'Show Resistance',
    value: 'resistance',
    disabled: kind !== 'lamp',
  });
  if (kind === 'transistor') {
    rows.push({ label: 'Show Vce vs Ic', special: 'vceIc', disabled: false });
  }
  return rows;
}

/** Type guard for the compound Vce-vs-Ic action row. */
export const isVceIcRow = (
  row: PlotValueRow,
): row is Extract<PlotValueRow, { special: 'vceIc' }> => 'special' in row && row.special === 'vceIc';

/** Whether the scope popup's Remove Plot may act on `plotId`, the same guards
 *  removePlot enforces: the id must name a real plot (a menu can outlive its
 *  plot), the plot must carry a trace because a raw-only one exists only to
 *  re-emit its o line tokens on save, and a single-plot panel must not empty. */
export function canRemovePlot(plots: ScopePlot[], plotId: number): boolean {
  const plot = plots.find((p) => p.id === plotId);
  if (!plot || plot.value === null || plot.elementId === null) return false;
  return plots.length > 1;
}

/** The short quantity name inside an axis label, upstream's getScopeText
 *  additions (TransistorElm.java:524-537); generic values have none and lean
 *  on the element name alone. */
const VALUE_NAMES: Partial<Record<ScopeValue, string>> = {
  ib: 'Ib',
  ic: 'Ic',
  ie: 'Ie',
  vbe: 'Vbe',
  vbc: 'Vbc',
  vce: 'Vce',
  resistance: 'R',
};

/** One X-Y axis or modulator list entry: `name (units)`, where the name is the
 *  element's own or "element, Ic" for a transistor pin plot, exactly the shape
 *  populatePlotListBox builds from getScopeText and getScaleUnitsText. */
export function plotAxisLabel(kind: string | null, value: ScopeValue | null): string {
  const kindLabel = kind === null ? null : (defFor(kind)?.label ?? kind);
  const name =
    kindLabel === null ? 'Plot' : (value !== null && VALUE_NAMES[value] ? `${kindLabel}, ${VALUE_NAMES[value]}` : kindLabel);
  const unit = value === null ? '?' : UNIT[value];
  return `${name} (${unit})`;
}
