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
 *  current, terminal voltage and power from the engine's flat arrays. The same
 *  shape `readElementReadout` returns, so its result passes straight through. */
export interface InfoLinesValues {
  current?: number;
  voltage?: number;
  power?: number;
}

/** The element's `getInfo` array (CircuitElm.java:1199-1203): the kind as the
 *  label line, then the shared `I =` / `Vd =` pair, then the kind-specific
 *  lines. I and Vd are magnitudes, upstream's `getCurrentDText` and
 *  `getVoltageDText` apply `Math.abs`; P uses the scope-convention power from
 *  the engine's array, the same source the live readout reads. Unknown kinds
 *  keep only the shared lines. */
export function infoLines(kind: string, e: CircuitElement, values: InfoLinesValues): string[] {
  const current = values.current ?? 0;
  const voltage = values.voltage ?? 0;
  const lines = [
    kind,
    `I = ${formatValue(Math.abs(current), 'A')}`,
    `Vd = ${formatValue(Math.abs(voltage), 'V')}`,
  ];
  const power = values.power ?? 0;
  switch (kind) {
    case 'resistor':
      lines.push(`R = ${formatValue(e.params.resistance ?? 0, 'Ω')}`);
      lines.push(`P = ${formatValue(power, 'W')}`);
      break;
    case 'capacitor':
      lines.push(`C = ${formatValue(e.params.capacitance ?? 0, 'F')}`);
      lines.push(`P = ${formatValue(power, 'W')}`);
      // Q is the signed stored charge, capacitance times the live terminal
      // voltage (CapacitorElm.java:219), so it stays a signed value.
      lines.push(`Q = ${formatValue((e.params.capacitance ?? 0) * voltage, 'C')}`);
      break;
    case 'inductor':
      lines.push(`L = ${formatValue(e.params.inductance ?? 0, 'H')}`);
      lines.push(`P = ${formatValue(power, 'W')}`);
      break;
  }
  return lines;
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
