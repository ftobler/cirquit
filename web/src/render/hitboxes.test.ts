import { describe, expect, it, vi } from 'vitest';
import type { CircuitElement } from '../model/types';
import { defFor } from '../model/registry';
import { hitRegions } from './geometry';
import { HITBOX_COLORS, drawHitboxes } from './hitboxes';

/** A recording 2D context stub. Only the calls the overlay makes are stubbed;
 *  the point is which shapes are asked for and at what size, never pixels. */
const recordingCtx = () => {
  const arcs: { x: number; y: number; r: number; color: string }[] = [];
  const rects: { x: number; y: number; w: number; h: number; color: string }[] = [];
  const stub = {
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn((x: number, y: number, r: number) => {
      arcs.push({ x, y, r, color: stub.strokeStyle });
    }),
    strokeRect: vi.fn((x: number, y: number, w: number, h: number) => {
      rects.push({ x, y, w, h, color: stub.strokeStyle });
    }),
    save: vi.fn(),
    restore: vi.fn(),
    setLineDash: vi.fn(),
  };
  return { ctx: stub as unknown as CanvasRenderingContext2D, stub, arcs, rects };
};

const element = (kind: string, x1: number, y1: number, x2: number, y2: number): CircuitElement => ({
  id: 1,
  kind,
  x1,
  y1,
  x2,
  y2,
  flags: 0,
  params: {},
});

describe('drawHitboxes', () => {
  it('draws every terminal circle at the reach the picker allows', () => {
    const { ctx, arcs } = recordingCtx();
    const e = element('resistor', 0, 0, 160, 0);
    drawHitboxes(ctx, [e], 8, 1);
    const posts = arcs.filter((a) => a.color === HITBOX_COLORS.post && a.r === 8);
    // One full circle per terminal, centred on the terminal itself.
    expect(posts.map((a) => ({ x: a.x, y: a.y }))).toEqual([
      { x: 0, y: 0 },
      { x: 160, y: 0 },
    ]);
    // The axis band is a capsule, so its two caps carry the axis hue at the
    // same radius: a fat line would be a different shape from the one the
    // distance test measures.
    const axis = arcs.filter((a) => a.color === HITBOX_COLORS.axis);
    expect(axis).toHaveLength(2);
    expect(axis.every((a) => a.r === 8)).toBe(true);
  });

  it('grows a chip housing by the reach and keeps the def rect as its core', () => {
    const { ctx, arcs } = recordingCtx();
    const e = element('dFlipFlop', 0, 0, 96, 0);
    const box = defFor('dFlipFlop')!.bodyRect!(e);
    drawHitboxes(ctx, [e], 8, 1);
    // Four quarter-circle corners, one per rect corner, all at the reach.
    const corners = arcs.filter((a) => a.color === HITBOX_COLORS.body);
    expect(corners).toHaveLength(4);
    expect(corners.every((a) => a.r === 8)).toBe(true);
    expect(new Set(corners.map((a) => `${a.x},${a.y}`))).toEqual(
      new Set([
        `${box.x0},${box.y0}`,
        `${box.x1},${box.y0}`,
        `${box.x0},${box.y1}`,
        `${box.x1},${box.y1}`,
      ]),
    );
  });

  it('draws a switch lever ungrown, because its test is plain containment', () => {
    const { ctx, rects } = recordingCtx();
    const e = element('switch', 0, 0, 64, 0);
    const lever = defFor('switch')!.switchRect!(e);
    drawHitboxes(ctx, [e], 8, 1);
    expect(rects).toEqual([
      { x: lever.x, y: lever.y, w: lever.w, h: lever.h, color: HITBOX_COLORS.switch },
    ]);
  });

  it('draws one band per routed wire segment and no terminal circles', () => {
    const { ctx, arcs } = recordingCtx();
    const wire: CircuitElement = {
      ...element('wire', 0, 0, 160, 0),
      route: [
        [0, 0],
        [80, 80],
        [160, 0],
      ],
    };
    // The picker measures the polyline alone for a routed wire, so the overlay
    // must show exactly that: two capsules, two caps each, no post circles.
    expect(hitRegions(wire)).toHaveLength(2);
    drawHitboxes(ctx, [wire], 8, 1);
    expect(arcs.filter((a) => a.color === HITBOX_COLORS.wire)).toHaveLength(4);
    expect(arcs.some((a) => a.color === HITBOX_COLORS.post)).toBe(false);
  });

  it('leaves the context settings it borrowed', () => {
    const { ctx, stub } = recordingCtx();
    drawHitboxes(ctx, [element('resistor', 0, 0, 160, 0)], 8, 0.5);
    expect(stub.save).toHaveBeenCalledTimes(1);
    expect(stub.restore).toHaveBeenCalledTimes(1);
    // The hairline is asked for in circuit units, so the caller can hold it at
    // one screen pixel through a zoom.
    expect(stub.lineWidth).toBe(0.5);
  });
});
