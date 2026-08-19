import {
  canvasFont,
  elementLength,
  endpoints,
  formatValueShort,
  interp,
  isHighlighted,
  lead,
  limbColor,
  voltageColor,
} from '../../../render/draw';
import { TESTPOINT_LABEL } from '../flags';
import { onePost, readParams, endpointBox } from '../shared';
import type { DrawContext, ElementDef } from '../../types';

/** The value caption per meter mode, formatted from the engine's `value()`
 *  (the selected value, TestPointElm.java:319-353) with upstream's units
 *  (TestPointElm.java:180-213): the binary mode is a bare 0/1. */
export function testPointText(meter: number, value: number, digits: number): string {
  switch (meter) {
    case 0:
      return formatValueShort(value, 'V', digits);
    case 1:
      return formatValueShort(value, 'V(rms)', digits);
    case 10:
      return formatValueShort(value, 'V(avg)', digits);
    case 2:
      return formatValueShort(value, 'Vpk', digits);
    case 3:
      return formatValueShort(value, 'Vmin', digits);
    case 4:
      return formatValueShort(value, 'Vp2p', digits);
    case 5:
      return formatValueShort(value, '', digits);
    case 6:
      return formatValueShort(value, 'Hz', digits);
    // TP_PER (7) leaves the value string unset upstream (TestPointElm.java:
    // 204-206), so it stays on the fallback and renders the raw value in V.
    case 8:
      return formatValueShort(value, 's', digits);
    case 9:
      return formatValueShort(value, '', digits);
    default:
      return formatValueShort(value, 'V', digits);
  }
}

/** The label and value, one above the other, upstream's drawText
 *  (TestPointElm.java:139-163): the pair is centred on the free-end point for a
 *  vertical stem, right of it (or left, for a right-to-left stem) for a
 *  horizontal one. */
function drawTestPointText(
  g: DrawContext,
  label: string,
  value: string,
  pt1: { x: number; y: number },
  pt2: { x: number; y: number },
): void {
  const w1 = g.ctx.measureText(label).width;
  const w2 = g.ctx.measureText(value).width;
  const spacing = 14;
  const wmax = Math.max(w1, w2);
  const h = 14;
  let x = pt2.x;
  let y = pt2.y;
  if (pt1.y !== pt2.y) {
    x -= wmax / 2;
    y += Math.sign(pt2.y - pt1.y) * h;
    if (pt2.y < pt1.y) y -= spacing - 4;
  } else if (pt2.x > pt1.x) {
    x += 4;
  } else {
    x -= 4 + wmax;
  }
  g.ctx.textBaseline = 'middle';
  g.ctx.textAlign = 'left';
  g.ctx.fillText(label, x + (wmax - w1) / 2, y);
  g.ctx.fillText(value, x + (wmax - w2) / 2, y + spacing);
}

export const TEST_POINT_DEF: ElementDef = {
  kind: 'testPoint',
  label: 'Test point',
  category: 'Other',
  dumpCode: '368',
  postCount: 1,
  posts: onePost,
  draggablePosts: 2,  // the free end is a control point, not a terminal
  defaultText: 'TP',  // TestPointElm.java:64
  defaults: { meter: 0 },
  parse: (t, e) => {
    readParams(t, e, ['meter']);
    // The label token exists only under FLAG_LABEL (TestPointElm.java:70-73);
    // without it the constructor's default stands.
    if ((e.flags & TESTPOINT_LABEL) !== 0 && t[1] !== undefined) e.text = t[1];
    else if (e.text === undefined) e.text = 'TP';
  },
  dump: (e) => {
    const tokens: (string | number)[] = [e.params.meter ?? 0];
    if (e.text && e.text !== 'TP') tokens.push(e.text);
    return tokens;
  },
  // Upstream never overrides dump(), so its text save drops both the meter and
  // the label; the port writes the meter and, when the label differs from the
  // default, the label under FLAG_LABEL, keeping the token count and the flag
  // in step.
  dumpFlags: (e) =>
    e.text && e.text !== 'TP' ? e.flags | TESTPOINT_LABEL : e.flags & ~TESTPOINT_LABEL,
  fields: [
    {
      name: 'meter',
      label: 'Value',
      type: 'choice',
      // meterChoices() order (TestPointElm.java:448-450); TP_AVG (10) is not
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
    { name: 'text', label: 'Label', type: 'text', target: 'text' },
  ],
  // The label and value text at the free end are a solid pick zone
  // (TestPointElm.java:139-163).
  bodyRect: (e) => endpointBox(e, 16),
  draw(g, e) {
    const [p1, p2] = endpoints(e);
    const selected = isHighlighted(g);
    // Upstream sets a 14 px SansSerif, bold while selected, and colours the
    // text white or selection (TestPointElm.java:168-171).
    g.ctx.font = selected ? `bold ${canvasFont(14)}` : canvasFont(14);
    g.ctx.fillStyle = selected ? g.theme.selection : g.theme.whiteColor;
    const label = e.text ?? 'TP';
    const dn = elementLength(e);
    // The stem stops half a "TP" text width plus 8 short of the free end, so
    // the lead never runs under the text (TestPointElm.java:175). A collapsed
    // element has no direction to stop along, so the stem degrades to the post.
    const wTP = g.ctx.measureText('TP').width;
    const lead1 = dn === 0 ? p1 : interp(p1, p2, 1 - (wTP / 2 + 8) / dn);
    const meter = e.params.meter ?? 0;
    const value = testPointText(meter, g.value, g.valueDigits);
    drawTestPointText(g, label, value, p1, lead1);
    // The stem is voltage-coloured, overridden by the selection colour when
    // highlighted (TestPointElm.java:216-219).
    lead(g, p1, lead1, limbColor(g, voltageColor(g, g.voltages[0])));
  },
};
