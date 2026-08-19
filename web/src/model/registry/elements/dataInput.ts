import { VOLTAGE_COS, VOLTAGE_PULSE_DUTY, VOLTAGE_SHOW_VOLTAGE, DATA_INPUT_REPEAT } from '../flags';
import { onePost, readParams, writeParams, endpointBox } from '../shared';
import { railFileInputDraw } from './audioInput';
import type { ElementDef } from '../../types';

/** The AC waveform's file code, WF_AC (VoltageElm.java:40). */
const AC_WAVEFORM = 1;

export const DATA_INPUT_DEF: ElementDef = {
  kind: 'dataInput',
  label: 'Data input',
  category: 'Sources',
  dumpCode: '424',
  postCount: 1,
  posts: onePost,
  draggablePosts: 2,  // the free end is a control point, not a terminal
  defaultFlags: VOLTAGE_SHOW_VOLTAGE,  // DataInputElm extends RailElm, inherits the voltage source flag
  defaults: {
    waveform: AC_WAVEFORM,
    frequency: 60,
    maxVoltage: 5,
    bias: 0,
    phaseShift: 0,
    dutyCycle: 0.5,
    sampleLength: 1e-3,
    scaleFactor: 1,
    fileNum: 0,
  },
  parse: (t, e) => {
    // The rail's six source tokens, then the element's own three
    // (DataInputElm.java:55-68). The full 9-token form, or the short 3-token
    // form upstream's own dump writes, which reads only the trailing three.
    if (t.length >= 9) {
      readParams(t, e, [
        'waveform',
        'frequency',
        'maxVoltage',
        'bias',
        'phaseShift',
        'dutyCycle',
        'sampleLength',
        'scaleFactor',
        'fileNum',
      ]);
    } else {
      readParams(t, e, ['sampleLength', 'scaleFactor', 'fileNum']);
    }
    // The rail's load-time flag conversions (VoltageElm.java:80-88), then the
    // waveform is pinned to AC, exactly as the token constructor forces WF_AC
    // (DataInputElm.java:58-59).
    if (e.flags & VOLTAGE_COS) {
      e.params.phaseShift = Math.PI / 2;
      e.flags &= ~VOLTAGE_COS;
    }
    e.params.waveform = AC_WAVEFORM;
    e.flags &= ~VOLTAGE_PULSE_DUTY;
  },
  dump: writeParams([
    'waveform',
    'frequency',
    'maxVoltage',
    'bias',
    'phaseShift',
    'dutyCycle',
    'sampleLength',
    'scaleFactor',
    'fileNum',
  ]),
  // getEditInfo order: the file widget, Scale Factor, Sample Length, then the
  // Repeat checkbox (DataInputElm.java:139-169).
  fields: [
    { name: 'fileNum', label: 'Load data file', type: 'file', fileLoad: 'data' },
    { name: 'scaleFactor', label: 'Scale Factor' },
    { name: 'sampleLength', label: 'Sample Length', unit: 's' },
    { name: 'repeat', label: 'Repeat', type: 'bool', flag: DATA_INPUT_REPEAT },
  ],
  // The file-name label at the free end is a solid pick zone (DataInputElm.java).
  bodyRect: (e) => endpointBox(e, 14),
  draw: railFileInputDraw,
};
