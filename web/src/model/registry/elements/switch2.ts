import {
  circle,
  currentDots,
  endpoints,
  interp,
  line,
  voltageColor,
} from '../../../render/draw';
import { SWITCH2_CENTER_OFF, SWITCH_LABEL } from '../flags';
import { OPEN_HS } from '../shared';
import { switchTokens, labelFlags } from './switch';
import type { CircuitElement, ElementDef, Point } from '../../types';

function switch2Posts(e: CircuitElement): Point[] {
  const [p1, p2] = endpoints(e);
  const throws = Math.max(2, e.params.throwCount ?? 2);
  const posts: Point[] = [p1];
  // Upstream uses Java integer division here (Switch2Elm.java:76), so the
  // spacing stays grid-aligned for every even throw count.
  for (let i = 0; i < throws; i++) {
    const hs = i === 0 && throws === 2 ? OPEN_HS : -OPEN_HS * (i - Math.floor((throws - 1) / 2));
    posts.push(interp(p1, p2, 1, hs));
  }
  return posts;
}

export const SWITCH2_DEF: ElementDef = {
  kind: 'switch2',
  label: 'SPDT switch',
  category: 'Basics',
  dumpCode: 'S',
  postCount: 3,
  posts: switch2Posts,
  interactive: true,
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
  draw(g, e) {
    const posts = switch2Posts(e);
    const [p1, p2] = endpoints(e);
    const lead1 = interp(p1, p2, 0.25);
    line(g, p1, lead1, voltageColor(g, g.voltages[0]));
    const sel = (e.state ?? 0) + 1;
    posts.slice(1).forEach((p, i) => {
      line(g, interp(p1, p2, 0.75, 0), p, voltageColor(g, g.voltages[i + 1]));
      circle(g, interp(p1, p2, 0.75, 0), 2, g.theme.wire, true, 1);
    });
    // Center-off is the open middle position: the lever rests on the pole
    // where the throws fan out rather than on a throw, so `posts[sel]`
    // would be out of range (Switch2Elm.java:82,108-109).
    const centerOff =
      (e.flags & SWITCH2_CENTER_OFF) !== 0 &&
      (e.params.throwCount ?? 2) === 2 &&
      (e.state ?? 0) === 2;
    const tip = centerOff ? interp(p1, p2, 0.75) : posts[Math.min(sel, posts.length - 1)];
    line(g, lead1, tip, voltageColor(g, g.voltages[0]));
    if (!centerOff) currentDots(g, p1, tip, g.current);
  },
};
