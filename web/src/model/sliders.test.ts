import { describe, expect, it } from 'vitest';
import {
  adjustableFields,
  paramScale,
  resolveParam,
  sliderPositionToValue,
  sliderValueToPosition,
} from './sliders';

describe('adjustable fields', () => {
  it('lists only the numeric fields a slider can drive, in field order', () => {
    // The voltage source's fields: waveform (choice), maxVoltage, frequency,
    // bias, phaseShift, riseTime, dutyCycle. The choice is excluded, so the
    // adjustable list is the numeric ones in order.
    expect(adjustableFields('voltage').map((f) => f.name)).toEqual([
      'maxVoltage',
      'frequency',
      'bias',
      'phaseShift',
      'riseTime',
      'dutyCycle',
    ]);
    // A labeled node's only field is text: nothing to bind a slider to.
    expect(adjustableFields('labeledNode')).toEqual([]);
    // A kind with no definition has no fields either.
    expect(adjustableFields('unijunction')).toEqual([]);
  });

  it('excludes the file and download rows upstream rejects as widget/button', () => {
    // EditInfo.java:103 also rejects `widget` and `button` rows, which are the
    // port's `type: 'file'` (audio/data input) and `type: 'download'` (data
    // recorder) fields. A slider on them would drag params.fileNum and
    // silently overwrite the loaded-file index on save.
    expect(adjustableFields('audioInput').some((f) => f.type === 'file')).toBe(false);
    expect(adjustableFields('dataInput').some((f) => f.type === 'file')).toBe(false);
    expect(adjustableFields('dataRecorder').some((f) => f.type === 'download')).toBe(false);
    // The numeric fields beside the widget still stay adjustable.
    expect(adjustableFields('audioInput').map((f) => f.name)).toEqual([
      'maxVoltage',
      'startPosition',
    ]);
    expect(adjustableFields('dataRecorder').map((f) => f.name)).toEqual(['dataCount']);
  });

  it('excludes the SRAM/ROM contents editor, upstream\'s textArea edit item', () => {
    // Upstream rejects a textArea row in canCreateAdjustable (EditInfo
    // .java:101-104); a slider on it would write a phantom `contents` param
    // the engine cannot patch. The two bit widths beside it stay adjustable.
    expect(adjustableFields('sram').map((f) => f.name)).toEqual([
      'addressBits',
      'dataBits',
      'highVoltage',
    ]);
    expect(adjustableFields('rom').map((f) => f.name)).toEqual([
      'addressBits',
      'dataBits',
      'highVoltage',
    ]);
  });

  it('editItem indexes the adjustable list the same way resolveParam binds', () => {
    // resolveParam's caption-free fallback indexes into this exact list, so a
    // dialog creating a slider at index 1 saves a line that resolves back.
    const fields = adjustableFields('voltage');
    expect(resolveParam('voltage', 1, '')).toMatchObject({ name: fields[1].name });
  });
});

describe('slider parameter resolution', () => {
  it('pins the corpus bindings by caption and alias', () => {
    // Caption match against the field label.
    expect(resolveParam('resistor', 0, 'Resistance')).toMatchObject({ name: 'resistance' });
    expect(resolveParam('current', 0, 'Current')).toMatchObject({ name: 'current' });
    expect(resolveParam('capacitor', 0, 'Capacitance')).toMatchObject({ name: 'capacitance' });
    expect(resolveParam('inductor', 0, 'Inductance')).toMatchObject({ name: 'inductance' });
    // The alias wins where the caption and the port's field order disagree.
    expect(resolveParam('transistor', 0, 'Beta/hFE')).toMatchObject({ name: 'beta' });
    // "Duty Cycle" matches the field label even though editItem 6 is stale
    // against upstream's current edit list.
    expect(resolveParam('voltage', 6, 'Duty Cycle')).toMatchObject({ name: 'dutyCycle' });
    expect(resolveParam('resistor', 0, 'Phase Control')).toMatchObject({ name: 'resistance' });
  });

  it('matches case- and separator-insensitively', () => {
    expect(resolveParam('voltage', 6, 'duty cycle')).toMatchObject({ name: 'dutyCycle' });
    expect(resolveParam('voltage', 6, 'Duty-Cycle')).toMatchObject({ name: 'dutyCycle' });
    expect(resolveParam('transistor', 0, 'BETA/HFE')).toMatchObject({ name: 'beta' });
  });

  it('falls back to the numeric edit-item index when the caption matches nothing', () => {
    // The resistor's only numeric field is resistance, at index 0.
    expect(resolveParam('resistor', 0, 'Unrelated')).toMatchObject({ name: 'resistance' });
    // The voltage source's numeric fields in port order (waveform is a choice,
    // so it is skipped): amplitude, frequency, DC offset, phase offset,
    // rise/fall time, duty cycle.
    expect(resolveParam('voltage', 1, '')).toMatchObject({ name: 'frequency' });
    expect(resolveParam('voltage', 5, '')).toMatchObject({ name: 'dutyCycle' });
  });

  it('an out-of-range index and a kind with no fields resolve to null', () => {
    expect(resolveParam('resistor', 5, '')).toBeNull();
    // Wires and grounds expose no numeric fields.
    expect(resolveParam('wire', 0, '')).toBeNull();
    expect(resolveParam('ground', 0, '')).toBeNull();
    // A kind with no fields (the unijunction, dump 417) resolves to nothing,
    // like a definition that is absent altogether.
    expect(resolveParam('unijunction', 0, '')).toBeNull();
  });

  it('excludes text fields from the numeric-index fallback', () => {
    // A labeled node's only field is its text; without the exclusion the index
    // fallback would resolve to a phantom `text` param and force a full engine
    // rebuild on set_param.
    expect(resolveParam('labeledNode', 0, '')).toBeNull();
  });

  it('excludes the model-choice field from the numeric-index fallback', () => {
    // A diode's first field is the model choice, a non-numeric row like a text
    // or choice field. Without the exclusion the index fallback would resolve
    // a slider to a phantom `modelName` param; the numeric list is what the
    // caption-free index binds against, so index 0 is the forward drop.
    expect(resolveParam('diode', 0, '')).toMatchObject({ name: 'forwardVoltage' });
    // The name cannot resolve to a model param even with the caption matching
    // nothing.
    const byCaption = resolveParam('diode', 99, 'Forward drop');
    expect(byCaption?.name).toBe('forwardVoltage');
  });
});

describe('slider value/position conversion', () => {
  it('maps linear positions to values', () => {
    expect(sliderPositionToValue(50, 1, 101, false, 0)).toBe(51);
    expect(sliderPositionToValue(0, 1, 101, false, 0)).toBe(1);
    expect(sliderPositionToValue(100, 1, 101, false, 0)).toBe(101);
  });

  it('rounds to the step above min when one is set', () => {
    // 51 lands exactly on a multiple of 10 above 1; a position that does not
    // snaps to the nearest one.
    expect(sliderPositionToValue(50, 1, 101, false, 10)).toBe(51);
    expect(sliderPositionToValue(51, 1, 101, false, 10)).toBe(51);
    expect(sliderPositionToValue(5, 0, 100, false, 10)).toBe(10);
  });

  it('round-trips values through the logarithmic conversion', () => {
    for (const x of [1, 1.5, 10, 100, 500, 1000, 3.7, 999]) {
      const pos = sliderValueToPosition(x, 1, 1000, true);
      const back = sliderPositionToValue(pos, 1, 1000, true, 0);
      expect(back).toBeCloseTo(x, 9);
      // The position itself also round-trips.
      expect(sliderValueToPosition(back, 1, 1000, true)).toBeCloseTo(pos, 9);
    }
  });

  it('falls back to linear when log is requested on a non-positive range', () => {
    expect(sliderValueToPosition(0.5, 0, 1, true)).toBe(50);
    expect(sliderPositionToValue(50, 0, 1, true, 0)).toBe(0.5);
  });

  it('log mapping falls back to linear on a degenerate range', () => {
    // An inverted range would make logMax - logMin negative; the max > min
    // guard routes it to linear instead (50.5 = (50-100)*100/(1-100)).
    expect(sliderValueToPosition(50, 100, 1, true)).toBeCloseTo(50.5050505050505, 9);
    expect(sliderPositionToValue(50, 100, 1, true, 0)).toBeCloseTo(50.5, 9);
  });

  it('a stored fraction shows at its own position in a percent range', () => {
    // The corpus duty slider is `38 14 6 0 100 Duty\sCycle`, a percent range,
    // but the stored param is the fraction 0.56. The thumb read-back keeps the
    // raw param against the file range: position 0.56, not 56.
    expect(sliderValueToPosition(0.56, 0, 100, false)).toBe(0.56);
  });

  it('paramScale converts the file range into the param unit', () => {
    // Upstream's duty-cycle edit item is the percent (VoltageElm.java:578),
    // the port's dutyCycle param the fraction, so a slider value is scaled by
    // 0.01 before set_param. Every other param shares its file range.
    expect(paramScale('dutyCycle')).toBe(0.01);
    expect(paramScale('resistance')).toBe(1);
  });
});
