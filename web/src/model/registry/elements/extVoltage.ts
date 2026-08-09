import { canvasFont, currentDots, endpoints, line, voltageColor } from '../../../render/draw';
import { railLabelAnchor, railLead } from './rail';
import { VOLTAGE_SHOW_VOLTAGE } from '../flags';
import { onePost, readParams } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** The name a fresh or name-less extVoltage carries (ExtVoltageElm.java:27). */
function extName(e: CircuitElement): string {
  return e.text && e.text.length > 0 ? e.text : 'ext';
}

/** The name token a line saves. An explicitly empty name (`\0` in the file)
 *  must round-trip as such; only a fresh part that never carried a name token
 *  falls back to the constructor default 'ext'. */
function extSavedName(e: CircuitElement): string {
  return e.text === undefined ? 'ext' : e.text;
}

export const EXT_VOLTAGE_DEF: ElementDef = {
  kind: 'extVoltage',
  label: 'External voltage',
  category: 'Sources',
  dumpCode: '418',
  postCount: 1,
  posts: onePost,
  draggablePosts: 2,  // the free end is a control point, not a terminal
  defaultFlags: VOLTAGE_SHOW_VOLTAGE,  // VoltageElm.java:23-24, the rail's constructor flag
  // The rail's token defaults with waveform pinned to WF_AC and the injected
  // `voltage` added; the name default lives in extName() because defaults
  // holds numbers only.
  defaults: {
    waveform: 1,
    frequency: 40,
    maxVoltage: 5,
    bias: 0,
    phaseShift: 0,
    dutyCycle: 0.5,
    voltage: 5,
  },
  // The inherited RailElm token list (waveform frequency maxVoltage bias
  // phaseShift dutyCycle), then the escaped name (ExtVoltageElm.java:28-33).
  parse: (t, e) => {
    readParams(t, e, ['waveform', 'frequency', 'maxVoltage', 'bias', 'phaseShift', 'dutyCycle']);
    if (t[6] !== undefined) e.text = t[6];
    // Upstream's token constructor forces WF_AC after reading the common
    // tokens (ExtVoltageElm.java:32), so a save always writes waveform 1.
    e.params.waveform = 1;
    // The injected value has no token: upstream's text dump inherits
    // VoltageElm's and never writes the `voltage` field, so the inherited
    // `maxVoltage` token is the only amplitude a loaded line carries.
    e.params.voltage = e.params.maxVoltage ?? 5;
  },
  dump: (e) => [
    e.params.waveform ?? 1,
    e.params.frequency ?? 40,
    // The value saves where upstream's amplitude token lives. Upstream's own
    // text save drops the injected value entirely (ExtVoltageElm.java has no
    // dump() override), and writing it here keeps a save-then-reload from
    // snapping back to a stale token, the same fix as the thermistor and LDR.
    e.params.voltage ?? e.params.maxVoltage ?? 5,
    e.params.bias ?? 0,
    e.params.phaseShift ?? 0,
    e.params.dutyCycle ?? 0.5,
    extSavedName(e),
  ],
  fields: [
    { name: 'text', label: 'Name', type: 'text', target: 'text' },
    { name: 'voltage', label: 'External voltage', unit: 'V' },
  ],
  draw(g, e) {
    const [p1, p2] = endpoints(e);
    const color = voltageColor(g, g.voltages[0]);
    const lead1 = railLead(p1, p2);
    // A single stem from the post to the symbol end, with the name where a DC
    // rail would draw its voltage (ExtVoltageElm.java:47-49, drawRailText).
    line(g, p1, lead1, color);
    drawExtName(g, e, lead1, extName(e));
    currentDots(g, p1, lead1, g.current);
  },
};

/** The name drawn at the stem end, cloned from the rail's DC label draw. */
function drawExtName(g: DrawContext, e: CircuitElement, lead1: Point, text: string): void {
  const [p1] = endpoints(e);
  const anchor = railLabelAnchor(p1, lead1, g.ctx.measureText(text).width, g.valueFontSize);
  g.ctx.fillStyle = g.theme.text;
  g.ctx.font = canvasFont(g.valueFontSize);
  g.ctx.textAlign = 'left';
  g.ctx.textBaseline = 'middle';
  g.ctx.fillText(text, anchor.x, anchor.y);
}
