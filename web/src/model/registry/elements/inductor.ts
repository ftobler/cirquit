import {
  COIL_LOOPS,
  calcLeads,
  coilPoints,
  currentDotsPath,
  drawLeads,
  endpoints,
  formatValue,
  label,
  polyline,
  voltageColor,
} from '../../../render/draw';
import { IND_BACK_EULER } from '../flags';
import { readParams, twoPosts, writeParams } from '../shared';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

function drawInductorBody(g: DrawContext, e: CircuitElement): void {
  const [lead1, lead2] = calcLeads(e, 32);
  drawLeads(g, e, lead1, lead2);
  const color = voltageColor(g, (g.voltages[0] + g.voltages[1]) / 2);
  polyline(g, coilPoints(lead1, lead2, COIL_LOOPS), color);
  const [p1, p2] = endpoints(e);
  currentDotsPath(g, [p1, lead1, lead2, p2], g.current);
  label(g, e, formatValue(e.params.inductance ?? 0, 'H'));
}

export const INDUCTOR_DEF: ElementDef = {
  kind: 'inductor',
  label: 'Inductor',
  category: 'Basics',
  dumpCode: 'l',
  postCount: 2,
  posts: twoPosts,
  // The second token is the running state the file was saved with
  // (InductorElm.java:42), kept so a mid-transient save reloads where it
  // left off; a zero here is indistinguishable from no saved state.
  defaults: { inductance: 1e-3, current: 0, initialCurrent: 0, saturationCurrent: 0 },
  parse: (t, e) =>
    readParams(t, e, ['inductance', 'current', 'initialCurrent', 'saturationCurrent']),
  dump: writeParams(['inductance', 'current', 'initialCurrent', 'saturationCurrent']),
  fields: [
    { name: 'inductance', label: 'Inductance', unit: 'H' },
    { name: 'initialCurrent', label: 'Initial current (on reset)', unit: 'A' },
    { name: 'saturationCurrent', label: 'Saturation current (0 = none)', unit: 'A' },
    // Same flag and same semantics as the capacitor's checkbox; upstream
    // labels it "Trapezoidal Approximation" and ticks it when the flag is
    // *clear* (InductorElm.java:133-137), so naming it after the flag is the
    // same control with the label the right way up.
    { name: 'backEuler', label: 'Backward Euler', type: 'bool', flag: IND_BACK_EULER },
  ],
  draw: drawInductorBody,
};
