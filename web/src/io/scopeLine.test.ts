import { describe, expect, it } from 'vitest';
import type { PlotMeasurements, Scope, ScopePlot } from '../engine/scopeModel';
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
  measurements: null,
  origValueToken: null,
  origElementIndex: null,
});

/** A measurement mask with every readout off except the named ones. */
const mask = (...on: (keyof PlotMeasurements)[]): PlotMeasurements => ({
  showScale: false,
  showMax: false,
  showMin: false,
  showP2P: false,
  showFreq: false,
  showRMS: false,
  showAverage: false,
  showDutyCycle: false,
  showPhaseAngle: false,
  ...Object.fromEntries(on.map((k) => [k, true])),
}) as PlotMeasurements;

/** The scope state the store's load path would build from a decoded line: the
 *  display fields plus the per-plot fields merged onto their plots. */
const loadedScope = (decoded: DecodedScopeLine, plots: ScopePlot[]): Scope => {
  const { perPlot, ...fields } = decoded;
  return {
    id: 1,
    raw: null,
    trailPersistence: 0,
    plots: plots.map((p, i) => ({
      ...p,
      acCoupled: perPlot[i].acCoupled,
      manScale: perPlot[i].manScale,
      manVPosition: perPlot[i].manVPosition,
      measurements: perPlot[i].measurements,
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
    expect(decoded.perPlot).toEqual([
      { acCoupled: false, measurements: null, manScale: null, manVPosition: 0 },
    ]);
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
      { acCoupled: false, measurements: null, manScale: null, manVPosition: 0 },
      { acCoupled: false, measurements: null, manScale: null, manVPosition: 0 },
    ]);
    expect(decoded.label).toBe('J');
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
    // showAverage. The trailing 160 is the W-scale, not a label. The power
    // plot loads at the bottom of the manual-mode screen (manVPosition -100),
    // upstream's ScopePlot constructor (ScopePlot.java:62-66).
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
    expect(decoded.perPlot[0]).toEqual({
      acCoupled: false,
      measurements: null,
      manScale: null,
      manVPosition: -100,
    });
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
    // The first plot's token is '0': no AC bit and no measurement bits, so
    // the plot only carries the man-scale pair below.
    const decoded = decodeScopeLine(
      ['64', '0', '790528', '20', '0.05', '0', '2', '0', '2', '50', '1', '1', '3', '1', '60', 'label'],
      [plot(0, 'voltage'), plot(1, 'current')],
      [null, 'resistor'],
      0,
    );
    expect(decoded.perPlot).toEqual([
      { acCoupled: false, measurements: null, manScale: 2, manVPosition: 50 },
      { acCoupled: true, measurements: null, manScale: 1, manVPosition: 60 },
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
      { acCoupled: false, measurements: null, manScale: null, manVPosition: 0 },
      { acCoupled: false, measurements: null, manScale: null, manVPosition: 0 },
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
    const first = encodeScopeLine(scope, () => 0, kinds);
    // Re-encoding the re-decoded line must be stable. Some old-format lines
    // (manual mode without per-plot pairs, or pairs or a divisions token
    // without manual mode) normalize to upstream's current canonical form on
    // the first encode (ScopeSerializer.java:29-30, 42-43), so the fixed point
    // is reached on the second pass, not the first.
    const second = encodeScopeLine(
      loadedScope(decodeScopeLine(first, plots, kinds, scope.position), plots),
      () => 0,
      kinds,
    );
    expect(second).toEqual(first);
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
    // Manual mode (bit 16): the per-plot man-scale pairs and the divisions
    // token ride the line (ScopeSerializer.java:29-30, 42-43). The encoder
    // writes a pair for every plot and the divisions token after the count.
    roundTrips(
      ['64', '0', '790544', '20', '0.05', '0', '2', '8', '1', '2', '50', '0', '0', '3', '1', '60', 'label'],
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
    expect(decoded.manDivisions).toBe(4);
    expect(decoded.perPlot).toEqual([
      { acCoupled: false, measurements: null, manScale: null, manVPosition: 0 },
      { acCoupled: false, measurements: null, manScale: null, manVPosition: 0 },
    ]);
    expect(decoded.label).toBe('');
    roundTrips(raw, plots, kinds);
  });

  it('round-trips a per-plot W-scale token after the second plot value', () => {
    // The second plot is power, so its per-unit scale token follows its
    // `ne val` pair and must be skipped before the label (ScopeSerializer.java:
    // 236-238); the encoder pushes the same fixed 20 per division. The power
    // plot loads at the bottom of the manual-mode screen, so its manVPosition
    // is -100 (ScopePlot.java:62-66).
    const raw = ['64', '0', '4099', '20', '0.05', '0', '2', '0', '7', '20'];
    const plots = [plot(0, 'voltage'), plot(0, 'power')];
    const kinds = ['resistor', 'resistor'];
    const decoded = decodeScopeLine(raw, plots, kinds, 0);
    expect(decoded.perPlot).toEqual([
      { acCoupled: false, measurements: null, manScale: null, manVPosition: 0 },
      { acCoupled: false, measurements: null, manScale: null, manVPosition: -100 },
    ]);
    expect(decoded.label).toBe('');
    roundTrips(raw, plots, kinds);
  });

  it('round-trips the showElmInfo flag (bit 1<<20) and manDivisions', () => {
    // showElmInfo + manualScale: flags 1052691 = 1<<20 + FLAG_MAN_SCALE +
    // FLAG_PLOTS + showV + showI. The re-encoded manual-mode line carries the
    // divisions token and a per-plot pair.
    const raw = ['64', '0', '1052691', '20', '0.05', '0', '1'];
    const plots = [plot(0, 'voltage')];
    const decoded = decodeScopeLine(raw, plots, ['resistor'], 0);
    expect(decoded.showElmInfo).toBe(true);
    expect(decoded.manualScale).toBe(true);
    expect(decoded.manDivisions).toBe(8);
    roundTrips(raw, plots, ['resistor']);
  });

  it('decodes and re-encodes the showPhaseAngle flag (bit 1<<23)', () => {
    // flags 8392706 = 1<<23 + showV + FLAG_PLOTS: the phase-angle box on top
    // of the default showV scope.
    const raw = ['64', '0', '8392706', '20', '0.05', '0', '1'];
    const plots = [plot(0, 'voltage')];
    const decoded = decodeScopeLine(raw, plots, ['resistor'], 0);
    expect(decoded.showPhaseAngle).toBe(true);
    expect(encodeScopeLine(loadedScope(decoded, plots), () => 0, ['resistor'])).toContain('8392706');
    roundTrips(raw, plots, ['resistor']);
  });

  it('writes upstream-shaped token streams', () => {
    // The power line decodes with manualScale on (bit 16), so the encoder
    // writes the canonical manual-mode form: FLAG_DIVISIONS (1<<21) and
    // FLAG_PERPLOT_MAN_SCALE (1<<19) ride the flag word, the divisions token
    // follows the plot count, and a man-scale pair follows the W-scale token.
    const power = loadedScope(
      decodeScopeLine(['64', '7', '135187', '80', '0.00009765625', '0', '1', '160'], [plot(17, 'power')], ['resistor'], 0),
      [plot(17, 'power')],
    );
    expect(encodeScopeLine(power, () => 17, ['resistor'])).toEqual([
      '64', '7', '2756627', '80', '0.00009765625', '0', '1', '8', '20', '1', '-100',
    ]);
    const oldStyle = loadedScope(
      decodeScopeLine(['64', '0', '6', '5.0', '9.765625E-5', '0', 'set'], [plot(15, 'voltage')], [null], 0),
      [plot(15, 'voltage')],
    );
    expect(encodeScopeLine(oldStyle, () => 15, [null])).toEqual([
      '64', '0', '4102', '5', '0.00009765625', '0', '1', 'set',
    ]);
  });
  it('writes no scale token for a per-element plot and its output re-decodes', () => {
    // The bug this pins: needsScaleToken used to decide with a null kind, so
    // token 1 (Ib on a transistor) fell into the generic legacy-power branch
    // (watts) and gained a literal 20 no decoder would skip. Under
    // FLAG_PERPLOTFLAGS that stray token was eaten as the next plot's flag
    // word and every later field landed one token off.
    const kinds = ['transistor', 'transistor', 'transistor'];
    const plots = [plot(0, 'ib'), plot(0, 'ic'), plot(0, 'vce')];
    const raw = [
      '64', '1', '266306', '20', '0.05', '0', '3',
      '0',             // plot 0's per-plot flags word (hex)
      '1', '0', '2',   // plot 1's word (AC coupled), then ne val (Ic)
      '0', '0', '6',   // plot 2's word, then ne val (Vce)
      'Label',
    ];
    const decoded = decodeScopeLine(raw, plots, kinds, 0);
    expect(decoded.perPlot).toEqual([
      { acCoupled: false, measurements: null, manScale: null, manVPosition: 0 },
      { acCoupled: true, measurements: null, manScale: null, manVPosition: 0 },
      { acCoupled: false, measurements: null, manScale: null, manVPosition: 0 },
    ]);
    expect(decoded.label).toBe('Label');
    const encoded = encodeScopeLine(loadedScope(decoded, plots), (id) => id, kinds);
    // Ib in amps carries no scale token, exactly like the Ic beside it; only
    // plotXY's second bit is new against the input line (the encoder always
    // writes both 2D bits).
    expect(encoded).toEqual([
      '64', '1', '266434', '20', '0.05', '0', '3',
      '0',
      '1', '0', '2',
      '0', '0', '6',
      'Label',
    ]);
    // The encoder's own output walks back to the same state, which is what
    // the save path relies on when it regenerates an edited line.
    const again = decodeScopeLine(encoded, plots, kinds, 0);
    expect(again.perPlot).toEqual(decoded.perPlot);
    expect(again.label).toBe('Label');
    const second = encodeScopeLine(loadedScope(again, plots), (id) => id, kinds);
    expect(second).toEqual(encoded);
  });
});

describe('per-plot measurement bits under FLAG_PERPLOTFLAGS', () => {
  // flags 266242 = showV + FLAG_PLOTS + FLAG_PERPLOTFLAGS. Plot A's token
  // '420' (hex) sets the mask-present sentinel (bit 10) plus bit 5, the
  // port's per-plot showFreq; plot B's token '0' carries neither, so B
  // inherits.
  const RAW = ['64', '0', '266242', '20', '0.05', '0', '2', '420', '0', '0', '3', 'FreqOnly'];
  const plots = [plot(0, 'voltage'), plot(0, 'current')];
  const kinds: (string | null)[] = [null, null];

  it('decodes a masked plot and an inheriting one', () => {
    const decoded = decodeScopeLine(RAW, plots, kinds, 0);
    expect(decoded.perPlot).toHaveLength(2);
    expect(decoded.perPlot[0].measurements).toEqual(mask('showFreq'));
    expect(decoded.perPlot[1]).toMatchObject({ acCoupled: false, measurements: null });
    expect(decoded.label).toBe('FreqOnly');
  });

  it('re-encodes to the same tokens and scopeLineMatches agrees', () => {
    const decoded = decodeScopeLine(RAW, plots, kinds, 0);
    const scope = loadedScope(decoded, plots);
    expect(encodeScopeLine(scope, () => 0, kinds)).toEqual(RAW);
    expect(scopeLineMatches(scope, RAW, kinds, 0)).toBe(true);
    // Giving B its own differing mask breaks the match, the same way any
    // display edit does.
    const edited = loadedScope(decoded, plots);
    edited.plots[1] = { ...edited.plots[1], measurements: mask('showRMS') };
    expect(scopeLineMatches(edited, RAW, kinds, 0)).toBe(false);
    // So does clearing A's mask back to inheriting.
    const cleared = loadedScope(decoded, plots);
    cleared.plots[0] = { ...cleared.plots[0], measurements: null };
    expect(scopeLineMatches(cleared, RAW, kinds, 0)).toBe(false);
  });

  it('reads a multi-bit hex token and round-trips it', () => {
    // The mask-present sentinel is bit 10, showMax bit 2 and showPhaseAngle
    // bit 9: 1024 + 4 + 512 = 1540 = hex '604'.
    const raw = ['64', '0', '266242', '20', '0.05', '0', '1', '604'];
    const single = [plot(0, 'voltage')];
    const decoded = decodeScopeLine(raw, single, [null], 0);
    expect(decoded.perPlot[0].measurements).toEqual(mask('showMax', 'showPhaseAngle'));
    expect(encodeScopeLine(loadedScope(decoded, single), () => 0, [null])).toEqual(raw);
  });

  it('a sentinel-carrying token with empty measurement bits decodes as all-off', () => {
    // A foreign file (or this port's own encoder) marks a real mask with
    // bit 10 alone: hex '400'. That must come back as an explicit all-off
    // mask, not collapse into inheriting.
    const raw = ['64', '0', '266242', '20', '0.05', '0', '2', '400', '0', '0', '3'];
    const decoded = decodeScopeLine(raw, plots, kinds, 0);
    expect(decoded.perPlot[0].measurements).toEqual(mask());
    expect(decoded.perPlot[1].measurements).toBeNull();
    expect(encodeScopeLine(loadedScope(decoded, plots), () => 0, kinds)).toEqual(raw);
  });

  it('an AC-only token keeps the plot inheriting, exactly as before this feature', () => {
    // Upstream writes per-plot tokens for AC coupling alone; those must not
    // grow an all-off measurement mask or an untouched file would stop
    // drawing its inherited readouts.
    const raw = ['64', '0', '266242', '20', '0.05', '0', '2', '1', '0', '0', '3'];
    const decoded = decodeScopeLine(raw, plots, kinds, 0);
    expect(decoded.perPlot[0].acCoupled).toBe(true);
    expect(decoded.perPlot[0].measurements).toBeNull();
    expect(decoded.perPlot[1].acCoupled).toBe(false);
    expect(decoded.perPlot[1].measurements).toBeNull();
    expect(encodeScopeLine(loadedScope(decoded, plots), () => 0, kinds)).toEqual(raw);
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
    expect(scopeLineMatches({ ...loaded(), showPhaseAngle: true }, RAW, kinds, 0)).toBe(false);
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

describe('memristor and ohmmeter VAL_R plots', () => {
  // A resistance plot carries an Ω-scale token after the plot count
  // (ScopeSerializer.java:221-223), so the walk must skip it or the second
  // plot's `ne` is read one token early. MemristorElm and OhmMeterElm plot
  // VAL_R in ohms exactly like a lamp (MemristorElm.java:144-146,
  // OhmMeterElm.java:40-42).
  const RAW = ['64', '2', '4099', '20', '0.05', '0', '2', '160', '0', '3'];
  const plots = [plot(0, 'resistance'), plot(0, 'current')];

  it.each([['memristor'], ['ohmmeter']] as const)(
    'walks the scale token on a %s and regenerates it',
    (kind) => {
      const kinds = [kind, kind];
      const decoded = decodeScopeLine(RAW, plots, kinds, 0);
      // The resistance plot sits at the bottom of the manual-mode screen and
      // the label starts where the walk stopped, not one token early.
      expect(decoded.perPlot).toEqual([
        { acCoupled: false, measurements: null, manScale: null, manVPosition: -100 },
        { acCoupled: false, measurements: null, manScale: null, manVPosition: 0 },
      ]);
      expect(decoded.label).toBe('');
      // An edit flips scopeLineMatches, so the save path regenerates from
      // state: the Ω-scale token must survive that round trip, written fresh
      // like every regenerated scale token.
      expect(encodeScopeLine(loadedScope(decoded, plots), () => 0, kinds)).toEqual([
        '64', '2', '4099', '20', '0.05', '0', '2', '20', '0', '3',
      ]);
    },
  );
});

describe('regeneration preserves uninterpretable plot tokens', () => {
  // A transistor scope whose second plot carries val 9, a token outside the
  // VAL_ table that decodes to null, and ne 3 pointing at an element line this
  // build cannot read. A display edit flips scopeLineMatches and regenerates
  // the line from state; the once-known tokens must survive that instead of
  // collapsing into an attached voltage plot.
  const RAW = ['64', '0', '4102', '20', '0.05', '0', '2', '3', '9', 'Label'];
  const kinds: (string | null)[] = ['transistor', 'transistor'];
  const rawPlots = (): ScopePlot[] => [
    { ...plot(0, 'voltage'), elementId: 7 },
    { ...plot(1, null), elementId: null, origValueToken: 9, origElementIndex: 3 },
  ];

  it('decodes the second plot to null and stops the walk at the label', () => {
    const decoded = decodeScopeLine(RAW, rawPlots(), kinds, 0);
    expect(decoded.perPlot[1]).toEqual({
      acCoupled: false,
      measurements: null,
      manScale: null,
      manVPosition: 0,
    });
    expect(decoded.label).toBe('Label');
  });

  it('a display edit regenerates the original val and ne, not val 0 ne -1', () => {
    const decoded = decodeScopeLine(RAW, rawPlots(), kinds, 0);
    const edited = { ...loadedScope(decoded, rawPlots()), showFreq: true };
    const encoded = encodeScopeLine(edited, (id) => (id === 7 ? 0 : undefined), kinds);
    // The flag word gains FLAG_SHOW_FREQ (8); every other token, including
    // the preserved `3 9` pair, is exactly what the file had.
    expect(encoded).toEqual(['64', '0', String(4102 | 8), '20', '0.05', '0', '2', '3', '9', 'Label']);
  });

  it('prefers live state over the stored originals when both exist', () => {
    const live = [
      { ...plot(0, 'voltage'), elementId: 7 },
      { ...plot(1, 'current'), origValueToken: 9, origElementIndex: 3 },
    ];
    const scope = loadedScope(decodeScopeLine(RAW, live, kinds, 0), live);
    const encoded = encodeScopeLine(scope, () => 5, kinds);
    // Current encodes as val 3 and indexOf resolves ne 5; the originals are
    // never written blindly over real state.
    expect(encoded).toEqual(['64', '0', '4102', '20', '0.05', '0', '2', '5', '3', 'Label']);
  });

  it('a null plot with no stored originals still encodes the legacy 0 and -1', () => {
    const bare = [
      { ...plot(0, 'voltage'), elementId: 7 },
      { ...plot(1, null), elementId: null },
    ];
    const scope = loadedScope(decodeScopeLine(RAW, bare, kinds, 0), bare);
    expect(encodeScopeLine(scope, () => undefined, kinds)).toEqual([
      '64', '0', '4102', '20', '0.05', '0', '2', '-1', '0', 'Label',
    ]);
  });
});
