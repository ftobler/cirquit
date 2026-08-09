import { describe, expect, it } from 'vitest';
import { parseCircuit, serializeCircuit } from './index';
import { SAMPLE } from './fixtures';
import { DEFAULT_SETTINGS } from '../../model/types';

describe('netlist parsing', () => {
  it('reads every supported element on the line', () => {
    const parsed = parseCircuit(SAMPLE);
    expect(parsed.elements.map((e) => e.kind)).toEqual([
      'resistor',
      'switch',
      'wire',
      'capacitor',
      'inductor',
      'voltage',
      'ground',
    ]);
  });

  it('reads coordinates, flags and parameters', () => {
    const [resistor, , , capacitor, , voltage] = parseCircuit(SAMPLE).elements;
    expect(resistor).toMatchObject({ x1: 176, y1: 80, x2: 384, y2: 80, flags: 0 });
    expect(resistor.params.resistance).toBe(10);
    expect(capacitor.params.capacitance).toBe(0.000015);
    // waveform, frequency, amplitude
    expect(voltage.params.waveform).toBe(0);
    expect(voltage.params.frequency).toBe(40);
    expect(voltage.params.maxVoltage).toBe(5);
  });

  it('reads global settings from the header', () => {
    const parsed = parseCircuit(SAMPLE);
    expect(parsed.settings.timeStep).toBe(0.000005);
    expect(parsed.settings.currentSpeed).toBe(50);
    expect(parsed.settings.voltageRange).toBe(5);
    // Token 6 is the power brightness, not a default.
    expect(parsed.settings.powerRange).toBe(43);
  });

  it('reads iterCount and minTimeStep from the header', () => {
    const parsed = parseCircuit('$ 1 0.000005 10.20027730826997 50 5 43 5e-11\n');
    expect(parsed.settings.iterCount).toBe(10.20027730826997);
    expect(parsed.settings.minTimeStep).toBe(5e-11);
    expect(parsed.settings.adaptiveTimeStep).toBe(false);
  });

  it('decodes header flag bit 64 into adaptiveTimeStep', () => {
    expect(parseCircuit('$ 64 0.000005 10 50 5 50 5e-11\n').settings.adaptiveTimeStep).toBe(true);
    expect(parseCircuit('$ 0 0.000005 10 50 5 50 5e-11\n').settings.adaptiveTimeStep).toBe(false);
  });

  it('decodes header flag bit 128 into autoDC', () => {
    expect(parseCircuit('$ 128 0.000005 10 50 5 43 5e-11\n').settings.autoDC).toBe(true);
    expect(parseCircuit('$ 1 0.000005 10 50 5 43 5e-11\n').settings.autoDC).toBe(false);
  });

  it('decodes header flag bit 1 into showCurrent', () => {
    expect(parseCircuit('$ 0 0.000005 10 50 5 50 5e-11\n').settings.showCurrent).toBe(false);
    expect(parseCircuit('$ 1 0.000005 10 50 5 43 5e-11\n').settings.showCurrent).toBe(true);
  });

  it('preserves header flag bit 2 through a parse-save round trip', () => {
    // The small-grid option is removed, but the file byte upstream wrote must
    // survive load-and-save: bit 2 rides the headerFlags passthrough, never a
    // settings field. A header with the bit set re-serialises with it set, and
    // one without stays without.
    for (const [header, expectBit] of [
      ['$ 3', 2],
      ['$ 1', 0],
    ] as const) {
      const parsed = parseCircuit(`${header} 0.000005 10 50 5 43 5e-11\n`);
      const out = serializeCircuit(
        parsed.elements,
        { ...DEFAULT_SETTINGS, ...parsed.settings },
        parsed.scopes,
        parsed.passthrough,
        parsed.order,
      );
      expect(Number(out.split('\n')[0].split(' ')[1]) & 2).toBe(expectBit);
    }
  });

  it('round-trips a small-grid file through the header flags', () => {
    const parsed = parseCircuit('$ 3 0.000005 10 50 5 43 5e-11\n');
    const out = serializeCircuit(
      parsed.elements,
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
    );
    expect(Number(out.split('\n')[0].split(' ')[1]) & 2).toBe(2);
    const again = parseCircuit(out);
    expect(Number(again.settings.headerFlags ?? 0) & 2).toBe(2);
  });

  it('a fresh circuit writes header flag bit 2 clear', () => {
    const out = serializeCircuit([], { ...DEFAULT_SETTINGS });
    expect(Number(out.split('\n')[0].split(' ')[1]) & 2).toBe(0);
  });

  it('decodes header flag bits 4 and 8 into the colour modes', () => {
    // Bit 8 is power on; bit 4 is voltage off, and it wins the volts checkbox
    // even when power is clear (readCircuitFlags, CircuitLoader.java:274-277).
    const power = parseCircuit('$ 8 0.000005 10 50 5 43 5e-11\n').settings;
    expect(power.showPowerColor).toBe(true);
    expect(power.showVoltageColor).toBe(false);
    const voltsOff = parseCircuit('$ 4 0.000005 10 50 5 43 5e-11\n').settings;
    expect(voltsOff.showVoltageColor).toBe(false);
    expect(voltsOff.showPowerColor).toBe(false);
    const plain = parseCircuit('$ 1 0.000005 10 50 5 43 5e-11\n').settings;
    expect(plain.showVoltageColor).toBe(true);
    expect(plain.showPowerColor).toBe(false);
  });

  it('keeps scope lines and unmodelled lines instead of dropping them', () => {
    const parsed = parseCircuit(SAMPLE);
    expect(parsed.scopes).toHaveLength(1);
    expect(parsed.scopes[0].plots[0].elementIndex).toBe(4);
    // The `38` slider line parses into state now; it takes its own order slot
    // so the e token can be rewritten on save, and is not reported unsupported.
    expect(parsed.sliders).toHaveLength(1);
    expect(parsed.sliders[0].text).toBe('Capacitance');
    expect(parsed.unsupported).not.toContain('38');
    expect(parsed.order).toContainEqual({ kind: 'slider', id: parsed.sliders[0].id });
  });

  it('round-trips element lines byte-for-byte', () => {
    const parsed = parseCircuit(SAMPLE);
    const out = serializeCircuit(parsed.elements, {
      ...DEFAULT_SETTINGS,
      ...parsed.settings,
    });
    const lines = out.trim().split('\n');
    expect(lines).toContain('r 176 80 384 80 0 10');
    expect(lines).toContain('w 176 80 176 352 0');
    expect(lines).toContain('v 448 352 448 80 0 0 40 5 0 0 0.5');
  });

  it('reparses its own output to the same circuit', () => {
    const first = parseCircuit(SAMPLE);
    const text = serializeCircuit(first.elements, { ...DEFAULT_SETTINGS, ...first.settings });
    const second = parseCircuit(text);
    expect(second.elements.map((e) => e.kind)).toEqual(first.elements.map((e) => e.kind));
    expect(second.elements.map((e) => [e.x1, e.y1, e.x2, e.y2])).toEqual(
      first.elements.map((e) => [e.x1, e.y1, e.x2, e.y2]),
    );
  });

  it('rounds fractional coordinates from a hand-edited file', () => {
    // Upstream files are integral, but a hand-edited line can carry fractions
    // that would fail the engine's `[i32; 2]` post type on load.
    const [resistor] = parseCircuit(
      '$ 1 0.000005 10 50 5 43 5e-11\nr 10.4 20.6 170.2 20.6 0 100\n',
    ).elements;
    expect([resistor.x1, resistor.y1, resistor.x2, resistor.y2]).toEqual([10, 21, 170, 21]);
  });

  it('ignores unknown element types without failing the load', () => {
    const parsed = parseCircuit('$ 1 0.000005 10 50 5 43 5e-11\n999 1 2 3 4 0\nr 0 0 16 0 0 100\n');
    expect(parsed.elements).toHaveLength(1);
    expect(parsed.unsupported).toContain('999');
  });

  it('reports the non-element line types upstream dispatches on', () => {
    // `%`/`?` afilter and `.` subcircuit definitions are neither elements nor
    // interpreted, so the load has to admit them. A `!` custom-logic model
    // line is now interpreted when it carries a full table, but a partial line
    // (here, no pin lists or rules) stays preserved-but-unresolvable like any
    // other truncated model line.
    const parsed = parseCircuit('! model stuff\n% 1 2\n? 3 4\n. sub\n');
    expect(parsed.unsupported).toEqual(['%', '?', '.']);
    expect(parsed.passthrough).toEqual(['! model stuff', '% 1 2', '? 3 4', '. sub']);
  });
});

describe('scope o-line fidelity', () => {
  const HEADER = '$ 1 0.000005 10 50 5 43 5e-11\n';
  const resistors = (n: number) =>
    Array.from({ length: n }, (_, i) => `r ${i * 16} 0 ${(i + 1) * 16} 0 0 ${100 + i}\n`).join('');

  it('round-trips an o-line verbatim, plot list included', () => {
    const parsed = parseCircuit(SAMPLE);
    const out = serializeCircuit(
      parsed.elements,
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
    );
    expect(out).toContain('o 4 64 0 4099 20 0.05 0 2 4 3');
  });

  it('interprets the value token into voltage, current, power and legacy power', () => {
    const text =
      HEADER + resistors(3) + ['0', '3', '7', '1'].map((v, i) => `o ${i} 64 ${v} 4099 20 0.05 0 1`).join('\n') + '\n';
    const parsed = parseCircuit(text);
    expect(parsed.scopes.map((s) => s.plots[0].value)).toEqual([
      'voltage',
      'current',
      'power',
      'power',
    ]);
  });

  it('maps value token 1 on a transistor to a null plot', () => {
    const parsed = parseCircuit(
      HEADER + 't 0 0 16 0 0 1 0 0 0 0 0\n' + 'o 0 64 1 4099 20 0.05 0 1\n',
    );
    expect(parsed.scopes[0].plots).toEqual([expect.objectContaining({ elementIndex: 0, value: null })]);
  });

  it('does not register the transistor VCE plot as a voltage trace', () => {
    // early.txt and multivib-a.txt carry VAL_VCE (6) plots; the transistor's
    // getScopeValue is element-specific and the engine cannot sample it, so
    // the plot is preserved but unregistered instead of drawing a wrong
    // voltage waveform.
    const parsed = parseCircuit(
      HEADER + 't 0 0 16 0 0 1 0 0 0 0 0\n' + 'o 0 64 6 4162 4e-7 1e-9 0 2 0 2\n',
    );
    expect(parsed.scopes[0].plots.map((p) => p.value)).toEqual([null, null]);
    expect(parsed.scopes[0].raw).toEqual(['64', '6', '4162', '4e-7', '1e-9', '0', '2', '0', '2']);
  });

  it('does not register a lamp resistance or capacitor charge plot', () => {
    // lightbulb.txt's VAL_R (2) plot on a lamp and a capacitor's VAL_CHARGE
    // (8) have no engine meaning: both stay preserved, not plotted as voltage.
    const parsed = parseCircuit(
      HEADER +
        '181 0 0 16 0 0 293 100 120 0.4 0.4\n' +
        'c 16 0 32 0 0 1e-6 0.001\n' +
        'o 0 64 2 4099 160 1.6 0 1 160\n' +
        'o 1 64 8 4099 20 0.05 0 1\n',
    );
    expect(parsed.scopes.map((s) => s.plots[0].value)).toEqual([null, null]);
    expect(parsed.scopes.map((s) => s.plots[0].elementIndex)).toEqual([0, 1]);
  });

  it('consumes the scale token a charge plot carries before the next plot', () => {
    // VAL_CHARGE plots in coulombs, a unit above A, so the walk must skip its
    // scale token before reading the second plot's `ne`, or it would read the
    // scale as an element index and invent a phantom plot.
    const text =
      HEADER + 'c 0 0 16 0 0 1e-6 0.001\n' + 'o 0 64 8 4099 20 0.05 0 2 0.001 0 3\n';
    const plots = parseCircuit(text).scopes[0].plots;
    expect(plots).toHaveLength(2);
    expect(plots[0]).toMatchObject({ elementIndex: 0, value: null });
    expect(plots[1]).toMatchObject({ elementIndex: 0, value: 'current' });
  });

  it('reads the W-scale token a power plot carries', () => {
    // A real power line has one more token than voltage or current: the scale
    // for the W units, right after the plot count (ScopeSerializer.java:221-223).
    const parsed = parseCircuit(HEADER + resistors(1) + 'o 0 64 7 4099 20 0.05 0 1 160\n');
    expect(parsed.scopes[0].plots[0].value).toBe('power');
  });

  it('walks past manDivisions before a power plot scale', () => {
    // FLAG_DIVISIONS (1 << 21) inserts a manDivisions token between the plot
    // count and the W-scale token. Both must be skipped to find plot 0.
    const flags = 4096 | (1 << 21);
    const parsed = parseCircuit(HEADER + resistors(3) + `o 2 64 1 ${flags} 20 0.05 0 1 8 10\n`);
    expect(parsed.scopes[0].plots).toHaveLength(1);
    expect(parsed.scopes[0].plots[0]).toMatchObject({ elementIndex: 2, value: 'power' });
  });

  it('walks past per-plot flags and man-scale pairs', () => {
    // FLAG_PERPLOTFLAGS (1 << 18) inserts a per-plot flags token before each
    // plot and FLAG_PERPLOT_MAN_SCALE (1 << 19) a manScale/manVPosition pair
    // after each. Both plots must still come out, in order.
    const flags = 4096 | (1 << 18) | (1 << 19);
    const text =
      HEADER +
      resistors(3) +
      `o 2 64 0 ${flags} 20 0.05 0 2 1 2 3 4 2 3 5 6\n`;
    const plots = parseCircuit(text).scopes[0].plots;
    expect(plots).toHaveLength(2);
    expect(plots[0]).toMatchObject({ elementIndex: 2, value: 'voltage' });
    expect(plots[1]).toMatchObject({ elementIndex: 2, value: 'current' });
  });

  it('resolves scope indices through file position, past an unmodelled element', () => {
    // `214` (CCVS) is a code upstream creates but this build does not model,
    // so it still takes the element-list slot and the scope's index 2 is the
    // second resistor, not the first.
    const parsed = parseCircuit(
      HEADER + 'r 0 0 16 0 0 100\n' + 'o 2 64 0 4099 20 0.05 0 1\n' + '214 1 2 3 4 0\n' + 'r 16 0 32 0 0 220\n',
    );
    expect(parsed.scopes[0].plots[0].elementIndex).toBe(2);
    expect(parsed.scopes[0].plots[0].elementId).toBe(parsed.elements[1].id);
  });

  it('an unrecognized code does not consume a scope index', () => {
    // `999` is not a code upstream's createCe accepts either, so it is skipped
    // without a slot (CircuitLoader.java:201-204) and the scope's index 1 is
    // still the second resistor.
    const parsed = parseCircuit(
      HEADER + 'r 0 0 16 0 0 100\n' + 'o 1 64 0 4099 20 0.05 0 1\n' + '999 1 2 3 4 0\n' + 'r 16 0 32 0 0 220\n',
    );
    expect(parsed.scopes[0].plots[0].elementIndex).toBe(1);
    expect(parsed.scopes[0].plots[0].elementId).toBe(parsed.elements[1].id);
  });

  it('non-element lines do not consume a scope index', () => {
    const parsed = parseCircuit(
      HEADER + resistors(2) + '38 3 0 0.000001 0.000101 Capacitance\n' + 'h a hint\n' + 'o 1 64 0 4099 20 0.05 0 1\n',
    );
    // The slider and hint lines do not advance the element list, so index 1 is
    // the second resistor.
    expect(parsed.scopes[0].plots[0].elementIndex).toBe(1);
    expect(parsed.scopes[0].plots[0].elementId).toBe(parsed.elements[1].id);
  });

  it('resolves a scope that appears above its element', () => {
    const parsed = parseCircuit(HEADER + 'o 0 64 0 4099 20 0.05 0 1\n' + resistors(1));
    expect(parsed.scopes[0].plots[0].elementId).toBe(parsed.elements[0].id);
  });

  it('a two-plot line yields a voltage plot and a current plot', () => {
    const parsed = parseCircuit(HEADER + resistors(5) + 'o 4 64 0 4099 20 0.05 0 2 4 3\n');
    const plots = parsed.scopes[0].plots;
    expect(plots).toHaveLength(2);
    expect(plots[0]).toMatchObject({ elementIndex: 4, value: 'voltage' });
    expect(plots[1]).toMatchObject({ elementIndex: 4, value: 'current' });
  });

  it('a scope pointing at an unmodelled element stays preserved', () => {
    const text = HEADER + resistors(3) + 'o 9 64 0 4099 20 0.05 0 1\n';
    const parsed = parseCircuit(text);
    expect(parsed.scopes[0].plots[0].elementIndex).toBe(9);
    expect(parsed.scopes[0].plots[0].elementId).toBeUndefined();
    // The line still comes back on save, verbatim.
    const out = serializeCircuit(
      parsed.elements,
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
    );
    expect(out).toContain('o 9 64 0 4099 20 0.05 0 1');
  });

  it('an old-style line keeps raw handling and a plot 0 value', () => {
    // tlmatch2.txt:38, old-style (no FLAG_PLOTS): the trailing text is scope
    // text and the value token 1 is legacy power.
    const parsed = parseCircuit(
      HEADER + resistors(6) + 'o 5 64 1 51 0.15625 1.220703125E-5 0 -1 matched\n',
    );
    expect(parsed.scopes[0].plots).toHaveLength(1);
    expect(parsed.scopes[0].plots[0]).toMatchObject({ elementIndex: 5, value: 'power' });
    expect(parsed.scopes[0].raw).toEqual([
      '64',
      '1',
      '51',
      '0.15625',
      '1.220703125E-5',
      '0',
      '-1',
      'matched',
    ]);
  });
});

describe('slider (38) parsing', () => {
  /** One element per file index, mirroring the corpus slider targets: resistor
   *  0, current source 1, capacitor 2, inductor 3, transistor 4, resistor 5,
   *  square-wave voltage source 6. */
  const FIXTURE = `$ 1 0.000005 10 50 5 43 5e-11
r 0 0 16 0 0 100
i 0 0 16 0 0 0.002
c 0 0 16 0 0 1e-6 0.001
l 0 0 16 0 0 1 0
t 0 0 16 0 0 1 0 0 100
r 16 0 32 0 0 16087
v 0 0 0 16 0 2 40 5 5 0 0.56
38 0 0 1 101 Resistance
38 1 0 0 0.005 Current
38 2 0 0.000001 0.000101 Capacitance
38 3 0 0.01 1.01 Inductance
38 4 0 1 1000 Beta/hFE
38 5 0 100 22000 Phase\\sControl
38 6 6 0 100 Duty\\sCycle
`;

  it('parses every corpus-form slider into its bound element and fields', () => {
    const parsed = parseCircuit(FIXTURE);
    expect(parsed.sliders).toHaveLength(7);
    // The five corpus lines each resolve to the element their caption names.
    const [resistance, current, capacitance, inductance, beta, phase, duty] = parsed.sliders;
    expect(resistance).toMatchObject({
      elementId: parsed.elements[0].id,
      editItem: 0,
      min: 1,
      max: 101,
      text: 'Resistance',
      step: 0,
      logarithmic: false,
      shared: null,
    });
    expect(current).toMatchObject({ elementId: parsed.elements[1].id, text: 'Current' });
    expect(capacitance).toMatchObject({ elementId: parsed.elements[2].id, min: 1e-6, max: 1.01e-4, text: 'Capacitance' });
    expect(inductance).toMatchObject({ elementId: parsed.elements[3].id, text: 'Inductance' });
    expect(beta).toMatchObject({ elementId: parsed.elements[4].id, text: 'Beta/hFE' });
    // The escaped caption token comes back unescaped.
    expect(phase).toMatchObject({ elementId: parsed.elements[5].id, text: 'Phase Control' });
    expect(duty).toMatchObject({ elementId: parsed.elements[6].id, editItem: 6, text: 'Duty Cycle' });
    // A parsed slider is not an unsupported type.
    expect(parsed.unsupported).not.toContain('38');
  });

  it('an out-of-range e or the -1 sentinel leaves the line inert', () => {
    const parsed = parseCircuit(FIXTURE.replace('38 6 6 0 100 Duty\\sCycle', '38 -1 6 0 100 Duty\\sCycle'));
    // The sentinel line binds to nothing and is preserved, so it drops from
    // the slider list but not from the file.
    expect(parsed.sliders).toHaveLength(6);
    expect(parsed.passthrough.some((l) => l.startsWith('38 -1'))).toBe(true);
    const out = parseCircuit(FIXTURE + '38 99 0 1 100 Ghost\\sSlider\n');
    expect(out.sliders).toHaveLength(8);
    expect(out.sliders[7].elementId).toBeUndefined();
  });

  it('reads F-prefixed flags, editItem, shared index and step', () => {
    const fixture = (line: string) =>
      parseCircuit(
        'r 0 0 16 0 0 100\nr 16 0 32 0 0 220\nr 32 0 48 0 0 330\nr 48 0 64 0 0 470\n' + line,
      );
    const withFlags = fixture('38 3 F2 0 1 100 Text 0.5\n');
    expect(withFlags.sliders[0]).toMatchObject({
      elementId: withFlags.elements[3].id,
      editItem: 0,
      min: 1,
      max: 100,
      step: 0.5,
      text: 'Text',
      logarithmic: true,
      shared: null,
    });
    const shared = fixture('38 3 F1 0 1 100 2 Text 0\n');
    expect(shared.sliders[0]).toMatchObject({ shared: 2, step: 0, logarithmic: false });
    // The old no-F form predates the flags field (Adjustable.java:54-58).
    const legacy = fixture('38 3 0 1 100 Text\n');
    expect(legacy.sliders[0]).toMatchObject({ editItem: 0, step: 0, text: 'Text' });
    expect(legacy.sliders[0].shared).toBeNull();
    expect(legacy.sliders[0].logarithmic).toBe(false);
  });
});
