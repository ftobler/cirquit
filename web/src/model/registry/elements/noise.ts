import { canvasFont, currentDots, endpoints, lead, voltageColor } from '../../../render/draw';
import { VOLTAGE_COS, VOLTAGE_PULSE_DUTY, VOLTAGE_SHOW_VOLTAGE } from '../flags';
import { onePost, readParams, writeParams } from '../shared';
import { railLabelAnchor, railLead } from './rail';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** The noise waveform's file code, WF_NOISE (VoltageElm.java:45). */
const NOISE_WAVEFORM = 6;

export const NOISE_DEF: ElementDef = {
  kind: 'noise',
  label: 'Noise',
  category: 'Sources',
  dumpCode: 'n',
  postCount: 1,
  posts: onePost,
  draggablePosts: 2,  // the free end is a control point, not a terminal
  defaultFlags: VOLTAGE_SHOW_VOLTAGE,  // NoiseElm extends RailElm, inherits the voltage source flag
  defaults: {
    waveform: NOISE_WAVEFORM,
    frequency: 40,
    maxVoltage: 5,
    bias: 0,
    phaseShift: 0,
    dutyCycle: 0.5,
  },
  parse: (t, e) => {
    readParams(t, e, ['waveform', 'frequency', 'maxVoltage', 'bias', 'phaseShift', 'dutyCycle']);
    // The rail shares the voltage source's load-time flag conversions
    // (VoltageElm.java:80-88), since NoiseElm extends RailElm.
    if (e.flags & VOLTAGE_COS) {
      e.params.phaseShift = Math.PI / 2;
      e.flags &= ~VOLTAGE_COS;
    }
    // Then the waveform is pinned, exactly as the token constructor forces
    // WF_NOISE regardless of the token it read (NoiseElm.java:24-28).
    e.params.waveform = NOISE_WAVEFORM;
    e.flags &= ~VOLTAGE_PULSE_DUTY;
  },
  dump: writeParams(['waveform', 'frequency', 'maxVoltage', 'bias', 'phaseShift', 'dutyCycle']),
  fields: [
    { name: 'maxVoltage', label: 'Voltage', unit: 'V' },
    { name: 'frequency', label: 'Frequency', unit: 'Hz' },
  ],
  draw(g, e) {
    const [p1, p2] = endpoints(e);
    const color = voltageColor(g, g.voltages[0]);
    const lead1 = railLead(p1, p2);
    // A single stem from the post to the symbol end, then the "Noise" label
    // the rail draws for WF_NOISE (RailElm.java:50-64).
    lead(g, p1, lead1, color);
    drawNoiseLabel(g, e, lead1);
    // NoiseElm inherits RailElm.draw, whose stem dots run against the
    // reported current (RailElm.java:61-63), i.e. symbol-to-post here.
    currentDots(g, lead1, p1, g.current);
  },
};

function drawNoiseLabel(g: DrawContext, e: CircuitElement, lead1: Point): void {
  const [p1] = endpoints(e);
  const text = 'Noise';
  const anchor = railLabelAnchor(p1, lead1, g.ctx.measureText(text).width, g.valueFontSize);
  g.ctx.fillStyle = g.theme.text;
  g.ctx.font = canvasFont(g.valueFontSize);
  g.ctx.textAlign = 'left';
  g.ctx.textBaseline = 'middle';
  g.ctx.fillText(text, anchor.x, anchor.y);
}
