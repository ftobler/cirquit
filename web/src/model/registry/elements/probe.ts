import {
  calcLeads,
  canvasFont,
  circle,
  formatValue,
  interp,
  label,
  line,
  voltageColor,
} from '../../../render/draw';
import { PROBE_CIRCLE, PROBE_SHOW_VOLTAGE } from '../flags';
import { readParams, twoPosts, writeParams } from '../shared';
import type { ElementDef } from '../../types';

export const PROBE_DEF: ElementDef = {
  kind: 'probe',
  label: 'Voltmeter',
  category: 'Other',
  dumpCode: 'p',
  postCount: 2,
  posts: twoPosts,
  defaultFlags: PROBE_SHOW_VOLTAGE | PROBE_CIRCLE,  // ProbeElm.java:52
  parse: (t, e) => readParams(t, e, ['meter', 'scale', 'resistance']),
  dump: writeParams(['meter', 'scale', 'resistance']),
  draw(g, e) {
    const [lead1, lead2] = calcLeads(e, 16);
    line(g, { x: e.x1, y: e.y1 }, lead1, voltageColor(g, g.voltages[0]));
    line(g, lead2, { x: e.x2, y: e.y2 }, voltageColor(g, g.voltages[1]));
    const mid = interp(lead1, lead2, 0.5);
    circle(g, mid, 9, g.theme.wire, false, 1.5);
    g.ctx.fillStyle = g.theme.text;
    g.ctx.font = canvasFont(9);
    g.ctx.textAlign = 'center';
    g.ctx.textBaseline = 'middle';
    g.ctx.fillText('V', mid.x, mid.y);
    label(g, e, formatValue(g.voltage, 'V'), 18);
  },
};
