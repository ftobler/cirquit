import { circle, currentDots, elementLength, endpoints, lead, voltageColor } from '../../../render/draw';
import { drawWaveformGlyph, onePost, readParams, writeParams } from '../shared';
import type { ElementDef } from '../../types';

/** Sweep symbol radius (SweepElm.java:49). */
const SWEEP_CIRCLE = 17;

/** SweepElm.java:27-28. */
const FLAG_LOG = 1;
const FLAG_BIDIR = 2;

export const SWEEP_DEF: ElementDef = {
  kind: 'sweep',
  label: 'Sweep',
  category: 'Sources',
  dumpCode: '170',
  postCount: 1,
  posts: onePost,
  draggablePosts: 2,  // the free end is a control point, not a terminal
  defaultLength: 4,          // 64 px, like the voltage source's drag length
  defaultFlags: FLAG_BIDIR,  // SweepElm.java:35
  defaults: { minF: 20, maxF: 4000, maxV: 5, sweepTime: 0.1 },
  parse: (t, e) => {
    readParams(t, e, ['minF', 'maxF', 'maxV', 'sweepTime']);
  },
  dump: writeParams(['minF', 'maxF', 'maxV', 'sweepTime']),
  fields: [
    { name: 'minF', label: 'Min Frequency', unit: 'Hz' },
    { name: 'maxF', label: 'Max Frequency', unit: 'Hz' },
    { name: 'maxV', label: 'Max Voltage', unit: 'V' },
    { name: 'sweepTime', label: 'Sweep Time', unit: 's' },
    { name: 'log', label: 'Log Sweep', type: 'bool', flag: FLAG_LOG },
    { name: 'bidir', label: 'Bidirectional', type: 'bool', flag: FLAG_BIDIR },
  ],
  draw(g, e) {
    const [p1, p2] = endpoints(e);
    const color = voltageColor(g, g.voltages[0]);
    const dn = Math.max(1, elementLength(e));
    // The stem stops one circle radius short of `point2`, which holds the
    // symbol (SweepElm.java:68-71, setPoints).
    const lead1 = {
      x: p2.x - (SWEEP_CIRCLE * (p2.x - p1.x)) / dn,
      y: p2.y - (SWEEP_CIRCLE * (p2.y - p1.y)) / dn,
    };
    lead(g, p1, lead1, color);
    circle(g, p2, SWEEP_CIRCLE, g.theme.text, false);
    drawWaveformGlyph(g, p2, 1, SWEEP_CIRCLE);
    // Stem dots flow symbol-to-post, the same reversal the sweep's ancestor
    // RailElm applies to its stem (SweepElm.java:120, which calls
    // `updateDotCount(-current, ...)`).
    currentDots(g, lead1, p1, g.current);
  },
};
