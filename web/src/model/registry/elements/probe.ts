import {
  calcLeads,
  canvasFont,
  circle,
  formatValueShort,
  interp,
  label,
  lead,
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
  defaults: { meter: 0, scale: 0, resistance: 1e7 },  // ProbeElm.java:53-54
  parse: (t, e) => {
    readParams(t, e, ['meter', 'scale', 'resistance']);
    // Upstream's file constructor defaults resistance to 0 (ideal) and only
    // overrides it from the third token (ProbeElm.java:61). The `defaults`
    // above give new probes 10 M, so a tokenless legacy line must be forced
    // back to 0 or every bundled probe would load with a 10 M load across
    // whatever it measures. 31 lines in the corpus stop after 6 or 7 tokens.
    if (t.length < 3) e.params.resistance = 0;
  },
  dump: writeParams(['meter', 'scale', 'resistance']),
  fields: [
    {
      name: 'meter',
      label: 'Value',
      type: 'choice',
      // meterChoices() order (ProbeElm.java:444-446); TP_AVG (10) is not
      // contiguous with the others, so the file values are explicit.
      choices: [
        { value: 0, label: 'Voltage' },
        { value: 1, label: 'RMS Voltage' },
        { value: 10, label: 'Average Voltage' },
        { value: 2, label: 'Max Voltage' },
        { value: 3, label: 'Min Voltage' },
        { value: 4, label: 'P2P Voltage' },
        { value: 5, label: 'Binary Value' },
      ],
    },
    { name: 'resistance', label: 'Series resistance', unit: 'Ω' },
  ],
  draw(g, e) {
    const [lead1, lead2] = calcLeads(e, 16);
    lead(g, { x: e.x1, y: e.y1 }, lead1, voltageColor(g, g.voltages[0]));
    lead(g, lead2, { x: e.x2, y: e.y2 }, voltageColor(g, g.voltages[1]));
    const mid = interp(lead1, lead2, 0.5);
    // The circle is a drawThickCircle upstream (ProbeElm.java:232), the
    // 3-unit body weight.
    circle(g, mid, 9, g.theme.wire, false);
    g.ctx.fillStyle = g.theme.text;
    g.ctx.font = canvasFont(9);
    g.ctx.textAlign = 'center';
    g.ctx.textBaseline = 'middle';
    g.ctx.fillText('V', mid.x, mid.y);
    // The label shows the selected meter reading, not the instant differential:
    // for TP_VOL the engine's value is that differential anyway.
  label(g, e, formatValueShort(g.value, 'V', g.valueDigits), 18);
  },
};
