import { describe, expect, it, vi } from 'vitest';
import type { CircuitElement, Context2D } from '../model/types';
import { canvasFont, formatValue, makeTheme } from './draw';
import {
  drawInfoBox,
  getTimeText,
  INFO_LINE_SPACING,
  infoBoxX,
  infoBoxY,
  infoLines,
  simStatsLines,
} from './infoBox';

const el = (kind: string, params: Record<string, number>, modelName?: string): CircuitElement => ({
  id: 1,
  kind,
  x1: 0,
  y1: 0,
  x2: 160,
  y2: 0,
  flags: 0,
  params,
  ...(modelName !== undefined ? { modelName } : {}),
});

/** A transistor scope-value table in the engine's declared order [ib, ic,
 *  ie, vbe, vbc, vce]; ie = -(ib+ic) and vce = vbe - vbc follow from the
 *  same node differences the engine reports. */
const transistorScope = (ib: number, ic: number, vbe: number, vbc: number): Float64Array =>
  new Float64Array([ib, ic, -(ib + ic), vbe, vbc, vbe - vbc]);

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

  it('prints the ohmmeter R as the raw signed V/I ratio', () => {
    // OhmMeterElm.java:57-63 prints getVoltageDiff()/current through
    // getUnitText with no magnitude wrapper, so a reversing reading stays
    // signed.
    expect(
      infoLines('ohmmeter', el('ohmmeter', {}), { current: 0.01, voltage: 5 }),
    ).toEqual(['ohmmeter', `R = ${formatValue(500, 'Ω')}`]);
    expect(infoLines('ohmmeter', el('ohmmeter', {}), { current: -0.01, voltage: 5 })[1]).toBe(
      `R = ${formatValue(-500, 'Ω')}`,
    );
  });

  it('prints infinity for an exactly zero ohmmeter current', () => {
    // Upstream's `==` test counts negative zero as zero too.
    expect(infoLines('ohmmeter', el('ohmmeter', {}), { current: 0, voltage: 5 })).toEqual([
      'ohmmeter',
      'R = ∞',
    ]);
    expect(infoLines('ohmmeter', el('ohmmeter', {}), { current: -0, voltage: 5 })[1]).toBe('R = ∞');
  });

  it('keeps the ohmmeter to exactly two rows with no I/Vd/P', () => {
    const rows = infoLines('ohmmeter', el('ohmmeter', {}), {
      current: 0.01,
      voltage: 5,
      power: 0.05,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe('ohmmeter');
  });

  it('a sine voltage source yields the upstream line order with V(rms) at zero bias', () => {
    // waveform 1 is the A/C (sine) code; the periodic block appends f, Vmax and
    // V(rms) before P, in VoltageElm.java:478-491 order.
    expect(
      infoLines(
        'voltage source',
        el('voltage source', { waveform: 1, frequency: 40, maxVoltage: 5, bias: 0 }),
        { current: 0.1, voltage: 3, power: 0.3 },
      ),
    ).toEqual([
      'A/C source',
      'I = 100m A',
      'Vd = 3 V',
      'f = 40 Hz',
      'Vmax = 5 V',
      `V(rms) = ${formatValue((5 * 1) / Math.SQRT2, 'V')}`,
      'P = 300m W',
    ]);
  });

  it('swaps V(rms) for Voff when the source is biased', () => {
    expect(
      infoLines(
        'voltage source',
        el('voltage source', { waveform: 1, frequency: 40, maxVoltage: 5, bias: 2 }),
        { current: 0.1, voltage: 3, power: 0.3 },
      ),
    ).toEqual([
      'A/C source',
      'I = 100m A',
      'Vd = 3 V',
      'f = 40 Hz',
      'Vmax = 5 V',
      'Voff = 2 V',
      'P = 300m W',
    ]);
  });

  it('appends the wavelength line above 500 Hz at zero bias', () => {
    // The else-if on frequency binds to the bias != 0 test, so the wavelength
    // line only appears in the zero-bias branch (VoltageElm.java:485-487).
    expect(
      infoLines(
        'voltage source',
        el('voltage source', { waveform: 1, frequency: 1000, maxVoltage: 5, bias: 0 }),
        { current: 0.1, voltage: 3, power: 0.3 },
      ),
    ).toEqual([
      'A/C source',
      'I = 100m A',
      'Vd = 3 V',
      'f = 1k Hz',
      'Vmax = 5 V',
      `V(rms) = ${formatValue(5 / Math.SQRT2, 'V')}`,
      `wavelength = ${formatValue(2.9979e8 / 1000, 'm')}`,
      'P = 300m W',
    ]);
  });

  it('a DC rail labels its third line "V =" not "Vd =" and emits no f/Vmax block', () => {
    expect(
      infoLines('rail', el('rail', { waveform: 0, bias: 0 }), { current: 0.2, voltage: 5, power: 1 }),
    ).toEqual([
      'voltage source',
      'I = 200m A',
      'V = 5 V',
      'P = 1 W',
    ]);
  });

  it('a value-form diode gains P and Vf', () => {
    expect(
      infoLines('diode', el('diode', { forwardVoltage: 0.7 }), { current: 0.01, voltage: 0.7, power: 0.007 }),
    ).toEqual([
      'diode',
      'I = 10m A',
      'Vd = 700m V',
      'P = 7m W',
      'Vf = 700m V',
    ]);
  });

  it('a model-name diode names the model and shows no numeric Vf', () => {
    expect(
      infoLines('diode', el('diode', {}, '1N4148'), { current: 0.01, voltage: 0.7, power: 0.007 }),
    ).toEqual([
      'diode (1N4148)',
      'I = 10m A',
      'Vd = 700m V',
      'P = 7m W',
    ]);
  });

  it('prints signed current and voltage on the rail table', () => {
    // VoltageElm.java:474-476 uses getCurrentText/getVoltageText, not the
    // magnitude D-text variants, so a sinking rail reads negative.
    expect(
      infoLines('rail', el('rail', { waveform: 0, bias: 0 }), { current: -0.2, voltage: -5, power: 1 }),
    ).toEqual([
      'voltage source',
      'I = -200m A',
      'V = -5 V',
      'P = 1 W',
    ]);
  });

  it('prints signed current and voltage on the diode table', () => {
    // A reverse-biased junction carries negative current at negative Vd,
    // exactly what upstream's signed rows show (DiodeElm.java:188-189).
    expect(
      infoLines('diode', el('diode', { forwardVoltage: 0.7 }), { current: -0.01, voltage: -5, power: 0.05 }),
    ).toEqual([
      'diode',
      'I = -10m A',
      'Vd = -5 V',
      'P = 50m W',
      'Vf = 700m V',
    ]);
  });

  it('the zener header reads "Zener diode" like upstream prints it', () => {
    // ZenerElm overrides only the header line of DiodeElm's getInfo
    // (ZenerElm.java:91-96), in both the value and named-model forms.
    const valued = infoLines('zener', el('zener', { zenerVoltage: 5.6 }), { current: 0.01, voltage: 5, power: 0.05 });
    expect(valued[0]).toBe('Zener diode');
    const modeled = infoLines('zener', el('zener', {}, '1N750'), { current: 0.01, voltage: 5, power: 0.05 });
    expect(modeled[0]).toBe('Zener diode');
    expect(modeled[3]).toBe('P = 50m W');
  });

  it('keeps the varactor header plain and the LED header uppercase with its model split', () => {
    // VaractorElm.java:21-25 replaces the header wholesale; LEDElm.java:
    // 113-118 keeps DiodeElm's value/model distinction under the LED word.
    const varactor = infoLines('varactor', el('varactor', {}, 'BB202'), { current: 0.001, voltage: 2, power: 0.002 });
    expect(varactor[0]).toBe('varactor');
    const ledValued = infoLines('led', el('led', { forwardVoltage: 2 }), { current: 0.02, voltage: 2, power: 0.04 });
    expect(ledValued[0]).toBe('LED');
    const ledModeled = infoLines('led', el('led', {}, 'red'), { current: 0.02, voltage: 2, power: 0.04 });
    expect(ledModeled[0]).toBe('LED (red)');
  });

  it('builds the nine upstream rows for an NPN in the active region', () => {
    // P is upstream's getPower (TransistorElm.java:206-208), Vbe*Ib + Vce*Ic
    // = 0.65*9µ + 4.65*920µ ≈ 4.284 mW absorbed, positive.
    expect(
      infoLines('transistor', el('transistor', { pnp: 1, beta: 100 }, '2N2222'), {
        power: 0.00428385,
        scopeValues: transistorScope(9e-6, 9.2e-4, 0.65, -4),
      }),
    ).toEqual([
      'transistor (NPN)',
      '2N2222, β=100',
      'fwd active',
      'Ic = 920µ A',
      'Ib = 9µ A',
      'Vbe = 650m V',
      'Vbc = -4 V',
      'Vce = 4.65 V',
      'P = 4.284m W',
    ]);
  });

  it('prints the PNP header and the raw signed junction rows', () => {
    // The engine scales terminal currents by the polarity sign exactly as
    // upstream stores them (TransistorElm.java:455-457), so a conducting PNP
    // reads negative Ic/Ib beside its negative raw Vbe/Vce and positive Vbc,
    // which is what upstream's signed rows print. P stays positive: raw
    // junction volts times the signed currents.
    expect(
      infoLines('transistor', el('transistor', { pnp: -1, beta: 50 }), {
        power: 0.0037252,
        scopeValues: transistorScope(-8e-6, -8e-4, -0.65, 4),
      }),
    ).toEqual([
      'transistor (PNP)',
      'default, β=50',
      'fwd active',
      'Ic = -800µ A',
      'Ib = -8µ A',
      'Vbe = -650m V',
      'Vbc = 4 V',
      'Vce = -4.65 V',
      'P = 3.725m W',
    ]);
  });

  it.each([
    ['saturation', 0.75, 0.3],
    ['reverse active', 0.1, 0.3],
    ['cutoff', 0.1, -1],
  ] as const)('classifies an NPN at Vbe %p, Vbc %p as %s', (mode, vbe, vbc) => {
    const lines = infoLines('transistor', el('transistor', { pnp: 1 }), {
      scopeValues: transistorScope(0, 0, vbe, vbc),
    });
    expect(lines[2]).toBe(mode);
  });

  it('keeps exactly .2 out of saturation on either side of the polarity sign', () => {
    // Upstream's thresholds are strict > .2 on vbc*pnp then vbe*pnp
    // (TransistorElm.java:545-548), so the boundary itself classifies as
    // active, mirrored through the PNP's negative raw voltages.
    const npn = infoLines('transistor', el('transistor', { pnp: 1 }), {
      scopeValues: transistorScope(0, 0, 0.7, 0.2),
    });
    expect(npn[2]).toBe('fwd active');
    const pnp = infoLines('transistor', el('transistor', { pnp: -1 }), {
      scopeValues: transistorScope(0, 0, -0.7, -0.2),
    });
    expect(pnp[2]).toBe('fwd active');
  });

  it('falls back to zero rows when the readout carries no scope table', () => {
    // A readout without the table (a source that never crossed the
    // boundary) must degrade to zeros, not NaN.
    expect(infoLines('transistor', el('transistor', {}), { power: 0 })).toEqual([
      'transistor (NPN)',
      'default, β=100',
      'cutoff',
      'Ic = 0 A',
      'Ib = 0 A',
      'Vbe = 0 V',
      'Vbc = 0 V',
      'Vce = 0 V',
      'P = 0 W',
    ]);
  });

  it('the rms multipliers match upstream for sine, triangle and square', () => {
    // V(rms) = Vmax * multiplier (VoltageElm.getRmsMultiplier).
    const sine = infoLines('voltage source', el('voltage source', { waveform: 1, frequency: 50, maxVoltage: 10, bias: 0 }), {});
    const triangle = infoLines('voltage source', el('voltage source', { waveform: 3, frequency: 50, maxVoltage: 10, bias: 0 }), {});
    const square = infoLines('voltage source', el('voltage source', { waveform: 2, frequency: 50, maxVoltage: 10, bias: 0 }), {});
    expect(sine[5]).toBe(`V(rms) = ${formatValue(10 / Math.SQRT2, 'V')}`);
    expect(triangle[5]).toBe(`V(rms) = ${formatValue(10 / Math.sqrt(3), 'V')}`);
    expect(square[5]).toBe(`V(rms) = ${formatValue(10, 'V')}`);
  });

  it('a pulse source uses sqrt(dutyCycle) for V(rms), not a flat 1', () => {
    // Upstream getRmsMultiplier returns sqrt(dutyCycle) for the pulse waveform
    // (VoltageElm.java:453); the port's own rail.ts uses the same formula.
    const quarter = infoLines('voltage source', el('voltage source', { waveform: 5, frequency: 50, maxVoltage: 10, bias: 0, dutyCycle: 0.25 }), {});
    expect(quarter[5]).toBe(`V(rms) = ${formatValue(10 * Math.sqrt(0.25), 'V')}`);
    const defaultDuty = infoLines('voltage source', el('voltage source', { waveform: 5, frequency: 50, maxVoltage: 10, bias: 0 }), {});
    expect(defaultDuty[5]).toBe(`V(rms) = ${formatValue(10 * Math.sqrt(0.5), 'V')}`);
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
