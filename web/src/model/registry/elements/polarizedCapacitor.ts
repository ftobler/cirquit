import { canvasFont, dsign, elementLength, endpoints, interp } from '../../../render/draw';
import { CAP_BACK_EULER } from '../flags';
import { twoPosts, writeParams } from '../shared';
import { capacitorFlags, drawCapacitorBody, polarCapacitorParse } from './capacitor';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** The plain capacitor plus the polarity marker PolarCapacitorElm draws next
 *  to its first plate (PolarCapacitorElm.java:36-49). */
function drawPolarCapacitorBody(g: DrawContext, e: CircuitElement): void {
  drawCapacitorBody(g, e);
  const [p1, p2] = endpoints(e);
  // f = (dn/2-4)/dn - 8/dn = 0.5 - 12/dn: a constant 12px offset from the
  // segment midpoint toward point1, independent of length `dn`
  // (PolarCapacitorElm.java:38,47).
  const dn = elementLength(e);
  const f = dn === 0 ? 0.5 : 0.5 - 12 / dn;
  const plus = interp(p1, p2, f, -10 * dsign(p1, p2));
  // Upstream's pixel-snap nudge for near-vertical/diagonal segments
  // (PolarCapacitorElm.java:48-51).
  if (p2.y > p1.y) plus.y += 4;
  if (p1.y > p2.y) plus.y += 3;
  g.ctx.fillStyle = g.theme.text;
  g.ctx.font = canvasFont(11);
  g.ctx.textAlign = 'center';
  g.ctx.textBaseline = 'middle';
  g.ctx.fillText('+', plus.x, plus.y);
}

export const POLARIZED_CAPACITOR_DEF: ElementDef = {
  kind: 'polarizedCapacitor',
  label: 'Polarized Capacitor',
  category: 'Basics',
  dumpCode: '209',
  shortcut: 'C',  // PolarCapacitorElm.java
  postCount: 2,
  posts: twoPosts,
  defaults: {
    capacitance: 1e-5,
    initialVoltage: 1e-3,
    seriesResistance: 0,
    maxNegativeVoltage: 1,
  },
  // Same trailing tokens as the plain capacitor, plus maxNegativeVoltage
  // (PolarCapacitorElm.java: dump() appends it after CapacitorElm.dump()).
  parse: polarCapacitorParse,
  dump: writeParams([
    'capacitance',
    'voltDiff',
    'initialVoltage',
    'seriesResistance',
    'maxNegativeVoltage',
  ]),
  dumpFlags: capacitorFlags,
  fields: [
    { name: 'capacitance', label: 'Capacitance', unit: 'F' },
    { name: 'seriesResistance', label: 'Series resistance', unit: 'Ω' },
    { name: 'initialVoltage', label: 'Initial voltage (on reset)', unit: 'V' },
    { name: 'maxNegativeVoltage', label: 'Max reverse voltage', unit: 'V', min: 0 },
    { name: 'backEuler', label: 'Backward Euler', type: 'bool', flag: CAP_BACK_EULER },
  ],
  draw: drawPolarCapacitorBody,
};
