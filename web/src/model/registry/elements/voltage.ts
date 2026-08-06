import { formatValue, interp, label } from '../../../render/draw';
import { VOLTAGE_SHOW_VOLTAGE } from '../flags';
import { drawSourceCircle, drawWaveformGlyph, readParams, twoPosts, writeParams } from '../shared';
import type { ElementDef } from '../../types';

export const VOLTAGE_DEF: ElementDef = {
  kind: 'voltage',
  label: 'Voltage source',
  category: 'Sources',
  dumpCode: 'v',
  postCount: 2,
  posts: twoPosts,
  vertical: true,       // VoltageElm.java:93
  defaultLength: 4,     // 64 px, default getDragLength()
  defaultFlags: VOLTAGE_SHOW_VOLTAGE,
  defaults: { waveform: 0, frequency: 40, maxVoltage: 5, bias: 0, phaseShift: 0, dutyCycle: 0.5 },
  parse: (t, e) =>
    readParams(t, e, ['waveform', 'frequency', 'maxVoltage', 'bias', 'phaseShift', 'dutyCycle']),
  dump: writeParams(['waveform', 'frequency', 'maxVoltage', 'bias', 'phaseShift', 'dutyCycle']),
  fields: [
    {
      name: 'waveform',
      label: 'Waveform',
      type: 'choice',
      choices: [
        { value: 0, label: 'DC' },
        { value: 1, label: 'Sine' },
        { value: 2, label: 'Square' },
        { value: 3, label: 'Triangle' },
        { value: 4, label: 'Sawtooth' },
        { value: 5, label: 'Pulse' },
        { value: 6, label: 'Noise' },
      ],
    },
    { name: 'maxVoltage', label: 'Amplitude', unit: 'V' },
    { name: 'frequency', label: 'Frequency', unit: 'Hz' },
    { name: 'bias', label: 'DC offset', unit: 'V' },
    { name: 'dutyCycle', label: 'Duty cycle', min: 0, max: 1 },
  ],
  draw(g, e) {
    const [lead1, lead2] = drawSourceCircle(g, e, 12);
    drawWaveformGlyph(g, interp(lead1, lead2, 0.5), e.params.waveform ?? 0, 12);
    label(g, e, formatValue(e.params.maxVoltage ?? 0, 'V'), 20);
  },
};
