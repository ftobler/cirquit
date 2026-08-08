import {
  calcLeads,
  currentDotsPath,
  drawLeads,
  endpoints,
  interp2,
  line,
  triangle,
  voltageColor,
} from '../../../render/draw';
import { elementColor, twoPosts } from '../shared';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/**
 * The tunnel diode symbol: the plain diode triangle pointing at a cathode
 * whose bar carries two wings swept back to 0.8 of the body (TunnelDiodeElm.
 * java:44-49). The triangle is filled with post 0's voltage colour and the
 * cathode marks with post 1's, matching the two `setVoltageColor` calls in
 * the upstream draw (TunnelDiodeElm.java:60-69).
 */
function drawTunnelDiodeBody(g: DrawContext, e: CircuitElement): void {
  const [lead1, lead2] = calcLeads(e, 16);
  drawLeads(g, e, lead1, lead2);
  const [t1, t2] = interp2(lead1, lead2, 0, 8);
  triangle(g, t1, t2, lead2, elementColor(g, g.voltages[0], g.power));
  const color2 = voltageColor(g, g.voltages[1]);
  const [b1, b2] = interp2(lead1, lead2, 1, 8);
  const [w0, w1] = interp2(lead1, lead2, 0.8, 8);
  line(g, b1, b2, color2, 2.5);
  line(g, w0, b1, color2, 2.5);
  line(g, w1, b2, color2, 2.5);
  const [p1, p2] = endpoints(e);
  currentDotsPath(g, [p1, lead1, lead2, p2], g.current);
}

export const TUNNEL_DIODE_DEF: ElementDef = {
  kind: 'tunnelDiode',
  label: 'Tunnel diode',
  category: 'Semiconductors',
  // getDumpType() returns the int 175, not a char (TunnelDiodeElm.java:35).
  dumpCode: '175',
  postCount: 2,
  posts: twoPosts,
  // The curve is hardcoded in the engine model, so the file format carries
  // nothing after the shared x/y/flags fields: no tokens, no fields.
  draw: drawTunnelDiodeBody,
};
