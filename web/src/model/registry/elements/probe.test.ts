import { describe, expect, it } from 'vitest';
import { makeGhostElement } from '../../../state/helpers';
import { rotateElement } from '../../transform';
import { PROBE_DEF, meterTraceMarkers, probePlusPoint } from './probe';
import type { CircuitElement, DrawContext } from '../../types';

/** A canvas stub that records the text and the fill colour it was drawn in. */
function recordingCtx() {
  const texts: { text: string; fill: string }[] = [];
  const target = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    globalAlpha: 1,
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    arc: () => {},
    fill: () => {},
    closePath: () => {},
    setLineDash: () => {},
    measureText: (text: string) => ({ width: text.length * 6 }),
    fillText: (text: string) => {
      texts.push({ text, fill: String(target.fillStyle) });
    },
  };
  const ctx = new Proxy(target, {
    get: (t, prop) => (prop in t ? t[prop as keyof typeof t] : () => {}),
    set: (t, prop, value) => {
      (t as Record<string | symbol, unknown>)[prop] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts };
}

function context(ctx: CanvasRenderingContext2D, overrides: Partial<DrawContext> = {}): DrawContext {
  return {
    ctx,
    theme: { text: '#eee', wire: '#888', currentDot: '#0ff' } as never,
    voltages: [1, 0],
    current: 0.01,
    voltage: 1,
    power: 0.01,
    value: 1,
    state: 0,
    wave: [],
    dotPhase: 0,
    postCurrents: [-0.01, 0.01],
    postDotPhases: [0, 0],
    showCurrent: false,
    showValues: true,
    showVoltageColor: false,
    showPowerColor: false,
    conventional: true,
    euroResistors: true,
    euroGates: false,
    selected: false,
    hovered: false,
    onHighlightedNet: false,
    voltageRange: 5,
    powerRange: 50,
    scale: 1,
    valueDigits: 1,
    valueFontSize: 12,
    ...overrides,
  };
}

describe('voltmeter polarity', () => {
  it('is placed vertically with the positive post 0 on top', () => {
    const e = makeGhostElement('probe', 0, 0, 0);
    expect(e.x1).toBe(e.x2);
    expect(e.y1).toBeLessThan(e.y2);
  });

  it('marks + beside post 0 in every orientation', () => {
    // Placed, then turned a quarter at a time: the mark must always sit on the
    // post-0 half of the body, never the post-1 half.
    let e: CircuitElement = { ...makeGhostElement('probe', 0, 0, 0), id: 1 };
    for (let turn = 0; turn < 4; turn++) {
      const p1 = { x: e.x1, y: e.y1 };
      const p2 = { x: e.x2, y: e.y2 };
      const dn = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const plus = probePlusPoint(p1, p2, dn);
      const d1 = Math.hypot(plus.x - p1.x, plus.y - p1.y);
      const d2 = Math.hypot(plus.x - p2.x, plus.y - p2.y);
      expect(d1, `turn ${turn}`).toBeLessThan(d2);
      e = rotateElement(e);
    }
  });

  it('puts + above the circle on a freshly placed meter', () => {
    const e = makeGhostElement('probe', 0, 0, 0);
    const p1 = { x: e.x1, y: e.y1 };
    const p2 = { x: e.x2, y: e.y2 };
    const plus = probePlusPoint(p1, p2, Math.hypot(p2.x - p1.x, p2.y - p1.y));
    expect(plus.y).toBeLessThan((e.y1 + e.y2) / 2 - 12);
  });
});

describe('voltmeter scope link', () => {
  const meter = (): CircuitElement => ({ ...makeGhostElement('probe', 0, 0, 0), id: 4 });

  it('draws the viewer label above the disc', () => {
    const e = { ...meter(), text: 'Supply A' };
    const { ctx, texts } = recordingCtx();
    PROBE_DEF.draw(context(ctx), e);
    expect(texts.map((t) => t.text)).toContain('Supply A');
  });

  it('draws each reading trace in its own colour', () => {
    const { ctx, texts } = recordingCtx();
    const traces = new Map([
      [
        4,
        [
          { plotId: 1, scopeId: 1, color: '#123456', label: 'Scope 1', unit: 'V' },
          { plotId: 2, scopeId: 2, color: '#abcdef', label: 'Scope 2', unit: 'A' },
        ],
      ],
    ]);
    PROBE_DEF.draw(context(ctx, { meterTraces: traces }), meter());
    expect(texts.find((t) => t.text === 'Scope 1 V')?.fill).toBe('#123456');
    expect(texts.find((t) => t.text === 'Scope 2 A')?.fill).toBe('#abcdef');
  });

  it('keeps the label and the link out of the file', () => {
    const e = { ...meter(), text: 'Supply A' };
    // The probe's own tokens are meter, scale and resistance; a label field
    // exists in the editor but never reaches dump().
    const dumped = PROBE_DEF.dump?.(e) ?? [];
    expect(dumped).toHaveLength(3);
    expect(dumped).not.toContain('Supply A');
    expect(PROBE_DEF.fields?.some((f) => f.target === 'text')).toBe(true);
  });

  it('stacks markers below the disc', () => {
    expect(meterTraceMarkers({ x: 10, y: 20 }, 2)).toEqual([
      { x: 10, y: 38 },
      { x: 10, y: 49 },
    ]);
  });
});
