import {
  canvasFont,
  circle,
  currentDots,
  elementLength,
  endpoints,
  lead,
  voltageColor,
} from '../../../render/draw';
import { onePost, readParams, writeParams } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** AM symbol radius (AMElm.java:84). */
const AM_CIRCLE = 17;

/** Load-time only: a legacy cosine flag, cleared on load. Unlike the voltage
 *  source's bit 2 it converts nothing: the token constructor just clears it
 *  (AMElm.java:43-45), so a sine carrier stays a sine carrier. */
const FLAG_COS = 2;

/** Draws the stem, the circled "AM"/"FM" label and the stem dots, shared by
 *  the two modulated sources whose symbols differ only in the caption
 *  (AMElm.java:86-103, FMElm.java:96-113). */
export function modulatedSourceDraw(g: DrawContext, e: CircuitElement, label: string): void {
  const [p1, p2] = endpoints(e);
  const color = voltageColor(g, g.voltages[0]);
  const dn = Math.max(1, elementLength(e));
  // The stem stops one circle radius short of `point2`, which holds the symbol
  // (AMElm.java:116-119, setPoints).
  const lead1: Point = {
    x: p2.x - (AM_CIRCLE * (p2.x - p1.x)) / dn,
    y: p2.y - (AM_CIRCLE * (p2.y - p1.y)) / dn,
  };
  lead(g, p1, lead1, color);
  circle(g, p2, AM_CIRCLE, g.theme.text, false);
  g.ctx.fillStyle = g.theme.text;
  g.ctx.font = canvasFont(12);
  g.ctx.textAlign = 'center';
  g.ctx.textBaseline = 'middle';
  g.ctx.fillText(label, p2.x, p2.y);
  // Stem dots flow symbol-to-post, the reversal the sweep and rail apply to
  // their stems (AMElm.java:100-102, updateDotCount(-current, ...)).
  currentDots(g, lead1, p1, g.current);
}

export const AM_DEF: ElementDef = {
  kind: 'am',
  label: 'AM source',
  category: 'Sources',
  dumpCode: '200',
  postCount: 1,
  posts: onePost,
  draggablePosts: 2,  // the free end is a control point, not a terminal
  // The constructor defaults (AMElm.java:30-35).
  defaults: { carrierFreq: 1000, signalFreq: 40, maxVoltage: 5 },
  // carrierfreq signalfreq maxVoltage (AMElm.java:40-42). FLAG_COS is cleared
  // like the token constructor clears it, so a save never re-emits the bit.
  parse: (t, e) => {
    readParams(t, e, ['carrierFreq', 'signalFreq', 'maxVoltage']);
    e.flags &= ~FLAG_COS;
  },
  dump: writeParams(['carrierFreq', 'signalFreq', 'maxVoltage']),
  // getEditInfo order: Max Voltage, Carrier Frequency, Signal Frequency
  // (AMElm.java:140-149).
  fields: [
    { name: 'maxVoltage', label: 'Max Voltage', unit: 'V' },
    { name: 'carrierFreq', label: 'Carrier Frequency', unit: 'Hz' },
    { name: 'signalFreq', label: 'Signal Frequency', unit: 'Hz' },
  ],
  draw(g, e) {
    modulatedSourceDraw(g, e, 'AM');
  },
};
