import { onePost, readParams, writeParams, endpointBox } from '../shared';
import { modulatedSourceDraw, AM_CIRCLE } from './am';
import type { ElementDef } from '../../types';

/** Load-time only: a legacy cosine flag, cleared on load. Like the AM source's
 *  bit 2 it converts nothing: the token constructor just clears it
 *  (FMElm.java:47-49), so a sine carrier stays a sine carrier. */
const FLAG_COS = 2;

export const FM_DEF: ElementDef = {
  kind: 'fm',
  label: 'FM source',
  category: 'Sources',
  dumpCode: '201',
  postCount: 1,
  posts: onePost,
  draggablePosts: 2,  // the free end is a control point, not a terminal
  // The constructor defaults (FMElm.java:32-38).
  defaults: { carrierFreq: 800, signalFreq: 40, maxVoltage: 5, deviation: 200 },
  // carrierfreq signalfreq maxVoltage deviation (FMElm.java:43-46). FLAG_COS
  // is cleared like the token constructor clears it, so a save never re-emits
  // the bit.
  parse: (t, e) => {
    readParams(t, e, ['carrierFreq', 'signalFreq', 'maxVoltage', 'deviation']);
    e.flags &= ~FLAG_COS;
  },
  dump: writeParams(['carrierFreq', 'signalFreq', 'maxVoltage', 'deviation']),
  // getEditInfo order: Max Voltage, Carrier Frequency, Signal Frequency,
  // Deviation (FMElm.java:151-162).
  fields: [
    { name: 'maxVoltage', label: 'Max Voltage', unit: 'V' },
    { name: 'carrierFreq', label: 'Carrier Frequency', unit: 'Hz' },
    { name: 'signalFreq', label: 'Signal Frequency', unit: 'Hz' },
    { name: 'deviation', label: 'Deviation', unit: 'Hz' },
  ],
  // The circled label at the free end is a solid pick zone (FMElm.java, the
  // AM circle radius).
  bodyRect: (e) => endpointBox(e, AM_CIRCLE),
  draw(g, e) {
    modulatedSourceDraw(g, e, 'FM');
  },
};
