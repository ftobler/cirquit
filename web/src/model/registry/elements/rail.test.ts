import { describe, expect, it, vi } from 'vitest';
import { RAIL_DEF } from './rail';
import { RAIL_SHOW_VOLTAGE } from '../flags';
import type { CircuitElement, DrawContext } from '../../types';

function mk(waveform: number, flags: number): CircuitElement {
  return {
    id: 1,
    kind: 'rail',
    x1: 0,
    y1: 0,
    x2: 100,
    y2: 0,
    flags,
    params: { ...(RAIL_DEF.defaults ?? {}), waveform, maxVoltage: 5, frequency: 40 },
  };
}

/** Minimal canvas stub recording only the text the caption draws. */
function mkCtx() {
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    createLinearGradient: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    closePath: vi.fn(),
    fillText: vi.fn(),
    setLineDash: vi.fn(),
    measureText: (text: string) => ({ width: text.length * 6 }),
  };
}

const context = (ctx: ReturnType<typeof mkCtx>, overrides: Partial<DrawContext> = {}): DrawContext => ({
  ctx: ctx as unknown as CanvasRenderingContext2D,
  theme: { text: '#fff' } as never,
  voltages: [0],
  current: 0,
  voltage: 0,
  power: 0,
  value: 0,
  state: 0,
  wave: [],
  dotPhase: 0,
  postCurrents: [],
  postDotPhases: [],
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
});

const captions = (waveform: number, flags: number, showValues = true): string[] => {
  const ctx = mkCtx();
  RAIL_DEF.draw(context(ctx, { showValues, voltages: [0] }), mk(waveform, flags));
  // The stem, circle and waveform glyph emit no fillText; the recorded texts
  // are exactly the caption.
  return ctx.fillText.mock.calls.map((a: unknown[]) => String(a[0]));
};

describe('rail caption', () => {
  it('gates the non-DC value caption on RAIL_SHOW_VOLTAGE', () => {
    // A sine rail with the bit set draws the voltage plus the frequency;
    // without it the frequency alone rides the global show-values toggle
    // (VoltageElm.java:406-417).
    expect(captions(1, RAIL_SHOW_VOLTAGE)).toEqual(['5V 40Hz']);
    expect(captions(1, 0)).toEqual(['40Hz']);
  });

  it('suppresses the frequency fallback when global show-values is off', () => {
    expect(captions(1, 0, false)).toEqual([]);
  });

  it('draws the DC label unconditionally, since bit 64 does nothing there', () => {
    // Upstream's DC rail label always draws (RailElm.java:69-80); the Show
    // Voltage row is hidden for the DC waveform precisely because this flag is
    // not its control.
    expect(captions(0, 0)).toEqual(['+5V']);
    expect(captions(0, RAIL_SHOW_VOLTAGE)).toEqual(['+5V']);
  });
});