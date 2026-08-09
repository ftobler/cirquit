import {
  canvasFont,
  circle,
  currentDots,
  elementLength,
  endpoints,
  formatValue,
  interp,
  line,
  voltageColor,
} from '../../../render/draw';
import { RAIL_CLOCK, RAIL_SHOW_VOLTAGE, VOLTAGE_COS, VOLTAGE_PULSE_DUTY, VOLTAGE_SHOW_VOLTAGE } from '../flags';
import { drawWaveformGlyph, onePost, readParams, writeParams } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** The duty cycle old pulse lines are stuck with (VoltageElm.java:51). */
const DEFAULT_PULSE_DUTY = 1 / (2 * Math.PI);

/** Rail waveform glyph and DC label radius (VoltageElm.java:246, circleSize). */
export const RAIL_CIRCLE = 17;

/** Font size of the rail's voltage label (CircuitElm.java:53, valueFontSize). */
const VALUE_FONT = 12;

/**
 * The stem's far end: one circle radius short of `point2`, which is where the
 * label or the waveform circle sits (RailElm.java:43, :55).
 */
export function railLead(p1: Point, p2: Point): Point {
  const dn = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  return interp(p1, p2, dn > 0 ? 1 - RAIL_CIRCLE / dn : 1);
}

/**
 * The DC rail's label, plus sign and all (RailElm.java:72-80): a plain decimal
 * with " V" below 1 volt, the short prefix form from there up, and a leading
 * plus only for positive rails. `digits` is the short-format digit count the
 * label sites use (g.valueDigits), so the option applies here too.
 */
export function railText(v: number, digits = 3): string {
  const s = Math.abs(v) < 1 ? `${decimal(v, digits)} V` : compact(v, 'V', digits);
  return v > 0 ? `+${s}` : s;
}

/** Plain decimal with `digits` fraction digits, trailing zeroes stripped. */
function decimal(v: number, digits = 3): string {
  return v.toFixed(digits).replace(/\.?0+$/, '');
}

/** Upstream's short unit text: no space before the unit (getUnitText, sf). */
function compact(v: number, unit: string, digits = 3): string {
  return formatValue(v, unit, digits).replace(' ', '');
}

/**
 * Where the rail label is drawn, cloning `drawLabeledNode` (CircuitElm.java:
 * 945-968): vertical rails centre the text on the stem end and step it one
 * font height along the travel direction; horizontal rails set it 4 clear of
 * the stem end. `fontSize` keeps the offset in step with the value-font-size
 * setting.
 */
export function railLabelAnchor(p1: Point, lead1: Point, textWidth: number, fontSize = VALUE_FONT): Point {
  if (p1.y !== lead1.y) {
    return {
      x: lead1.x - textWidth / 2,
      y: lead1.y + Math.sign(lead1.y - p1.y) * fontSize,
    };
  }
  if (lead1.x > p1.x) return { x: lead1.x + 4, y: lead1.y };
  return { x: lead1.x - 4 - textWidth, y: lead1.y };
}

/** RMS-to-peak multiplier per waveform (VoltageElm.java:446-455). */
const RMS_MULT = [1, 1 / Math.sqrt(2), 1, 1 / Math.sqrt(3), 1 / Math.sqrt(3), 0.5, 1];

/** The value label beside an AC rail's waveform circle, under
 *  FLAG_SHOW_VOLTAGE_RAIL: the voltage (RMS when that is the rounder number)
 *  and optionally the frequency (VoltageElm.java:406-418). */
export function railValueText(e: CircuitElement, showFrequency: boolean, digits = 3): string {
  const maxV = e.params.maxVoltage ?? 0;
  const bias = e.params.bias ?? 0;
  const wf = e.params.waveform ?? 0;
  const voltage = shortRailVoltage(e, maxV, bias, wf, digits);
  if (!showFrequency) return voltage;
  return `${voltage} ${compact(e.params.frequency ?? 0, 'Hz', digits)}`;
}

function shortRailVoltage(e: CircuitElement, maxV: number, bias: number, wf: number, digits: number): string {
  if (bias !== 0) return compact(bias + maxV, 'V', digits);  // VoltageElm.java:437-438
  const mult = wf === 5 ? Math.sqrt(e.params.dutyCycle ?? 0.5) : (RMS_MULT[wf] ?? 1);
  // Show RMS when that is the rounder number (VoltageElm.java:427-433).
  const rounder =
    mult !== 1 &&
    Math.abs(maxV) > 1e-4 &&
    diffFromInteger(maxV * mult * 1e4) < diffFromInteger(maxV * 1e4);
  if (rounder) return `${compact(maxV * mult, 'V', digits)}rms`;
  return compact(maxV, 'V', digits);
}

function diffFromInteger(x: number): number {
  return Math.abs(x - Math.round(x));
}

/**
 * Where the AC rail's value label goes, cloning `drawValues` for a rail
 * (CircuitElm.java:915-942): anchored on `point2`, offset a circle radius
 * perpendicular, voltage sources always on the left (CircuitElm.java:938).
 * `fontSize` keeps the vertical centring in step with the value-font-size
 * setting.
 */
export function railValueAnchor(e: CircuitElement, textWidth: number, fontSize = VALUE_FONT): Point {
  const [p1, p2] = endpoints(e);
  const dn = Math.max(1, elementLength(e));
  const dpx = Math.trunc(((p2.y - p1.y) / dn) * RAIL_CIRCLE);
  const dpy = Math.trunc((-(p2.x - p1.x) / dn) * RAIL_CIRCLE);
  if (dpx === 0) return { x: p2.x - textWidth / 2, y: p2.y - Math.abs(dpy) - 2 };
  return { x: p2.x - (textWidth + Math.abs(dpx) + 2), y: p2.y + dpy + fontSize / 2 };
}

export const RAIL_DEF: ElementDef = {
  kind: 'rail',
  label: 'Voltage rail',
  category: 'Sources',
  dumpCode: 'R',
  postCount: 1,
  posts: onePost,
  draggablePosts: 2,  // the free end is a control point, not a terminal
  defaultFlags: VOLTAGE_SHOW_VOLTAGE,  // RailElm.java:23-24, inherits the voltage source flag
  defaults: { waveform: 0, frequency: 40, maxVoltage: 5, bias: 0, phaseShift: 0, dutyCycle: 0.5 },
  parse: (t, e) => {
    readParams(t, e, ['waveform', 'frequency', 'maxVoltage', 'bias', 'phaseShift', 'dutyCycle']);
    // The rail shares the voltage source's load-time flag conversions
    // (VoltageElm.java:80-88), since RailElm extends VoltageElm.
    if (e.flags & VOLTAGE_COS) {
      e.params.phaseShift = Math.PI / 2;
      e.flags &= ~VOLTAGE_COS;
    }
    if (!(e.flags & VOLTAGE_PULSE_DUTY) && e.params.waveform === 5) {
      e.params.dutyCycle = DEFAULT_PULSE_DUTY;
    }
    // Same stored-flag invariant as the voltage source: bit 4 tracks the
    // waveform so a rebuild never re-normalises an edited duty.
    if (e.params.waveform === 5) e.flags |= VOLTAGE_PULSE_DUTY;
    else e.flags &= ~VOLTAGE_PULSE_DUTY;
  },
  dump: writeParams(['waveform', 'frequency', 'maxVoltage', 'bias', 'phaseShift', 'dutyCycle']),
  // Same canonicalisation as the voltage source: a pulse line's duty token is
  // authoritative and says so, or the next load would normalise it away.
  dumpFlags: (e) => (e.params.waveform === 5 ? e.flags | VOLTAGE_PULSE_DUTY : e.flags),
  fields: [
    { name: 'maxVoltage', label: 'Voltage', unit: 'V' },
    { name: 'frequency', label: 'Frequency', unit: 'Hz' },
  ],
  draw(g, e) {
    const [p1, p2] = endpoints(e);
    const color = voltageColor(g, g.voltages[0]);
    const wf = e.params.waveform ?? 0;
    const lead1 = railLead(p1, p2);
    // A single stem from the post to the symbol end; the symbol is either the
    // labeled node (DC, clock, noise) or the waveform circle (RailElm.java:
    // 50-64).
    line(g, p1, lead1, color);
    if (wf === 2 && (e.flags & RAIL_CLOCK) !== 0) {
      drawRailLabel(g, e, lead1, 'CLK');
    } else if (wf === 0) {
      const v = (e.params.maxVoltage ?? 0) + (e.params.bias ?? 0);  // getVoltage, WF_DC
      drawRailLabel(g, e, lead1, railText(v, g.valueDigits));
    } else if (wf === 6) {
      drawRailLabel(g, e, lead1, 'Noise');
    } else {
      circle(g, p2, RAIL_CIRCLE, g.theme.text, false, 3);
      drawWaveformGlyph(g, p2, wf, RAIL_CIRCLE);
      const showF = g.showValues;
      if ((e.flags & RAIL_SHOW_VOLTAGE) !== 0) {
        drawRailValue(g, e, railValueText(e, showF, g.valueDigits));
      } else if (showF) {
        drawRailValue(g, e, `${compact(e.params.frequency ?? 0, 'Hz', g.valueDigits)}`);
      }
    }
    currentDots(g, p1, lead1, g.current);
  },
};

function drawRailLabel(g: DrawContext, e: CircuitElement, lead1: Point, text: string): void {
  const [p1] = endpoints(e);
  const anchor = railLabelAnchor(p1, lead1, g.ctx.measureText(text).width, g.valueFontSize);
  g.ctx.fillStyle = g.theme.text;
  g.ctx.font = canvasFont(g.valueFontSize);
  g.ctx.textAlign = 'left';
  g.ctx.textBaseline = 'middle';
  g.ctx.fillText(text, anchor.x, anchor.y);
}

function drawRailValue(g: DrawContext, e: CircuitElement, text: string): void {
  const anchor = railValueAnchor(e, g.ctx.measureText(text).width, g.valueFontSize);
  g.ctx.fillStyle = g.theme.text;
  g.ctx.font = canvasFont(g.valueFontSize);
  g.ctx.textAlign = 'left';
  g.ctx.textBaseline = 'middle';
  g.ctx.fillText(text, anchor.x, anchor.y);
}
