import {
  calcLeads,
  currentDotsFrom,
  dotPhaseAfter,
  drawLeads,
  elementLength,
  endpoints,
  formatValueShort,
  interp2Precise,
  label,
  line,
  voltageColor,
} from '../../../render/draw';
import { CAP_BACK_EULER, CAP_RESISTANCE } from '../flags';
import { readParams, twoPosts, writeParams } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** Plate gap: the leads stop 4 units short of the centre each side, upstream's
 *  `f = (dn/2-4)/dn` (CapacitorElm.java:100). */
const CAP_PLATE_GAP = 8;
/** Plate half-width, upstream's `interpPoint2(point1, point2, ..., f, 12)`
 *  (CapacitorElm.java:107-108). */
const CAP_PLATE_HALF_WIDTH = 12;
/** Plate stroke, upstream's `drawThickLine` default width (CircuitElm.java:
 *  1013-1014). */
const CAP_PLATE_STROKE = 3;

export interface CapacitorPlateGeometry {
  lead1: Point;
  lead2: Point;
  plate1: [Point, Point];
  plate2: [Point, Point];
}

/** The capacitor's drawn geometry: the floored lead ends (the lead-body
 *  junction) and the two plates. The plate perpendicular comes from the true
 *  axis `p1 -> p2`, not the floored lead axis, or a diagonal capacitor's
 *  plates tilt off perpendicular and jump as the element is dragged
 *  (diagonal-body-rounding). Only the along-axis fraction comes from
 *  `calcLeads`, so the plates sit where the leads meet the body. */
export function capacitorPlateGeometry(e: CircuitElement): CapacitorPlateGeometry {
  const [p1, p2] = endpoints(e);
  const [lead1, lead2] = calcLeads(e, CAP_PLATE_GAP);
  const dn = elementLength(e);
  // Same short-element guard as calcLeads (returns the posts): plates at
  // fractions 0 and 1 of the true axis, never crossed.
  const f = dn < CAP_PLATE_GAP ? 0 : (dn - CAP_PLATE_GAP) / (2 * dn);
  return {
    lead1,
    lead2,
    plate1: interp2Precise(p1, p2, f, CAP_PLATE_HALF_WIDTH),
    plate2: interp2Precise(p1, p2, 1 - f, CAP_PLATE_HALF_WIDTH),
  };
}

export function drawCapacitorBody(g: DrawContext, e: CircuitElement): void {
  const { lead1, lead2, plate1, plate2 } = capacitorPlateGeometry(e);
  drawLeads(g, e, lead1, lead2);
  line(g, plate1[0], plate1[1], voltageColor(g, g.voltages[0]), CAP_PLATE_STROKE);
  line(g, plate2[0], plate2[1], voltageColor(g, g.voltages[1]), CAP_PLATE_STROKE);
  // The plate gap breaks the current path, so the dots cannot cross the body
  // in one run; the second lead starts at the phase the first would have
  // reached at the gap, keeping the two inlets aligned (CapacitorElm.java:
  // 139-140's +curcount/-curcount split).
  const [p1, p2] = endpoints(e);
  const leadLen = Math.hypot(lead1.x - p1.x, lead1.y - p1.y);
  currentDotsFrom(g, p1, lead1, g.current, g.dotPhase);
  currentDotsFrom(g, lead2, p2, g.current, dotPhaseAfter(g.dotPhase, leadLen));
  label(g, e, formatValueShort(e.params.capacitance ?? 0, 'F', g.valueDigits));
}

/**
 * The leading tokens both capacitor types share (CapacitorElm.java:43-52):
 * `capacitance` and `voltDiff` always, then `initialVoltage`, which is
 * optional and falls back to the 1e-3 default. Always three token slots, so
 * the callers below know where the series resistance would start.
 */
function capacitorHead(tokens: string[], e: CircuitElement): number {
  readParams(tokens, e, ['capacitance', 'voltDiff', 'initialVoltage']);
  return 3;
}

/**
 * A plain `c` line, whose fourth token can only ever be the series
 * resistance, so it is read whether or not FLAG_RESISTANCE is set.
 *
 * Upstream reads it only under the flag (CapacitorElm.java:59-60), but the
 * flag is there to keep the stream position unambiguous for `PolarCapacitorElm`,
 * which reads more state after it; nothing follows on a plain `c`. Honouring
 * the flag here would silently drop a real value: `cappar.txt` carries
 * `c 192 192 192 288 0 2e-4 0.925 0.001 0.1` with the bit clear, and that 0.1
 * is not noise. It is what upstream's own `validate()` wrote back
 * (CapacitorElm.java:274-291) after finding the ideal-capacitor loop that
 * capacitor sits in, and the next save would overwrite it with a zero.
 */
export const capacitorParse = (tokens: string[], e: CircuitElement): void => {
  const n = capacitorHead(tokens, e);
  readParams(tokens.slice(n), e, ['seriesResistance']);
};

/**
 * A `209` line, where the flag genuinely disambiguates: `PolarCapacitorElm`
 * reads `maxNegativeVoltage` off the same token stream its superclass left
 * (PolarCapacitorElm.java:13-17), so without FLAG_RESISTANCE the rating is the
 * fourth token, not the fifth.
 */
export const polarCapacitorParse = (tokens: string[], e: CircuitElement): void => {
  let n = capacitorHead(tokens, e);
  if ((e.flags & CAP_RESISTANCE) !== 0) {
    readParams(tokens.slice(n), e, ['seriesResistance']);
    n += 1;
  }
  readParams(tokens.slice(n), e, ['maxNegativeVoltage']);
};

/** Upstream's `dump()` sets FLAG_RESISTANCE unconditionally and always writes
 *  the ESR token (CapacitorElm.java:69-72), which is what tells the reader the
 *  token is there at all. Both capacitor types share the writer. */
export const capacitorFlags = (e: CircuitElement): number => e.flags | CAP_RESISTANCE;

export const CAPACITOR_DEF: ElementDef = {
  kind: 'capacitor',
  label: 'Capacitor',
  category: 'Basics',
  dumpCode: 'c',
  shortcut: 'c',  // CapacitorElm.java
  postCount: 2,
  posts: twoPosts,
  // 1e-3, not 0: upstream's constructor puts a small charge on every fresh
  // capacitor so an LC tank self-starts (CapacitorElm.java:38).
  defaults: { capacitance: 1e-5, initialVoltage: 1e-3, seriesResistance: 0 },
  // The stored voltage is part of the format but is state, not a setting.
  parse: capacitorParse,
  dump: writeParams(['capacitance', 'voltDiff', 'initialVoltage', 'seriesResistance']),
  dumpFlags: capacitorFlags,
  fields: [
    { name: 'capacitance', label: 'Capacitance', unit: 'F' },
    { name: 'seriesResistance', label: 'Series resistance', unit: 'Ω' },
    { name: 'initialVoltage', label: 'Initial voltage (on reset)', unit: 'V' },
    // Upstream labels this "Trapezoidal Approximation" and ticks it when the
    // flag is *clear* (CapacitorElm.java:238-241, :253-258); naming it after
    // the flag is the same control with the label the right way up.
    { name: 'backEuler', label: 'Backward Euler', type: 'bool', flag: CAP_BACK_EULER },
  ],
  draw: drawCapacitorBody,
};
