import {
  calcLeads,
  currentDots,
  endpoints,
  interp,
  line,
  voltageColor,
} from '../../../render/draw';
import { SWITCH2_CENTER_OFF, SWITCH_LABEL } from '../flags';
import { OPEN_HS, rectOfPoints } from '../shared';
import { switchTokens, labelFlags } from './switch';
import type { CircuitElement, ElementDef, Point } from '../../types';

function switch2Posts(e: CircuitElement): Point[] {
  const [p1, p2] = endpoints(e);
  const throws = Math.max(2, e.params.throwCount ?? 2);
  const posts: Point[] = [p1];
  // Upstream uses Java integer division here (Switch2Elm.java:76), so the
  // spacing stays grid-aligned for every even throw count.
  for (let i = 0; i < throws; i++) {
    const hs = throwOffset(i, throws);
    posts.push(interp(p1, p2, 1, hs));
  }
  return posts;
}

/** Perpendicular throw offset for index `i`, the absolute `openhs` fan of the
 *  SPDT (Switch2Elm.java:76-80): throw 0 is the only one that never matches
 *  the centred formula. */
function throwOffset(i: number, throws: number): number {
  return i === 0 && throws === 2 ? OPEN_HS : -OPEN_HS * (i - Math.floor((throws - 1) / 2));
}

/**
 * The fan points the lever and the throw leads meet at: fraction 1 of the
 * body leads (not of the whole span), each at its throw's perpendicular offset
 * (Switch2Elm.java:79). The throw leads then continue from here to the posts,
 * so the lever never reaches the terminal. Center-off rests the lever on
 * `lead2`, which is what `swpoles[i] = lead2` records (Switch2Elm.java:82).
 */
export function switch2Poles(e: CircuitElement): Point[] {
  const [lead1, lead2] = calcLeads(e, 32);
  const throws = Math.max(2, e.params.throwCount ?? 2);
  const poles: Point[] = [];
  for (let i = 0; i < throws; i++) {
    poles.push(interp(lead1, lead2, 1, throwOffset(i, throws)));
  }
  return poles;
}

export const SWITCH2_DEF: ElementDef = {
  kind: 'switch2',
  label: 'SPDT switch',
  category: 'Basics',
  dumpCode: 'S',
  shortcut: 'S',  // Switch2Elm.java
  postCount: 3,
  posts: switch2Posts,
  interactive: true,
  // The clickable region spans the lever's fan: the pivot lead and the first
  // and last throw poles (Switch2Elm.java:121-123). It is position-independent,
  // so center-off still toggles back onto a throw from anywhere in the fan.
  switchRect: (e) => {
    const [lead1] = calcLeads(e, 32);
    const poles = switch2Poles(e);
    return rectOfPoints([lead1, poles[0], poles[poles.length - 1]]);
  },
  noDiagonal: true,  // Switch2Elm.java:35,51
  defaults: { position: 0, throwCount: 2 },
  parse: (t, e) => {
    const p = t[0];
    e.params.position = p === 'true' ? 1 : p === 'false' ? 0 : Number(p) || 0;
    e.params.momentary = t[1] === 'true' ? 1 : 0;
    // Upstream reads the label in `super(...)` before link and throwCount
    // (Switch2Elm.java:44-50), so a label shifts both of them one token on.
    let i = 2;
    if ((e.flags & SWITCH_LABEL) !== 0 && t[i] !== undefined) e.text = t[i++];
    e.params.link = Number(t[i++]) || 0;
    e.params.throwCount = Number(t[i]) || 2;
    e.state = e.params.position;
  },
  dump: (e) => [...switchTokens(e), e.params.link ?? 0, e.params.throwCount ?? 2],
  dumpFlags: labelFlags,
  fields: [{ name: 'keyShortcut', label: 'Keyboard Shortcut', type: 'text', target: 'keyShortcut' }],
  draw(g, e) {
    const posts = switch2Posts(e);
    const throws = Math.max(2, e.params.throwCount ?? 2);
    const [p1] = endpoints(e);
    const [lead1, lead2] = calcLeads(e, 32);
    const poles = switch2Poles(e);
    line(g, p1, lead1, voltageColor(g, g.voltages[0]));
    // One lead per throw, from its fan point to its post (Switch2Elm.java:
    // 96-99). The fan point sits on the body, so the pole and post share the
    // offset but not the x.
    for (let i = 0; i < throws; i++) {
      line(g, poles[i], posts[i + 1], voltageColor(g, g.voltages[i + 1]));
    }
    // Center-off is the open middle position: the lever rests on the pole
    // where the throws fan out rather than on a throw, so `poles[sel]` would
    // be out of range (Switch2Elm.java:82,108-109).
    const centerOff =
      (e.flags & SWITCH2_CENTER_OFF) !== 0 &&
      throws === 2 &&
      (e.state ?? 0) === 2;
    const sel = Math.min(e.state ?? 0, poles.length - 1);
    line(g, lead1, centerOff ? lead2 : poles[sel], voltageColor(g, g.voltages[0]));
    if (!centerOff) {
      currentDots(g, p1, lead1, g.current);
      currentDots(g, poles[sel], posts[sel + 1], g.current);
    }
  },
};
