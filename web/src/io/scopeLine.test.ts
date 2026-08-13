import { describe, expect, it } from 'vitest';
import type { Scope, ScopePlot } from '../engine/simulator';
import {
  decodeScopeLine,
  encodeScopeLine,
  scopeLineMatches,
  type DecodedScopeLine,
} from './scopeLine';

/** A minimal plot for a trace quantity. */
const plot = (id: number, value: ScopePlot['value']): ScopePlot => ({
  id,
  elementId: id,
  value,
  manScale: null,
  manVPosition: 0,
  acCoupled: false,
});

/** The scope state the store's load path would build from a decoded line: the
 *  display fields plus the per-plot fields merged onto their plots. */
const loadedScope = (decoded: DecodedScopeLine, plots: ScopePlot[]): Scope => {
  const { perPlot, ...fields } = decoded;
  return {
    id: 1,
    raw: null,
    plots: plots.map((p, i) => ({
      ...p,
      acCoupled: perPlot[i].acCoupled,
      manScale: perPlot[i].manScale,
      manVPosition: perPlot[i].manVPosition,
    })),
    trigger: { mode: 'freeRun', edge: 'rising', level: 0 },
    ...fields,
  };
};

describe('decodeScopeLine on the corpus shapes', () => {
  it('decodes an old-style line with a label', () => {
    // clockedsrff.txt: flags 6 = showV plus showMax-off (bit 4), no plot list.
    const decoded = decodeScopeLine(
      ['64', '0', '6', '5.0', '9.765625E-5', '0', 'set'],
      [plot(15, 'voltage')],
      [null],
      0,
    );
    expect(decoded.speed).toBe(64);
    expect(decoded.position).toBe(0);
    expect(decoded.showV).toBe(true);
    expect(decoded.showMax).toBe(false);
    expect(decoded.label).toBe('set');
    expect(decoded.scaleV).toBe(5);
    expect(decoded.scaleA).toBeCloseTo(9.765625e-5, 15);
    expect(decoded.perPlot).toEqual([{ acCoupled: false, manScale: null, manVPosition: 0 }]);
  });

  it('decodes a new-style two-plot line with a label', () => {
    // jkff.txt: flags 4102 = showV + showMax-off + FLAG_PLOTS.
    const decoded = decodeScopeLine(
      ['64', '0', '4102', '5', '0.00009765625', '0', '2', '48', '3', 'J'],
      [plot(48, 'voltage'), plot(48, 'current')],
      ['jkmaster', 'jkmaster'],
      0,
    );
    expect(decoded.showV).toBe(true);
    expect(decoded.showMax).toBe(false);
    expect(decoded.label).toBe('J');
    expect(decoded.perPlot).toEqual([
      { acCoupled: false, manScale: null, manVPosition: 0 },
      { acCoupled: false, manScale: null, manVPosition: 0 },
    ]);
  });

  it('decodes an X-Y line, plotXY from upstream plot2d.enabled (bit 64)', () => {
    // diodecurve.txt: flags 4163 = showI + showV + bit 64, no plotXY bit 128.
    const decoded = decodeScopeLine(
      ['64', '0', '4163', '1.25e-8', '5.12e-7', '1', '2', '1', '3', 'I', 'vs', 'V'],
      [plot(1, 'voltage'), plot(1, 'current')],
      [null, null],
      0,
    );
    expect(decoded.showI).toBe(true);
    expect(decoded.showV).toBe(true);
    expect(decoded.plotXY).toBe(true);
    expect(decoded.position).toBe(1);
    expect(decoded.label).toBe('I vs V');
  });

  it('decodes a power line, skipping the W-scale token before the label', () => {
    // longdist.txt: flags 135187 = showI + showV + manualScale + FLAG_PLOTS +
    // showAverage. The trailing 160 is the W-scale, not a label.
    const decoded = decodeScopeLine(
      ['64', '7', '135187', '80', '0.00009765625', '0', '1', '160'],
      [plot(17, 'power')],
      ['resistor'],
      0,
    );
    expect(decoded.showI).toBe(true);
    expect(decoded.showV).toBe(true);
    expect(decoded.manualScale).toBe(true);
    expect(decoded.showAverage).toBe(true);
    expect(decoded.label).toBe('');
    expect(decoded.perPlot[0]).toEqual({ acCoupled: false, manScale: null, manVPosition: 0 });
  });

  it('decodes showDutyCycle and showFreq off the flag word', () => {
    // 555dutycycle.txt: flags 36874 = showV + showFreq + showDutyCycle + PLOTS.
    const decoded = decodeScopeLine(
      ['2', '0', '36874', '10', '0.00009765625', '1', '1'],
      [plot(9, 'voltage')],
      [null],
      0,
    );
    expect(decoded.speed).toBe(2);
    expect(decoded.position).toBe(1);
    expect(decoded.showFreq).toBe(true);
    expect(decoded.showDutyCycle).toBe(true);
    expect(decoded.label).toBe('');  // the trailing 1 is the plot count
  });

  it('unescapes the label of an escaped-label line', () => {
    // early.txt, a transistor VCE line: plotXY via bit 64, label escaped.
    const decoded = decodeScopeLine(
      ['64', '6', '4162', '2.0971519999999997e-9', '1e-17', '0', '2', '0', '2', 'no\\sEarly\\seffect'],
      [plot(0, null), plot(0, null)],
      ['transistor', 'transistor'],
      0,
    );
    expect(decoded.showV).toBe(true);
    expect(decoded.plotXY).toBe(true);
    expect(decoded.label).toBe('no Early effect');
  });

  it('reads per-plot flags and manScale pairs', () => {
    // flags 790528 = FLAG_PLOTS + FLAG_PERPLOTFLAGS + FLAG_PERPLOT_MAN_SCALE.
    const decoded = decodeScopeLine(
      ['64', '0', '790528', '20', '0.05', '0', '2', 'a', '2', '50', '1', '1', '3', '1', '60', 'label'],
      [plot(0, 'voltage'), plot(1, 'current')],
      [null, 'resistor'],
      0,
    );
    expect(decoded.perPlot).toEqual([
      { acCoupled: false, manScale: 2, manVPosition: 50 },
      { acCoupled: true, manScale: 1, manVPosition: 60 },
    ]);
    expect(decoded.label).toBe('label');
  });

  it('skips the per-unit scale token a capacitor charge plot carries', () => {
    // A VAL_CHARGE plot plots in coulombs, a unit above A, so its scale token
    // sits right after the plot count and must be skipped before the second
    // plot's `ne` (ScopeSerializer.java:221-223, parse.test.ts case).
    const decoded = decodeScopeLine(
      ['64', '8', '4099', '20', '0.05', '0', '2', '0.001', '0', '3'],
      [plot(0, null), plot(0, 'current')],
      ['capacitor', 'capacitor'],
      0,
    );
    expect(decoded.perPlot).toEqual([
      { acCoupled: false, manScale: null, manVPosition: 0 },
      { acCoupled: false, manScale: null, manVPosition: 0 },
    ]);
    expect(decoded.label).toBe('');
  });

  it('falls back to the supplied index when the line carries no position token', () => {
    const decoded = decodeScopeLine(
      ['64', '0', '3', '0.625', '0.05'],
      [plot(0, 'voltage')],
      [null],
      2,
    );
    expect(decoded.position).toBe(2);
  });
});

describe('encodeScopeLine round-trip', () => {
  const roundTrips = (
    raw: string[],
    plots: ScopePlot[],
    kinds: (string | null)[],
  ): void => {
    const decoded = decodeScopeLine(raw, plots, kinds, 0);
    const scope = loadedScope(decoded, plots);
    const tokens = encodeScopeLine(scope, () => 0);
    expect(decodeScopeLine(tokens, plots, kinds, scope.position)).toEqual(decoded);
  };

  it('reproduces every corpus shape field-for-field', () => {
    roundTrips(['64', '0', '6', '5.0', '9.765625E-5', '0', 'set'], [plot(15, 'voltage')], [null]);
    roundTrips(
      ['64', '0', '4102', '5', '0.00009765625', '0', '2', '48', '3', 'J'],
      [plot(48, 'voltage'), plot(48, 'current')],
      ['jkmaster', 'jkmaster'],
    );
    roundTrips(
      ['64', '0', '4163', '1.25e-8', '5.12e-7', '1', '2', '1', '3', 'I', 'vs', 'V'],
      [plot(1, 'voltage'), plot(1, 'current')],
      [null, null],
    );
    roundTrips(
      ['64', '7', '135187', '80', '0.00009765625', '0', '1', '160'],
      [plot(17, 'power')],
      ['resistor'],
    );
    roundTrips(['2', '0', '36874', '10', '0.00009765625', '1', '1'], [plot(9, 'voltage')], [null]);
    roundTrips(
      ['64', '6', '4162', '2.0971519999999997e-9', '1e-17', '0', '2', '0', '2', 'no\\sEarly\\seffect'],
      [plot(0, null), plot(0, null)],
      ['transistor', 'transistor'],
    );
  });

  it('round-trips per-plot AC coupling and manual scale', () => {
    roundTrips(
      ['64', '0', '790528', '20', '0.05', '0', '2', '1', '2', '50', '0', '0', '3', '1', '60', 'label'],
      [plot(0, 'voltage'), plot(1, 'current')],
      [null, 'resistor'],
    );
  });

  it('round-trips a line with a manDivisions token (FLAG_DIVISIONS)', () => {
    // flags 2101250 = FLAG_DIVISIONS (1<<21) + FLAG_PLOTS + showV. The
    // manDivisions token sits between the plot count and the per-plot tokens,
    // so it must be skipped or the second plot's `ne` is read one token early
    // (ScopeSerializer.java:219-220).
    const raw = ['64', '0', '2101250', '20', '0.05', '0', '2', '4', '0', '3'];
    const plots = [plot(0, 'voltage'), plot(0, 'current')];
    const kinds = ['resistor', 'resistor'];
    const decoded = decodeScopeLine(raw, plots, kinds, 0);
    expect(decoded.showV).toBe(true);
    expect(decoded.perPlot).toEqual([
      { acCoupled: false, manScale: null, manVPosition: 0 },
      { acCoupled: false, manScale: null, manVPosition: 0 },
    ]);
    expect(decoded.label).toBe('');
    roundTrips(raw, plots, kinds);
  });

  it('round-trips a per-plot W-scale token after the second plot value', () => {
    // The second plot is power, so its per-unit scale token follows its
    // `ne val` pair and must be skipped before the label (ScopeSerializer.java:
    // 236-238); the encoder pushes the same fixed 20 per division.
    const raw = ['64', '0', '4099', '20', '0.05', '0', '2', '0', '7', '20'];
    const plots = [plot(0, 'voltage'), plot(0, 'power')];
    const kinds = ['resistor', 'resistor'];
    const decoded = decodeScopeLine(raw, plots, kinds, 0);
    expect(decoded.perPlot).toEqual([
      { acCoupled: false, manScale: null, manVPosition: 0 },
      { acCoupled: false, manScale: null, manVPosition: 0 },
    ]);
    expect(decoded.label).toBe('');
    roundTrips(raw, plots, kinds);
  });

  it('writes upstream-shaped token streams', () => {
    // The power line's decoded state encodes with the W-scale token and the
    // old-style line's decoded state encodes as the equivalent new-style line.
    const power = loadedScope(
      decodeScopeLine(['64', '7', '135187', '80', '0.00009765625', '0', '1', '160'], [plot(17, 'power')], ['resistor'], 0),
      [plot(17, 'power')],
    );
    expect(encodeScopeLine(power, () => 17)).toEqual([
      '64', '7', '135187', '80', '0.00009765625', '0', '1', '20',
    ]);
    const oldStyle = loadedScope(
      decodeScopeLine(['64', '0', '6', '5.0', '9.765625E-5', '0', 'set'], [plot(15, 'voltage')], [null], 0),
      [plot(15, 'voltage')],
    );
    expect(encodeScopeLine(oldStyle, () => 15)).toEqual([
      '64', '0', '4102', '5', '0.00009765625', '0', '1', 'set',
    ]);
  });
});

describe('scopeLineMatches', () => {
  const RAW = ['64', '0', '4099', '20', '0.05', '0', '2', '0', '3'];
  const plots = [plot(0, 'voltage'), plot(0, 'current')];
  const kinds = ['resistor', 'resistor'];

  const loaded = () =>
    loadedScope(decodeScopeLine(RAW, plots, kinds, 0), plots);

  it('is true for a freshly loaded scope and ignores the speed', () => {
    expect(scopeLineMatches(loaded(), RAW, kinds, 0)).toBe(true);
    // A zoom patches the speed token separately, so a speed change matches.
    expect(scopeLineMatches({ ...loaded(), speed: 256 }, RAW, kinds, 0)).toBe(true);
  });

  it('is false after every kind of display edit', () => {
    expect(scopeLineMatches({ ...loaded(), label: 'x' }, RAW, kinds, 0)).toBe(false);
    expect(scopeLineMatches({ ...loaded(), showMax: false }, RAW, kinds, 0)).toBe(false);
    expect(scopeLineMatches({ ...loaded(), manualScale: true }, RAW, kinds, 0)).toBe(false);
    expect(
      scopeLineMatches(
        { ...loaded(), plots: [plots[0], { ...plots[1], acCoupled: true }] },
        RAW,
        kinds,
        0,
      ),
    ).toBe(false);
    expect(scopeLineMatches({ ...loaded(), position: 5 }, RAW, kinds, 0)).toBe(false);
  });
});
