import {
  canvasFont,
  elementLength,
  endpoints,
  formatValueShort,
  interp,
  isHighlighted,
  lead,
  voltageColor,
} from '../../../render/draw';
import { OUTPUT_FIXED, OUTPUT_SHOW_VOLTAGE } from '../flags';
import { onePost, readParams, writeParams, endpointBox } from '../shared';
import type { ElementDef } from '../../types';

/** The value body of a fixed-scale readout: `toFixed`'s trailing zeros are
 *  kept when FLAG_FIXED is set and trimmed otherwise, upstream's fixedFormat
 *  vs showFormat (CircuitElm.java:179-184). */
function scaled(v: number, fixed: boolean, digits: number): string {
  const s = v.toFixed(digits);
  return fixed ? s : s.replace(/\.?0+$/, '');
}

/** Readout text of an output, upstream's `getUnitTextWithScale`
 *  (CircuitElm.java:1139-1150): auto picks the engineering-prefix short form,
 *  the fixed scales render the value at that unit. The m/µ prefix drops in
 *  with no space, like every other on-canvas label. */
export function outputText(v: number, scale = 0, fixed = false, digits = 3): string {
  if (!Number.isFinite(v)) return '--';
  if (scale === 1) return `${scaled(v, fixed, digits)}V`;
  if (scale === 2) return `${scaled(v * 1e3, fixed, digits)}mV`;
  if (scale === 3) return `${scaled(v * 1e6, fixed, digits)}µV`;
  return formatValueShort(v, 'V', digits);
}

export const OUTPUT_DEF: ElementDef = {
  kind: 'output',
  label: 'Output',
  category: 'Other',
  dumpCode: 'O',
  postCount: 1,
  posts: onePost,
  draggablePosts: 2,  // the free end is a control point, not a terminal
  parse: (t, e) => readParams(t, e, ['scale']),
  dump: writeParams(['scale']),
  fields: [
    // OutputElm.java:93. Upstream shows Scale and Fixed Precision only while
    // Show Voltage is on, and Fixed Precision only under a fixed scale; the
    // port's field list is static, so the two are always offered. Setting
    // either flag under auto is harmless, since the formatter ignores it.
    { name: 'showVoltage', label: 'Show Voltage', type: 'bool', flag: OUTPUT_SHOW_VOLTAGE },
    {
      name: 'scale',
      label: 'Scale',
      type: 'choice',
      choices: [
        { value: 0, label: 'Auto' },
        { value: 1, label: 'V' },
        { value: 2, label: 'mV' },
        { value: 3, label: 'µV' },
      ],
    },
    { name: 'fixed', label: 'Fixed Precision', type: 'bool', flag: OUTPUT_FIXED },
  ],
  // The readout at the free end is a solid pick zone (OutputElm.java).
  bodyRect: (e) => endpointBox(e, 12),
  // A fresh output draws the literal `out`: upstream's constructor leaves
  // flags 0, so `defaultFlags` stays unset and Show Voltage is the edit toggle
  // (OutputElm.java:31-34, :66). That is what the corpus's flagless lines mean.
  draw(g, e) {
    const [p1, p2] = endpoints(e);
    const s =
      (e.flags & OUTPUT_SHOW_VOLTAGE) !== 0
        ? outputText(g.voltages[0] ?? 0, e.params.scale ?? 0, (e.flags & OUTPUT_FIXED) !== 0, g.valueDigits)
        : 'out';
    // The stem stops half a text width plus 8 short of the anchor, so the lead
    // never runs under the readout (OutputElm.java:71). A collapsed element
    // has no direction to stop along, so the stem degrades to the post.
    const dn = elementLength(e);
    g.ctx.fillStyle = g.theme.text;
    // Upstream bolds the text when the part is selected (OutputElm.java:63);
    // the port's highlight family covers selection, hover and the net shade.
    g.ctx.font = isHighlighted(g) ? `bold ${canvasFont(g.valueFontSize)}` : canvasFont(g.valueFontSize);
    const w = g.ctx.measureText(s).width;
    const lead1 = dn === 0 ? p1 : interp(p1, p2, 1 - (w / 2 + 8) / dn);
    lead(g, p1, lead1, voltageColor(g, g.voltages[0] ?? 0));
    g.ctx.textAlign = 'center';
    g.ctx.textBaseline = 'middle';
    g.ctx.fillText(s, p2.x, p2.y);
  },
};
