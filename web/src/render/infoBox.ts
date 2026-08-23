/** The hovered-element info box and the sim stats drawn at the bottom of the
 *  main canvas, the port of upstream's `drawBottomArea` (UIManager.java:796-891):
 *  a fixed overlay in screen space that shows the hovered element's `getInfo`
 *  lines, or the `t =` / `time step =` stats when nothing is hovered. */

import type { CircuitElement, Context2D } from '../model/types';
import { canvasFont, formatValue } from './draw';

/** Width of the info area upstream reserves at the canvas right edge, and the
 *  no-scope anchor (CirSim.java:57, `infoWidth = 160`). */
export const INFO_WIDTH = 160;
/** Line pitch of the stacked info text, upstream's `ybase+15*(i+1)`. */
export const INFO_LINE_SPACING = 15;
/** Margin upstream keeps between the last scope column and the info box
 *  (UIManager.java:876, `rightEdge() + 20`). */
export const SCOPE_MARGIN = 20;

/** The per-frame operating-point readout an element's info lines draw on:
 *  current, terminal voltage and power from the engine's flat arrays, plus
 *  the on-demand scope-value table for the kinds whose rows need more. The
 *  same shape `readElementReadout` returns, so its result passes straight
 *  through. */
export interface InfoLinesValues {
  current?: number;
  voltage?: number;
  power?: number;
  /** The element's live scope-value table from `elementScopeValues`, in the
   *  order its kind declares in the engine. Present only when the kind's
   *  info table reads it; absent means the rows fall back to zero. */
  scopeValues?: Float64Array;
}

/** Upstream's waveform codes (VoltageElm.java:39-46, the `waveform` field).
 *  The port's own file-format reference uses the same numbering
 *  (OVERVIEW.md:785-786). */
const WF_DC = 0;
const WF_AC = 1;
const WF_SQUARE = 2;
const WF_TRIANGLE = 3;
const WF_SAWTOOTH = 4;
const WF_PULSE = 5;
const WF_NOISE = 6;
const WF_VAR = 7;

/** The first getInfo line per periodic/DC waveform, upstream's getInfo switch
 *  (VoltageElm.java:464-473). VAR rides the DC caption; NOISE keeps its own. */
const WAVEFORM_CAPTION: Record<number, string> = {
  [WF_DC]: 'voltage source',
  [WF_VAR]: 'voltage source',
  [WF_AC]: 'A/C source',
  [WF_SQUARE]: 'square wave gen',
  [WF_PULSE]: 'pulse gen',
  [WF_SAWTOOTH]: 'sawtooth gen',
  [WF_TRIANGLE]: 'triangle gen',
  [WF_NOISE]: 'noise gen',
};

/** The RMS-to-peak multiplier per waveform (VoltageElm.getRmsMultiplier,
 *  VoltageElm.java:446-456). RMS amplitude = peak * multiplier, so a sine's
 *  V(rms) is Vmax / sqrt(2) and a square's is Vmax. The pulse is the one entry
 *  that is not pure waveform data: its multiplier is sqrt(dutyCycle), read from
 *  the element's own params like rail.ts's own getInfo does, so a 25% duty
 *  pulse reports V(rms) = Vmax/2 rather than the flat-1 value. */
const WAVEFORM_RMS_MULTIPLIER: Record<number, number> = {
  [WF_DC]: 1,
  [WF_AC]: 1 / Math.SQRT2,
  [WF_SQUARE]: 1,
  [WF_TRIANGLE]: 1 / Math.sqrt(3),
  [WF_SAWTOOTH]: 1 / Math.sqrt(3),
  [WF_NOISE]: 1,
  [WF_VAR]: 1,
};

/** The voltage source's getInfo block (VoltageElm.java:463-492). The rail and
 *  the free-standing source share everything but the voltage-line label
 *  (RailElm uses "V =", VoltageElm "Vd ="). I and Vd ride upstream's signed
 *  getCurrentText/getVoltageText (VoltageElm.java:474-476), not the
 *  magnitude D-text variants, so a reversed source reads negative. The
 *  periodic waveforms append the f / Vmax pair, then V(rms) at zero bias or
 *  Voff otherwise, and a wavelength line above 500 Hz at zero bias, mirroring
 *  the upstream else-if chain. Upstream's DC "(R = ...)" row is omitted: it
 *  only prints under its showResistanceInVoltageSources setting
 *  (VoltageElm.java:489), which this port does not have, so there is no row
 *  and nothing to gate it on. */
function voltageSourceLines(
  kind: string,
  e: CircuitElement,
  current: number,
  voltage: number,
  power: number,
): string[] {
  const wf = Math.round(e.params.waveform ?? WF_DC);
  const caption = WAVEFORM_CAPTION[wf] ?? 'voltage source';
  const vLabel = kind === 'rail' ? 'V = ' : 'Vd = ';
  const lines = [
    caption,
    `I = ${formatValue(current, 'A')}`,
    `${vLabel}${formatValue(voltage, 'V')}`,
  ];
  // DC, VAR and NOISE have no timebase to describe, so upstream skips the block
  // (VoltageElm.java:478).
  if (wf !== WF_DC && wf !== WF_VAR && wf !== WF_NOISE) {
    const frequency = e.params.frequency ?? 0;
    const maxVoltage = e.params.maxVoltage ?? 0;
    const bias = e.params.bias ?? 0;
    lines.push(`f = ${formatValue(frequency, 'Hz')}`);
    lines.push(`Vmax = ${formatValue(maxVoltage, 'V')}`);
    if (bias === 0) {
      const rms = wf === WF_PULSE ? Math.sqrt(e.params.dutyCycle ?? 0.5) : WAVEFORM_RMS_MULTIPLIER[wf] ?? 1;
      lines.push(`V(rms) = ${formatValue(maxVoltage * rms, 'V')}`);
    } else {
      lines.push(`Voff = ${formatValue(bias, 'V')}`);
    }
    // The wavelength rides only the zero-bias branch above (the else-if on
    // frequency binds to the bias != 0 test), so a biased source never shows it.
    if (bias === 0 && frequency > 500) {
      lines.push(`wavelength = ${formatValue(2.9979e8 / frequency, 'm')}`);
    }
  }
  lines.push(`P = ${formatValue(power, 'W')}`);
  return lines;
}

/** The diode family's header line. getInfo lives in DiodeElm and prints
 *  "diode", or "diode (model)" for a named model (DiodeElm.java:183-186);
 *  each subclass overrides just that first line, so the zener reads
 *  "Zener diode" (ZenerElm.java:91-96), the varactor stays plain "varactor"
 *  (VaractorElm.java:21-25) and the LED keeps the value/model split
 *  (LEDElm.java:113-118). */
function diodeFamilyHeader(kind: string, e: CircuitElement): string {
  switch (kind) {
    case 'zener':
      return 'Zener diode';
    case 'varactor':
      return 'varactor';
    case 'led':
      return e.modelName != null ? `LED (${e.modelName})` : 'LED';
    default:
      return e.modelName != null ? `diode (${e.modelName})` : 'diode';
  }
}

/** The diode family's getInfo block (DiodeElm.java:183-193). I and Vd use
 *  upstream's signed getCurrentText/getVoltageText (:188-189), not the
 *  magnitude D-text variants, so a reverse-biased junction reads negative.
 *  The value form (a forward drop in params, no model name) gains the Vf
 *  line that upstream's oldStyle branch appends. P is shared by the whole
 *  family; upstream also appends a Vz row on the zener and a C row on the
 *  varactor, which need live model state this table does not carry yet. */
function diodeFamilyLines(
  kind: string,
  e: CircuitElement,
  current: number,
  voltage: number,
  power: number,
): string[] {
  const lines = [
    diodeFamilyHeader(kind, e),
    `I = ${formatValue(current, 'A')}`,
    `Vd = ${formatValue(voltage, 'V')}`,
    `P = ${formatValue(power, 'W')}`,
  ];
  // A named model resolves its drop from the table and exposes no numeric Vf;
  // only the value form (no model name) carries the drop upstream would print.
  if (e.modelName == null) {
    lines.push(`Vf = ${formatValue(e.params.forwardVoltage ?? 0, 'V')}`);
  }
  return lines;
}

/** The transistor's scope-value slots, in the order the engine's declared
 *  table walks them (upstream's VAL_ id order, TransistorElm.java:582-593).
 *  The info rows index this table by position, so a reorder on either side
 *  shows up as swapped rows rather than silent garbage. */
const TRANSISTOR_SCOPE_TABLE = ['ib', 'ic', 'ie', 'vbe', 'vbc', 'vce'] as const;

/** The transistor's getInfo block (TransistorElm.java:538-563): header, model
 *  and beta, operating mode, then the signed terminal rows. Ic, Ib, Vbe, Vbc
 *  and Vce read the scope-value table; posts are base 0, collector 1,
 *  emitter 2, so the junction voltages are raw node differences exactly as
 *  upstream classifies them. P rides the shared flat-array power. */
function transistorLines(e: CircuitElement, values: InfoLinesValues): string[] {
  const sv = values.scopeValues;
  const at = (slot: number) => (sv !== undefined && slot < sv.length ? sv[slot] : 0);
  // The file sign is the type: -1 is PNP, everything else NPN.
  const pnp = (e.params.pnp ?? 1) < 0 ? -1 : 1;
  const vbc = at(TRANSISTOR_SCOPE_TABLE.indexOf('vbc'));
  const vbe = at(TRANSISTOR_SCOPE_TABLE.indexOf('vbe'));
  // Upstream's classification thresholds are strict > .2 on the
  // polarity-scaled junction voltages, so exactly .2 stays out of saturation.
  const mode =
    vbc * pnp > 0.2
      ? vbe * pnp > 0.2
        ? 'saturation'
        : 'reverse active'
      : vbe * pnp > 0.2
        ? 'fwd active'
        : 'cutoff';
  return [
    `transistor (${pnp === -1 ? 'PNP' : 'NPN'})`,
    // Upstream names the resolved model even when it is the unnamed default
    // (TransistorModel "default"), so an absent name still prints.
    `${e.modelName ?? 'default'}, β=${showFormat(e.params.beta ?? 100)}`,
    mode,
    `Ic = ${formatValue(at(TRANSISTOR_SCOPE_TABLE.indexOf('ic')), 'A')}`,
    `Ib = ${formatValue(at(TRANSISTOR_SCOPE_TABLE.indexOf('ib')), 'A')}`,
    `Vbe = ${formatValue(vbe, 'V')}`,
    `Vbc = ${formatValue(vbc, 'V')}`,
    `Vce = ${formatValue(at(TRANSISTOR_SCOPE_TABLE.indexOf('vce')), 'V')}`,
    `P = ${formatValue(values.power ?? 0, 'W')}`,
  ];
}

/** The element's `getInfo` array (CircuitElm.java:1199-1203): the kind as the
 *  label line, then the shared `I =` / `Vd =` pair, then the kind-specific
 *  lines. I and Vd are magnitudes for most kinds, upstream's
 *  `getCurrentDText` and `getVoltageDText` apply `Math.abs`; the
 *  voltage-source/rail and diode-family tables instead ride upstream's signed
 *  getCurrentText/getVoltageText, as their getInfo calls do. P uses the
 *  scope-convention power from the engine's array, the same source the live
 *  readout reads. The voltage source, rail, diode family and transistor get
 *  their full upstream tables; switch family, ground and wire and any unknown
 *  kind keep the shared pair only, matching upstream's own short tables. */
export function infoLines(kind: string, e: CircuitElement, values: InfoLinesValues): string[] {
  const current = values.current ?? 0;
  const voltage = values.voltage ?? 0;
  const power = values.power ?? 0;
  switch (kind) {
    case 'voltage source':
    case 'rail':
      return voltageSourceLines(kind, e, current, voltage, power);
    case 'transistor':
      return transistorLines(e, values);
    case 'diode':
    case 'zener':
    case 'led':
    case 'varactor':
      return diodeFamilyLines(kind, e, current, voltage, power);
    case 'resistor':
      return [
        kind,
        `I = ${formatValue(Math.abs(current), 'A')}`,
        `Vd = ${formatValue(Math.abs(voltage), 'V')}`,
        `R = ${formatValue(e.params.resistance ?? 0, 'Ω')}`,
        `P = ${formatValue(power, 'W')}`,
      ];
    case 'capacitor':
      return [
        kind,
        `I = ${formatValue(Math.abs(current), 'A')}`,
        `Vd = ${formatValue(Math.abs(voltage), 'V')}`,
        `C = ${formatValue(e.params.capacitance ?? 0, 'F')}`,
        `P = ${formatValue(power, 'W')}`,
        // Q is the signed stored charge, capacitance times the live terminal
        // voltage (CapacitorElm.java:219), so it stays a signed value.
        `Q = ${formatValue((e.params.capacitance ?? 0) * voltage, 'C')}`,
      ];
    case 'inductor':
      return [
        kind,
        `I = ${formatValue(Math.abs(current), 'A')}`,
        `Vd = ${formatValue(Math.abs(voltage), 'V')}`,
        `L = ${formatValue(e.params.inductance ?? 0, 'H')}`,
        `P = ${formatValue(power, 'W')}`,
      ];
  }
  return [
    kind,
    `I = ${formatValue(Math.abs(current), 'A')}`,
    `Vd = ${formatValue(Math.abs(voltage), 'V')}`,
  ];
}

/** Formats a plain number like upstream's `####.#` `showFormat` pattern: up to
 *  three fraction digits, trailing zeros trimmed (CircuitElm.java:157-171). */
function showFormat(v: number): string {
  return String(Number(v.toFixed(3)));
}

/** Upstream's `getTimeText` (CircuitElm.java:1078-1088): clock notation once a
 *  second has passed, engineering seconds below. */
export function getTimeText(v: number): string {
  if (v < 60) return formatValue(v, 's');
  let s = v;
  const h = Math.floor(s / 3600);
  s -= 3600 * h;
  const m = Math.floor(s / 60);
  s -= 60 * m;
  if (h === 0) return `${m}:${s >= 10 ? '' : '0'}${showFormat(s)}`;
  return `${h}:${m >= 10 ? '' : '0'}${m}:${s >= 10 ? '' : '0'}${showFormat(s)}`;
}

/** The `t =` / `time step =` lines, with the ` (ratex)` suffix once the
 *  effective rate `160*iterCount*timeStep` reaches 0.1, mirroring
 *  UIManager.java:858-863. */
export function simStatsLines(time: number, timeStep: number, iterCount: number): string[] {
  const timerate = 160 * iterCount * timeStep;
  const rate = timerate >= 0.1 ? ` (${showFormat(timerate)}x)` : '';
  return [`t = ${getTimeText(time)}${rate}`, `time step = ${getTimeText(timeStep)}`];
}

/** The box's left edge: upstream's two positions (UIManager.java:874-876). The
 *  scope strip spans the full canvas width in this port, so the scope-anchored
 *  position resolves to the info-area boundary (canvas right edge minus
 *  INFO_WIDTH) plus the same margin upstream keeps between the last scope
 *  column and the box. */
export function infoBoxX(width: number, hasScopes: boolean): number {
  const leftX = Math.max(width - INFO_WIDTH, 0);
  return hasScopes ? leftX + SCOPE_MARGIN : leftX;
}

/** Base y for the stacked lines, bottom-anchored so the last line clears the
 *  canvas edge by 10 px: a long element readout grows upward instead of
 *  clipping, where upstream's fixed 70 px band would. */
export function infoBoxY(height: number, lineCount: number): number {
  return height - 10 - INFO_LINE_SPACING * lineCount;
}

/** Draws stacked info text at (x, y), one line every INFO_LINE_SPACING pixels
 *  in the theme text colour. y is the base: the first line sits 15 px below
 *  it, matching upstream's `ybase+15*(i+1)` (UIManager.java:887-889). */
export function drawInfoBox(
  ctx: Context2D,
  x: number,
  y: number,
  lines: string[],
  color: string,
): void {
  ctx.font = canvasFont(10);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = color;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], x, y + INFO_LINE_SPACING * (i + 1));
  }
}
