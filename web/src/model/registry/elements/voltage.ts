import { formatValue, interp, label } from '../../../render/draw';
import { VOLTAGE_COS, VOLTAGE_PULSE_DUTY, VOLTAGE_SHOW_VOLTAGE } from '../flags';
import { drawSourceCircle, drawWaveformGlyph, readParams, twoPosts, writeParams } from '../shared';
import type { ElementDef } from '../../types';

/** The duty cycle old pulse lines are stuck with (VoltageElm.java:51). */
const DEFAULT_PULSE_DUTY = 1 / (2 * Math.PI);

export const VOLTAGE_DEF: ElementDef = {
  kind: 'voltage',
  label: 'Voltage source',
  category: 'Sources',
  dumpCode: 'v',
  shortcut: 'v',  // DCVoltageElm.java
  postCount: 2,
  posts: twoPosts,
  vertical: true,       // VoltageElm.java:93
  defaultLength: 4,     // 64 px, default getDragLength()
  defaultFlags: VOLTAGE_SHOW_VOLTAGE,
  defaults: {
    waveform: 0,
    frequency: 40,
    maxVoltage: 5,
    bias: 0,
    phaseShift: 0,
    dutyCycle: 0.5,
    riseTime: 0,
  },
  parse: (t, e) => {
    readParams(t, e, ['waveform', 'frequency', 'maxVoltage', 'bias', 'phaseShift', 'dutyCycle']);
    // Old files flagged a cosine as a sine with FLAG_COS; upstream clears the
    // bit and materialises the pi/2 phase so a save is canonical
    // (VoltageElm.java:80-83).
    if (e.flags & VOLTAGE_COS) {
      e.params.phaseShift = Math.PI / 2;
      e.flags &= ~VOLTAGE_COS;
    }
    // Old pulse files predate a configurable duty cycle, so upstream forces
    // the legacy value whenever the flag is absent (VoltageElm.java:85-88).
    if (!(e.flags & VOLTAGE_PULSE_DUTY) && e.params.waveform === 5) {
      e.params.dutyCycle = DEFAULT_PULSE_DUTY;
    }
    // Keep the stored flag in step with the waveform: a pulse source carries
    // bit 4 so a rebuild does not re-apply the normalisation above to an
    // edited duty, and a non-pulse line never carries a stray bit 4.
    if (e.params.waveform === 5) e.flags |= VOLTAGE_PULSE_DUTY;
    else e.flags &= ~VOLTAGE_PULSE_DUTY;
  },
  dump: writeParams(['waveform', 'frequency', 'maxVoltage', 'bias', 'phaseShift', 'dutyCycle']),
  // A pulse line always carries its duty token, so it always carries the flag
  // that says the token is authoritative; otherwise the legacy normalisation
  // above would snap an edited duty back to 1/(2*pi) on the next load.
  dumpFlags: (e) => (e.params.waveform === 5 ? e.flags | VOLTAGE_PULSE_DUTY : e.flags),
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
    { name: 'phaseShift', label: 'Phase offset', unit: 'rad' },
    { name: 'riseTime', label: 'Rise/fall time', unit: 's' },
    { name: 'dutyCycle', label: 'Duty cycle', min: 0, max: 1 },
  ],
  draw(g, e) {
    const [lead1, lead2] = drawSourceCircle(g, e, 12);
    drawWaveformGlyph(g, interp(lead1, lead2, 0.5), e.params.waveform ?? 0, 12);
  label(g, e, formatValue(e.params.maxVoltage ?? 0, 'V', g.valueDigits), 20);
  },
};
