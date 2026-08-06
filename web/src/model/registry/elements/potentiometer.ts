import {
  arrowHead,
  bodyRect,
  calcLeads,
  endpoints,
  formatValue,
  interp,
  label,
  line,
  voltageColor,
} from '../../../render/draw';
import { POT_FLIP, POT_FLIP_OFFSET, POT_SHOW_VALUES } from '../flags';
import { readParams } from '../shared';
import { GRID_SIZE } from '../../types';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

function drawPotBody(g: DrawContext, e: CircuitElement): void {
  const [lead1, lead2] = calcLeads(e, 32);
  const [p1, p2] = endpoints(e);
  const color = voltageColor(g, (g.voltages[0] + g.voltages[1]) / 2);
  line(g, p1, lead1, voltageColor(g, g.voltages[0]));
  line(g, lead2, p2, voltageColor(g, g.voltages[1]));
  bodyRect(g, lead1, lead2, 6, color);  // IEC rectangle, 32 x 12 as upstream

  const wiper = potPosts(e)[2];
  const contact = interp(lead1, lead2, e.params.position ?? 0.5, 0);
  line(g, wiper, contact, voltageColor(g, g.voltages[2]));
  arrowHead(g, wiper, contact, 8, voltageColor(g, g.voltages[2]));
  label(g, e, formatValue(e.params.maxResistance ?? 0, 'Ω'), 20);
}

/**
 * Replicates `PotElm.setPoints` (PotElm.java:184-209): the far post snaps to
 * the dominant axis and, on a drag, the wiper offset comes from the perpendicular
 * drag delta instead of a fixed side. The file stores the dragged x2,y2 while
 * the posts use the normalized endpoint, exactly like upstream.
 */
function potPosts(e: CircuitElement): Point[] {
  const [p1, p2] = endpoints(e);
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  let end = p2;
  let offset = 0;
  if (Math.abs(dx) > Math.abs(dy) !== ((e.flags & POT_FLIP) !== 0)) {
    const myLen = 2 * GRID_SIZE * Math.sign(dx) * Math.ceil(Math.abs(dx) / (2 * GRID_SIZE));
    end = { x: p1.x + myLen, y: p1.y };  // PotElm.java:190-192
    offset = dx < 0 ? dy : -dy;          // PotElm.java:191
  } else {
    const myLen = 2 * GRID_SIZE * Math.sign(dy) * Math.ceil(Math.abs(dy) / (2 * GRID_SIZE));
    if (dy !== 0) {
      end = { x: p1.x, y: p1.y + myLen };  // PotElm.java:196-197
      offset = dy > 0 ? dx : -dx;          // PotElm.java:197
    }
  }
  if (offset === 0)
    offset = (e.flags & POT_FLIP_OFFSET) !== 0 ? -GRID_SIZE : GRID_SIZE;  // PotElm.java:201-202
  return [p1, end, interp(p1, end, 0.5, offset)];  // post3, PotElm.java:209
}

export const POTENTIOMETER_DEF: ElementDef = {
  kind: 'potentiometer',
  label: 'Potentiometer',
  category: 'Basics',
  dumpCode: '174',
  postCount: 3,
  posts: potPosts,
  canMirror: true,
  defaultFlags: POT_SHOW_VALUES,  // PotElm.java:51
  defaults: { maxResistance: 1000, position: 0.5 },
  // Upstream joins every remaining token into the slider caption with single
  // spaces and never escapes it (PotElm.java:58-62), so the tokens stay raw
  // in both directions. Its own writer dropped these three tokens when the
  // save path moved to XML; its reader still requires them.
  rawTokens: true,
  parse: (t, e) => {
    readParams(t, e, ['maxResistance', 'position']);
    if (t.length > 2) e.text = t.slice(2).join(' ');
  },
  dump: (e) => {
    // An empty caption would write a trailing empty token and shift nothing
    // into `sliderText`, so fall back to the constructor's default.
    const text = e.text?.trim() ? e.text.trim() : 'Resistance';  // PotElm.java:50
    return [e.params.maxResistance ?? 1000, e.params.position ?? 0.5, ...text.split(/\s+/)];
  },
  fields: [
    { name: 'maxResistance', label: 'Max resistance', unit: 'Ω' },
    { name: 'position', label: 'Wiper position', min: 0, max: 1 },
  ],
  draw: drawPotBody,
};
