import {
  arrowHead,
  calcLeads,
  canvasFont,
  circle,
  currentDots,
  currentDotsFrom,
  dsign,
  dotPhaseAfter,
  drawLeads,
  elementLength,
  endpoints,
  formatValueShort,
  interp,
  label,
  lead,
  voltageColor,
} from '../../../render/draw';
import { readParams, twoPosts, writeParams, bodyBox } from '../shared';
import type { ElementDef } from '../../types';

// AmmeterElm.java:85-86. Kept local: these two bits are the ammeter's own
// file-format contract, not yet shared with another element.
const AMMETER_SHOW_CURRENT = 1;
const AMMETER_CIRCLE = 2;

/** `####.#` formatting for the fixed-scale choices, the same trim formatValue
 *  applies after its engineering prefix (CircuitElm.java:163-167). */
function fixed(v: number, digits: number): string {
  const t = v.toFixed(digits);
  return t.includes('.') ? t.replace(/\.?0+$/, '') : t;
}

export const AMMETER_DEF: ElementDef = {
  kind: 'ammeter',
  label: 'Ammeter',
  category: 'Other',
  dumpCode: '370',
  postCount: 2,
  posts: twoPosts,
  defaultFlags: AMMETER_SHOW_CURRENT | AMMETER_CIRCLE,  // AmmeterElm.java:46
  defaults: { meter: 0, scale: 0 },  // AmmeterElm.java:47, 52-56
  parse: (t, e) => readParams(t, e, ['meter', 'scale']),
  dump: writeParams(['meter', 'scale']),
  fields: [
    {
      name: 'meter',
      label: 'Value',
      type: 'choice',
      choices: [
        { value: 0, label: 'Current' },
        { value: 1, label: 'RMS Current' },
      ],
    },
    {
      name: 'scale',
      label: 'Scale',
      type: 'choice',
      choices: [
        { value: 0, label: 'Auto' },
        { value: 1, label: 'A' },
        { value: 2, label: 'mA' },
        { value: 3, label: 'µA' },
      ],
    },
    { name: 'circular', label: 'Circular Symbol', type: 'bool', flag: AMMETER_CIRCLE },
  ],
  // The 12-radius disc of the circular symbol (AmmeterElm.java:172, :204) is
  // a solid pick zone; the arrow form rides the axis, which the axis band and
  // posts already reach.
  bodyRect: (e) => bodyBox(e, 24, 12),
  draw(g, e) {
    const [p1, p2] = endpoints(e);
    if ((e.flags & AMMETER_CIRCLE) !== 0) {
      const [lead1, lead2] = calcLeads(e, 24);  // circleSize*2 (AmmeterElm.java:204)
      drawLeads(g, e, lead1, lead2);
      const mid = interp(lead1, lead2, 0.5);
      // The circle is a drawThickCircle upstream (AmmeterElm.java:172), the
      // 3-unit body weight.
      circle(g, mid, 12, g.theme.wire, false);
      g.ctx.fillStyle = g.theme.text;
      g.ctx.font = canvasFont(10);
      g.ctx.textAlign = 'center';
      g.ctx.textBaseline = 'middle';
      g.ctx.fillText('A', mid.x, mid.y);
      // Plus mark on the post-0 (positive) side of the circle, off the axis by
      // dsign (AmmeterElm.java:178-183).
      const dn = elementLength(e);
      if (dn > 0) {
        const plus = interp(p1, p2, 0.5 - 16 / dn, -10 * dsign(p1, p2));
        g.ctx.fillText('+', plus.x, plus.y);
      }
      // The circle opens a gap in the current path, so the dots run each lead
      // separately with the second starting at the phase the first would have
      // reached at the gap, like the source symbol.
      if ((e.flags & AMMETER_SHOW_CURRENT) !== 0) {
        const leadLen = Math.hypot(lead1.x - p1.x, lead1.y - p1.y);
        currentDotsFrom(g, p1, lead1, g.current, g.dotPhase);
        currentDotsFrom(g, lead2, p2, g.current, dotPhaseAfter(g.dotPhase, leadLen));
      }
    } else {
      // A thick line with an arrow toward the current direction, the meter's
      // other symbol (AmmeterElm.java:162-164).
      lead(g, p1, p2, voltageColor(g, g.voltages[0]));
      const mid = interp(p1, p2, 0.6);
      arrowHead(g, p1, mid, 14, voltageColor(g, g.voltages[0]));
      if ((e.flags & AMMETER_SHOW_CURRENT) !== 0) {
        currentDots(g, p1, p2, g.current);
      }
    }
    // The label shows the selected meter reading: the engine's `value` is the
    // instant current for AM_VOL and the half-cycle RMS for AM_RMS.
    const value = g.value;
    const unit = (e.params.meter ?? 0) === 1 ? 'A(rms)' : 'A';
    const scale = e.params.scale ?? 0;
    let text: string;
    if (scale === 1) text = `${fixed(value, g.valueDigits)}${unit}`;
    else if (scale === 2) text = `${fixed(value * 1e3, g.valueDigits)}m${unit}`;
    else if (scale === 3) text = `${fixed(value * 1e6, g.valueDigits)}µ${unit}`;
    else text = formatValueShort(value, unit, g.valueDigits);
    label(g, e, text, 18);
  },
};
