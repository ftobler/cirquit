import { canvasFont, currentDots, endpoints, lead, voltageColor } from '../../../render/draw';
import { VOLTAGE_COS, VOLTAGE_PULSE_DUTY, VOLTAGE_SHOW_VOLTAGE } from '../flags';
import { onePost, readParams, writeParams, endpointBox } from '../shared';
import { railLabelAnchor, railLead } from './rail';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** The AC waveform's file code, WF_AC (VoltageElm.java:40). */
const AC_WAVEFORM = 1;

/** Draws the audio/data input rail: a stem from the post to the free end and
 *  the loaded file's basename as the rail label, with the dots running
 *  symbol-to-post like the antenna (RailElm.java:50-64,
 *  AudioInputElm.java:117-123, DataInputElm.java:106-112). */
export function railFileInputDraw(g: DrawContext, e: CircuitElement): void {
  const [p1, p2] = endpoints(e);
  const color = voltageColor(g, g.voltages[0]);
  const lead1 = railLead(p1, p2);
  // A single stem from the post to the symbol end, then the rail label, which
  // reads "No file" before any file is loaded (AudioInputElm.java:118).
  lead(g, p1, lead1, color);
  drawRailFileLabel(g, e, lead1, e.text ?? 'No file');
  // RailElm.draw's stem dots run against the reported current
  // (RailElm.java:61-63), i.e. symbol-to-post here.
  currentDots(g, lead1, p1, g.current);
}

function drawRailFileLabel(g: DrawContext, e: CircuitElement, lead1: Point, text: string): void {
  const [p1] = endpoints(e);
  const anchor = railLabelAnchor(p1, lead1, g.ctx.measureText(text).width, g.valueFontSize);
  g.ctx.fillStyle = g.theme.text;
  g.ctx.font = canvasFont(g.valueFontSize);
  g.ctx.textAlign = 'left';
  g.ctx.textBaseline = 'middle';
  g.ctx.fillText(text, anchor.x, anchor.y);
}

export const AUDIO_INPUT_DEF: ElementDef = {
  kind: 'audioInput',
  label: 'Audio input',
  category: 'Sources',
  dumpCode: '411',
  postCount: 1,
  posts: onePost,
  draggablePosts: 2,  // the free end is a control point, not a terminal
  defaultFlags: VOLTAGE_SHOW_VOLTAGE,  // AudioInputElm extends RailElm, inherits the voltage source flag
  defaults: {
    waveform: AC_WAVEFORM,
    frequency: 60,
    maxVoltage: 5,
    bias: 0,
    phaseShift: 0,
    dutyCycle: 0.5,
    startPosition: 0,
    fileNum: 0,
  },
  parse: (t, e) => {
    // The rail's six source tokens, then the element's own three
    // (AudioInputElm.java:57-66). The full 9-token form repeats maxVoltage;
    // the short 3-token form (upstream's own dump, whose base CircuitElm.dump
    // carries no tokens) reads only the trailing three.
    if (t.length >= 9) {
      readParams(t, e, [
        'waveform',
        'frequency',
        'maxVoltage',
        'bias',
        'phaseShift',
        'dutyCycle',
        'maxVoltage',
        'startPosition',
        'fileNum',
      ]);
    } else {
      readParams(t, e, ['maxVoltage', 'startPosition', 'fileNum']);
    }
    // The rail's load-time flag conversions (VoltageElm.java:80-88), then the
    // waveform is pinned to AC, exactly as the token constructor forces WF_AC
    // regardless of the token it read (AudioInputElm.java:60-61).
    if (e.flags & VOLTAGE_COS) {
      e.params.phaseShift = Math.PI / 2;
      e.flags &= ~VOLTAGE_COS;
    }
    e.params.waveform = AC_WAVEFORM;
    e.flags &= ~VOLTAGE_PULSE_DUTY;
  },
  // readParams last-write-wins means the later maxVoltage token is the
  // element's own value, so writing the full nine names is safe.
  dump: writeParams([
    'waveform',
    'frequency',
    'maxVoltage',
    'bias',
    'phaseShift',
    'dutyCycle',
    'maxVoltage',
    'startPosition',
    'fileNum',
  ]),
  // getEditInfo order: the file widget, then Max Voltage and Start Position
  // (AudioInputElm.java:152-170).
  fields: [
    { name: 'fileNum', label: 'Load audio file', type: 'file', fileLoad: 'audio' },
    { name: 'maxVoltage', label: 'Max Voltage', unit: 'V' },
    { name: 'startPosition', label: 'Start Position', unit: 's' },
  ],
  // The file-name label at the free end is a solid pick zone (AudioInputElm.java).
  bodyRect: (e) => endpointBox(e, 14),
  draw: railFileInputDraw,
};
