import {
  calcLeads,
  canvasFont,
  circle,
  drawLeads,
  formatValueShort,
  interp,
  label,
} from '../../../render/draw';
import { readParams, twoPosts, writeParams, bodyBox } from '../shared';
import type { ElementDef } from '../../types';

export const OHMMETER_DEF: ElementDef = {
  kind: 'ohmmeter',
  label: 'Ohmmeter',
  category: 'Other',
  dumpCode: '216',
  postCount: 2,
  posts: twoPosts,
  // CurrentElm tokens: the ohmmeter is an ideal 0.01 A current source with no
  // compliance (OhmMeterElm extends CurrentElm). getEditInfo is commented out
  // upstream, so the values only ever come from the file.
  defaults: { current: 0.01, maxVoltage: 0 },
  parse: (t, e) => readParams(t, e, ['current', 'maxVoltage']),
  dump: writeParams(['current', 'maxVoltage']),
  // The 12-radius disc is a solid pick zone (OhmMeterElm.java:17, :25).
  bodyRect: (e) => bodyBox(e, 26, 12),
  draw(g, e) {
    const [lead1, lead2] = calcLeads(e, 26);  // OhmMeterElm.java:17
    drawLeads(g, e, lead1, lead2);
    const mid = interp(lead1, lead2, 0.5);
    // The circle is a drawThickCircle upstream (OhmMeterElm.java:25), the
    // 3-unit body weight.
    circle(g, mid, 12, g.theme.wire, false);
    g.ctx.fillStyle = g.theme.text;
    g.ctx.font = canvasFont(10);
    g.ctx.textAlign = 'center';
    g.ctx.textBaseline = 'middle';
    g.ctx.fillText('Ω', mid.x, mid.y);
    // The reading only exists while current flows; upstream draws it only
    // when `current != 0` and shows infinity otherwise (OhmMeterElm.java:30-33).
    // The value is the port's short Ω form: the Ω glyph is already in the
    // circle, so the caption is the bare scaled number, like a resistor.
    if (g.current !== 0) {
      label(g, e, formatValueShort(g.value, 'Ω', g.valueDigits), 14);
    }
  },
};
