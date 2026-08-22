import { describe, expect, it, vi } from 'vitest';
import { VOLTAGE_DEF } from './voltage';
import { VOLTAGE_SHOW_VOLTAGE } from '../flags';
import type { CircuitElement, DrawContext } from '../../types';

function mk(waveform: number, flags: number): CircuitElement {
  return {
    id: 1,
    kind: 'voltage',
    x1: 0,
    y1: 0,
    x2: 64,
    y2: 0,
    flags,
    params: { ...(VOLTAGE_DEF.defaults ?? {}), waveform, maxVoltage: 5 },
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
  voltages: [0, 0],
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

const captions = (waveform: number, flags: number): string[] => {
  const ctx = mkCtx();
  VOLTAGE_DEF.draw(context(ctx, { showValues: true, voltages: [0, 0] }), mk(waveform, flags));
  // The battery plates and the waveform glyph emit no fillText; the caption
  // is the only one, so the recorded texts are exactly the caption.
  return ctx.fillText.mock.calls.map((a: unknown[]) => String(a[0]));
};

describe('voltage source caption', () => {
  it('the Show Voltage flag gates the DC battery caption', () => {
    // Waveform 0, no circle flag: the two-plate battery symbol.
    expect(captions(0, VOLTAGE_SHOW_VOLTAGE)).toEqual(['5V']);
    expect(captions(0, 0)).toEqual([]);
  });

  it('the Show Voltage flag gates the circle-and-waveform caption', () => {
    // A sine draws the source circle; its caption obeys the same flag.
    expect(captions(1, VOLTAGE_SHOW_VOLTAGE)).toEqual(['5V']);
    expect(captions(1, 0)).toEqual([]);
  });

  it('the global show-values toggle still suppresses the caption', () => {
    const ctx = mkCtx();
    VOLTAGE_DEF.draw(
      context(ctx, { showValues: false, voltages: [0, 0] }),
      mk(0, VOLTAGE_SHOW_VOLTAGE),
    );
    expect(ctx.fillText.mock.calls).toEqual([]);
  });
});