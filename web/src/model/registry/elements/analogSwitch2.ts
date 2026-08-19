/**
 * Analog switch with two throws (AnalogSwitch2Elm.java), the SPDT sibling of
 * the analog switch: posts 0 common, 1 and 2 the two throws, 3 the control.
 * The control gates which throw carries `r_on`, so the common is never left
 * open. FLAG_PULLDOWN is inherited from the SPST (AnalogSwitchElm.java:27):
 * with it set, both throws ride `r_off` pulldowns to ground for the whole
 * run. The lever points at the conducting throw (AnalogSwitch2Elm.java:105-118).
 */

import {
  calcLeads,
  canvasFont,
  currentDots,
  dsign,
  elementLength,
  endpoints,
  interp,
  lead,
  line,
  voltageColor,
} from '../../../render/draw';
import { OPEN_HS, readParams, writeParams, postsBox } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

const FLAG_INVERT = 1;  // AnalogSwitchElm.java:26
const FLAG_PULLDOWN = 2;  // AnalogSwitchElm.java:27

interface AnalogSwitch2Geometry {
  p1: Point;
  p2: Point;
  lead1: Point;
  lead2: Point;
  posts: Point[];
  poles: Point[];
  ctlPoint: Point;
}

/** The throw terminals, their fan points and the control post, matching
 *  AnalogSwitch2Elm.setPoints (AnalogSwitch2Elm.java:32-44): throw 1 hangs at
 *  `+openhs` on the `dsign`-determined side and throw 2 at `-openhs`, both at
 *  the far end; the control sits at the body midpoint on the `+openhs` side. */
function analogSwitch2Geometry(e: CircuitElement): AnalogSwitch2Geometry {
  const [p1, p2] = endpoints(e);
  const [lead1, lead2] = calcLeads(e, 32);
  const openhs = dsign(p1, p2) * OPEN_HS;
  return {
    p1,
    p2,
    lead1,
    lead2,
    posts: [p1, interp(p1, p2, 1, openhs), interp(p1, p2, 1, -openhs)],
    poles: [interp(lead1, lead2, 1, openhs), interp(lead1, lead2, 1, -openhs)],
    ctlPoint: interp(lead1, lead2, 0.5, openhs),
  };
}

function analogSwitch2Posts(e: CircuitElement): Point[] {
  const { posts, ctlPoint } = analogSwitch2Geometry(e);
  return [posts[0], posts[1], posts[2], ctlPoint];
}

/** The lever's throw index from the live control voltage, mirroring doStep
 *  (AnalogSwitch2Elm.java:105-108): open (control below threshold) throws to
 *  post 2, FLAG_INVERT swaps it. */
function leverPosition(g: DrawContext, e: CircuitElement): number {
  let open = (g.voltages[3] ?? 0) < (e.params.threshold ?? 2.5);
  if ((e.flags & FLAG_INVERT) !== 0) open = !open;
  return open ? 1 : 0;
}

function drawAnalogSwitch2(g: DrawContext, e: CircuitElement): void {
  const { p1, p2, lead1, posts, poles } = analogSwitch2Geometry(e);
  const position = leverPosition(g, e);

  // The common lead and the two throw leads, then the lever to the conducting
  // throw (AnalogSwitch2Elm.java:49-66). The control terminal has no stub
  // upstream; the dead-end post keeps its junction dot.
  lead(g, p1, lead1, voltageColor(g, g.voltages[0]));
  lead(g, poles[0], posts[1], voltageColor(g, g.voltages[1]));
  lead(g, poles[1], posts[2], voltageColor(g, g.voltages[2]));
  // The lever points at the conducting throw but does not carry its voltage:
  // upstream strokes it lightGray (AnalogSwitch2Elm.java:63-65).
  line(g, lead1, poles[position], g.theme.lightGray);

  currentDots(g, p1, lead1, g.current);
  currentDots(g, poles[position], posts[position + 1], g.current);

  // Name the throws when the part is picked, like upstream's highlight labels
  // (AnalogSwitch2Elm.java:75-80): at rest post 2 is NC and post 1 NO, unless
  // FLAG_INVERT swaps them.
  if (g.selected || g.hovered) {
    const dn = Math.max(1, elementLength(e));
    const off = OPEN_HS + 10;
    const labels = [
      interp(p1, p2, 1 - 10 / dn, off),
      interp(p1, p2, 1 - 10 / dn, -off),
    ];
    const inverted = (e.flags & FLAG_INVERT) !== 0;
    g.ctx.fillStyle = g.theme.selection;
    g.ctx.font = canvasFont(11);
    g.ctx.textAlign = 'center';
    g.ctx.textBaseline = 'middle';
    g.ctx.fillText(inverted ? 'NC' : 'NO', labels[0].x, labels[0].y);
    g.ctx.fillText(inverted ? 'NO' : 'NC', labels[1].x, labels[1].y);
  }
}

export const ANALOG_SWITCH2_DEF: ElementDef = {
  kind: 'analogSwitch2',
  label: 'Analog switch (SPDT)',
  category: 'Active',
  dumpCode: '160',
  postCount: 4,
  posts: analogSwitch2Posts,
  noDiagonal: true,  // AnalogSwitchElm.java:42
  defaultFlags: FLAG_PULLDOWN,  // the fresh constructor sets it (AnalogSwitchElm.java:43)
  defaults: { r_on: 20, r_off: 1e10, threshold: 2.5 },
  parse: (t, e) => readParams(t, e, ['r_on', 'r_off', 'threshold']),
  dump: writeParams(['r_on', 'r_off', 'threshold']),
  fields: [
    { name: 'r_on', label: 'On resistance', unit: 'Ω' },
    { name: 'r_off', label: 'Off resistance', unit: 'Ω' },
    { name: 'threshold', label: 'Threshold', unit: 'V' },
    { name: 'nc', label: 'Normally closed', type: 'bool', flag: FLAG_INVERT },
    { name: 'pulldown', label: 'Pulldown resistor', type: 'bool', flag: FLAG_PULLDOWN },
  ],
  // The two throws hang at ±openhs off the far end and the lever points at
  // one of them, so the whole fan is a solid pick zone (AnalogSwitch2Elm.java:
  // 48).
  bodyRect: (e) => postsBox(e, OPEN_HS),
  draw: drawAnalogSwitch2,
};
