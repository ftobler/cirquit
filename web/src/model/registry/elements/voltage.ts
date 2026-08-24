import {
  calcLeads,
  currentDots,
  drawLeads,
  endpoints,
  formatValueShort,
  interp,
  interp2,
  label,
  line,
  voltageColor,
} from '../../../render/draw';
import { VOLTAGE_CIRCLE_SYMBOL, VOLTAGE_COS, VOLTAGE_PULSE_DUTY, VOLTAGE_SHOW_VOLTAGE, VOLTAGE_TIME_SPEC } from '../flags';
import { drawSourceCircle, drawWaveformGlyph, boxOfPoints, readParams, twoPosts, writeParams } from '../shared';
import type { CircuitElement, ElementDef, FieldDef } from '../../types';

/** The duty cycle old pulse lines are stuck with (VoltageElm.java:51). */
const DEFAULT_PULSE_DUTY = 1 / (2 * Math.PI);

/**
 * The frequency a loaded line seeds when its token is missing
 * (VoltageElm.java:66): the file constructor runs at 40 Hz, and only the
 * toolbar constructor starts a fresh part at 60 (VoltageElm.java:57).
 */
export const FILE_FREQUENCY = 40;

/** The Waveform choice's options, identical for the voltage source and the
 *  rail (VoltageElm.java:521-532). */
export const WAVEFORM_CHOICES = [
  { value: 0, label: 'DC' },
  { value: 1, label: 'Sine' },
  { value: 2, label: 'Square' },
  { value: 3, label: 'Triangle' },
  { value: 4, label: 'Sawtooth' },
  { value: 5, label: 'Pulse' },
  { value: 6, label: 'Noise' },
];

/** The square/pulse waveforms, upstream's hasTimingOptions
 *  (VoltageElm.java:494). They are the only ones whose shapes take a duty
 *  cycle and a rise time, so only they offer the Specify As choice and the
 *  time-spec pair. */
export function hasTimingOptions(e: CircuitElement): boolean {
  const wf = e.params.waveform ?? 0;
  return wf === 2 || wf === 5;
}

/** The High Time / Low Time rows show only under FLAG_TIME_SPEC and only for
 *  square/pulse, upstream's timeSpec() (VoltageElm.java:495). A loaded sine
 *  with the bit set keeps the flag but shows the frequency rows. */
export function timeSpec(e: CircuitElement): boolean {
  return hasTimingOptions(e) && (e.flags & VOLTAGE_TIME_SPEC) !== 0;
}

/** The frequency and phase rows show for every waveform but DC and noise
 *  (VoltageElm.java:553-554). */
export function hasFrequencyRows(e: CircuitElement): boolean {
  const wf = e.params.waveform ?? 0;
  return wf !== 0 && wf !== 6;
}

/** The amplitude row's caption: "Voltage" on DC, "Max Voltage" otherwise
 *  (VoltageElm.java:552-554). Shared by the rail, whose dialog is the same
 *  table. */
export function amplitudeLabel(e: CircuitElement): string {
  return (e.params.waveform ?? 0) === 0 ? 'Voltage' : 'Max Voltage';
}

/** The rows below Show Voltage, shared by the voltage source and the rail:
 *  upstream's frequency-offset block (VoltageElm.java:552-591). DC and noise
 *  offer nothing more; sine/triangle/sawtooth keep frequency + phase; the
 *  square/pulse family adds the Specify As choice, the time-spec pair and the
 *  rise time. Under FLAG_TIME_SPEC the frequency and duty rows are replaced
 *  by the High Time / Low Time pair, which display and write back
 *  dutyCycle/frequency without inventing new storage. */
export function waveformRows(): FieldDef[] {
  return [
    {
      name: 'specifyAs',
      label: 'Specify As',
      type: 'choice',
      flag: VOLTAGE_TIME_SPEC,
      choices: [
        { value: 0, label: 'Frequency/Duty Cycle' },
        { value: 1, label: 'High Time/Low Time' },
      ],
      visible: hasTimingOptions,
    },
    {
      name: 'frequency',
      label: 'Frequency',
      unit: 'Hz',
      visible: (e) => hasFrequencyRows(e) && !timeSpec(e),
    },
    {
      name: 'highTime',
      label: 'High Time',
      unit: 's',
      visible: timeSpec,
      get: (e) => (e.params.dutyCycle ?? 0) / (e.params.frequency ?? 0),
      apply: (e, v) => {
        // High time edited: the low time stays what the stored pair implies
        // and both times recompute the pair (VoltageElm.java:636-641). A zero
        // or negative time leaves the pair untouched, upstream's guard.
        const lowTime = (1 - (e.params.dutyCycle ?? 0)) / (e.params.frequency ?? 0);
        if (v > 0 && lowTime > 0) {
          e.params.frequency = 1 / (v + lowTime);
          e.params.dutyCycle = v / (v + lowTime);
        }
      },
    },
    {
      name: 'phaseShift',
      label: 'Phase offset',
      unit: 'rad',
      visible: hasFrequencyRows,
    },
    {
      name: 'lowTime',
      label: 'Low Time',
      unit: 's',
      visible: timeSpec,
      get: (e) => (1 - (e.params.dutyCycle ?? 0)) / (e.params.frequency ?? 0),
      apply: (e, v) => {
        // Low time edited: the high time stays what the stored pair implies
        // and both times recompute the pair (VoltageElm.java:652-657).
        const highTime = (e.params.dutyCycle ?? 0) / (e.params.frequency ?? 0);
        if (highTime > 0 && v > 0) {
          e.params.frequency = 1 / (highTime + v);
          e.params.dutyCycle = highTime / (highTime + v);
        }
      },
    },
    {
      name: 'dutyCycle',
      label: 'Duty cycle',
      min: 0,
      max: 1,
      visible: (e) => hasTimingOptions(e) && !timeSpec(e),
    },
    {
      name: 'riseTime',
      label: 'Rise/fall time',
      unit: 's',
      visible: hasTimingOptions,
    },
  ];
}

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
    // The toolbar constructor's values (VoltageElm.java:52-58). A short
    // loaded line keeps the file constructor's 40 Hz seed instead; see parse.
    waveform: 0,
    frequency: 60,
    maxVoltage: 5,
    bias: 0,
    phaseShift: 0,
    dutyCycle: 0.5,
    riseTime: 0,
  },
  parse: (t, e) => {
    readParams(t, e, ['waveform', 'frequency', 'maxVoltage', 'bias', 'phaseShift', 'dutyCycle']);
    // A line that stops before the frequency token keeps the file
    // constructor's seed (VoltageElm.java:65-66), not the fresh part's 60:
    // grid2.txt's `v` carries nothing but its waveform token.
    if (t.length < 2) e.params.frequency = FILE_FREQUENCY;
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
    { name: 'maxVoltage', label: amplitudeLabel, unit: 'V' },
    {
      name: 'waveform',
      label: 'Waveform',
      type: 'choice',
      choices: WAVEFORM_CHOICES,
    },
    { name: 'bias', label: 'DC offset', unit: 'V' },
    { name: 'showVoltage', label: 'Show Voltage', type: 'bool', flag: VOLTAGE_SHOW_VOLTAGE },
    // Upstream shows this only on the DC waveform (VoltageElm.java:563-566);
    // every other waveform always draws the circle and the flag means nothing.
    {
      name: 'circleSymbol',
      label: 'Circle Symbol',
      type: 'bool',
      flag: VOLTAGE_CIRCLE_SYMBOL,
      visible: (e) => (e.params.waveform ?? 0) === 0,
    },
    ...waveformRows(),
  ],
  // The drawn body is a solid pick zone, so a click on the source disc or the
  // battery plates grabs the element rather than falling through to the wires.
  bodyRect: (e) => {
    const [lead1, lead2] = calcLeads(e, 8);
    const wf = e.params.waveform ?? 0;
    if (wf === 0 && (e.flags & VOLTAGE_CIRCLE_SYMBOL) === 0) {
      // The two-plate battery: a short plate at lead1 and a long one at lead2.
      const [s1, s2] = interp2(lead1, lead2, 0, 10);
      const [l1, l2] = interp2(lead1, lead2, 1, 16);
      return boxOfPoints([s1, s2, l1, l2]);
    }
    // The circle symbol: a source circle of radius 12 around the body centre.
    const mid = interp(lead1, lead2, 0.5);
    return boxOfPoints([
      { x: mid.x - 12, y: mid.y - 12 },
      { x: mid.x + 12, y: mid.y - 12 },
      { x: mid.x + 12, y: mid.y + 12 },
      { x: mid.x - 12, y: mid.y + 12 },
    ]);
  },
  draw(g, e) {
    const wf = e.params.waveform ?? 0;
    if (wf === 0 && (e.flags & VOLTAGE_CIRCLE_SYMBOL) === 0) {
      // The two-plate battery: a short plate at lead1 and a long one at
      // lead2, the leads 8 units long each side (VoltageElm.java:252,
      // :281-291). Each plate takes its own post's colour; the current dots
      // run the whole path, through the plate gap (VoltageElm.java:325-326).
      const [p1, p2] = endpoints(e);
      const [lead1, lead2] = calcLeads(e, 8);
      drawLeads(g, e, lead1, lead2);
      // Each plate takes its own post's voltage colour, like the capacitor
      // plates (capacitor.ts:59-60), upstream's per-post setVoltageColor with
      // power colouring forced off (VoltageElm.java:282-291).
      const [s1, s2] = interp2(lead1, lead2, 0, 10);
      line(g, s1, s2, voltageColor(g, g.voltages[0]));
      const [l1, l2] = interp2(lead1, lead2, 1, 16);
      line(g, l1, l2, voltageColor(g, g.voltages[1]));
      currentDots(g, p1, p2, g.current);
      // The value caption clears the long plate's reach (hs = 16,
      // VoltageElm.java:319), and only draws under FLAG_SHOW_VOLTAGE: the
      // Show Voltage checkbox is its control, upstream's showV gate
      // (VoltageElm.java:308-322). A saved source without the bit stops
      // drawing its caption until the box is checked, exactly as upstream.
      if ((e.flags & VOLTAGE_SHOW_VOLTAGE) !== 0) {
        label(g, e, formatValueShort(e.params.maxVoltage ?? 0, 'V', g.valueDigits), 16);
      }
      return;
    }
    const [lead1, lead2] = drawSourceCircle(g, e, 12);
    drawWaveformGlyph(g, interp(lead1, lead2, 0.5), wf, 12);
    // Same showV gate as the battery plates: the circled +/− symbol and every
    // waveform glyph carry the caption only under FLAG_SHOW_VOLTAGE.
    if ((e.flags & VOLTAGE_SHOW_VOLTAGE) !== 0) {
      label(g, e, formatValueShort(e.params.maxVoltage ?? 0, 'V', g.valueDigits), 20);
    }
  },
};
