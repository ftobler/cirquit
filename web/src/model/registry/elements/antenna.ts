import { canvasFont, currentDots, endpoints, lead, voltageColor } from '../../../render/draw';
import { VOLTAGE_COS, VOLTAGE_PULSE_DUTY, VOLTAGE_SHOW_VOLTAGE } from '../flags';
import { onePost, readParams, writeParams, endpointBox } from '../shared';
import { railLabelAnchor, railLead } from './rail';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** The AC waveform's file code, WF_AC (VoltageElm.java:40). */
const AC_WAVEFORM = 1;

export const ANTENNA_DEF: ElementDef = {
  kind: 'antenna',
  label: 'Antenna',
  category: 'Sources',
  dumpCode: 'A',
  postCount: 1,
  posts: onePost,
  draggablePosts: 2,  // the free end is a control point, not a terminal
  defaultFlags: VOLTAGE_SHOW_VOLTAGE,  // AntennaElm extends RailElm, inherits the voltage source flag
  defaults: {
    waveform: AC_WAVEFORM,
    frequency: 40,
    maxVoltage: 5,
    bias: 0,
    phaseShift: 0,
    dutyCycle: 0.5,
  },
  parse: (t, e) => {
    // The rail shares the voltage source's load-time flag conversions
    // (VoltageElm.java:80-88), since AntennaElm extends RailElm.
    readParams(t, e, ['waveform', 'frequency', 'maxVoltage', 'bias', 'phaseShift', 'dutyCycle']);
    if (e.flags & VOLTAGE_COS) {
      e.params.phaseShift = Math.PI / 2;
      e.flags &= ~VOLTAGE_COS;
    }
    // Then the waveform is pinned to AC, exactly as the token constructor
    // forces WF_AC regardless of the token it read (AntennaElm.java:24-28).
    e.params.waveform = AC_WAVEFORM;
    e.flags &= ~VOLTAGE_PULSE_DUTY;
  },
  dump: writeParams(['waveform', 'frequency', 'maxVoltage', 'bias', 'phaseShift', 'dutyCycle']),
  // getEditInfo returns null (AntennaElm.java:54-56), so there are no fields.
  fields: [],
  // The "Ant" label at the free end is a solid pick zone (AntennaElm.java).
  bodyRect: (e) => endpointBox(e, 14),
  draw(g, e) {
    const [p1, p2] = endpoints(e);
    const color = voltageColor(g, g.voltages[0]);
    const lead1 = railLead(p1, p2);
    // A single stem from the post to the symbol end, then the "Ant" label the
    // rail draws for the antenna (RailElm.java:50-64, AntennaElm.java:31-33).
    lead(g, p1, lead1, color);
    drawAntennaLabel(g, e, lead1);
    // AntennaElm inherits RailElm.draw, whose stem dots run against the
    // reported current (RailElm.java:61-63), i.e. symbol-to-post here.
    currentDots(g, lead1, p1, g.current);
  },
};

function drawAntennaLabel(g: DrawContext, e: CircuitElement, lead1: Point): void {
  const [p1] = endpoints(e);
  const text = 'Ant';
  const anchor = railLabelAnchor(p1, lead1, g.ctx.measureText(text).width, g.valueFontSize);
  g.ctx.fillStyle = g.theme.text;
  g.ctx.font = canvasFont(g.valueFontSize);
  g.ctx.textAlign = 'left';
  g.ctx.textBaseline = 'middle';
  g.ctx.fillText(text, anchor.x, anchor.y);
}
