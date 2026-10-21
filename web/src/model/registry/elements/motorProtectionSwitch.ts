/**
 * Motor protection switch (MotorProtectionSwitchElm.java, dump 428): three
 * independent fuse channels, one per motor phase, sharing a single trip flag.
 * Any channel's accumulated I²t crossing the rating opens all three at once,
 * and the switch drives the relay contact sharing its label, so a tripped
 * switch can drop out a contactor in the motor circuit
 * (MotorProtectionSwitchElm.java:221-243, :245-256). The body hangs off the
 * first dragged point and always extends downward; the second endpoint is
 * inert, because upstream's setPoints uses only `x, y`
 * (MotorProtectionSwitchElm.java:90-101).
 */

import { canvasFont, closedPolyline, currentDots, lead, line, voltageColor } from '../../../render/draw';
import { readParams, boxOfPoints } from '../shared';
import { boolToken } from './switch';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** Column spacing between the three pole pairs (MotorProtectionSwitchElm.java:136). */
const CHANNEL_SPACING = 48;
/** Body height, the y span of setPoints (MotorProtectionSwitchElm.java:97). */
const MPS_HEIGHT = 192;

/** Port extension: the body's dihedral orientation. The body always extends
 *  from the first dragged point in fixed local +x/+y directions upstream, and
 *  upstream forbids flipping it (canFlipX/Y are false), so it has no flags.
 *  The port turns and mirrors every two-point part; this three-bit state
 *  records the rotation and the mirror so each post lands on its rigid image
 *  while an unrotated loaded file (state 0) keeps the old coordinates. Bits
 *  0-1 are the quarter-turn count, bit 2 the mirror. */
export const MPS_ORIENT_MASK = 7;
export const MPS_ROTATION_MASK = 3;
export const MPS_MIRROR = 4;

/** Local body coordinates to circuit space: mirror across the local y axis
 *  first, then the stored number of quarter turns, then the anchor. This is
 *  the dihedral element D = R^r M^m; transform.ts composes turns and mirrors
 *  into the same state. */
function mpsMap(e: CircuitElement): (x: number, y: number) => Point {
  const state = e.flags & MPS_ORIENT_MASK;
  const turns = state & MPS_ROTATION_MASK;
  const mirror = (state & MPS_MIRROR) !== 0 ? -1 : 1;
  return (x, y) => {
    let px = mirror * x;
    let py = y;
    for (let i = 0; i < turns; i++) {
      const nx = py;
      py = -px;
      px = nx;
    }
    return { x: e.x1 + px, y: e.y1 + py };
  };
}

/** The six posts, in upstream's order: per channel the top terminal at
 *  `y`, then the bottom terminal at `y + 192` (MotorProtectionSwitchElm.java:95-100),
 *  both carried by the body's orientation state. */
function motorProtectionSwitchPosts(e: CircuitElement): Point[] {
  const map = mpsMap(e);
  const posts: Point[] = [];
  for (let i = 0; i < 3; i++) {
    posts.push(map(i * CHANNEL_SPACING, 0));
    posts.push(map(i * CHANNEL_SPACING, MPS_HEIGHT));
  }
  return posts;
}

/** Per-channel current, derived from the terminal voltages exactly like the
 *  engine's calculateCurrent (MotorProtectionSwitchElm.java:205-209). Only
 *  voltages and params cross the engine boundary, so the draw recomputes the
 *  same division, using the file's blown flag for the effective resistance.
 *  The dots only matter while a channel is intact anyway; a tripped channel
 *  draws none. */
function channelCurrent(g: DrawContext, e: CircuitElement, i: number): number {
  const blown = (e.params.blown ?? 0) !== 0;
  const r = blown ? 1e9 : (e.params.resistance ?? 0.0613);
  return ((g.voltages[2 * i] ?? 0) - (g.voltages[2 * i + 1] ?? 0)) / r;
}

function drawMotorProtectionSwitch(g: DrawContext, e: CircuitElement): void {
  const map = mpsMap(e);
  const blown = (e.params.blown ?? 0) !== 0;
  const topColor = (i: number) => voltageColor(g, g.voltages[2 * i]);
  const bottomColor = (i: number) => voltageColor(g, g.voltages[2 * i + 1]);

  // Light meter-panel grid behind the three channels
  // (MotorProtectionSwitchElm.java:177-181).
  for (let i = 0; i < 3; i++) {
    line(g, map(-24, 80 + 48 * i), map(120, 80 + 48 * i), g.theme.text, 1);
  }
  for (let i = 0; i < 4; i++) {
    line(
      g,
      map(i * CHANNEL_SPACING - 24, 80),
      map(i * CHANNEL_SPACING - 24, 176),
      g.theme.text,
      1,
    );
  }

  for (let i = 0; i < 3; i++) {
    const x = i * CHANNEL_SPACING;
    const topPost = map(x, 0);
    const bottomPost = map(x, MPS_HEIGHT);

    // Terminal, fuse mark, blade and body stub down to the heat element
    // (MotorProtectionSwitchElm.java:149-160).
    lead(g, topPost, map(x, 32), topColor(i));
    if (blown) {
      line(g, map(x - 4, 32), map(x + 4, 32), topColor(i));
    }
    const bladeStart = map(blown ? x - 16 : x, 32);
    lead(g, bladeStart, map(x, 64), topColor(i));
    lead(g, map(x, 64), map(x, 80), topColor(i));

    // The fuse X just below the terminal (MotorProtectionSwitchElm.java:159-160),
    // a plain drawLine upstream and so drawn at fine width 1.
    const x1 = map(x - 4, 12);
    const x2 = map(x + 4, 20);
    const x3 = map(x + 4, 12);
    const x4 = map(x - 4, 20);
    g.ctx.strokeStyle = topColor(i);
    g.ctx.lineWidth = 1;
    g.ctx.beginPath();
    g.ctx.moveTo(x1.x, x1.y);
    g.ctx.lineTo(x2.x, x2.y);
    g.ctx.moveTo(x3.x, x3.y);
    g.ctx.lineTo(x4.x, x4.y);
    g.ctx.stroke();

    // The zigzag heat element whose I²t integration trips the switch
    // (MotorProtectionSwitchElm.java:164-170), plain drawLines upstream.
    const heatColor = voltageColor(g, (g.voltages[2 * i] + g.voltages[2 * i + 1]) / 2);
    line(g, map(x, 80), map(x, 96), heatColor, 1);
    line(g, map(x - 12, 96), map(x - 12, 112), heatColor, 1);
    line(g, map(x - 12, 96), map(x, 96), heatColor, 1);
    line(g, map(x - 12, 112), map(x, 112), heatColor, 1);
    line(g, map(x, 112), map(x, 128), heatColor, 1);

    // The overcurrent threshold marker (MotorProtectionSwitchElm.java:175).
    const marker = map(x, 152);
    g.ctx.fillStyle = g.theme.text;
    g.ctx.font = canvasFont(11);
    g.ctx.textAlign = 'center';
    g.ctx.textBaseline = 'middle';
    g.ctx.fillText('I>', marker.x, marker.y);

    lead(g, map(x, 176), bottomPost, bottomColor(i));
  }

  // The label terminal block on the left and the label text beside it
  // (MotorProtectionSwitchElm.java:141-146, :183-191). Upstream draws the
  // block's grid and lead as plain `g.drawLine` calls, so they stay at fine
  // width 1 while the channel leads draw thick.
  const square = map(-CHANNEL_SPACING - 12, 36);
  closedPolyline(
    g,
    [
      square,
      map(-CHANNEL_SPACING + 12, 36),
      map(-CHANNEL_SPACING + 12, 60),
      map(-CHANNEL_SPACING - 12, 60),
      square,
    ],
    g.theme.text,
    1,
  );
  line(g, map(-CHANNEL_SPACING - 12 - CHANNEL_SPACING / 2, 48), square, g.theme.text, 1);
  line(
    g,
    map(-CHANNEL_SPACING - 12 - CHANNEL_SPACING / 2, 36),
    map(-CHANNEL_SPACING - 12 - CHANNEL_SPACING / 2, 60),
    g.theme.text,
    1,
  );
  if (e.text) {
    const label = map(120, 48);
    g.ctx.fillStyle = g.theme.text;
    g.ctx.font = canvasFont(11);
    g.ctx.textAlign = 'left';
    g.ctx.textBaseline = 'middle';
    g.ctx.fillText(e.text, label.x, label.y);
  }

  // Current dots on each channel, only while the switch is intact, like
  // upstream's `if (!blown)` guard (MotorProtectionSwitchElm.java:193-199).
  // The top run covers the blade, the bottom run the lower lead, both in the
  // same post-to-lead direction as upstream's drawDots calls.
  if (!blown) {
    for (let i = 0; i < 3; i++) {
      const current = channelCurrent(g, e, i);
      const x = i * CHANNEL_SPACING;
      currentDots(g, map(x, 0), map(x, 80), current);
      // The lower run is the mirror of the upper one, like upstream's
      // `drawDots(g, posts[i*2+1], leads[i*2+1], -curcounts[i])`
      // (MotorProtectionSwitchElm.java:197): the dots on the lower lead move
      // toward the bottom post when the channel conducts top to bottom.
      currentDots(g, map(x, 176), map(x, MPS_HEIGHT), current);
    }
  }
}

export const MOTOR_PROTECTION_SWITCH_DEF: ElementDef = {
  kind: 'motorProtectionSwitch',
  label: 'Motor protection switch',
  category: 'Basics',
  dumpCode: '428',
  postCount: 6,
  posts: motorProtectionSwitchPosts,
  canMirror: true,  // port extension; upstream canFlipX/Y are false
  defaultLength: 4, // 64 px, the base getDragLength
  defaults: { resistance: 0.0613, i2t: 6.73 },
  // dump() and the token constructor both go resistance, i2t, blown, label
  // (MotorProtectionSwitchElm.java:48-64); blown is a literal `true`/`false`
  // token, and the label is one escaped token read defensively upstream.
  parse: (t, e) => {
    readParams(t, e, ['resistance', 'i2t']);
    e.params.blown = boolToken(t[2]);
    if (t[3] !== undefined) e.text = t[3];
  },
  dump: (e) => [
    e.params.resistance ?? 0.0613,
    e.params.i2t ?? 6.73,
    (e.params.blown ?? 0) !== 0 ? 'true' : 'false',
    e.text ?? '',
  ],
  fields: [
    { name: 'i2t', label: 'I²t rating', unit: 'A²s' },
    { name: 'resistance', label: 'On resistance', unit: 'Ω' },
    { name: 'label', label: 'Label (for linking)', type: 'text', target: 'text' },
  ],
  // The whole switch bank, three channels high, is a solid pick zone: a click
  // anywhere on the body grabs it (MotorProtectionSwitchElm.java:90-101).
  bodyRect: (e) => boxOfPoints(motorProtectionSwitchPosts(e)),
  draw: drawMotorProtectionSwitch,
};
