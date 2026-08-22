import { describe, expect, it, beforeEach } from 'vitest';
import { defFor } from './registry';
import {
  DIODE_MODELS,
  MOSFET_MODELS,
  TRANSISTOR_MODELS,
  allModels,
  clearUserModels,
  diodeModelLine,
  emissionCoefficientFor,
  forwardVoltageFor,
  forwardVoltageAt,
  modelFamilyFor,
  pruneUnreferencedModels,
  putUserModel,
  regenerateDiodeLine,
  regenerateTransistorLine,
  resolveModelParams,
  saturationCurrentFor,
  seedModelEntry,
  selectableModels,
  simpleForwardSeed,
  synthesizeModelName,
  transistorModelLine,
  userModel,
  type UserDiodeEntry,
  type UserTransistorEntry,
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

describe('the writable model store', () => {
  const diodeEntry = (name: string, breakdownVoltage = 0): UserDiodeEntry => ({
    name,
    builtIn: false,
    saturationCurrent: 1e-9,
    seriesResistance: 0,
    emissionCoefficient: 2,
    breakdownVoltage,
  });

  beforeEach(() => clearUserModels());

  it('putUserModel is visible through allModels, sorted after the built-ins', () => {
    putUserModel('diode', diodeEntry('my-1N4148'));
    putUserModel('diode', diodeEntry('aaa'));
    const names = allModels('diode').map((e) => e.name);
    // The ten built-ins come first, then the two writable names sorted.
    expect(names).toEqual([...selectableModels('diode').slice(0, 10), 'aaa', 'my-1N4148']);
    // The writable entry itself carries its body.
    expect(allModels('diode').find((e) => e.name === 'my-1N4148')).toMatchObject({
      builtIn: false,
      saturationCurrent: 1e-9,
    });
  });

  it('selectableModels shows user models, and the zener filter drops their zero-breakdown rows', () => {
    putUserModel('diode', diodeEntry('my-zener', 6.3));
    putUserModel('diode', diodeEntry('my-plain'));
    expect(selectableModels('diode')).toContain('my-zener');
    expect(selectableModels('diode')).toContain('my-plain');
    // A created zener must not vanish from the picker it was made from
    // (feature/device-model-editor.md risk notes).
    expect(selectableModels('diode', true)).toContain('my-zener');
    expect(selectableModels('diode', true)).not.toContain('my-plain');
  });

  it('resolveModelParams consults the writable store before the built-ins', () => {
    putUserModel('diode', diodeEntry('1N4148'));
    const params = resolveModelParams('diode', '1N4148', undefined);
    expect(params?.saturationCurrent).toBe(1e-9);
    // The file's own line still wins over the writable entry.
    const fileWins = resolveModelParams('diode', '1N4148', {
      saturationCurrent: 5e-9,
      seriesResistance: 0,
      emissionCoefficient: 2,
      breakdownVoltage: 0,
    });
    expect(fileWins?.saturationCurrent).toBe(5e-9);
    // A transistor entry resolves satCur and betaR like the built-in does.
    putUserModel('transistor', { name: 'myt', builtIn: false, saturationCurrent: 2e-13, betaReverse: 1 });
    expect(resolveModelParams('transistor', 'myt', undefined)).toEqual({
      saturationCurrent: 2e-13,
      betaReverse: 1,
    });
  });

  it('a writable model shadowing a built-in appears once, file entry winning', () => {
    // A legal file shape: a `34` line names `1N4148`, shadowing the built-in
    // row the way the load-time resolution lets the file win.
    putUserModel('diode', {
      name: '1N4148',
      builtIn: false,
      saturationCurrent: 1e-9,
      seriesResistance: 0,
      emissionCoefficient: 2,
      breakdownVoltage: 0,
    });
    const entries = allModels('diode').filter((e) => e.name === '1N4148');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ builtIn: false, saturationCurrent: 1e-9 });
    // The picker has exactly one option for the name.
    expect(selectableModels('diode').filter((n) => n === '1N4148')).toEqual(['1N4148']);
    // And resolution still favours the writable entry over the built-in.
    expect(resolveModelParams('diode', '1N4148', undefined)?.saturationCurrent).toBe(1e-9);
  });

  it('synthesizeModelName follows upstream pickName, suffixing on collision', () => {
    // The family words, and the zener/simple diode names (DiodeModel.java:
    // 365-371, TransistorModel.java:340, MosfetModel.java:374).
    expect(synthesizeModelName('transistor', { name: '', builtIn: false, saturationCurrent: 1e-13, betaReverse: 1 })).toBe('transistormodel');
    expect(synthesizeModelName('mosfet', { name: '', builtIn: false, threshold: 1.5, beta: 0.02, jfet: false })).toBe('mosfetmodel');
    expect(synthesizeModelName('jfet', { name: '', builtIn: false, threshold: -4, beta: 0.00125, jfet: true })).toBe('jfetmodel');
    expect(synthesizeModelName('diode', diodeEntry(''))).toBe('diodemodel');
    expect(synthesizeModelName('diode', diodeEntry('', 5.6))).toBe('zener-5.6');
    expect(synthesizeModelName('diode', { ...diodeEntry(''), flags: 1, forwardVoltage: 0.806 })).toBe('fwdrop=0.806');
    // A collision against a built-in or a writable name gets the -2 suffix.
    putUserModel('diode', diodeEntry('diodemodel'));
    putUserModel('diode', diodeEntry('diodemodel-2'));
    expect(synthesizeModelName('diode', diodeEntry(''))).toBe('diodemodel-3');
    expect(synthesizeModelName('diode', diodeEntry('1N4148'))).toBe('1N4148-2');
    // An explicit name is left alone when nothing holds it.
    expect(synthesizeModelName('diode', diodeEntry('my-own'))).toBe('my-own');
    // An in-place edit that keeps its name is not a collision with itself.
    putUserModel('diode', diodeEntry('shared'));
    expect(synthesizeModelName('diode', diodeEntry('shared'), 'shared')).toBe('shared');
  });

  it('forward-voltage derivation works in both directions', () => {
    const is = 1e-9;
    const fwdI = 1;
    const v = forwardVoltageAt(is, 2, fwdI);
    // The simple mode's n from V/I is the inverse of the forward voltage.
    expect(emissionCoefficientFor(v, fwdI, is)).toBeCloseTo(2, 10);
    expect(forwardVoltageAt(is, emissionCoefficientFor(v, fwdI, is), fwdI)).toBeCloseTo(v, 10);
    // forwardVoltageFor is the 1 A special case of forwardVoltageAt.
    expect(forwardVoltageAt(is, 2, 1)).toBeCloseTo(forwardVoltageFor(is, 2), 10);
    // And the inverse recovers Is from a drop.
    expect(saturationCurrentFor(forwardVoltageFor(is, 2), 2)).toBeCloseTo(is, 10);
    // simpleForwardSeed defaults the current to 1 A (setForwardVoltage,
    // DiodeModel.java:326-330).
    expect(simpleForwardSeed(is, 2, undefined)).toEqual({
      forwardCurrent: 1,
      forwardVoltage: forwardVoltageFor(is, 2),
    });
  });

  it('pruneUnreferencedModels deletes only the unreferenced entries', () => {
    putUserModel('diode', diodeEntry('used'));
    putUserModel('diode', diodeEntry('orphan'));
    putUserModel('transistor', { name: 'orphan-t', builtIn: false, saturationCurrent: 1e-13, betaReverse: 1 });
    pruneUnreferencedModels([
      { kind: 'diode', modelName: 'used' },
      { kind: 'zener', modelName: 'used' },
    ]);
    expect(userModel('diode', 'used')).toBeDefined();
    expect(userModel('diode', 'orphan')).toBeUndefined();
    expect(userModel('transistor', 'orphan-t')).toBeUndefined();
  });

  it('writes the 34 line upstream dumps, in the token order parse reads', () => {
    expect(
      diodeModelLine({ ...diodeEntry('mydiode'), forwardCurrent: 1e-3, forwardVoltage: 0.806 }),
    ).toBe('34 mydiode 0 1e-9 0 2 0 0.001');
    // A simple-mode entry carries FLAGS_SIMPLE (bit 0) in the flags token.
    expect(diodeModelLine({ ...diodeEntry('mydiode'), flags: 1 })).toBe('34 mydiode 1 1e-9 0 2 0');
  });

  it('writes a full 32 table and regenerates an edited one in place', () => {
    const entry: UserTransistorEntry = { name: 'myt', builtIn: false, saturationCurrent: 2e-13, betaReverse: 1 };
    // The defaults the port does not model ride the upstream constructor
    // values, so the line still walks the way `parseTransistorModelLine` reads.
    expect(transistorModelLine(entry)).toBe('32 myt 0 2e-13 0 0 1.5 0 0 2 1 1 0 0 1');
    // An edited file line keeps its unknown tokens byte for byte.
    expect(
      regenerateTransistorLine('32 early 0 1e-13 0 0 1.5 0 0 2 1 1 0.02 0 1', {
        ...entry,
        name: 'early',
        saturationCurrent: 5e-13,
      }),
    ).toBe('32 early 0 5e-13 0 0 1.5 0 0 2 1 1 0.02 0 1');
    // Indented lines keep their leading whitespace (the order walk carries the
    // raw, untrimmed line).
    expect(
      regenerateTransistorLine('  32 early 0 1e-13 0 0 1.5 0 0 2 1 1 0.02 0 1', {
        ...entry,
        name: 'early',
        saturationCurrent: 5e-13,
      }),
    ).toBe('  32 early 0 5e-13 0 0 1.5 0 0 2 1 1 0.02 0 1');
    // An unchanged token keeps its original spelling: only satCur changed, so
    // the file's `1.0` betaR must not be rewritten to `1`.
    expect(
      regenerateTransistorLine('32 early 0 5e-13 0 0 1.5 0 0 2 1 1 0.02 0 1.0', {
        ...entry,
        name: 'early',
        saturationCurrent: 5e-13,
      }),
    ).toBe('32 early 0 5e-13 0 0 1.5 0 0 2 1 1 0.02 0 1.0');
  });

  it('regenerateDiodeLine keeps the file line leading whitespace like the transistor writer', () => {
    const entry = { name: 'mydiode', builtIn: false as const, flags: 0, saturationCurrent: 2e-9, seriesResistance: 0, emissionCoefficient: 2, breakdownVoltage: 0 };
    expect(regenerateDiodeLine(' 34 mydiode 0 1e-9 0 2 0', entry)).toBe(
      ' 34 mydiode 0 2e-9 0 2 0',
    );
  });

  it('seedModelEntry copies the current model for a create, empty-named', () => {
    // A value-form diode recovers its saturation current from the drop.
    const seed = seedModelEntry(
      'diode',
      { forwardVoltage: 0.805904783, seriesResistance: 0, emissionCoefficient: 2 },
      undefined,
      'create-simple',
    );
    expect(seed).toMatchObject({ name: '', builtIn: false, flags: 1, forwardCurrent: 1 });
    expect((seed as UserDiodeEntry).saturationCurrent).toBeCloseTo(1.7143528192808883e-7, 12);
    // An advanced create keeps the copy's params under flags 0.
    const advanced = seedModelEntry(
      'diode',
      { forwardVoltage: 0.805904783, seriesResistance: 0.5, emissionCoefficient: 2 },
      undefined,
      'create-advanced',
    );
    expect(advanced).toMatchObject({ name: '', builtIn: false, flags: 0, seriesResistance: 0.5 });
    // A source entry's forward current carries into the simple seed.
    const fromSource = seedModelEntry(
      'diode',
      {},
      { ...diodeEntry('src'), forwardCurrent: 2 },
      'create-simple',
    );
    expect(fromSource).toMatchObject({ forwardCurrent: 2, saturationCurrent: 1e-9 });
  });
});
