import { canvasFont, currentDots, endpoints, line, voltageColor } from '../../../render/draw';
import { VOLTAGE_SHOW_VOLTAGE } from '../flags';
import { onePost, readParams } from '../shared';
import { railLabelAnchor, railLead, railText } from './rail';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/**
 * A rail whose output is a slider (WF_VAR), extending from `bias` (min) to
 * `maxVoltage` (max) (VarRailElm.java:29-38). The slider value lives in the
 * `voltage` param; the file stores it in the rail's `frequency` token slot,
 * because upstream reuses that field to track the slider
 * (VarRailElm.java:36, :72). The waveform is always 7 (WF_VAR).
 */
export const VAR_RAIL_DEF: ElementDef = {
  kind: 'varRail',
  label: 'Variable rail',
  category: 'Sources',
  dumpCode: '172',
  postCount: 1,
  posts: onePost,
  // VarRailElm.java:29-38 inherits the voltage source's FLAG_SHOW_VOLTAGE.
  defaultFlags: VOLTAGE_SHOW_VOLTAGE,
  defaults: { maxVoltage: 5, bias: 0, voltage: 5 },
  // The slider caption is every token after the six source tokens, joined with
  // single spaces and `%2B` turned back into `+` (VarRailElm.java:42-45). Like
  // the potentiometer's, it is not escaped; rawTokens keeps the whole tail
  // raw so the caption round-trips through real token boundaries.
  rawTokens: true,
  parse: (t, e) => {
    // The rail's token layout unchanged, except the `frequency` slot carries
    // the current slider value and is read into `voltage`.
    readParams(t, e, ['waveform', 'voltage', 'maxVoltage', 'bias', 'phaseShift', 'dutyCycle']);
    if (t.length > 6) e.text = t.slice(6).join(' ').replace(/%2[bB]/g, '+');
  },
  dump: (e) => {
    const text = e.text?.trim() ? e.text.trim() : 'Voltage';  // VarRailElm.java:35
    return [
      e.params.waveform ?? 7,
      e.params.voltage ?? 5,
      e.params.maxVoltage ?? 5,
      e.params.bias ?? 0,
      e.params.phaseShift ?? 0,
      e.params.dutyCycle ?? 0.5,
      // A `+` is written as `%2B` so it survives the token format, the same
      // encoding VarRailElm.java:45 decodes on load.
      ...text.split(/\s+/).map((w) => w.replace(/\+/g, '%2B')),
    ];
  },
  fields: [
    { name: 'bias', label: 'Min Voltage', unit: 'V' },
    { name: 'maxVoltage', label: 'Max Voltage', unit: 'V' },
    { name: 'text', label: 'Slider Text', type: 'text', target: 'text' },
  ],
  draw(g, e) {
    const [p1, p2] = endpoints(e);
    const color = voltageColor(g, g.voltages[0]);
    const lead1 = railLead(p1, p2);
    line(g, p1, lead1, color);
    // A varRail always draws its current value like a DC rail (RailElm.java:
    // 69-81, WF_VAR is in the DC branch), never the waveform circle.
    const v = e.params.voltage ?? 5;
    drawRailLabel(g, e, lead1, railText(v, g.valueDigits));
    currentDots(g, p1, lead1, g.current);
  },
};

function drawRailLabel(g: DrawContext, e: CircuitElement, lead1: Point, text: string): void {
  const [p1] = endpoints(e);
  const anchor = railLabelAnchor(p1, lead1, g.ctx.measureText(text).width, g.valueFontSize);
  g.ctx.fillStyle = g.theme.text;
  g.ctx.font = canvasFont(g.valueFontSize);
  g.ctx.textAlign = 'left';
  g.ctx.textBaseline = 'middle';
  g.ctx.fillText(text, anchor.x, anchor.y);
}
