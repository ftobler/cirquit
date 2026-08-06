import {
  canvasFont,
  endpoints,
  formatValue,
  interp,
  interp2,
  line,
  voltageColor,
} from '../../../render/draw';
import { VOLTAGE_SHOW_VOLTAGE } from '../flags';
import { onePost, readParams, writeParams } from '../shared';
import type { ElementDef } from '../../types';

export const RAIL_DEF: ElementDef = {
  kind: 'rail',
  label: 'Voltage rail',
  category: 'Sources',
  dumpCode: 'R',
  postCount: 1,
  posts: onePost,
  defaultFlags: VOLTAGE_SHOW_VOLTAGE,  // RailElm.java:23-24, inherits the voltage source flag
  defaults: { waveform: 0, frequency: 40, maxVoltage: 5, bias: 0, phaseShift: 0, dutyCycle: 0.5 },
  parse: (t, e) =>
    readParams(t, e, ['waveform', 'frequency', 'maxVoltage', 'bias', 'phaseShift', 'dutyCycle']),
  dump: writeParams(['waveform', 'frequency', 'maxVoltage', 'bias', 'phaseShift', 'dutyCycle']),
  fields: [
    { name: 'maxVoltage', label: 'Voltage', unit: 'V' },
    { name: 'frequency', label: 'Frequency', unit: 'Hz' },
  ],
  draw(g, e) {
    const [p1, p2] = endpoints(e);
    const color = voltageColor(g, g.voltages[0]);
    const stem = interp(p1, p2, 0.6);
    line(g, p1, stem, color);
    const [a, b] = interp2(p1, p2, 0.6, 10);
    line(g, a, b, color, 3);
    g.ctx.fillStyle = g.theme.text;
    g.ctx.font = canvasFont(10);
    g.ctx.textAlign = 'center';
    g.ctx.textBaseline = 'bottom';
    const t = interp(p1, p2, 1.0);
    g.ctx.fillText(formatValue(e.params.maxVoltage ?? 0, 'V'), t.x, t.y);
  },
};
