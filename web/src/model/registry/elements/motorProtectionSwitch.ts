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
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** Column spacing between the three pole pairs (MotorProtectionSwitchElm.java:136). */
const CHANNEL_SPACING = 48;
/** Body height, the y span of setPoints (MotorProtectionSwitchElm.java:97). */
const MPS_HEIGHT = 192;

/** The six posts, in upstream's order: per channel the top terminal at
 *  `y`, then the bottom terminal at `y + 192` (MotorProtectionSwitchElm.java:95-100). */
function motorProtectionSwitchPosts(e: CircuitElement): Point[] {
  const posts: Point[] = [];
  for (let i = 0; i < 3; i++) {
    posts.push({ x: e.x1 + i * CHANNEL_SPACING, y: e.y1 });
    posts.push({ x: e.x1 + i * CHANNEL_SPACING, y: e.y1 + MPS_HEIGHT });
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
  const ax = e.x1;
  const ay = e.y1;
  const blown = (e.params.blown ?? 0) !== 0;
  const topColor = (i: number) => voltageColor(g, g.voltages[2 * i]);
  const bottomColor = (i: number) => voltageColor(g, g.voltages[2 * i + 1]);

  // Light meter-panel grid behind the three channels
  // (MotorProtectionSwitchElm.java:177-181).
  for (let i = 0; i < 3; i++) {
    line(
      g,
      { x: ax - 24, y: ay + 80 + 48 * i },
      { x: ax + 120, y: ay + 80 + 48 * i },
      g.theme.text,
      1,
    );
  }
  for (let i = 0; i < 4; i++) {
    line(
      g,
      { x: ax + i * CHANNEL_SPACING - 24, y: ay + 80 },
      { x: ax + i * CHANNEL_SPACING - 24, y: ay + 176 },
      g.theme.text,
      1,
    );
  }

  for (let i = 0; i < 3; i++) {
    const x = ax + i * CHANNEL_SPACING;
    const topPost = { x, y: ay };
    const bottomPost = { x, y: ay + MPS_HEIGHT };

    // Terminal, fuse mark, blade and body stub down to the heat element
    // (MotorProtectionSwitchElm.java:149-160).
    lead(g, topPost, { x, y: ay + 32 }, topColor(i));
    if (blown) {
      line(g, { x: x - 4, y: ay + 32 }, { x: x + 4, y: ay + 32 }, topColor(i));
    }
    const bladeStart = { x: blown ? x - 16 : x, y: ay + 32 };
    lead(g, bladeStart, { x, y: ay + 64 }, topColor(i));
    lead(g, { x, y: ay + 64 }, { x, y: ay + 80 }, topColor(i));

    // The fuse X just below the terminal (MotorProtectionSwitchElm.java:159-160),
    // a plain drawLine upstream and so drawn at fine width 1.
    g.ctx.strokeStyle = topColor(i);
    g.ctx.lineWidth = 1;
    g.ctx.beginPath();
    g.ctx.moveTo(x - 4, ay + 12);
    g.ctx.lineTo(x + 4, ay + 20);
    g.ctx.moveTo(x + 4, ay + 12);
    g.ctx.lineTo(x - 4, ay + 20);
    g.ctx.stroke();

    // The zigzag heat element whose I²t integration trips the switch
    // (MotorProtectionSwitchElm.java:164-170), plain drawLines upstream.
    const heatColor = voltageColor(g, (g.voltages[2 * i] + g.voltages[2 * i + 1]) / 2);
    line(g, { x, y: ay + 80 }, { x, y: ay + 96 }, heatColor, 1);
    line(g, { x: x - 12, y: ay + 96 }, { x: x - 12, y: ay + 112 }, heatColor, 1);
    line(g, { x: x - 12, y: ay + 96 }, { x, y: ay + 96 }, heatColor, 1);
    line(g, { x: x - 12, y: ay + 112 }, { x, y: ay + 112 }, heatColor, 1);
    line(g, { x, y: ay + 112 }, { x, y: ay + 128 }, heatColor, 1);

    // The overcurrent threshold marker (MotorProtectionSwitchElm.java:175).
    g.ctx.fillStyle = g.theme.text;
    g.ctx.font = canvasFont(11);
    g.ctx.textAlign = 'center';
    g.ctx.textBaseline = 'middle';
    g.ctx.fillText('I>', x, ay + 152);

    lead(g, { x, y: ay + 176 }, bottomPost, bottomColor(i));
  }

  // The label terminal block on the left and the label text beside it
  // (MotorProtectionSwitchElm.java:141-146, :183-191). Upstream draws the
  // block's grid and lead as plain `g.drawLine` calls, so they stay at fine
  // width 1 while the channel leads draw thick.
  const square = { x: ax - CHANNEL_SPACING - 12, y: ay + 36 };
  closedPolyline(
    g,
    [
      square,
      { x: square.x + 24, y: square.y },
      { x: square.x + 24, y: square.y + 24 },
      { x: square.x, y: square.y + 24 },
      square,
    ],
    g.theme.text,
    1,
  );
  line(g, { x: square.x - CHANNEL_SPACING / 2, y: square.y + 12 }, square, g.theme.text, 1);
  line(
    g,
    { x: square.x - CHANNEL_SPACING / 2, y: square.y },
    { x: square.x - CHANNEL_SPACING / 2, y: square.y + 24 },
    g.theme.text,
    1,
  );
  if (e.text) {
    g.ctx.fillStyle = g.theme.text;
    g.ctx.font = canvasFont(11);
    g.ctx.textAlign = 'left';
    g.ctx.textBaseline = 'middle';
    g.ctx.fillText(e.text, ax + 120, square.y + 12);
  }

  // Current dots on each channel, only while the switch is intact, like
  // upstream's `if (!blown)` guard (MotorProtectionSwitchElm.java:193-199).
  // The top run covers the blade, the bottom run the lower lead, both in the
  // same post-to-lead direction as upstream's drawDots calls.
  if (!blown) {
    for (let i = 0; i < 3; i++) {
      const current = channelCurrent(g, e, i);
      const x = ax + i * CHANNEL_SPACING;
      currentDots(g, { x, y: ay }, { x, y: ay + 80 }, current);
      // The lower run is the mirror of the upper one, like upstream's
      // `drawDots(g, posts[i*2+1], leads[i*2+1], -curcounts[i])`
      // (MotorProtectionSwitchElm.java:197): the dots on the lower lead move
      // toward the bottom post when the channel conducts top to bottom.
      currentDots(g, { x, y: ay + 176 }, { x, y: ay + MPS_HEIGHT }, current);
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
  defaultLength: 4, // 64 px, the base getDragLength
  defaults: { resistance: 0.0613, i2t: 6.73 },
  // dump() and the token constructor both go resistance, i2t, blown, label
  // (MotorProtectionSwitchElm.java:48-64); blown is a literal `true`/`false`
  // token, and the label is one escaped token read defensively upstream.
  parse: (t, e) => {
    readParams(t, e, ['resistance', 'i2t']);
    e.params.blown = t[2] === 'true' ? 1 : 0;
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
