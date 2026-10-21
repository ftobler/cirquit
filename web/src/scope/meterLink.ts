/**
 * The scope-to-meter link: which traces are reading an element's meter, and in
 * what colour, so the schematic can say "your Scope 2 voltage trace is this
 * meter" without opening the dock. Session-only viewer state: scopes already
 * know their element, and nothing new goes into the file.
 *
 * Pure given the scopes and theme, so it is testable without a canvas.
 */

import type { MeterTrace, Scope } from '../engine/scopeModel';
import type { Theme } from '../model/types';
import { isDrawable, plotColors, visiblePlotsOf } from './draw';
import { UNIT } from './units';

/** Most markers one meter draws; a scope stack can put many traces on one
 *  element and the little badge has to stay readable. */
export const MAX_METER_TRACES = 4;

/**
 * The traces reading each element, keyed by store element id, in scope order
 * and within a scope in the plotted order. A math trace is skipped: it is a
 * derivation, not a reading of the element. `scopeIndex` supplies the display
 * number the fallback label uses.
 */
export function meterTracesByElement(
  scopes: readonly Scope[],
  theme: Theme,
  limit = MAX_METER_TRACES,
): Map<number, MeterTrace[]> {
  const out = new Map<number, MeterTrace[]>();
  scopes.forEach((scope, index) => {
    const colors = plotColors(scope, theme);
    const label = scope.label.trim() !== '' ? scope.label.trim() : `Scope ${index + 1}`;
    for (const plot of visiblePlotsOf(scope).filter(isDrawable)) {
      if (plot.elementId === null || plot.math) continue;
      const list = out.get(plot.elementId) ?? [];
      if (list.length >= limit) continue;
      list.push({
        plotId: plot.id,
        scopeId: scope.id,
        color: colors.get(plot.id) ?? theme.whiteColor,
        label,
        unit: UNIT[plot.value],
      });
      out.set(plot.elementId, list);
    }
  });
  return out;
}
