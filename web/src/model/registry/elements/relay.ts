import {
  calcLeads,
  canvasFont,
  closedPolyline,
  currentDots,
  dsign,
  elementLength,
  endpoints,
  gradientCoil,
  interp,
  lead,
  line,
  voltageColor,
} from '../../../render/draw';
import {
  RELAY_BOTH_SIDES_COIL,
  RELAY_CONTACT_IEC,
  RELAY_CONTACT_NORMALLY_CLOSED,
  RELAY_FLIP,
  RELAY_PULLDOWN,
  RELAY_SHOW_BOX,
  RELAY_SWAP_COIL,
} from '../flags';
import { CONTACT_STROKE_WIDTH, OPEN_HS, readParams, rectOfPoints, twoPosts } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** Coil placement encoded in the flags, upstream's `coilStyleFromFlags`
 *  (RelayElm.java:47-51): 2 = the far end, 0 = both ends, 1 = the near end. */
function coilStyleFromFlags(e: CircuitElement): number {
  if ((e.flags & RELAY_SWAP_COIL) !== 0) return 2;
  if ((e.flags & RELAY_BOTH_SIDES_COIL) !== 0) return 0;
  return 1;
}

/** The blade's drawn position: 0 off, 1 on, 2 caught mid-throw, matching the
 *  file token. Live throws never cross back out of the engine, so this is the
 *  loaded position, exactly like every other element's saved state. */
function bladePosition(e: CircuitElement): number {
  const p = e.params.position ?? 0;
  return p === 2 ? 0.5 : p;
}

/** Draws a relay label at a fixed offset from the body, always on, since a
 *  coil/contact pair is only linkable by what these labels say. */
function textAt(g: DrawContext, x: number, y: number, text: string, align: CanvasTextAlign): void {
  g.ctx.fillStyle = g.theme.text;
  g.ctx.font = canvasFont(11);
  g.ctx.textAlign = align;
  g.ctx.textBaseline = 'middle';
  g.ctx.fillText(text, x, y);
}

/** Port of RelayElm.setPoints (RelayElm.java:303-361). The post order is
 *  pole 0, its two throws, then per extra pole `3p, 3p+1, 3p+2`, then the two
 *  coil terminals. `dflip` carries FLAG_FLIP and `openhs = -dflip*16`, so the
 *  whole switch bank flips side on a mirror like upstream. */
function relayPosts(e: CircuitElement): Point[] {
  const [p1, p2] = endpoints(e);
  const poleCount = Math.min(8, Math.max(1, Math.round(e.params.poleCount ?? 1)));
  let dflip = dsign(p1, p2);
  if ((e.flags & RELAY_FLIP) !== 0) dflip = -dflip;
  const openhs = -dflip * OPEN_HS;
  const posts: Point[] = [];
  for (let i = 0; i < poleCount; i++) {
    posts.push(interp(p1, p2, 0, -openhs * 3 * i));
    posts.push(interp(p1, p2, 1, -openhs * 3 * i - openhs));
    posts.push(interp(p1, p2, 1, -openhs * 3 * i + openhs));
  }
  const coilStyle = coilStyleFromFlags(e);
  const x = coilStyle === 2 ? 1 : 0;
  if (coilStyle !== 0) {
    posts.push(interp(p1, p2, x, openhs * 2));
    posts.push(interp(p1, p2, x, openhs * 3));
  } else {
    posts.push(interp(p1, p2, 0, openhs * 2));
    posts.push(interp(p1, p2, 1, openhs * 2));
  }
  return posts;
}

interface RelayGeometry {
  p1: Point;
  p2: Point;
  poleCount: number;
  dflip: number;
  openhs: number;
  swposts: Point[][];
  swpoles: Point[][];
  coilPosts: Point[];
  coilLeads: Point[];
  outline: Point[];
  dn: number;
}

function relayGeometry(e: CircuitElement): RelayGeometry {
  const [p1, p2] = endpoints(e);
  const dn = elementLength(e);
  const poleCount = Math.min(8, Math.max(1, Math.round(e.params.poleCount ?? 1)));
  let dflip = dsign(p1, p2);
  if ((e.flags & RELAY_FLIP) !== 0) dflip = -dflip;
  const openhs = -dflip * OPEN_HS;
  const coilStyle = coilStyleFromFlags(e);
  const [lead1, lead2] = calcLeads(e, 32);

  const swposts: Point[][] = [];
  const swpoles: Point[][] = [];
  for (let i = 0; i < poleCount; i++) {
    swposts.push([
      interp(p1, p2, 0, -openhs * 3 * i),
      interp(p1, p2, 1, -openhs * 3 * i - openhs),
      interp(p1, p2, 1, -openhs * 3 * i + openhs),
    ]);
    swpoles.push([
      interp(lead1, lead2, 0, -openhs * 3 * i),
      interp(lead1, lead2, 1, -openhs * 3 * i - openhs),
      interp(lead1, lead2, 1, -openhs * 3 * i + openhs),
    ]);
  }

  const x = coilStyle === 2 ? 1 : 0;
  let coilPosts: Point[];
  let coilLeads: Point[];
  if (coilStyle !== 0) {
    coilPosts = [interp(p1, p2, x, openhs * 2), interp(p1, p2, x, openhs * 3)];
    coilLeads = [interp(p1, p2, 0.5, openhs * 2), interp(p1, p2, 0.5, openhs * 3)];
  } else {
    coilPosts = [interp(p1, p2, 0, openhs * 2), interp(p1, p2, 1, openhs * 2)];
    coilLeads = [
      interp(p1, p2, 0.5 - 16 / dn, openhs * 2),
      interp(p1, p2, 0.5 + 16 / dn, openhs * 2),
    ];
  }

  // Body box, sizing with the switch bank height (RelayElm.java:349-357).
  const boxSize = coilStyle !== 0 ? 56 : 40;
  const boxWScale = Math.min(0.4, 25 / dn);
  const outline = [
    interp(p1, p2, 0.5 - boxWScale, -boxSize * dflip),
    interp(p1, p2, 0.5 + boxWScale, -boxSize * dflip),
    interp(p1, p2, 0.5 + boxWScale, -(openhs * 3 * poleCount) - 24 * dflip),
    interp(p1, p2, 0.5 - boxWScale, -(openhs * 3 * poleCount) - 24 * dflip),
  ];
  return { p1, p2, poleCount, dflip, openhs, swposts, swpoles, coilPosts, coilLeads, outline, dn };
}

function drawRelay(g: DrawContext, e: CircuitElement): void {
  const geo = relayGeometry(e);
  const { p1, p2, poleCount, dflip, openhs, swposts, swpoles, coilPosts, coilLeads, outline } =
    geo;
  const coilStyle = coilStyleFromFlags(e);
  const pos = bladePosition(e);

  for (let i = 0; i < 2; i++) {
    lead(g, coilLeads[i], coilPosts[i], voltageColor(g, g.voltages[3 * poleCount + i]));
  }
  const x = coilStyle === 2 ? 1 : 0;
  const len = Math.hypot(
    coilLeads[x].x - coilLeads[1 - x].x,
    coilLeads[x].y - coilLeads[1 - x].y,
  );
  // The coil shades across its own two terminals, not the element's posts 0/1:
  // `coilLeads[i]` rides the perpendicular of `coilPosts[i]`, whose voltage is
  // the i-th coil node (RelayElm.java:303-361). Each loop strokes as its own
  // arc with flat ends, so the semicircles read as distinct primitives.
  gradientCoil(g, coilLeads[x], coilLeads[1 - x], Math.max(1, Math.ceil(len / 11)), {
    v0: g.voltages[3 * poleCount + x],
    v1: g.voltages[3 * poleCount + 1 - x],
  });

  if ((e.flags & RELAY_SHOW_BOX) !== 0) {
    closedPolyline(g, [outline[0], outline[1], outline[2], outline[3], outline[0]], g.theme.text);
  }

  // Dashed lines running beside the switch bank, the only part of the symbol
  // that moves with the blade (RelayElm.java:236-251). Upstream strokes them
  // with a plain `g.drawLine`, so they stay at fine width 1.
  for (let i = 0; i < poleCount; i++) {
    let a: Point;
    if (i === 0) {
      const off = coilStyle === 0 ? 4 : 0;
      a = interp(p1, p2, 0.5, openhs * 2 + 5 * dflip - i * openhs * 3 + off);
    } else {
      a = interp(p1, p2, 0.5, Math.trunc(openhs * (-i * 3 + 3 - 0.5 + pos)) + 5 * dflip);
    }
    const b = interp(p1, p2, 0.5, Math.trunc(openhs * (-i * 3 - 0.5 + pos)) - 5 * dflip);
    g.ctx.setLineDash([4, 4]);
    line(g, a, b, g.theme.text, 1);
    g.ctx.setLineDash([]);
  }

  for (let p = 0; p < poleCount; p++) {
    for (let j = 0; j < 3; j++) {
      lead(g, swposts[p][j], swpoles[p][j], voltageColor(g, g.voltages[p * 3 + j]));
    }
    const tip = interp(swpoles[p][1], swpoles[p][2], pos);
    // The blade is the mechanical part, lightGray in upstream too
    // (RelayElm.java:261-264).
    line(g, swpoles[p][0], tip, g.theme.lightGray, CONTACT_STROKE_WIDTH);
  }
  currentDots(g, coilPosts[0], coilLeads[0], g.current);
  currentDots(g, coilLeads[1], coilPosts[1], g.current);
}

export const RELAY_DEF: ElementDef = {
  kind: 'relay',
  label: 'Relay',
  category: 'Basics',
  dumpCode: '178',
  shortcut: 'R',  // RelayElm.java
  postCount: 5,
  posts: relayPosts,
  noDiagonal: true,  // RelayElm.java:93
  canMirror: true,   // RelayElm.java:585-601, same FLAG_FLIP pattern as the mosfet
  defaultFlags: RELAY_SHOW_BOX | RELAY_BOTH_SIDES_COIL | RELAY_PULLDOWN,
  defaults: {
    poleCount: 1,
    inductance: 0.2,
    coilCurrent: 0,
    r_on: 0.05,
    r_off: 1e6,
    onCurrent: 0.02,
    coilR: 20,
    offCurrent: 0.015,
    switchingTime: 0.005,
    position: 0,
  },
  parse: (t, e) => {
    readParams(t, e, [
      'poleCount',
      'inductance',
      'coilCurrent',
      'r_on',
      'r_off',
      'onCurrent',
      'coilR',
      'offCurrent',
      'switchingTime',
      'position',
    ]);
  },
  dump: (e) => [
    e.params.poleCount ?? 1,
    e.params.inductance ?? 0.2,
    e.params.coilCurrent ?? 0,
    e.params.r_on ?? 0.05,
    e.params.r_off ?? 1e6,
    e.params.onCurrent ?? 0.02,
    e.params.coilR ?? 20,
    e.params.offCurrent ?? 0.015,
    e.params.switchingTime ?? 0.005,
    e.params.position ?? 0,
  ],
  fields: [
    { name: 'poleCount', label: 'Poles' },
    { name: 'inductance', label: 'Inductance', unit: 'H' },
    { name: 'r_on', label: 'On resistance', unit: 'Ω' },
    { name: 'r_off', label: 'Off resistance', unit: 'Ω' },
    { name: 'onCurrent', label: 'On current', unit: 'A' },
    { name: 'offCurrent', label: 'Off current', unit: 'A' },
    { name: 'coilR', label: 'Coil resistance', unit: 'Ω' },
    { name: 'switchingTime', label: 'Switching time', unit: 's' },
  ],
  draw: drawRelay,
};

interface RelayCoilGeometry {
  p1: Point;
  p2: Point;
  coilLeads: Point[];
  outline: Point[];
  extraPoints: Point[];
}

function relayCoilGeometry(e: CircuitElement): RelayCoilGeometry {
  const [p1, p2] = endpoints(e);
  const dn = elementLength(e);
  const d = dsign(p1, p2);
  const boxSize = 32;
  const boxWScale = Math.min(0.4, 12 / dn);
  const coilLeads = [interp(p1, p2, 0.5 - boxWScale), interp(p1, p2, 0.5 + boxWScale)];
  // Outline order [top-left, top-right, bottom-right, bottom-left], matching
  // RelayCoilElm.java:237-240, and the type glyph points at :247-259.
  const outline = [
    interp(p1, p2, 0.5 - boxWScale, -boxSize * d),
    interp(p1, p2, 0.5 + boxWScale, -boxSize * d),
    interp(p1, p2, 0.5 + boxWScale, boxSize * d),
    interp(p1, p2, 0.5 - boxWScale, boxSize * d),
  ];
  const type = e.params.type ?? 0;
  let extraPoints: Point[];
  if (type === 3 || type === 4 || type === 5) {
    extraPoints = [
      interp(coilLeads[0], coilLeads[1], 0.3, 8),
      interp(coilLeads[0], coilLeads[1], 0.3, 0),
      interp(coilLeads[0], coilLeads[1], 0.7, 0),
      interp(coilLeads[0], coilLeads[1], 0.7, -8),
    ];
  } else {
    extraPoints = [
      outline[0],
      interp(coilLeads[0], coilLeads[1], 0, -boxSize + 12),
      interp(coilLeads[0], coilLeads[1], 1, -boxSize + 12),
      outline[1],
    ];
  }
  return { p1, p2, coilLeads, outline, extraPoints };
}

function drawRelayCoil(g: DrawContext, e: CircuitElement): void {
  const { p1, p2, coilLeads, outline, extraPoints } = relayCoilGeometry(e);
  const type = e.params.type ?? 0;

  lead(g, p1, coilLeads[0], voltageColor(g, g.voltages[0]));
  lead(g, coilLeads[1], p2, voltageColor(g, g.voltages[1]));
  closedPolyline(g, [outline[0], outline[1], outline[2], outline[3], outline[0]], g.theme.text);

  if (type === 3 || type === 4 || type === 5) {
    for (let i = 0; i < 3; i++) line(g, extraPoints[i], extraPoints[i + 1], g.theme.text);
    if (type === 4 || type === 5) {
      textAt(g, extraPoints[0].x + 3, extraPoints[0].y + 9, type === 4 ? 'S' : 'R', 'left');
    }
  } else if (type === 1) {
    // On-delay: the open-switch glyph beside the box (RelayCoilElm.java:178-181).
    line(g, extraPoints[1], extraPoints[2], g.theme.text);
    line(g, extraPoints[0], extraPoints[2], g.theme.text);
    line(g, extraPoints[1], extraPoints[3], g.theme.text);
  } else if (type === 2) {
    // Off-delay: a filled rectangle (RelayCoilElm.java:183-184).
    const r = [extraPoints[0], { x: extraPoints[2].x, y: extraPoints[0].y }, extraPoints[2], { x: extraPoints[0].x, y: extraPoints[2].y }];
    g.ctx.fillStyle = g.theme.text;
    g.ctx.beginPath();
    g.ctx.moveTo(r[0].x, r[0].y);
    for (let i = 1; i < r.length; i++) g.ctx.lineTo(r[i].x, r[i].y);
    g.ctx.closePath();
    g.ctx.fill();
  }

  if (e.text) {
    const horizontal = Math.abs(e.x2 - e.x1) >= Math.abs(e.y2 - e.y1);
    textAt(
      g,
      horizontal ? (e.x1 + e.x2) / 2 : outline[2].x + 10,
      horizontal ? outline[1].y + 15 : (e.y1 + e.y2) / 2 + 4,
      e.text,
      horizontal ? 'center' : 'left',
    );
  }
  currentDots(g, p1, coilLeads[0], g.current);
  currentDots(g, coilLeads[1], p2, g.current);
}

export const RELAY_COIL_DEF: ElementDef = {
  kind: 'relayCoil',
  label: 'Relay coil',
  category: 'Basics',
  dumpCode: '425',
  postCount: 2,
  posts: twoPosts,
  noDiagonal: true,  // RelayCoilElm.java:84
  defaultFlags: 0,
  // The label is the link key, and the no-args constructor defaults it to
  // "label" (RelayCoilElm.java:88), so a fresh coil pairs with a fresh
  // contact without a hand-typed label.
  defaultText: 'label',
  defaults: {
    inductance: 0.2,
    coilCurrent: 0,
    onCurrent: 0.02,
    coilR: 20,
    offCurrent: 0.015,
    switchingTime: 0.005,
    type: 0,
    state: 0,
    switchPosition: 0,
  },
  parse: (t, e) => {
    if (t[0] !== undefined) e.text = t[0];
    readParams(t.slice(1), e, [
      'inductance',
      'coilCurrent',
      'onCurrent',
      'coilR',
      'offCurrent',
      'switchingTime',
      'type',
      'state',
      'switchPosition',
    ]);
  },
  dump: (e) => [
    e.text ?? '',
    e.params.inductance ?? 0.2,
    e.params.coilCurrent ?? 0,
    e.params.onCurrent ?? 0.02,
    e.params.coilR ?? 20,
    e.params.offCurrent ?? 0.015,
    e.params.switchingTime ?? 0.005,
    e.params.type ?? 0,
    e.params.state ?? 0,
    e.params.switchPosition ?? 0,
  ],
  fields: [
    { name: 'type', label: 'Type', type: 'choice', choices: [
      { value: 0, label: 'Normal' },
      { value: 1, label: 'On delay' },
      { value: 2, label: 'Off delay' },
      { value: 3, label: 'Latching' },
      { value: 4, label: 'Latching set' },
      { value: 5, label: 'Latching reset' },
    ] },
    { name: 'inductance', label: 'Inductance', unit: 'H' },
    { name: 'onCurrent', label: 'On current', unit: 'A' },
    { name: 'offCurrent', label: 'Off current', unit: 'A' },
    { name: 'coilR', label: 'Coil resistance', unit: 'Ω' },
    { name: 'switchingTime', label: 'Switching time', unit: 's' },
    { name: 'label', label: 'Label (for linking)', type: 'text', target: 'text' },
  ],
  draw: drawRelayCoil,
};

/** The contact's connectable posts are the two circuit terminals; the third
 *  drawn throw is cosmetic, exactly as upstream's getPostCount() returns 2
 *  while draw() renders three throws (RelayContactElm.java:172-178, :195-197). */
function drawRelayContact(g: DrawContext, e: CircuitElement): void {
  const [p1, p2] = endpoints(e);
  const [lead1, lead2] = calcLeads(e, 32);
  const openhs = dsign(p1, p2) * OPEN_HS;
  const swpoles = [
    interp(lead1, lead2, 0, 0),
    interp(lead1, lead2, 1, 0),
    interp(lead1, lead2, 1, openhs),
  ];
  const swposts = [interp(p1, p2, 0, 0), interp(p1, p2, 1, 0), interp(p1, p2, 1, openhs)];
  const pos = Math.max(0, Math.min(1, e.params.i_position ?? 0));

  lead(g, swposts[0], swpoles[0], voltageColor(g, g.voltages[0]));
  lead(g, swposts[1], swpoles[1], voltageColor(g, g.voltages[1]));
  const tip = interp(swpoles[1], swpoles[2], pos);
  // The contact blade is lightGray in upstream too (RelayContactElm.java:
  // 106-109).
  line(g, swpoles[0], tip, g.theme.lightGray);
  currentDots(g, swposts[0], swpoles[0], g.current);
  if (pos === 0) currentDots(g, swpoles[1], swposts[1], g.current);

  if (e.text) {
    const horizontal = Math.abs(e.x2 - e.x1) >= Math.abs(e.y2 - e.y1);
    const mid = swpoles[horizontal ? 0 : (e.y1 < e.y2 ? 0 : 1)];
    textAt(
      g,
      horizontal ? (e.x1 + e.x2) / 2 : p1.x + 10,
      horizontal ? mid.y - 5 : mid.y,
      e.text,
      horizontal ? 'center' : 'left',
    );
  }
}

export const RELAY_CONTACT_DEF: ElementDef = {
  kind: 'relayContact',
  label: 'Relay contact',
  category: 'Basics',
  dumpCode: '426',
  postCount: 2,
  posts: twoPosts,
  // The blade's region, from the same lead geometry the draw uses: the three
  // poles it can rest on (RelayContactElm.java:172-174). Not gated today: the
  // engine drives the blade from the linked coil, so this def stays
  // non-interactive and the rect is inert.
  switchRect: (e) => {
    const [p1, p2] = endpoints(e);
    const [lead1, lead2] = calcLeads(e, 32);
    const openhs = dsign(p1, p2) * OPEN_HS;
    return rectOfPoints([interp(lead1, lead2, 0, 0), interp(lead1, lead2, 1, 0), interp(lead1, lead2, 1, openhs)]);
  },
  noDiagonal: true,  // RelayContactElm.java:59
  defaultFlags: 4,   // FLAG_IEC, RelayContactElm.java:63
  // The contact links to its coil by this label, and the constructor defaults
  // it to "label" (RelayContactElm.java:62), matching the coil's own default.
  defaultText: 'label',
  defaults: {
    r_on: 0.05,
    r_off: 1e6,
    i_position: 0,
  },
  parse: (t, e) => {
    if (t[0] !== undefined) e.text = t[0];
    readParams(t.slice(1), e, ['r_on', 'r_off', 'i_position']);
  },
  dump: (e) => {
    const tokens: (string | number)[] = [e.text ?? '', e.params.r_on ?? 0.05, e.params.r_off ?? 1e6];
    if (e.params.i_position !== undefined) tokens.push(e.params.i_position);
    return tokens;
  },
  fields: [
    { name: 'r_on', label: 'On resistance', unit: 'Ω' },
    { name: 'r_off', label: 'Off resistance', unit: 'Ω' },
    { name: 'label', label: 'Label (for linking)', type: 'text', target: 'text' },
    { name: 'nc', label: 'Normally closed', type: 'bool', flag: RELAY_CONTACT_NORMALLY_CLOSED },
    { name: 'iec', label: 'IEC symbol', type: 'bool', flag: RELAY_CONTACT_IEC },
  ],
  draw: drawRelayContact,
};
