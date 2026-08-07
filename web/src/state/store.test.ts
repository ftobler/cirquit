import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type SimSettings } from '../model/types';
import { parseCircuit, serializeCircuit } from '../io/netlist';
import { makeElement, useStore } from './store';
import { addResistor, fresh } from './store.test-helpers';

beforeEach(() => useStore.setState(fresh()));

describe('creation defaults', () => {
  it('new elements save the upstream default flags', () => {
    // A new part must round-trip to upstream with its features on: without
    // these, upstream loads the file with FLAG_SHOW_VOLTAGE, FLAG_SHOW_VALUES,
    // FLAG_SHOWVOLTAGE|FLAG_CIRCLE and FLAG_GAIN all off.
    expect(makeElement('voltage', 0, 0, 0, 64).flags).toBe(16);
    expect(makeElement('rail', 0, 0, 0, 64).flags).toBe(16);
    expect(makeElement('potentiometer', 0, 0, 32, 0).flags).toBe(1);
    expect(makeElement('probe', 0, 0, 32, 0).flags).toBe(3);
    expect(makeElement('opamp', 0, 0, 26, 0).flags).toBe(8);
    // Everything else creates with flags 0.
    expect(makeElement('resistor', 0, 0, 32, 0).flags).toBe(0);
    expect(makeElement('transistor', 0, 0, 32, 0).flags).toBe(0);
    expect(makeElement('switch2', 0, 0, 32, 0).flags).toBe(0);
  });

  it('creates text at the upstream size of 24', () => {
    expect(makeElement('decoration', 0, 0, 0, 0).params.size).toBe(24);
  });
});

describe('value edits go through the fast path', () => {
  it('setParam bumps paramRevision and not revision', () => {
    const id = addResistor();
    const before = useStore.getState();

    useStore.getState().setParam(id, 'resistance', 2000);

    const after = useStore.getState();
    expect(after.revision).toBe(before.revision);
    expect(after.paramRevision).toBe(before.paramRevision + 1);
    expect(after.pendingParams.get(`${id}:resistance`)).toEqual({
      id,
      name: 'resistance',
      value: 2000,
    });
    // The value still lands in the element, so a later topology reload
    // serialises it.
    expect(after.elements[0].params.resistance).toBe(2000);
  });

  it('setElementState bumps paramRevision and not revision', () => {
    const id = addResistor();
    const before = useStore.getState();

    useStore.getState().setElementState(id, 1);

    const after = useStore.getState();
    expect(after.revision).toBe(before.revision);
    expect(after.paramRevision).toBe(before.paramRevision + 1);
    expect(after.pendingStates.get(id)).toBe(1);
    expect(after.elements[0].state).toBe(1);
  });

  it('coalesces repeated edits to one pending entry holding the last value', () => {
    const id = addResistor();

    for (let i = 0; i < 10; i++) {
      useStore.getState().setParam(id, 'resistance', i * 100);
    }

    const after = useStore.getState();
    expect(after.pendingParams.size).toBe(1);
    expect(after.pendingParams.get(`${id}:resistance`)?.value).toBe(900);
  });

  it('keeps different params on one element separate', () => {
    const id = useStore.getState().addElement({
      kind: 'capacitor',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { capacitance: 1e-6, initialVoltage: 0 },
    });

    useStore.getState().setParam(id, 'capacitance', 2e-6);
    useStore.getState().setParam(id, 'initialVoltage', 1);

    const after = useStore.getState();
    expect(after.pendingParams.size).toBe(2);
    expect(after.pendingParams.get(`${id}:capacitance`)?.value).toBe(2e-6);
    expect(after.pendingParams.get(`${id}:initialVoltage`)?.value).toBe(1);
  });

  it('keeps a source pulse-duty flag in step with its waveform', () => {
    // The engine reads bit 4 (VOLTAGE_PULSE_DUTY) at build time and re-applies
    // the legacy 1/(2*pi) duty whenever it is absent, so the stored flags must
    // carry it exactly when a voltage/rail source is pulse. The edit stays on
    // the fast path: only a rebuild would re-read the flags.
    const id = useStore.getState().addElement({
      kind: 'voltage',
      x1: 0,
      y1: 64,
      x2: 0,
      y2: 0,
      flags: 16,
      params: { waveform: 0, dutyCycle: 0.5 },
    });
    const before = useStore.getState();

    useStore.getState().setParam(id, 'waveform', 5);
    let after = useStore.getState();
    expect(after.elements[0].flags & 4).toBe(4);
    expect(after.revision).toBe(before.revision);
    expect(after.pendingParams.get(`${id}:waveform`)?.value).toBe(5);

    useStore.getState().setParam(id, 'dutyCycle', 0.3);
    after = useStore.getState();
    expect(after.elements[0].params.dutyCycle).toBe(0.3);
    // The flag stays set while the waveform is pulse, so a rebuild serialises
    // the edited 0.3 rather than snapping it back to 1/(2*pi).
    expect(after.elements[0].flags & 4).toBe(4);

    useStore.getState().setParam(id, 'waveform', 1);
    after = useStore.getState();
    expect(after.elements[0].flags & 4).toBe(0);

    // A rail behaves the same way.
    const railId = useStore.getState().addElement({
      kind: 'rail',
      x1: 0,
      y1: 64,
      x2: 0,
      y2: 0,
      flags: 16,
      params: { waveform: 0 },
    });
    useStore.getState().setParam(railId, 'waveform', 5);
    const rail = useStore.getState().elements.find((e) => e.id === railId);
    expect((rail?.flags ?? 0) & 4).toBe(4);
  });
});

describe('setText edits free text through the fast path', () => {
  const addDecoration = (text?: string) =>
    useStore.getState().addElement({
      kind: 'decoration',
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 0,
      flags: 0,
      params: { size: 12 },
      ...(text !== undefined ? { text } : {}),
    });

  it('updates only that element text and leaves params and other elements alone', () => {
    const resistor = addResistor();
    const deco = addDecoration('old');

    useStore.getState().setText(deco, 'new text');

    const after = useStore.getState();
    const edited = after.elements.find((e) => e.id === deco);
    const other = after.elements.find((e) => e.id === resistor);
    expect(edited?.text).toBe('new text');
    expect(edited?.params).toEqual({ size: 12 });
    expect(other?.params).toEqual({ resistance: 1000 });
    expect(other?.text).toBeUndefined();
  });

  it('bumps paramRevision and not revision', () => {
    const id = addDecoration();
    const before = useStore.getState();

    useStore.getState().setText(id, 'hello');

    const after = useStore.getState();
    expect(after.revision).toBe(before.revision);
    expect(after.paramRevision).toBe(before.paramRevision + 1);
    expect(after.pendingParams.size).toBe(0);
  });

  it('bumps revision on a labeled node, whose text is structural', () => {
    const id = useStore.getState().addElement({
      kind: 'labeledNode',
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 0,
      flags: 0,
      params: {},
      text: 'A',
    });
    const before = useStore.getState();

    useStore.getState().setText(id, 'B');

    const after = useStore.getState();
    expect(after.revision).toBe(before.revision + 1);
    expect(after.paramRevision).toBe(before.paramRevision);
    expect(after.elements[0].text).toBe('B');
  });

  it('strips newlines so a save never splits the element line', () => {
    const id = addDecoration();
    useStore.getState().setText(id, 'line1\nline2\r');
    expect(useStore.getState().elements[0].text).toBe('line1line2');
  });

  it('is a no-op on an unknown id', () => {
    const before = useStore.getState();
    useStore.getState().setText(999, 'nope');
    const after = useStore.getState();
    expect(after.elements).toEqual(before.elements);
    expect(after.revision).toBe(before.revision);
    expect(after.paramRevision).toBe(before.paramRevision);
  });
});

describe('topology mutators force a reload', () => {
  it.each([
    [
      'addElement',
      () =>
        useStore.getState().addElement({
          kind: 'wire',
          x1: 0,
          y1: 160,
          x2: 160,
          y2: 160,
          flags: 0,
          params: {},
        }),
    ],
    ['moveElements', (id: number) => useStore.getState().moveElements([id], 16, 0)],
    ['updateElement', (id: number) => useStore.getState().updateElement(id, { x2: 320 })],
    [
      'deleteSelected',
      (id: number) => {
        useStore.getState().select([id]);
        useStore.getState().deleteSelected();
      },
    ],
  ] as const)('%s bumps revision', (_name, mutate) => {
    const id = addResistor();
    const before = useStore.getState().revision;
    mutate(id);
    expect(useStore.getState().revision).toBe(before + 1);
  });
});

describe('updateSettings reload classification', () => {
  it.each([
    ['timeStep', 1e-5, true],
    // The adaptive floor and flag are engine options too, so either forces a
    // rebuild like timeStep does.
    ['minTimeStep', 1e-9, true],
    ['adaptiveTimeStep', false, true],
    // iterCount is a header round-trip field, never sent to the engine.
    ['iterCount', 10, false],
    ['stepsPerFrame', 160, false],
    ['voltageRange', 5, false],
    ['currentSpeed', 50, false],
    ['showCurrent', true, false],
    ['showValues', true, false],
    ['showVoltageColor', true, false],
    ['showGrid', true, false],
  ] as const)('%s reloads=%s', (key, value, reload) => {
    const before = useStore.getState().revision;
    useStore.getState().updateSettings({ [key]: value } as Partial<SimSettings>);
    expect(useStore.getState().revision - before).toBe(reload ? 1 : 0);
  });
});

describe('load resets the header stepping fields to their defaults', () => {
  it('a file that stops before minTimeStep does not inherit the previous file', () => {
    useStore.getState().loadNetlist('$ 0 0.000005 10 50 5 50 1e-9\nr 0 0 16 0 0 100\n');
    expect(useStore.getState().settings.minTimeStep).toBe(1e-9);

    useStore.getState().loadNetlist('$ 0 5e-6 10 50 5\nr 0 0 16 0 0 100\n');
    expect(useStore.getState().settings.minTimeStep).toBe(DEFAULT_SETTINGS.minTimeStep);
    expect(useStore.getState().settings.iterCount).toBe(DEFAULT_SETTINGS.iterCount);
    // A file with no adaptive flag loads as fixed-step, which is also the
    // default, so the header fields fall back to DEFAULT_SETTINGS.
    expect(useStore.getState().settings.adaptiveTimeStep).toBe(false);
  });
});

describe('diode model name', () => {
  it('editing a value drops the model name', () => {
    const [loaded] = parseCircuit('d 176 80 384 80 2 1N4148').elements;
    expect(loaded.modelName).toBe('1N4148');
    useStore.getState().addElement(loaded);
    const id = useStore.getState().elements[0].id;
    expect(useStore.getState().elements[0].modelName).toBe('1N4148');

    useStore.getState().setParam(id, 'forwardVoltage', 0.9);

    const e = useStore.getState().elements[0];
    expect(e.modelName).toBeUndefined();
    expect(e.params.forwardVoltage).toBe(0.9);
  });

  it('editing the zener voltage drops the model name', () => {
    const [loaded] = parseCircuit('z 100 100 100 0 2 default-zener').elements;
    expect(loaded.modelName).toBe('default-zener');
    useStore.getState().addElement(loaded);
    const id = useStore.getState().elements[0].id;

    useStore.getState().setParam(id, 'breakdownVoltage', 6.2);
    const e = useStore.getState().elements[0];
    expect(e.modelName).toBeUndefined();
    expect(e.params.breakdownVoltage).toBe(6.2);

    const line =
      serializeCircuit(useStore.getState().elements, { ...DEFAULT_SETTINGS })
        .trim()
        .split('\n')
        .find((l) => l.startsWith('z ')) ?? '';
    // The value form, not the stale name, and FLAG_MODEL is cleared so a
    // reload reads the tokens as numbers rather than a bogus model name.
    expect(line).toBe('z 100 100 100 0 1 0.805904783 6.2');
  });

  it('keeps the model name when a non-model param is edited', () => {
    const [loaded] = parseCircuit('d 176 80 384 80 2 1N4148').elements;
    useStore.getState().addElement(loaded);
    const id = useStore.getState().elements[0].id;

    useStore.getState().setParam(id, 'resistance', 5);

    expect(useStore.getState().elements[0].modelName).toBe('1N4148');
  });

  it('load-edit-save-reload keeps the edit as a value, not a stale model name', () => {
    // Regression: the value form used to keep FLAG_MODEL (bit 2) from the
    // loaded line, so a reload read the fwdrop token as a bogus model name and
    // silently lost the edit.
    const [loaded] = parseCircuit('d 176 80 384 80 2 1N4148').elements;
    useStore.getState().addElement(loaded);
    const id = useStore.getState().elements[0].id;

    useStore.getState().setParam(id, 'forwardVoltage', 0.9);
    expect(useStore.getState().elements[0].modelName).toBeUndefined();

    const line =
      serializeCircuit(useStore.getState().elements, { ...DEFAULT_SETTINGS })
        .trim()
        .split('\n')
        .find((l) => l.startsWith('d ')) ?? '';
    expect(line).toBe('d 176 80 384 80 1 0.9');

    const [again] = parseCircuit(line).elements;
    expect(again.params.forwardVoltage).toBe(0.9);
    expect(again.modelName).toBeUndefined();
  });
});
