import { describe, expect, it, beforeEach } from 'vitest';
import {
  kindOfDumpCode,
  parseCircuit,
  scopeValueFromToken,
  serializeCircuit,
  unitsOf,
  valueTokenOf,
} from './index';
import {
  clearUserModels,
  forwardVoltageAt,
  putUserModel,
  registerFileModels,
  simpleDiodeEntry,
  userModel,
  type UserDiodeEntry,
} from '../../model/deviceModels';
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

  it('parses 214 and 215 as real controlled sources', () => {
    // The CCVS (214) and CCCS (215) are no longer passthrough codes: they
    // build real elements and take no unsupported or passthrough slot.
    const parsed = parseCircuit('214 0 0 32 0 0 2 i*2\n215 0 0 32 0 0 2 i*2\n');
    expect(parsed.elements.map((e) => e.kind)).toEqual(['ccvs', 'cccs']);
    expect(parsed.unsupported).toEqual([]);
    expect(parsed.passthrough).toEqual([]);
  });

  it('reports the non-element line types upstream dispatches on', () => {
    // `%`/`?` afilter lines are neither elements nor interpreted, so the load
    // has to admit them. A `!` custom-logic model line is now interpreted when
    // it carries a full table, but a partial line (here, no pin lists or
    // rules) stays preserved-but-unresolvable like any other truncated model
    // line. A `.` subcircuit line is likewise interpreted when it carries a
    // full model, and a truncated one is preserved but no longer reported
    // unsupported: it is a line this build now owns.
    const parsed = parseCircuit('! model stuff\n% 1 2\n? 3 4\n. sub\n');
    expect(parsed.unsupported).toEqual(['%', '?']);
    expect(parsed.passthrough).toEqual(['! model stuff', '% 1 2', '? 3 4', '. sub']);
    // A truncated `.` line yields no model either.
    expect(parsed.compositeModels).toEqual([]);
  });

  it('returns the `.` line models in file order without registering them', () => {
    const line = (name: string) =>
      `. ${name} 0 2 2 1 in 1 0 0 ResistorElm\\s1\\s2 0\\\\s1000`;
    const parsed = parseCircuit(`${line('first')}\nr 0 0 16 0 0 100\n${line('second')}\n`);
    // Both lines still ride through verbatim; the interpreted copies come back
    // alongside, for the caller that commits the text to register.
    expect(parsed.passthrough).toEqual([line('first'), line('second')]);
    expect(parsed.compositeModels.map((m) => m.name)).toEqual(['first', 'second']);
    expect(parsed.compositeModels[0].extList).toEqual([{ name: 'in', node: 1, pos: 0, side: 0 }]);
  });
});

describe('strict element-line coordinates', () => {
  const HEADER = '$ 1 0.000005 10 50 5 43 5e-11\n';

  it('a non-finite coordinate token makes the element line unreadable', () => {
    // Upstream parses the four coordinates with Integer.parseInt inside the
    // per-line try (CircuitLoader.java:186-190); the throw lands in the catch
    // (:207-211) and the whole line is skipped. A silent (0,0) load instead
    // welds posts that never touched, so the line must degrade like any other
    // unmodelled element line: preserved verbatim, with a load warning.
    const parsed = parseCircuit('r 1 abc 64 0 1000');
    expect(parsed.elements).toEqual([]);
    expect(parsed.passthrough).toEqual(['r 1 abc 64 0 1000']);
    expect(parsed.order).toContainEqual({ kind: 'other', line: 'r 1 abc 64 0 1000' });
    expect(parsed.warnings).toEqual([
      'Resistor line with unreadable coordinates or flags was kept as an unrecognised line',
    ]);
  });

  it('a truncated line missing coordinate tokens degrades the same way', () => {
    // A NoSuchElementException upstream skips the line exactly like a
    // NumberFormatException, so absence and non-finiteness are one failure.
    const parsed = parseCircuit(`${HEADER}r 0 0 16\nr 16 0 32 0 0 220\n`);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['resistor']);
    expect(parsed.passthrough).toEqual(['r 0 0 16']);
    expect(parsed.warnings).toHaveLength(1);
  });

  it('a missing or non-finite flags token makes the line unreadable too', () => {
    // The flags token sits inside the same per-line try upstream
    // (CircuitLoader.java:190), so a line stopping after the coordinates, or
    // carrying junk there, skips there as well. Every writer emits flags, so
    // requiring one cannot strand a real file.
    const truncated = parseCircuit(`${HEADER}r 16 0 32 0\nr 48 0 64 0 0 330\n`);
    expect(truncated.elements.map((e) => e.kind)).toEqual(['resistor']);
    expect(truncated.passthrough).toEqual(['r 16 0 32 0']);
    expect(truncated.warnings).toHaveLength(1);
    const junkFlags = parseCircuit(`${HEADER}r 16 0 32 0 many\n`);
    expect(junkFlags.elements).toEqual([]);
    expect(junkFlags.warnings).toHaveLength(1);
  });

  it('an unknown-head line keeps riding through silently, whatever its tokens look like', () => {
    // Branch boundary: coordinate and flags strictness only applies once the
    // dump code resolves to a def. A line unknown to both builds degrades
    // before that point, with no warning of its own and, unlike a known code,
    // without a scope slot (pinned by 'an unrecognized code does not consume
    // a scope index'). Every code in the upstream snapshot is modelled here
    // today, so this path carries only codes newer than both builds.
    const parsed = parseCircuit(`${HEADER}999 1 abc 0 100\nr 16 0 32 0 0 220\n`);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['resistor']);
    expect(parsed.unsupported).toContain('999');
    expect(parsed.passthrough).toContain('999 1 abc 0 100');
    expect(parsed.warnings).toEqual([]);
  });

  it('a degraded line still takes its slot in the scope index space', () => {
    // The head is a known dump code, so the skipped line still shifts every
    // later scope index, like any unmodelled element line.
    const parsed = parseCircuit(
      `${HEADER}w 0 0 16 0 0\nr 1 abc 64 0 1000\nr 16 0 32 0 0 220\no 2 64 0 4099 20 0.05 0 1\n`,
    );
    expect(parsed.elements.map((e) => e.kind)).toEqual(['wire', 'resistor']);
    expect(parsed.scopes[0].plots[0].elementIndex).toBe(2);
    expect(parsed.scopes[0].plots[0].elementId).toBe(parsed.elements[1].id);
  });

  it('fractional coordinates still load rounded, without a warning', () => {
    // The deliberate accommodation for dragged geometry: fractions are read
    // and rounded, never treated as unreadable.
    const parsed = parseCircuit(`${HEADER}r 10.4 20.6 170.2 20.6 0 100\n`);
    const [resistor] = parsed.elements;
    expect([resistor.x1, resistor.y1, resistor.x2, resistor.y2]).toEqual([10, 21, 170, 21]);
    expect(parsed.warnings).toEqual([]);
  });

  it('a mixed damaged and healthy file keeps everything and saves back verbatim', () => {
    // Healthy parts stay, the damaged line rides through in its original
    // position among the comments and blank lines it arrived between, and the
    // save reproduces the file byte for byte.
    const text = [
      '# hand-edited file',
      '$ 1 0.000005 10 50 5 43 5e-11',
      'w 0 0 16 0 0',
      'r 1 abc 64 0 1000',
      '',
      'r 16 0 48 0 0 220',
      '',
    ].join('\n');
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['wire', 'resistor']);
    expect(parsed.passthrough).toEqual(['r 1 abc 64 0 1000']);
    // The trailing newline terminates the last line rather than opening an
    // empty one, so the order carries six entries for the seven split lines.
    expect(parsed.order.map((o) => o.kind)).toEqual([
      'other',
      'header',
      'element',
      'other',
      'other',
      'element',
    ]);
    expect(parsed.warnings).toHaveLength(1);
    const out = serializeCircuit(
      parsed.elements,
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
      parsed.sliders,
    );
    expect(out).toBe(text);
  });

  it('a coordinate past the i32 range makes its line unreadable, not the whole file', () => {
    // Upstream reads coordinates with Integer.parseInt inside the per-line try,
    // and an out-of-range integer throws exactly like a junk token
    // (CircuitLoader.java:186-190), so only that line skips. Letting it through
    // here instead dies in serde on the engine's `[i32; 2]` posts, failing the
    // build for every other element in the file.
    const text = `${HEADER}r 0 0 16 0 0 220\nr 3e9 0 3000000100 0 0 1000\n`;
    const parsed = parseCircuit(text);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['resistor']);
    expect(parsed.passthrough).toEqual(['r 3e9 0 3000000100 0 0 1000']);
    expect(parsed.warnings).toEqual([
      'Resistor line with unreadable coordinates or flags was kept as an unrecognised line',
    ]);
    // The skipped line rides passthrough in place: a save is byte-for-byte.
    const out = serializeCircuit(
      parsed.elements,
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
    );
    expect(out).toBe(text);
    // The boundary itself stays loadable.
    expect(parseCircuit(`${HEADER}r -2147483647 0 2147483647 0 0 220\n`).elements).toHaveLength(1);
  });
});

describe('device-model file lines and the save writer', () => {
  const HEADER = '$ 1 0.000005 10 50 5 43 5e-11\n';

  beforeEach(() => clearUserModels());

  it('loads a written 34 line into the exposed map', () => {
    const parsed = parseCircuit(
      HEADER + '34 mydiode 1 1e-9 0 2 5.6 1e-3\n' + 'd 0 0 160 0 2 mydiode\n',
    );
    expect(parsed.diodeFileModels.get('mydiode')).toEqual({
      saturationCurrent: 1e-9,
      seriesResistance: 0,
      emissionCoefficient: 2,
      breakdownVoltage: 5.6,
      forwardCurrent: 1e-3,
      flags: 1,
    });
    // The line still rides through in passthrough, byte for byte.
    expect(parsed.passthrough).toContain('34 mydiode 1 1e-9 0 2 5.6 1e-3');
    // A 32 line lands in the transistor map with the two modelled tokens.
    const t = parseCircuit(HEADER + '32 early 0 1e-13 0 0 1.5 0 0 2 1 1 0.02 0 1\n');
    expect(t.transistorFileModels.get('early')).toEqual({ saturationCurrent: 1e-13, betaReverse: 1 });
  });

  it('an untouched file model line stays byte-identical on save', () => {
    const text =
      HEADER + '34 aaa 0 1e-9 0 2 0\n' + 'd 0 0 160 0 2 aaa\n';
    const parsed = parseCircuit(text);
    registerFileModels(parsed.diodeFileModels, parsed.transistorFileModels);
    const out = serializeCircuit(
      parsed.elements,
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
    );
    expect(out).toBe(text);
  });

  it('an edited file model line regenerates in place', () => {
    const text =
      HEADER + '34 aaa 0 1e-9 0 2 0\n' + 'd 0 0 160 0 2 aaa\n' + '34 bbb 0 1e-12 1 2 0\n' + 'd 16 0 176 0 2 bbb\n';
    const parsed = parseCircuit(text);
    registerFileModels(parsed.diodeFileModels, parsed.transistorFileModels);
    // The editor changed aaa's saturation current and bbb's series resistance.
    putUserModel('diode', { name: 'aaa', builtIn: false, flags: 0, saturationCurrent: 2e-9, seriesResistance: 0, emissionCoefficient: 2, breakdownVoltage: 0 });
    putUserModel('diode', { name: 'bbb', builtIn: false, flags: 0, saturationCurrent: 1e-12, seriesResistance: 3, emissionCoefficient: 2, breakdownVoltage: 0 });
    const out = serializeCircuit(
      parsed.elements,
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
    );
    const lines = out.split('\n');
    expect(lines).toContain('34 aaa 0 2e-9 0 2 0');
    expect(lines).toContain('34 bbb 0 1e-12 3 2 0');
    expect(lines).not.toContain('34 aaa 0 1e-9 0 2 0');
    expect(lines).not.toContain('34 bbb 0 1e-12 1 2 0');
  });

  it('an edited transistor line keeps the tokens the port does not model', () => {
    const text =
      HEADER + '32 early 0 1e-13 0 0 1.5 0 0 2 1 1 0.02 0 1\n' + 't 0 0 16 0 0 1 0 0 100 early\n';
    const parsed = parseCircuit(text);
    registerFileModels(parsed.diodeFileModels, parsed.transistorFileModels);
    putUserModel('transistor', { name: 'early', builtIn: false, saturationCurrent: 5e-13, betaReverse: 2 });
    const out = serializeCircuit(
      parsed.elements,
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
    );
    expect(out).toContain('32 early 0 5e-13 0 0 1.5 0 0 2 1 1 0.02 0 2');
  });

  it('emits a fresh user-model line once, ahead of the first referencing element', () => {
    putUserModel('diode', { name: 'mydiode', builtIn: false, flags: 0, saturationCurrent: 1e-9, seriesResistance: 0, emissionCoefficient: 2, breakdownVoltage: 0 });
    const diodes = [
      { id: 1, kind: 'diode', x1: 0, y1: 0, x2: 160, y2: 0, flags: 2, params: {}, modelName: 'mydiode' },
      { id: 2, kind: 'diode', x1: 176, y1: 0, x2: 336, y2: 0, flags: 2, params: {}, modelName: 'mydiode' },
    ];
    const out = serializeCircuit(diodes, { ...DEFAULT_SETTINGS }).trim().split('\n');
    const modelLines = out.filter((l) => l.startsWith('34 '));
    expect(modelLines).toEqual(['34 mydiode 0 1e-9 0 2 0']);
    expect(out.indexOf('34 mydiode 0 1e-9 0 2 0')).toBeLessThan(out.findIndex((l) => l.startsWith('d ')));
  });

  it('mosfet and jfet model names never emit a line', () => {
    putUserModel('mosfet', { name: 'mymos', builtIn: false, threshold: 2, beta: 0.01, jfet: false });
    putUserModel('jfet', { name: 'myjfet', builtIn: false, threshold: -3, beta: 0.001, jfet: true });
    const out = serializeCircuit(
      [
        { id: 1, kind: 'mosfet', x1: 0, y1: 0, x2: 160, y2: 0, flags: 0, params: {}, modelName: 'mymos' },
        { id: 2, kind: 'jfet', x1: 0, y1: 0, x2: 160, y2: 0, flags: 1, params: {}, modelName: 'myjfet' },
      ],
      { ...DEFAULT_SETTINGS },
    );
    expect(out).not.toContain('34 ');
    expect(out).not.toContain('32 ');
  });

  it('an unchanged simple-mode file model keeps its line bytes after a dialog OK', () => {
    // Opening a simple model and pressing OK without editing anything must not
    // rewrite the `34` line: re-deriving n from the forward drop does not
    // round-trip bit-exactly (a stored 1.906 derives back as
    // 1.9060000000000001), so the dialog keeps the stored coefficient until a
    // field actually changes.
    const text =
      HEADER + '34 mysimple 1 4.352e-9 0 1.906 75 1e-3\n' + 'd 0 0 160 0 2 mysimple\n';
    const parsed = parseCircuit(text);
    registerFileModels(parsed.diodeFileModels, parsed.transistorFileModels);
    const initial = userModel('diode', 'mysimple') as UserDiodeEntry;
    // The dialog shows the forward drop derived from the stored current; an OK
    // with those unchanged fields must write back the stored n verbatim.
    putUserModel(
      'diode',
      simpleDiodeEntry(initial, {
        name: 'mysimple',
        saturationCurrent: initial.saturationCurrent,
        forwardVoltage: forwardVoltageAt(
          initial.saturationCurrent,
          initial.emissionCoefficient,
          initial.forwardCurrent ?? 1,
        ),
        forwardCurrent: initial.forwardCurrent ?? 1,
        breakdownVoltage: initial.breakdownVoltage,
      }),
    );
    const out = serializeCircuit(
      parsed.elements,
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
    );
    expect(out).toBe(text);
  });

  it('emits a session-only model line for an element placed after a load', () => {
    // A file's order tracks only its own elements. A diode placed (or pasted)
    // after the load appends at the end of the walk; its model's line must
    // still reach the saved file, or a reload would silently drop the model.
    const text = HEADER + 'r 0 0 16 0 0 100\n';
    const parsed = parseCircuit(text);
    putUserModel('diode', { name: 'placed', builtIn: false, flags: 0, saturationCurrent: 1e-9, seriesResistance: 0, emissionCoefficient: 2, breakdownVoltage: 0 });
    const placed = {
      id: 99,
      kind: 'diode',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 2,
      params: {},
      modelName: 'placed',
    };
    const out = serializeCircuit(
      [...parsed.elements, placed],
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
    );
    const lines = out.split('\n');
    expect(lines).toContain('34 placed 0 1e-9 0 2 0');
    expect(lines).toContain('d 0 0 160 0 2 placed');
  });

  it('regenerates an edited file line even when its order-tracked element was deleted', () => {
    // The file's own diode is gone (its order slot vacates), but a diode pasted
    // after the load still names the model. The regeneration pass consults
    // every live element, not just the file's order-tracked ones, so the edited
    // body still reaches the saved line.
    const text = HEADER + '34 shared 0 1e-9 0 2 0\n' + 'd 0 0 160 0 2 shared\n';
    const parsed = parseCircuit(text);
    registerFileModels(parsed.diodeFileModels, parsed.transistorFileModels);
    putUserModel('diode', { name: 'shared', builtIn: false, flags: 0, saturationCurrent: 3e-9, seriesResistance: 0, emissionCoefficient: 2, breakdownVoltage: 0 });
    const pasted = {
      id: 99,
      kind: 'diode',
      x1: 176,
      y1: 0,
      x2: 336,
      y2: 0,
      flags: 2,
      params: {},
      modelName: 'shared',
    };
    const out = serializeCircuit(
      [pasted],
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
    );
    expect(out).toContain('34 shared 0 3e-9 0 2 0');
    expect(out).not.toContain('34 shared 0 1e-9 0 2 0');
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

  it('maps value token 1 on a transistor to Ib', () => {
    const parsed = parseCircuit(
      HEADER + 't 0 0 16 0 0 1 0 0 0 0 0\n' + 'o 0 64 1 4099 20 0.05 0 1\n',
    );
    expect(parsed.scopes[0].plots).toEqual([expect.objectContaining({ elementIndex: 0, value: 'ib' })]);
  });

  it('maps the whole per-element value table and back', () => {
    // TransistorElm.getScopeValue's table (TransistorElm.java:582-593) and
    // LampElm's VAL_R, each with the inverse `valueTokenOf` so an edited
    // scope line re-encodes the same tokens it parsed.
    const transistor = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((tok) => scopeValueFromToken(tok, 'transistor'));
    expect(transistor).toEqual([
      'voltage',
      'ib',
      'ic',
      'ie',
      'vbe',
      'vbc',
      'vce',
      'power',
      'voltage',
    ]);
    expect(scopeValueFromToken(2, 'lamp')).toBe('resistance');
    for (const [value, tok] of [
      ['ib', 1],
      ['ic', 2],
      ['ie', 3],
      ['vbe', 4],
      ['vbc', 5],
      ['vce', 6],
      ['resistance', 2],
    ] as const) {
      expect(valueTokenOf(value)).toBe(tok);
    }
    // The walk still puts the per-element currents in amps and the resistance
    // in ohms, which is what decides whether a scale token follows.
    expect(unitsOf(2, 'lamp')).toBe(3);
    expect(unitsOf(3, 'transistor')).toBe(1);
    expect(unitsOf(6, 'transistor')).toBe(0);
  });

  it('maps the transistor VCE and IC pair to engine-sampled plots', () => {
    // early.txt and multivib-a.txt carry VAL_VCE (6) and VAL_IC (2) plots: the
    // transistor's getScopeValue table (TransistorElm.java:582-593) is
    // engine-sampled since the per-element value hook landed, so the pair is
    // registered as real traces instead of being preserved raw only.
    const parsed = parseCircuit(
      HEADER + 't 0 0 16 0 0 1 0 0 0 0 0\n' + 'o 0 64 6 4162 4e-7 1e-9 0 2 0 2\n',
    );
    expect(parsed.scopes[0].plots.map((p) => p.value)).toEqual(['vce', 'ic']);
    expect(parsed.scopes[0].raw).toEqual(['64', '6', '4162', '4e-7', '1e-9', '0', '2', '0', '2']);
  });

  it('keeps an out-of-table transistor value token unregistered', () => {
    // A token outside TransistorElm.getScopeValue's table returns nothing
    // upstream; drawing a wrong waveform would be worse than preserving the
    // line raw, so it still maps to null.
    const parsed = parseCircuit(
      HEADER + 't 0 0 16 0 0 1 0 0 0 0 0\n' + 'o 0 64 9 4099 20 0.05 0 1\n',
    );
    expect(parsed.scopes[0].plots[0].value).toBeNull();
    // The raw token rides along, so a save that regenerates an edited line
    // can write it back instead of collapsing the plot to voltage.
    expect(parsed.scopes[0].plots[0].valueToken).toBe(9);
  });

  it('maps lamp resistance and capacitor charge to their engine values', () => {
    // lightbulb.txt's VAL_R (2) plot on a lamp samples its hot resistance,
    // upstream's getScopeValue(VAL_R) (LampElm.java:218-219); a capacitor's
    // VAL_CHARGE (8) maps to the engine's Charge scope value, C*Vplate
    // (CapacitorElm.java:225-229).
    const parsed = parseCircuit(
      HEADER +
        '181 0 0 16 0 0 293 100 120 0.4 0.4\n' +
        'c 16 0 32 0 0 1e-6 0.001\n' +
        'o 0 64 2 4099 160 1.6 0 1 160\n' +
        'o 1 64 8 4099 20 0.05 0 1\n',
    );
    expect(parsed.scopes.map((s) => s.plots[0].value)).toEqual(['resistance', 'charge']);
    expect(parsed.scopes.map((s) => s.plots[0].elementIndex)).toEqual([0, 1]);
  });

  it('maps memristor and ohmmeter VAL_R plots to resistance and skips their scale token', () => {
    // MemristorElm and OhmMeterElm answer getScopeValue/getScopeUnits for
    // VAL_R too (MemristorElm.java:144-146, OhmMeterElm.java:40-42), so their
    // Ω-scale tokens sit where the walk must skip them. Before the fix both
    // kinds fell through to volts: the 160 was misread as the second plot's
    // `ne` and a regenerated line dropped the scale token.
    const parsed = parseCircuit(
      HEADER +
        'm 0 0 100 0 0 100 16000 0 1e-8 1e-10 0\n' +
        '216 80 64 80 288 0 0.01 0\n' +
        'o 0 64 2 4099 20 0.05 0 2 160 1 3\n',
    );
    expect(parsed.scopes[0].plots.map((p) => p.value)).toEqual(['resistance', 'current']);
    expect(parsed.scopes[0].plots.map((p) => p.elementIndex)).toEqual([0, 1]);
    expect(unitsOf(2, 'memristor')).toBe(3);
    expect(unitsOf(2, 'ohmmeter')).toBe(3);
    // An untouched line keeps its tokens byte-for-byte, Ω-scale token
    // included, per the no-loss guarantee.
    const out = serializeCircuit(
      parsed.elements,
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
    );
    expect(out).toContain('o 0 64 2 4099 20 0.05 0 2 160 1 3');
  });

  it('resolves the units-relevant kind straight from a raw dump code', () => {
    // The only kinds `unitsOf`/`scopeValueFromToken` special-case, so these are
    // the only codes an unreadable element line needs to be recognised by.
    expect(kindOfDumpCode('181')).toBe('lamp');
    expect(kindOfDumpCode('c')).toBe('capacitor');
    expect(kindOfDumpCode('209')).toBe('polarizedCapacitor');
    expect(kindOfDumpCode('t')).toBe('transistor');
    expect(kindOfDumpCode('m')).toBe('memristor');
    expect(kindOfDumpCode('216')).toBe('ohmmeter');
    // Every other code, including one with no units-specific meaning at all,
    // reports no kind: `unitsOf`'s token-only branches already get it right.
    expect(kindOfDumpCode('150')).toBeNull();
    expect(kindOfDumpCode('999')).toBeNull();
  });

  it('consumes the scale token a charge plot carries before the next plot', () => {
    // VAL_CHARGE plots in coulombs, a unit above A, so the walk must skip its
    // scale token before reading the second plot's `ne`, or it would read the
    // scale as an element index and invent a phantom plot.
    const text =
      HEADER + 'c 0 0 16 0 0 1e-6 0.001\n' + 'o 0 64 8 4099 20 0.05 0 2 0.001 0 3\n';
    const plots = parseCircuit(text).scopes[0].plots;
    expect(plots).toHaveLength(2);
    expect(plots[0]).toMatchObject({ elementIndex: 0, value: 'charge' });
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

  it('resolves scope indices through file position, past a modelled element', () => {
    // `214` (CCVS) is now a real element, so it still takes the element-list
    // slot and the scope's index 2 is the second resistor, not the first.
    const parsed = parseCircuit(
      HEADER + 'r 0 0 16 0 0 100\n' + 'o 2 64 0 4099 20 0.05 0 1\n' + '214 1 2 3 4 0 2 i\n' + 'r 16 0 32 0 0 220\n',
    );
    expect(parsed.scopes[0].plots[0].elementIndex).toBe(2);
    expect(parsed.scopes[0].plots[0].elementId).toBe(parsed.elements[2].id);
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
