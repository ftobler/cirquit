/**
 * The scope's units table: one display unit per plot value, doubling as the
 * units family that upstream compares in allPlotsSameUnits (Scope.java:656-661)
 * and indexes its per-scope scale[] with.
 */

import type { ScopeValue } from '../engine/simulator';

export const UNIT: Record<ScopeValue, string> = {
  voltage: 'V',
  current: 'A',
  power: 'W',
  charge: 'C',
  resistance: 'Ω',
  // The transistor pin values collapse onto the shared categories exactly as
  // TransistorElm.getScopeUnits answers them (TransistorElm.java:595-602):
  // Ib/Ic/Ie are currents and Vbe/Vbc/Vce voltages, so same-unit pin traces
  // on one panel share a gridline set instead of zooming apart.
  ib: 'A',
  ic: 'A',
  ie: 'A',
  vbe: 'V',
  vbc: 'V',
  vce: 'V',
};

/** The units family a value belongs to, upstream's UNITS_* index into
 *  scale[] (Scope.java:75). Values outside the table have no family; the
 *  caller decides what that means. */
export function unitsFamily(value: string): string | undefined {
  return UNIT[value as ScopeValue];
}
