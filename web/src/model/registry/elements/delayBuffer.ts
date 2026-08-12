/**
 * The delay buffer: the same IEC rectangle / ANSI triangle as the inverter,
 * but without the output bubble, with the "1" glyph centred on the body
 * (DelayBufferElm.java:65-98).
 */

import {
  canvasFont,
  closedPolyline,
  currentDots,
  elementLength,
  endpoints,
  interp,
  interp2,
  lead,
  voltageColor,
} from '../../../render/draw';
import { readParams, writeParams, twoPosts } from '../shared';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

const HS = 16;    // DelayBufferElm.java:79
const WW = 14;    // DelayBufferElm.java:80 (16-2)

function drawDelayBuffer(g: DrawContext, e: CircuitElement): void {
  const [p1, p2] = endpoints(e);
  const dn = Math.max(1, elementLength(e));
  const ww = Math.min(WW, dn / 2);
  const lead1 = interp(p1, p2, 0.5 - ww / dn);
  const lead2 = interp(p1, p2, 0.5 + ww / dn);

  lead(g, p1, lead1, voltageColor(g, g.voltages[0]));
  lead(g, lead2, p2, voltageColor(g, g.voltages[1]));

  const color = g.theme.wire;
  if (g.euroGates) {
    // The IEC rectangle runs from `lead1` to a point pulled back for the lead
    // gap, and the "1" glyph centres on it (DelayBufferElm.java:85-91).
    const l2 = interp(p1, p2, 0.5 + (ww - 5) / dn);
    const [top, bottom] = interp2(lead1, l2, 0, HS);
    const [bottom2, top2] = interp2(lead1, l2, 1, HS);
    closedPolyline(g, [top, bottom, bottom2, top2, top], color);
    const center = interp(lead1, l2, 0.5);
    g.ctx.fillStyle = g.theme.text;
    g.ctx.font = canvasFont(12);
    g.ctx.textAlign = 'center';
    g.ctx.textBaseline = 'middle';
    g.ctx.fillText('1', center.x, center.y - 6);
  } else {
    // The ANSI triangle, base on the body and apex at the lead gap
    // (DelayBufferElm.java:92-97).
    const [t0, t1] = interp2(lead1, lead2, 0, HS);
    const apex = interp(p1, p2, 0.5 + ww / dn);
    closedPolyline(g, [t0, t1, apex, t0], color);
  }
  // No output bubble: the buffer is non-inverting (DelayBufferElm.java:70-74).
  currentDots(g, lead2, p2, g.current);
}

export const DELAY_BUFFER_DEF: ElementDef = {
  kind: 'delayBuffer',
  label: 'Delay buffer',
  category: 'Logic',
  dumpCode: '422',
  postCount: 2,
  posts: twoPosts,
  noDiagonal: true,   // DelayBufferElm.java:31, :38
  defaultLength: 4,   // the base getDragLength() of 64
  // The no-arg constructor defaults: `delay` is never set, so a fresh part
  // starts at 0 (DelayBufferElm.java:29-34).
  defaults: { delay: 0, threshold: 2.5, highVoltage: 5 },
  // delay, then optional threshold highVoltage, both defaults 2.5/5 on load
  // (DelayBufferElm.java:39-46). Upstream's own dump never writes the tokens;
  // this port writes all three.
  parse: (t, e) => readParams(t, e, ['delay', 'threshold', 'highVoltage']),
  dump: writeParams(['delay', 'threshold', 'highVoltage']),
  fields: [
    { name: 'delay', label: 'Delay', unit: 's' },
    { name: 'threshold', label: 'Threshold', unit: 'V' },
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
  ],
  draw: drawDelayBuffer,
};
