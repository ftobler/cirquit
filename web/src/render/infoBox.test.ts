import { describe, expect, it, vi } from 'vitest';
import type { CircuitElement, Context2D } from '../model/types';
import { canvasFont, makeTheme } from './draw';
import {
  drawInfoBox,
  getTimeText,
  INFO_LINE_SPACING,
  infoBoxX,
  infoBoxY,
  infoLines,
  simStatsLines,
} from './infoBox';

const el = (kind: string, params: Record<string, number>): CircuitElement => ({
  id: 1,
  kind,
  x1: 0,
  y1: 0,
  x2: 160,
  y2: 0,
  flags: 0,
  params,
});

/** The fake-surface slice drawInfoBox writes to, mirroring the recorders the
 *  rest of the draw layer tests use. */
interface FakeSurface {
  fillStyle: string;
  font: string;
  textAlign: string;
  textBaseline: string;
  fillText: ReturnType<typeof vi.fn>;
}

const fake = (): FakeSurface => ({
  fillStyle: '',
  font: '',
  textAlign: '',
  textBaseline: '',
  fillText: vi.fn(),
});

describe('infoLines', () => {
  it('returns the resistor getInfo lines with the port value formatting', () => {
    expect(
      infoLines('resistor', el('resistor', { resistance: 1000 }), {
        current: -0.05,
        voltage: -2.5,
        power: 0.125,
      }),
    ).toEqual(['resistor', 'I = 50m A', 'Vd = 2.5 V', 'R = 1k Ω', 'P = 125m W']);
  });

  it('shows the capacitor lines including the signed stored-charge Q', () => {
    expect(
      infoLines('capacitor', el('capacitor', { capacitance: 1e-5 }), {
        current: 0.01,
        voltage: -100,
        power: 1,
      }),
    ).toEqual(['capacitor', 'I = 10m A', 'Vd = 100 V', 'C = 10µ F', 'P = 1 W', 'Q = -1m C']);
  });

  it('shows the inductor lines', () => {
    expect(
      infoLines('inductor', el('inductor', { inductance: 1e-3 }), {
        current: 0.5,
        voltage: 2,
        power: 1,
      }),
    ).toEqual(['inductor', 'I = 500m A', 'Vd = 2 V', 'L = 1m H', 'P = 1 W']);
  });

  it('keeps an unknown kind to the shared label, I and Vd lines', () => {
    expect(
      infoLines('widget', el('widget', {}), { current: 0.5, voltage: 0.25 }),
    ).toEqual(['widget', 'I = 500m A', 'Vd = 250m V']);
  });
});

describe('getTimeText', () => {
  it('formats sub-minute times with engineering seconds', () => {
    expect(getTimeText(0)).toBe('0 s');
    expect(getTimeText(0.5)).toBe('500m s');
    expect(getTimeText(59.9)).toBe('59.9 s');
  });

  it('switches to clock notation at 60 seconds', () => {
    expect(getTimeText(60)).toBe('1:00');
    expect(getTimeText(65.5)).toBe('1:05.5');
    expect(getTimeText(3600)).toBe('1:00:00');
    expect(getTimeText(3661)).toBe('1:01:01');
  });
});

describe('simStatsLines', () => {
  it('omits the rate suffix below 0.1x', () => {
    expect(simStatsLines(0.01, 5e-6, 10)).toEqual(['t = 10m s', 'time step = 5µ s']);
  });

  it('appends the formatted rate once it reaches 0.1x', () => {
    expect(simStatsLines(1, 1e-4, 100)).toEqual(['t = 1 s (1.6x)', 'time step = 100µ s']);
  });

  it('includes the rate at exactly 0.1x', () => {
    expect(simStatsLines(0, 0.1 / 160, 1)).toEqual(['t = 0 s (0.1x)', 'time step = 625µ s']);
  });
});

describe('infoBoxX', () => {
  it('anchors at the canvas right edge minus the info width without scopes', () => {
    expect(infoBoxX(800, false)).toBe(640);
  });

  it('nudges the scope margin right of the info-area boundary with scopes', () => {
    expect(infoBoxX(800, true)).toBe(660);
  });

  it('never goes negative on a narrow canvas', () => {
    expect(infoBoxX(100, false)).toBe(0);
  });
});

describe('infoBoxY', () => {
  it('bottom-anchors the stacked lines with a 10 px clearance', () => {
    expect(infoBoxY(600, 2)).toBe(600 - 10 - INFO_LINE_SPACING * 2);
    expect(infoBoxY(600, 5)).toBe(600 - 10 - INFO_LINE_SPACING * 5);
  });
});

describe('drawInfoBox', () => {
  it('stacks lines 15 px apart at the given x in the theme text colour', () => {
    const f = fake();
    const color = makeTheme().text;
    drawInfoBox(f as unknown as Context2D, 100, 200, ['a', 'b', 'c'], color);
    expect(f.fillStyle).toBe(color);
    expect(f.font).toBe(canvasFont(10));
    expect(f.textAlign).toBe('left');
    expect(f.textBaseline).toBe('top');
    for (let i = 0; i < 3; i++) {
      expect(f.fillText).toHaveBeenNthCalledWith(i + 1, 'abc'[i], 100, 200 + INFO_LINE_SPACING * (i + 1));
    }
  });
});
