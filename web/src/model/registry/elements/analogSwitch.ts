/**
 * Analog switch: a control-voltage-driven resistor between two signal posts,
 * with a perpendicular control post at the body midpoint. Posts 0 and 1 are
 * the signal path, post 2 the control (AnalogSwitchElm.java:83-92, :167-170).
 */

import {
  calcLeads,
  currentDotsPath,
  drawLeads,
  dsign,
  endpoints,
  interp,
  lead,
  line,
  voltageColor,
} from '../../../render/draw';
import { OPEN_HS, readParams, writeParams } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

const FLAG_INVERT = 1;  // AnalogSwitchElm.java:26
const FLAG_PULLDOWN = 2;  // AnalogSwitchElm.java:27

interface AnalogSwitchGeometry {
  p1: Point;
  p2: Point;
  lead1: Point;
  lead2: Point;
  point3: Point;
  lead3: Point;
  openhs: number;
}

/** The signal leads and the control stub, matching AnalogSwitchElm.setPoints
 *  (AnalogSwitchElm.java:83-92). `openhs` is ±16 on the `dsign`-determined
 *  side, exactly like the relay contact's throw offset; the control post and
 *  its stub hang off the opposite sign, and the open lever lifts onto
 *  `openhs`. */
function analogSwitchGeometry(e: CircuitElement): AnalogSwitchGeometry {
  const [p1, p2] = endpoints(e);
  const [lead1, lead2] = calcLeads(e, 32);
  const openhs = dsign(p1, p2) * OPEN_HS;
  return {
    p1,
    p2,
    lead1,
    lead2,
    point3: interp(lead1, lead2, 0.5, -openhs),
    lead3: interp(lead1, lead2, 0.5, -openhs / 2),
    openhs,
  };
}

function analogSwitchPosts(e: CircuitElement): Point[] {
  const { p1, p2, point3 } = analogSwitchGeometry(e);
  return [p1, p2, point3];
}

/** The path is open when the control sits below `threshold`, inverted by
 *  FLAG_INVERT. Derived live from the frame's control voltage, which is all
 *  the draw has: the open/closed state never crosses back out of the engine
 *  (AnalogSwitchElm.java:156-158). */
function analogSwitchOpen(e: CircuitElement, controlVoltage: number): boolean {
  let open = controlVoltage < (e.params.threshold ?? 2.5);
  if ((e.flags & FLAG_INVERT) !== 0) open = !open;
  return open;
}

function drawAnalogSwitch(g: DrawContext, e: CircuitElement): void {
  const { p1, p2, lead1, lead2, point3, lead3, openhs } = analogSwitchGeometry(e);
  const open = analogSwitchOpen(e, g.voltages[2]);

  // The closing bar: flat on the axis when closed, lifted `openhs` at the far
  // end when open, on the side opposite the control stub (AnalogSwitchElm.java:
  // 114-124). `hs1`/`hs2` are the same 0/2/openhs pattern as SwitchElm.
  const hs1 = open ? 0 : 2;
  const hs2 = open ? openhs : 2;
  drawLeads(g, e, lead1, lead2);
  // The closing bar is the mechanical part, lightGray in upstream too
  // (AnalogSwitchElm.java:120-123).
  line(g, interp(lead1, lead2, 0, hs1), interp(lead1, lead2, 1, hs2), g.theme.lightGray);
  lead(g, point3, lead3, voltageColor(g, g.voltages[2]));
  if (!open) {
    currentDotsPath(g, [p1, lead1, lead2, p2], g.current);
  }
}

export const ANALOG_SWITCH_DEF: ElementDef = {
  kind: 'analogSwitch',
  label: 'Analog switch',
  category: 'Active',
  dumpCode: '159',
  postCount: 3,
  posts: analogSwitchPosts,
  noDiagonal: true,  // AnalogSwitchElm.java:42
  defaultFlags: FLAG_PULLDOWN,  // the fresh constructor sets it (AnalogSwitchElm.java:43)
  defaults: {
    r_on: 20,
    r_off: 1e10,
    threshold: 2.5,
  },
  parse: (t, e) => readParams(t, e, ['r_on', 'r_off', 'threshold']),
  dump: writeParams(['r_on', 'r_off', 'threshold']),
  fields: [
    { name: 'r_on', label: 'On resistance', unit: 'Ω' },
    { name: 'r_off', label: 'Off resistance', unit: 'Ω' },
    { name: 'threshold', label: 'Threshold', unit: 'V' },
    { name: 'nc', label: 'Normally closed', type: 'bool', flag: FLAG_INVERT },
    { name: 'pulldown', label: 'Pulldown resistor', type: 'bool', flag: FLAG_PULLDOWN },
  ],
  draw: drawAnalogSwitch,
};
