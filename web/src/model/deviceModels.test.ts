import { describe, expect, it } from 'vitest';
import { defFor } from './registry';
import {
  DIODE_MODELS,
  MOSFET_MODELS,
  TRANSISTOR_MODELS,
  forwardVoltageFor,
  modelFamilyFor,
  resolveModelParams,
  selectableModels,
} from './deviceModels';

describe('built-in device model tables', () => {
  it('match the upstream values bit for bit', () => {
    // The 1N4148 row (DiodeModel.java:108), the whole point of the feature.
    expect(DIODE_MODELS['1N4148']).toEqual({
      saturationCurrent: 4.352e-9,
      seriesResistance: 0.6458,
      emissionCoefficient: 1.906,
      breakdownVoltage: 75,
    });
    // The default diode row (DiodeModel.java:83), which the port's element
    // defaults already equal.
    expect(DIODE_MODELS.default).toEqual({
      saturationCurrent: 1.7143528192808883e-7,
      seriesResistance: 0,
      emissionCoefficient: 2,
      breakdownVoltage: 0,
    });
    // spice-default transistor (TransistorModel.java:119): the 1e-16 satCur
    // that moves Vbe up by about 0.18 V against the 1e-13 default.
    expect(TRANSISTOR_MODELS['spice-default']).toEqual({
      saturationCurrent: 1e-16,
      betaReverse: 1,
    });
    expect(TRANSISTOR_MODELS.default).toEqual({ saturationCurrent: 1e-13, betaReverse: 1 });
    // The jfet default (MosfetModel.java:132-134) equals the engine's own
    // jfet defaults (jfet.rs:38-39), so resolving it is identity.
    expect(MOSFET_MODELS['default-jfet']).toEqual({ threshold: -4, beta: 0.00125, jfet: true });
    expect(MOSFET_MODELS.default).toEqual({ threshold: 1.5, beta: 0.02, jfet: false });
  });

  it('selectableModels excludes internal entries and filters by the jfet flag', () => {
    const diode = selectableModels('diode');
    // The ten user-selectable diode models (the plan's list). The internal
    // entries (old-default-led, 1N34, x2n2646-emitter, the two `~` models)
    // never appear.
    expect(diode).toEqual([
      '1N4004',
      '1N4148',
      '1N5711',
      '1N5712',
      'BAT85',
      'default',
      'default-led',
      'default-optocoupler-led',
      'default-zener',
      'spice-default',
    ]);

    const transistor = selectableModels('transistor');
    expect(transistor).toEqual(['default', 'spice-default']);

    // A mosfet sees the four non-jfet entries, a jfet only default-jfet.
    const mosfet = selectableModels('mosfet');
    expect(mosfet).toEqual(['default', 'default-body', 'default-digital', 'default-nodiode']);
    expect(selectableModels('jfet')).toEqual(['default-jfet']);
  });

  it('selectableModels with requireBreakdown drops the zero-breakdown rows', () => {
    // The zener's picker, matching getModelList(zener) (DiodeModel.java:193-194):
    // `spice-default` and `default` have no breakdown voltage, so a zener cannot
    // use them, while the models with a real zener voltage stay.
    expect(selectableModels('diode', true)).toEqual([
      '1N4004',
      '1N4148',
      '1N5711',
      '1N5712',
      'BAT85',
      'default-zener',
    ]);
  });

  it('zener FieldDef carries the breakdown filter, the diode one does not', () => {
    // The flag lives on the registry row so the picker can honour it; the
    // diode/varactor/led rows share the diode family but keep the full list.
    const zenerModel = defFor('zener')?.fields?.find((f) => f.type === 'modelChoice');
    expect(zenerModel?.zenerBreakdown).toBe(true);
    const diodeModel = defFor('diode')?.fields?.find((f) => f.type === 'modelChoice');
    expect(diodeModel?.zenerBreakdown).toBeUndefined();
  });

  it('derives the forward voltage upstream updateModel does', () => {
    // The exact values the resolution derives (DiodeModel.java:332-336).
    expect(forwardVoltageFor(1.7143528192808883e-7, 2)).toBeCloseTo(0.805904783, 10);
    expect(forwardVoltageFor(4.352e-9, 1.906)).toBeCloseTo(0.9491294544092825, 10);
    expect(forwardVoltageFor(1.7143528192808883e-7, 2)).toBeCloseTo(0.805904783, 10);
    // default-led (Is 93.2e-12, n 3.73) and the old default LED, whose value
    // form the port's fresh LED still writes.
    expect(forwardVoltageFor(93.2e-12, 3.73)).toBeCloseTo(2.2281, 3);
    expect(forwardVoltageFor(2.2349907006671927e-18, 2)).toBeCloseTo(2.1024259, 6);
  });

  it('modelFamilyFor maps the five naming kinds onto their families', () => {
    expect(modelFamilyFor('diode')).toBe('diode');
    expect(modelFamilyFor('zener')).toBe('diode');
    expect(modelFamilyFor('varactor')).toBe('diode');
    expect(modelFamilyFor('led')).toBe('diode');
    expect(modelFamilyFor('transistor')).toBe('transistor');
    expect(modelFamilyFor('mosfet')).toBe('mosfet');
    expect(modelFamilyFor('jfet')).toBe('jfet');
    expect(modelFamilyFor('resistor')).toBeUndefined();
  });
});

describe('resolveModelParams', () => {
  it('returns the file model before the built-in table', () => {
    // A `34` line for 1N4148 with a custom saturation current wins over the
    // built-in row of the same name.
    const file = { saturationCurrent: 1e-9, seriesResistance: 0, emissionCoefficient: 2, breakdownVoltage: 0 };
    const params = resolveModelParams('diode', '1N4148', file);
    expect(params?.saturationCurrent).toBe(1e-9);
    expect(params?.forwardVoltage).toBeCloseTo(forwardVoltageFor(1e-9, 2), 10);
  });

  it('returns the built-in before a miss', () => {
    const builtIn = resolveModelParams('diode', '1N4148', undefined);
    expect(builtIn).toEqual({
      saturationCurrent: 4.352e-9,
      seriesResistance: 0.6458,
      emissionCoefficient: 1.906,
      breakdownVoltage: 75,
      forwardVoltage: 0.9491294544092825,
    });
    const transistor = resolveModelParams('transistor', 'spice-default', undefined);
    expect(transistor).toEqual({ saturationCurrent: 1e-16, betaReverse: 1 });
    // The internal diode models resolve too: upstream's map lookup does not
    // check the picker visibility flag (DiodeModel.java:62-76).
    expect(resolveModelParams('diode', '~tl431ed-d_ed', undefined)?.saturationCurrent).toBe(1e-14);
    // A mosfet/jfet name resolves threshold and beta only.
    expect(resolveModelParams('jfet', 'default-jfet', undefined)).toEqual({ threshold: -4, beta: 0.00125 });
  });

  it('returns undefined for an unknown name', () => {
    expect(resolveModelParams('diode', '2N3906', undefined)).toBeUndefined();
    expect(resolveModelParams('transistor', 'early', undefined)).toBeUndefined();
    expect(resolveModelParams('diode', '2N3906', null)).toBeUndefined();
  });

  it('is case-sensitive like the upstream HashMap', () => {
    // `1n4148` does not resolve; `1N4148` does.
    expect(resolveModelParams('diode', '1n4148', undefined)).toBeUndefined();
    expect(resolveModelParams('diode', '1N4148', undefined)).toBeDefined();
  });
});
