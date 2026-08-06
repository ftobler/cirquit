import {
  canvasFont,
  endpoints,
  formatValue,
  interp,
  interp2,
  line,
  voltageColor,
} from '../../../render/draw';
import { VOLTAGE_COS, VOLTAGE_PULSE_DUTY, VOLTAGE_SHOW_VOLTAGE } from '../flags';
import { onePost, readParams, writeParams } from '../shared';
import type { ElementDef } from '../../types';

/** The duty cycle old pulse lines are stuck with (VoltageElm.java:51). */
const DEFAULT_PULSE_DUTY = 1 / (2 * Math.PI);

export const RAIL_DEF: ElementDef = {
  kind: 'rail',
  label: 'Voltage rail',
  category: 'Sources',
  dumpCode: 'R',
  postCount: 1,
  posts: onePost,
  defaultFlags: VOLTAGE_SHOW_VOLTAGE,  // RailElm.java:23-24, inherits the voltage source flag
  defaults: { waveform: 0, frequency: 40, maxVoltage: 5, bias: 0, phaseShift: 0, dutyCycle: 0.5 },
  parse: (t, e) => {
    readParams(t, e, ['waveform', 'frequency', 'maxVoltage', 'bias', 'phaseShift', 'dutyCycle']);
    // The rail shares the voltage source's load-time flag conversions
    // (VoltageElm.java:80-88), since RailElm extends VoltageElm.
    if (e.flags & VOLTAGE_COS) {
      e.params.phaseShift = Math.PI / 2;
      e.flags &= ~VOLTAGE_COS;
    }
    if (!(e.flags & VOLTAGE_PULSE_DUTY) && e.params.waveform === 5) {
      e.params.dutyCycle = DEFAULT_PULSE_DUTY;
    }
    // Same stored-flag invariant as the voltage source: bit 4 tracks the
    // waveform so a rebuild never re-normalises an edited duty.
    if (e.params.waveform === 5) e.flags |= VOLTAGE_PULSE_DUTY;
    else e.flags &= ~VOLTAGE_PULSE_DUTY;
  },
  dump: writeParams(['waveform', 'frequency', 'maxVoltage', 'bias', 'phaseShift', 'dutyCycle']),
  // Same canonicalisation as the voltage source: a pulse line's duty token is
  // authoritative and says so, or the next load would normalise it away.
  dumpFlags: (e) => (e.params.waveform === 5 ? e.flags | VOLTAGE_PULSE_DUTY : e.flags),
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
