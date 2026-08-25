import { beforeEach, describe, expect, it } from 'vitest';
import { parseCircuit } from '../io/netlist';
import { clearUserModels, userModel } from '../model/deviceModels';
import { useStore } from './store';
import { fresh } from './store.test-helpers';

beforeEach(() => {
  useStore.setState(fresh());
  clearUserModels();
});

const diodeEntry = (name: string, saturationCurrent = 1e-9) => ({
  name,
  builtIn: false as const,
  flags: 0,
  saturationCurrent,
  seriesResistance: 0,
  emissionCoefficient: 2,
  breakdownVoltage: 0,
});

describe('device model editor', () => {
  it('create-from-element rebinds the element and bumps revision', () => {
    const [loaded] = parseCircuit('d 176 80 384 80 0 0.805904783').elements;
    const id = useStore.getState().addElement(loaded);
    const revision = useStore.getState().revision;

    useStore.getState().applyDeviceModelEdit('diode', diodeEntry('mydiode'), id);

    const e = useStore.getState().elements[0];
    expect(e.modelName).toBe('mydiode');
    expect(e.params.saturationCurrent).toBe(1e-9);
    expect(useStore.getState().revision).toBeGreaterThan(revision);
    expect(userModel('diode', 'mydiode')).toBeDefined();
  });

  it('undo of the rebind keeps the model registered', () => {
    const [loaded] = parseCircuit('d 176 80 384 80 0 0.805904783').elements;
    const id = useStore.getState().addElement(loaded);
    useStore.getState().applyDeviceModelEdit('diode', diodeEntry('mydiode'), id);
    expect(useStore.getState().elements[0].modelName).toBe('mydiode');

    useStore.getState().undo();

    // The element goes back to the value form, but the model is module state
    // and survives the undo by design: dialog edits are session-persistent
    // and only the stack crossings are compensated (tombstones, pruned-model
    // restores, `.` line re-syncs). Upstream snapshots genuinely roll model
    // definitions back, so this is a recorded divergence from it.
    expect(useStore.getState().elements[0].modelName).toBeUndefined();
    expect(userModel('diode', 'mydiode')).toBeDefined();
  });

  it('editing a shared model changes every referencing element after a rebuild', () => {
    const text = [
      '$ 1 0.000005 10 50 5 43 5e-11',
      '34 shared 0 1e-9 0 2 0',
      'd 0 0 160 0 2 shared',
      'd 176 0 336 0 2 shared',
    ].join('\n');
    useStore.getState().loadNetlist(text);
    // The load committed the file's model line into the writable store.
    expect(userModel('diode', 'shared')).toBeDefined();
    const revision = useStore.getState().revision;

    useStore.getState().applyDeviceModelEdit(
      'diode',
      diodeEntry('shared', 3e-9),
      undefined,
      'shared',
    );

    for (const e of useStore.getState().elements) {
      expect(e.params.saturationCurrent).toBe(3e-9);
    }
    expect(useStore.getState().revision).toBeGreaterThan(revision);
    // The save writes the edited model's regenerated line.
    expect(useStore.getState().toNetlist()).toContain('34 shared 0 3e-9 0 2 0');
  });

  it('dropping the last referencing element removes the user model', () => {
    const [loaded] = parseCircuit('d 176 80 384 80 0 0.805904783').elements;
    const id = useStore.getState().addElement(loaded);
    useStore.getState().applyDeviceModelEdit('diode', diodeEntry('mydiode'), id);
    expect(userModel('diode', 'mydiode')).toBeDefined();

    useStore.getState().select([id]);
    useStore.getState().deleteSelected();

    expect(useStore.getState().elements).toHaveLength(0);
    expect(userModel('diode', 'mydiode')).toBeUndefined();
  });

  it('openDeviceModelEditor seeds a create from the element and opens the dialog', () => {
    const [loaded] = parseCircuit('d 176 80 384 80 0 0.805904783').elements;
    const id = useStore.getState().addElement(loaded);

    useStore.getState().openDeviceModelEditor('diode', id, 'create-simple');

    const editor = useStore.getState().deviceModelEditor;
    expect(editor?.family).toBe('diode');
    expect(editor?.attachedElementId).toBe(id);
    expect(editor?.prevName).toBeUndefined();
    // The simple copy inherits the current drop's saturation current.
    expect(editor?.initial).toMatchObject({ name: '', builtIn: false, flags: 1 });
    // Edit refuses a built-in name (the readOnly rule).
    useStore.getState().closeDeviceModelEditor();
    useStore.getState().setModelName(id, '1N4148');
    useStore.getState().openDeviceModelEditor('diode', id, 'edit');
    expect(useStore.getState().deviceModelEditor).toBeNull();
  });

  it('undo of a delete restores the pruned user model so the line survives a save', () => {
    const [loaded] = parseCircuit('d 176 80 384 80 0 0.805904783').elements;
    const id = useStore.getState().addElement(loaded);
    useStore.getState().applyDeviceModelEdit('diode', diodeEntry('mydiode'), id);
    useStore.getState().select([id]);
    useStore.getState().deleteSelected();
    expect(useStore.getState().elements).toHaveLength(0);
    expect(userModel('diode', 'mydiode')).toBeUndefined();

    // Undo brings the element back; the model it names has to come back with
    // it, or a save would drop the line and a reload would revert the model.
    useStore.getState().undo();
    expect(useStore.getState().elements[0].modelName).toBe('mydiode');
    expect(userModel('diode', 'mydiode')).toBeDefined();
    const saved = useStore.getState().toNetlist();
    expect(saved).toContain('34 mydiode 0 1e-9 0 2 0');

    // And the saved line survives a reload, params intact.
    useStore.getState().loadNetlist(saved);
    expect(useStore.getState().elements[0].modelName).toBe('mydiode');
    expect(useStore.getState().elements[0].params.saturationCurrent).toBe(1e-9);
    expect(userModel('diode', 'mydiode')).toBeDefined();
  });

  it('a redo re-applies the delete; the model stays registered like any module-state model', () => {
    // Models live outside the undo stack: a redo of the delete leaves the
    // restored model registered (the same principle as undo-of-a-rebind keeping
    // it). The entry is unreferenced, so a save emits no line for it, and a
    // document reset drops it; nothing is lost either way.
    const [loaded] = parseCircuit('d 176 80 384 80 0 0.805904783').elements;
    const id = useStore.getState().addElement(loaded);
    useStore.getState().applyDeviceModelEdit('diode', diodeEntry('mydiode'), id);
    useStore.getState().select([id]);
    useStore.getState().deleteSelected();
    useStore.getState().undo();
    expect(userModel('diode', 'mydiode')).toBeDefined();

    useStore.getState().redo();

    expect(useStore.getState().elements).toHaveLength(0);
    expect(userModel('diode', 'mydiode')).toBeDefined();
  });

  it('undo of a model rename restores the old name the reverted elements reference', () => {
    // A rename in the dialog moves the model to the new name and the elements
    // with it; undo reverts the elements to the old name, which has to come
    // back too, or a save would drop its line.
    const text = [
      '$ 1 0.000005 10 50 5 43 5e-11',
      '34 mydiode 0 1e-9 0 2 0',
      'd 0 0 160 0 2 mydiode',
    ].join('\n');
    useStore.getState().loadNetlist(text);
    useStore.getState().applyDeviceModelEdit('diode', diodeEntry('newdiode', 3e-9), undefined, 'mydiode');
    expect(useStore.getState().elements[0].modelName).toBe('newdiode');
    expect(userModel('diode', 'mydiode')).toBeUndefined();

    useStore.getState().undo();

    expect(useStore.getState().elements[0].modelName).toBe('mydiode');
    expect(userModel('diode', 'mydiode')).toBeDefined();
    // The old name's original file line is preserved byte for byte.
    expect(useStore.getState().toNetlist()).toContain('34 mydiode 0 1e-9 0 2 0');
  });

  it('a created model survives save and reload through its 34 line', () => {
    // The manual-pass shape: create a simple model off a fresh diode, save,
    // reload, and confirm the picker still shows it and the element resolves.
    const [loaded] = parseCircuit('d 176 80 384 80 0 0.805904783').elements;
    const id = useStore.getState().addElement(loaded);
    useStore.getState().applyDeviceModelEdit('diode', diodeEntry('fwdrop=0.8'), id);
    const saved = useStore.getState().toNetlist();
    // The `=` in the name rides the netlist escape set (`\q`).
    expect(saved).toContain('34 fwdrop\\q0.8 0 1e-9 0 2 0');

    useStore.getState().loadNetlist(saved);

    const e = useStore.getState().elements[0];
    expect(e.modelName).toBe('fwdrop=0.8');
    expect(e.params.saturationCurrent).toBe(1e-9);
    expect(userModel('diode', 'fwdrop=0.8')).toBeDefined();
    // An untouched reload still saves the line byte for byte.
    expect(useStore.getState().toNetlist()).toBe(saved);
  });
});