import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSampleCache, getDataSamples } from '../model/sampleCache';
import { parseCircuit } from '../io/netlist';
import { postPatch } from '../render/geometry';
import { DEFAULT_SETTINGS } from '../model/types';
import { hasUnsavedChanges, useStore } from './store';
import { addCapacitor, addResistor, fresh } from './store.test-helpers';

beforeEach(() => useStore.setState(fresh()));

describe('app preferences survive undo and redo', () => {
  it('undo of an unrelated edit keeps the preferences set after the commit', () => {
    const id = addResistor();  // one commit, taken while prefs were default
    useStore.getState().updateSettings({ decimalDigits: 5, wheelSensitivity: 3 });

    useStore.getState().undo();

    const s = useStore.getState();
    expect(s.elements).toHaveLength(0);
    // The colour/digit/wheel block rides no undo entry of its own, so the
    // restore must hand today's values back instead of the snapshot's.
    expect(s.settings.decimalDigits).toBe(5);
    expect(s.settings.wheelSensitivity).toBe(3);
    expect(s.undoStack).toHaveLength(0);
    void id;
  });

  it('redo re-applies the live preferences over the restored future', () => {
    addResistor();
    useStore.getState().updateSettings({ decimalDigits: 5 });
    addCapacitor();
    useStore.getState().undo();
    // Change the pref again after the undo: redo must not clobber it with
    // the future snapshot's older value.
    useStore.getState().updateSettings({ decimalDigits: 7 });
    useStore.getState().redo();
    expect(useStore.getState().settings.decimalDigits).toBe(7);
  });

  it('header-borne keys still rewind with the stack', () => {
    addResistor();  // snapshot holds voltageRange 5 (the default)
    useStore.getState().updateSettings({ voltageRange: 42 });
    useStore.getState().undo();
    // Upstream keeps these in the dump header, so an undo genuinely rolls
    // them back; only the pure app-pref keys are exempt.
    expect(useStore.getState().settings.voltageRange).toBe(DEFAULT_SETTINGS.voltageRange);
  });

  it('a whole block of preferences survives an undo round trip', () => {
    addResistor();
    useStore.getState().updateSettings({
      decimalDigits: 6,
      wheelSensitivity: 2,
      showCrosshair: !DEFAULT_SETTINGS.showCrosshair,
      positiveColor: '#ff0000',
      euroGates: !DEFAULT_SETTINGS.euroGates,
      mouseWheelEdit: !DEFAULT_SETTINGS.mouseWheelEdit,
    });

    useStore.getState().undo();

    const s = useStore.getState().settings;
    expect(s.decimalDigits).toBe(6);
    expect(s.wheelSensitivity).toBe(2);
    expect(s.showCrosshair).toBe(!DEFAULT_SETTINGS.showCrosshair);
    expect(s.positiveColor).toBe('#ff0000');
    expect(s.euroGates).toBe(!DEFAULT_SETTINGS.euroGates);
    expect(s.mouseWheelEdit).toBe(!DEFAULT_SETTINGS.mouseWheelEdit);
  });
});

describe('ctrl-drag post movement undo', () => {
  it('collapses a multi-move post drag into one undo step', () => {
    const id = addResistor();
    const original = useStore.getState().elements[0];
    const commitsBefore = useStore.getState().undoStack.length;
    useStore.getState().commit();
    // Simulate pointer-move events for the dragged post.
    for (const [x, y] of [
      [16, 0],
      [32, 16],
      [48, 0],
    ]) {
      useStore.getState().updateElement(id, postPatch(2, x, y));
    }
    const dragged = useStore.getState().elements[0];
    expect(dragged.x2).toBe(48);
    expect(dragged.y2).toBe(0);
    expect(dragged.x1).toBe(original.x1);
    expect(dragged.y1).toBe(original.y1);
    // updateElement never pushes undo entries, so the single commit is the
    // whole drag: one undo restores the original geometry.
    expect(useStore.getState().undoStack.length).toBe(commitsBefore + 1);
    useStore.getState().undo();
    expect(useStore.getState().elements[0]).toEqual(original);
  });

  it('undo restores the dragged element\'s endpoints', () => {
    const id = addResistor();
    const original = useStore.getState().elements[0];
    useStore.getState().commit();
    // updateElement never pushes undo entries, so the single commit is the
    // whole drag: one undo restores the original geometry.
    useStore.getState().updateElement(id, postPatch(2, 0, 0));
    expect(useStore.getState().elements[0].x2).toBe(0);
    expect(useStore.getState().elements[0].y2).toBe(0);
    useStore.getState().undo();
    expect(useStore.getState().elements[0]).toEqual(original);
  });

  it('a rail free-end ctrl-drag moves only the control point, one undo step', () => {
    // The canvas handler enters dragpost with post 2 when ctrl-dragging the
    // far end (its draggablePosts is 2), so each move writes postPatch(2, ...)
    // and never touches the connection post.
    const id = useStore.getState().addElement({
      kind: 'rail',
      x1: 0,
      y1: 0,
      x2: 32,
      y2: 0,
      flags: 0,
      params: {},
    });
    const original = useStore.getState().elements[0];
    const commitsBefore = useStore.getState().undoStack.length;
    useStore.getState().commit();
    for (const [x, y] of [
      [48, 16],
      [64, 48],
    ]) {
      useStore.getState().updateElement(id, postPatch(2, x, y));
    }
    const dragged = useStore.getState().elements[0];
    expect(dragged.x2).toBe(64);
    expect(dragged.y2).toBe(48);
    expect(dragged.x1).toBe(original.x1);
    expect(dragged.y1).toBe(original.y1);
    expect(useStore.getState().undoStack.length).toBe(commitsBefore + 1);
    useStore.getState().undo();
    expect(useStore.getState().elements[0]).toEqual(original);
  });
});

describe('scope raw snapshot isolation', () => {
  const NETLIST = [
    '$ 1 0.000005 10 50 5 50 5e-11',
    'r 0 0 16 0 0 100',
    'o 0 64 0 266244 20 0.05 0 1 1 Ac\\sCoupled',
    '',
  ].join('\n');

  it('an in-place push to a live scope raw after a commit does not corrupt the undo snapshot', () => {
    useStore.getState().loadNetlist(NETLIST);
    const scope = useStore.getState().scopes[0];
    const original = [...scope.raw!];
    useStore.getState().commit();
    // The hypothetical future mutator writes raw in place, so the snapshot's
    // clone must not share the array.
    scope.raw!.push('extra');
    useStore.getState().undo();
    expect(useStore.getState().scopes[0].raw).toEqual(original);
  });
});

describe('scope family undo-restore', () => {
  // The six structural mutators commit() themselves (addScope, removeScope,
  // togglePlot, removePlot, combineScopes, separateScope) and so do the fast
  // path setters (setScopeSpeed/Trigger/Flags/ShowValue,
  // setPlotCoupling/ManScale/ManPosition): item 21 decided they are ordinary
  // property edits and must be undoable as their own step. One undo after
  // each restores the exact pre-mutation snapshot, so the tests below call
  // the setter without an explicit commit.

  const scoped = () => {
    const a = addResistor();
    const b = addResistor();
    useStore.getState().addScope(a, 'voltage');
    return { a, b };
  };

  it('addScope: undo restores the pre-add scope list', () => {
    const { b } = scoped();
    const pre = useStore.getState().scopes;
    const preElements = useStore.getState().elements;

    useStore.getState().addScope(b, 'current');
    expect(useStore.getState().scopes).toHaveLength(2);

    useStore.getState().undo();
    const s = useStore.getState();
    expect(s.scopes).toEqual(pre);
    expect(s.elements).toEqual(preElements);
  });

  it('removeScope: undo restores the removed scope', () => {
    scoped();
    const pre = useStore.getState().scopes;
    const preElements = useStore.getState().elements;

    useStore.getState().removeScope(useStore.getState().scopes[0].id);
    expect(useStore.getState().scopes).toHaveLength(0);

    useStore.getState().undo();
    const s = useStore.getState();
    expect(s.scopes).toEqual(pre);
    expect(s.elements).toEqual(preElements);
  });

  it('togglePlot: undo restores the toggled companion plot', () => {
    scoped();
    const scopeId = useStore.getState().scopes[0].id;
    const pre = useStore.getState().scopes;

    useStore.getState().togglePlot(scopeId, 'current');
    expect(useStore.getState().scopes[0].plots).toHaveLength(1);

    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);
    expect(useStore.getState().scopes[0].plots).toHaveLength(2);
  });

  it('removePlot: undo returns the removed plot', () => {
    scoped();
    const scopeId = useStore.getState().scopes[0].id;
    const pre = useStore.getState().scopes;

    useStore.getState().removePlot(scopeId, useStore.getState().scopes[0].plots[1].id);
    expect(useStore.getState().scopes[0].plots).toHaveLength(1);

    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);
    expect(useStore.getState().scopes[0].plots).toHaveLength(2);
  });

  it('combineScopes: undo restores both scopes', () => {
    const { b } = scoped();
    useStore.getState().addScope(b, 'current');
    const [sa, sb] = useStore.getState().scopes;
    const pre = useStore.getState().scopes;

    useStore.getState().combineScopes(sa.id, sb.id);
    expect(useStore.getState().scopes).toHaveLength(1);

    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);
  });

  it('separateScope: undo restores the combined scope', () => {
    const { b } = scoped();
    useStore.getState().addScope(b, 'current');
    const [sa, sb] = useStore.getState().scopes;
    useStore.getState().combineScopes(sa.id, sb.id);
    const pre = useStore.getState().scopes;
    expect(pre).toHaveLength(1);
    expect(pre[0].plots).toHaveLength(3); // a V, a I, b I

    useStore.getState().separateScope(useStore.getState().scopes[0].id);
    expect(useStore.getState().scopes).toHaveLength(2);

    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);
  });

  const fastPath = () => {
    scoped();
    const scopeId = useStore.getState().scopes[0].id;
    const plotId = useStore.getState().scopes[0].plots[0].id;
    // The pre-set snapshot the setter is expected to commit itself. No
    // explicit commit: each setter pushes one entry holding this state, so
    // the undo below restores it and not some earlier commit.
    const pre = useStore.getState().scopes;
    return { scopeId, plotId, pre };
  };

  it('setScopeSpeed commits itself; undo restores the pre-set speed', () => {
    const { scopeId, pre } = fastPath();
    const baseline = useStore.getState().undoStack.length;
    expect(useStore.getState().scopes[0].speed).toBe(64);

    useStore.getState().setScopeSpeed(scopeId, 128);
    expect(useStore.getState().scopes[0].speed).toBe(128);
    expect(useStore.getState().undoStack.length).toBe(baseline + 1);

    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);

    useStore.getState().redo();
    expect(useStore.getState().scopes[0].speed).toBe(128);
  });

  it('setScopeTrigger commits itself; undo restores the pre-set trigger', () => {
    const { scopeId, pre } = fastPath();
    const baseline = useStore.getState().undoStack.length;

    useStore.getState().setScopeTrigger(scopeId, { mode: 'normal', edge: 'falling', level: 2.5 });
    expect(useStore.getState().scopes[0].trigger).toEqual({
      mode: 'normal',
      edge: 'falling',
      level: 2.5,
    });
    expect(useStore.getState().undoStack.length).toBe(baseline + 1);

    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);

    useStore.getState().redo();
    expect(useStore.getState().scopes[0].trigger).toEqual({
      mode: 'normal',
      edge: 'falling',
      level: 2.5,
    });
  });

  it('setScopeFlags commits itself; undo restores the pre-set flags', () => {
    const { scopeId, pre } = fastPath();
    const baseline = useStore.getState().undoStack.length;

    useStore.getState().setScopeFlags(scopeId, {
      label: 'Renamed',
      manualScale: true,
      showMax: false,
    });
    const after = useStore.getState();
    expect(after.scopes[0].label).toBe('Renamed');
    expect(after.scopes[0].manualScale).toBe(true);
    expect(after.scopes[0].showMax).toBe(false);
    expect(after.undoStack.length).toBe(baseline + 1);

    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);

    useStore.getState().redo();
    expect(useStore.getState().scopes[0].label).toBe('Renamed');
  });

  it('setPlotCoupling commits itself; undo restores the pre-set coupling', () => {
    const { scopeId, plotId, pre } = fastPath();
    const baseline = useStore.getState().undoStack.length;

    useStore.getState().setPlotCoupling(scopeId, plotId, true);
    expect(useStore.getState().scopes[0].plots[0].acCoupled).toBe(true);
    expect(useStore.getState().undoStack.length).toBe(baseline + 1);

    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);

    useStore.getState().redo();
    expect(useStore.getState().scopes[0].plots[0].acCoupled).toBe(true);
  });

  it('setPlotManScale commits itself; undo restores the pre-set man scale', () => {
    const { plotId, pre } = fastPath();
    const baseline = useStore.getState().undoStack.length;

    useStore.getState().setPlotManScale(plotId, 2);
    expect(useStore.getState().scopes[0].plots[0].manScale).toBe(2);
    expect(useStore.getState().undoStack.length).toBe(baseline + 1);

    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);

    useStore.getState().redo();
    expect(useStore.getState().scopes[0].plots[0].manScale).toBe(2);
  });

  it('setPlotManPosition commits itself; undo restores the pre-set position', () => {
    const { plotId, pre } = fastPath();
    const baseline = useStore.getState().undoStack.length;

    useStore.getState().setPlotManPosition(plotId, 100);
    expect(useStore.getState().scopes[0].plots[0].manVPosition).toBe(100);
    expect(useStore.getState().undoStack.length).toBe(baseline + 1);

    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);

    useStore.getState().redo();
    expect(useStore.getState().scopes[0].plots[0].manVPosition).toBe(100);
  });

  it('setScopeShowValue commits itself; undo restores the hidden flag', () => {
    const { scopeId, pre } = fastPath();
    const baseline = useStore.getState().undoStack.length;
    expect(useStore.getState().scopes[0].showV).toBe(true);

    // Unchecking Show Voltage in the properties dialog is an ordinary
    // property edit and must be its own undo step, like every sibling setter.
    useStore.getState().setScopeShowValue(scopeId, 'voltage', false);
    expect(useStore.getState().scopes[0].showV).toBe(false);
    expect(useStore.getState().undoStack.length).toBe(baseline + 1);

    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);

    useStore.getState().redo();
    expect(useStore.getState().scopes[0].showV).toBe(false);
  });

  it("setScopeShowValue's addPlot branch commits itself; undo drops the added plot", () => {
    const { scopeId } = fastPath();
    useStore.getState().togglePlot(scopeId, 'current');
    // The stripped panel is the snapshot the setter must commit itself; no
    // explicit commit between here and the call under test.
    const pre = useStore.getState().scopes;
    const baseline = useStore.getState().undoStack.length;
    expect(useStore.getState().scopes[0].plots.map((p) => p.value)).toEqual(['voltage']);

    // Re-checking Show Current has no plot to reveal, so the branch adds one:
    // that plot lands on the same undo step as the flag.
    useStore.getState().setScopeShowValue(scopeId, 'current', true);
    const after = useStore.getState();
    expect(after.scopes[0].showI).toBe(true);
    expect(after.scopes[0].plots.map((p) => p.value)).toEqual(['voltage', 'current']);
    expect(after.undoStack.length).toBe(baseline + 1);

    after.undo();
    expect(useStore.getState().scopes).toEqual(pre);

    useStore.getState().redo();
    expect(useStore.getState().scopes[0].plots.map((p) => p.value)).toEqual([
      'voltage',
      'current',
    ]);
  });

  it('a no-op setter call commits nothing', () => {
    const { scopeId, plotId } = fastPath();
    const baseline = useStore.getState().undoStack.length;

    // Every value below already equals the scope's state, so each setter must
    // bail before its commit: a drag frame or wheel tick that changes nothing
    // must not grow the undo stack.
    useStore.getState().setScopeSpeed(scopeId, 64);
    useStore.getState().setScopeTrigger(scopeId, { mode: 'freeRun', edge: 'rising', level: 0 });
    useStore.getState().setScopeFlags(scopeId, { showMax: true, label: '' });
    useStore.getState().setPlotCoupling(scopeId, plotId, false);
    useStore.getState().setPlotManScale(plotId, null);
    useStore.getState().setPlotManPosition(plotId, 0);
    useStore.getState().setScopeShowValue(scopeId, 'voltage', true);
    useStore.getState().setScopeShowValue(scopeId, 'current', true);

    expect(useStore.getState().undoStack.length).toBe(baseline);
  });
});

describe('caller-bracketed undo: setText, setModelName', () => {
  // These two setters do not commit themselves: setText and setModelName are
  // plain `set` calls (store.ts:1176,1073). Their undo baseline is the
  // caller's beginEdit, the edit dialog's onFocus on the field
  // (OptionsPanel.tsx:76,92,158), so each test opens that session with an
  // explicit commit before mutating and asserts one undo restores the exact
  // pre-mutation snapshot. A regression that drops the caller's commit would
  // make these undos restore an older state, so the pre-mutation equality
  // assertion is the thing under test. loadDataFile used to live here too but
  // now commits itself at the apply point (store.ts:1284), so it is tested in
  // the file-load undo block below instead.

  it('setText on a display-only decoration: undo restores the pre-mutation text', () => {
    const id = useStore.getState().addElement({
      kind: 'decoration',
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 0,
      flags: 0,
      params: { size: 12 },
      text: 'old',
    });
    // The caller's beginEdit, the dialog field's onFocus.
    useStore.getState().commit();
    const pre = useStore.getState().elements.find((e) => e.id === id);

    useStore.getState().setText(id, 'new text');
    expect(useStore.getState().elements.find((e) => e.id === id)?.text).toBe('new text');

    useStore.getState().undo();
    expect(useStore.getState().elements.find((e) => e.id === id)).toEqual(pre);
  });

  it('setText on a labeled node (the reload path): undo restores text and revision', () => {
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
    useStore.getState().commit();
    const pre = useStore.getState().elements.find((e) => e.id === id);
    const preRevision = useStore.getState().revision;

    useStore.getState().setText(id, 'B');
    expect(useStore.getState().elements.find((e) => e.id === id)?.text).toBe('B');
    expect(useStore.getState().revision).toBeGreaterThan(preRevision);

    useStore.getState().undo();
    const s = useStore.getState();
    expect(s.elements.find((e) => e.id === id)).toEqual(pre);
    // Undo itself bumps revision (store.ts:1985) to force an engine rebuild,
    // on top of the reload bump setText took, so the restored revision is
    // higher than the pre-mutation value; the element is what undo restores,
    // not the revision.
    expect(s.revision).toBeGreaterThan(preRevision);
  });

  it('setModelName: undo restores the pre-mutation model name and params', () => {
    const [loaded] = parseCircuit('d 176 80 384 80 2 1N4148').elements;
    useStore.getState().addElement(loaded);
    const id = useStore.getState().elements[0].id;
    useStore.getState().commit();
    const pre = useStore.getState().elements[0];
    expect(pre.modelName).toBe('1N4148');

    useStore.getState().setModelName(id, '1N4004');
    expect(useStore.getState().elements[0].modelName).toBe('1N4004');
    expect(useStore.getState().elements[0].params.saturationCurrent).toBe(18.8e-9);

    useStore.getState().undo();
    const e = useStore.getState().elements[0];
    expect(e.modelName).toBe('1N4148');
    expect(e).toEqual(pre);
  });
});

describe('file-load undo: the store action takes the baseline', () => {
  // loadAudioFile and loadDataFile commit themselves at the apply point
  // (store.ts:1267,1284), not on the file input's onFocus: the read and decode
  // are async, so an edit the user makes while they run must land on its own
  // undo step, and a decode that never completes must leave no entry. The
  // caller (OptionsPanel loadFileInto) never touches the undo stack.

  const DATA_INPUT = {
    kind: 'dataInput' as const,
    x1: 0,
    y1: 0,
    x2: 64,
    y2: 0,
    flags: 16,
    params: {
      waveform: 1,
      frequency: 60,
      maxVoltage: 5,
      bias: 0,
      phaseShift: 0,
      dutyCycle: 0.5,
      sampleLength: 1e-3,
      scaleFactor: 1,
      fileNum: 0,
    },
  };

  beforeEach(() => clearSampleCache());

  it('loadDataFile: undo restores the pre-mutation fileNum and label', () => {
    const id = useStore.getState().addElement(DATA_INPUT);
    // The action's own commit is the first load's baseline; no explicit commit
    // like the caller-bracketed setters above.
    useStore.getState().loadDataFile(id, [1.0], 'first');
    const pre = useStore.getState().elements.find((e) => e.id === id);
    const preFileNum = pre!.params.fileNum as number;

    useStore.getState().loadDataFile(id, [2.0], 'second');
    const after = useStore.getState().elements.find((e) => e.id === id);
    expect(after?.text).toBe('second');
    const afterFileNum = after!.params.fileNum as number;
    expect(afterFileNum).not.toBe(preFileNum);
    expect(getDataSamples(afterFileNum)).toEqual({ samples: [2.0] });

    useStore.getState().undo();
    const restored = useStore.getState().elements.find((e) => e.id === id);
    expect(restored?.text).toBe('first');
    expect(restored?.params.fileNum).toBe(preFileNum);
    // The old cache entry is deliberately kept (sampleCache.ts:9-11), so the
    // restored fileNum still resolves to the first file.
    expect(getDataSamples(restored?.params.fileNum as number)).toEqual({ samples: [1.0] });
  });

  it('a file load landing after an unrelated edit undoes as two separate steps', () => {
    const rid = addResistor();
    const id = useStore.getState().addElement(DATA_INPUT);
    const preResistor = useStore.getState().elements.find((e) => e.id === rid);

    // The file input commits nothing on focus, so starting the async load
    // leaves the stack alone. While the decode is in flight the user edits
    // the resistor; that field's onFocus commit is the pre-edit baseline.
    const commitsBefore = useStore.getState().undoStack.length;
    useStore.getState().commit();
    expect(useStore.getState().undoStack.length).toBe(commitsBefore + 1);
    useStore.getState().setParam(rid, 'resistance', 2200);
    expect(useStore.getState().elements.find((e) => e.id === rid)?.params.resistance).toBe(2200);

    // The decode lands: the store action commits the current state (the
    // resistor edit already applied) before applying the samples, so the two
    // edits get separate undo steps instead of folding into one.
    useStore.getState().loadDataFile(id, [2.0], 'second');
    expect(useStore.getState().elements.find((e) => e.id === id)?.text).toBe('second');

    // First undo reverts only the file load; the unrelated edit survives.
    useStore.getState().undo();
    const one = useStore.getState();
    expect(one.elements.find((e) => e.id === id)?.text).toBeUndefined();
    expect(one.elements.find((e) => e.id === rid)?.params.resistance).toBe(2200);

    // Second undo reverts the unrelated edit back to the pre-gesture element.
    useStore.getState().undo();
    expect(useStore.getState().elements.find((e) => e.id === rid)).toEqual(preResistor);
  });

  it('a failed decode leaves no spurious undo entry', () => {
    const id = useStore.getState().addElement(DATA_INPUT);
    const commitsBefore = useStore.getState().undoStack.length;
    const pre = useStore.getState().elements.find((e) => e.id === id);

    // The failure happens entirely in the caller (OptionsPanel loadFileInto):
    // the reader errors or decodeAudioFile rejects, the caller alerts and
    // never invokes loadDataFile/loadAudioFile. Because the baseline lives in
    // the store action and not on the file input's onFocus, an aborted load
    // pushes nothing: the stack is exactly where addElement left it.
    expect(useStore.getState().undoStack.length).toBe(commitsBefore);
    expect(useStore.getState().elements.find((e) => e.id === id)).toEqual(pre);

    // One undo still steps straight back over addElement, not over a phantom
    // entry the failed load would have left behind.
    useStore.getState().undo();
    expect(useStore.getState().elements.length).toBe(0);
  });
});

describe('unblowFuses is a run-mode reset, not an undoable edit', () => {
  // FINDING: unblowFuses is NOT undoable in the current design. It commits
  // nothing itself (store.ts:1279) and its only caller, the Reset command
  // (Menubar.tsx:654-666), commits nothing either: engine.reset() rewinds the
  // runtime state in place and unblowFuses just drops the store's live copies
  // of that reset. Like a switch toggle, reset is a run-mode action with no
  // undo entry (types.ts:340-344). A test that asserted "undo restores the
  // blown fuse" would pin a contract the code does not have, so this test pins
  // the actual behaviour: the blown-and-unblown sequence never reaches the
  // undo stack.

  it('pushes no undo entry, so undo cannot restore a blown fuse', () => {
    const fuseId = useStore.getState().addElement({
      kind: 'fuse',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { resistance: 0.0613, i2t: 6.73 },
    });
    useStore.getState().commit();
    useStore.getState().setElementState(fuseId, 1);
    expect(useStore.getState().elements.find((e) => e.id === fuseId)?.state).toBe(1);
    const baseline = useStore.getState().undoStack.length;

    useStore.getState().unblowFuses();
    const after = useStore.getState();
    expect(after.elements.find((e) => e.id === fuseId)?.state).toBe(0);
    expect(after.pendingStates.has(fuseId)).toBe(false);
    // No commit anywhere on the Reset path, so the stack does not grow.
    expect(after.undoStack.length).toBe(baseline);

    // Undo restores the last committed snapshot (the intact fuse); the
    // transient blown state was never committed, so it is unreachable. The
    // snapshot predates setElementState, so the restored fuse has no `state`
    // key at all, which the engine reads as intact.
    useStore.getState().undo();
    expect(useStore.getState().elements.find((e) => e.id === fuseId)?.state).toBeUndefined();
  });
});

describe('revertToBaseline: the collapse guards revert', () => {
  // The zero-length collapse guards (a post drag onto its partner, a row or
  // column sweep that folds both posts together) refuse the collapsed geometry
  // by reverting to the drag's baseline. A plain undo() would push that
  // refused state onto the redo stack, so an immediate Ctrl+Y resurrects
  // exactly the degenerate element the guard exists to prevent. The revert
  // must restore the top snapshot while leaving the redo future empty.

  it('restores the baseline and stages no redo future', () => {
    const id = addResistor();
    const original = useStore.getState().elements[0];
    useStore.getState().commit();
    useStore.getState().updateElement(id, { x2: 0, y2: 0 }); // the refused collapse
    expect(useStore.getState().elements[0].x2).toBe(0);

    useStore.getState().revertToBaseline();

    expect(useStore.getState().elements[0]).toEqual(original);
    expect(useStore.getState().redoStack).toEqual([]);

    // Ctrl+Y after the refusal brings nothing back.
    useStore.getState().redo();
    expect(useStore.getState().elements[0]).toEqual(original);
  });

  it('with an empty undo stack is a safe no-op', () => {
    // Nothing committed yet: there is no baseline to restore and nothing to
    // refuse, so the call must leave the circuit alone.
    useStore.getState().revertToBaseline();

    expect(useStore.getState().elements).toEqual([]);
    expect(useStore.getState().redoStack).toEqual([]);
  });
});

describe('run-mode mutations kill the stale redo future', () => {
  // toggleSwitchByKey, unblowFuses and updateSettings mutate without pushing
  // an undo entry, and switch throws, fuse state and settings all ride the
  // snapshots. A redo future left standing over such a mutation would rewind
  // it along with everything else on Ctrl+Shift+Z, so each action truncates
  // the future while staying entry-free, matching the commit-per-pointer-
  // toggle rule the pointer path already follows.

  const addKeyedSwitch = () =>
    useStore.getState().addElement({
      kind: 'switch',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { position: 0 },
      state: 0,
      keyShortcut: 'k',
    });

  const addFuse = () =>
    useStore.getState().addElement({
      kind: 'fuse',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { resistance: 0.0613, i2t: 6.73 },
    });

  const addKeyedMomentary = () =>
    useStore.getState().addElement({
      kind: 'switch',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      // Resting open, like the pointer tests' momentary: position 1, thrown.
      params: { position: 1, momentary: 1 },
      state: 1,
      keyShortcut: 'm',
    });

  it('a keyboard throw truncates the future, so a later redo cannot rewind it', () => {
    const id = addKeyedSwitch();
    useStore.getState().commit();
    useStore.getState().updateElement(id, { x2: 320 });
    useStore.getState().undo();
    expect(useStore.getState().redoStack.length).toBe(1);

    expect(useStore.getState().toggleSwitchByKey('k')).toBe(true);
    expect(useStore.getState().elements[0].state).toBe(1);
    expect(useStore.getState().redoStack).toEqual([]);

    // The rewound throw must not come back on Ctrl+Shift+Z.
    useStore.getState().redo();
    expect(useStore.getState().elements[0].state).toBe(1);
  });

  it('unblowFuses truncates the future without taking an undo entry', () => {
    const id = addFuse();
    useStore.getState().commit();
    useStore.getState().updateElement(id, { x2: 320 });
    useStore.getState().undo();
    const baseline = useStore.getState().undoStack.length;
    useStore.getState().setElementState(id, 1);
    expect(useStore.getState().elements.find((e) => e.id === id)?.state).toBe(1);
    expect(useStore.getState().redoStack.length).toBe(1);

    useStore.getState().unblowFuses();
    expect(useStore.getState().elements.find((e) => e.id === id)?.state).toBe(0);
    expect(useStore.getState().redoStack).toEqual([]);
    // Still a run-mode reset: the undo past is untouched.
    expect(useStore.getState().undoStack.length).toBe(baseline);

    useStore.getState().redo();
    expect(useStore.getState().elements.find((e) => e.id === id)?.state).toBe(0);
  });

  it('setKeyShortcut truncates the future without taking an undo entry', () => {
    // The assignment rides every snapshot yet takes no undo entry, so a redo
    // future left standing would rewind it silently along with everything
    // else on Ctrl+Shift+Z.
    const id = addKeyedSwitch();
    useStore.getState().commit();
    useStore.getState().updateElement(id, { x2: 320 });
    useStore.getState().undo();
    expect(useStore.getState().redoStack.length).toBe(1);
    const baseline = useStore.getState().undoStack.length;

    useStore.getState().setKeyShortcut(id, 'j');
    expect(useStore.getState().elements.find((e) => e.id === id)?.keyShortcut).toBe('j');
    expect(useStore.getState().redoStack).toEqual([]);
    expect(useStore.getState().undoStack.length).toBe(baseline);

    // The rewound assignment must not come back on Ctrl+Shift+Z.
    useStore.getState().redo();
    expect(useStore.getState().elements.find((e) => e.id === id)?.keyShortcut).toBe('j');
  });

  it('a repeated identical shortcut changes nothing and leaves the future alone', () => {
    // A no-op write must not kill a redo future behind it, matching the
    // no-op guards the other entry-free mutations carry.
    const id = addKeyedSwitch(); // already 'k'
    useStore.getState().commit();
    useStore.getState().updateElement(id, { x2: 320 });
    useStore.getState().undo();
    expect(useStore.getState().redoStack.length).toBe(1);

    useStore.getState().setKeyShortcut(id, 'K'); // normalises to the stored k

    expect(useStore.getState().elements.find((e) => e.id === id)?.keyShortcut).toBe('k');
    expect(useStore.getState().redoStack.length).toBe(1);
  });

  it('updateSettings kills the future but stays entry-free', () => {
    const id = addResistor();
    useStore.getState().commit();
    useStore.getState().setParam(id, 'resistance', 2200);
    useStore.getState().undo();
    expect(useStore.getState().redoStack.length).toBe(1);
    const baseline = useStore.getState().undoStack.length;

    useStore.getState().updateSettings({ voltageRange: 5 });
    expect(useStore.getState().settings.voltageRange).toBe(5);
    expect(useStore.getState().redoStack).toEqual([]);
    expect(useStore.getState().undoStack.length).toBe(baseline);

    // The no-op redo leaves both the settings write and the undone edit alone.
    useStore.getState().redo();
    expect(useStore.getState().settings.voltageRange).toBe(5);
    expect(useStore.getState().elements.find((e) => e.id === id)?.params.resistance).toBe(1000);
  });

  it('a momentary key release kills the future like its keydown did', () => {
    const id = addKeyedMomentary();
    useStore.getState().commit();
    useStore.getState().updateElement(id, { x2: 320 });
    useStore.getState().undo();
    const baseline = useStore.getState().undoStack.length;

    // Keydown throws entry-free and truncates, exactly like the plain switch
    // test above.
    expect(useStore.getState().toggleSwitchByKey('m')).toBe(true);
    expect(useStore.getState().elements.find((e) => e.id === id)?.state).toBe(0);
    expect(useStore.getState().redoStack).toEqual([]);

    // An undo landing while the key is still down stages a fresh future over
    // which the keyup's release would otherwise ride free.
    useStore.getState().commit();
    useStore.getState().updateElement(id, { x2: 480 });
    useStore.getState().undo();
    expect(useStore.getState().redoStack.length).toBe(1);

    useStore.getState().releaseMomentaryByKey('m');
    expect(useStore.getState().elements.find((e) => e.id === id)?.state).toBe(1);
    expect(useStore.getState().redoStack).toEqual([]);
    // Both halves stay run-mode actions: no entry anywhere.
    expect(useStore.getState().undoStack.length).toBe(baseline);
    useStore.getState().redo();
    expect(useStore.getState().elements.find((e) => e.id === id)?.state).toBe(1);
  });
});

describe('context menu state', () => {
  it('openContextMenu stores coordinates, the circuit point and an element target', () => {
    useStore.getState().openContextMenu(10, 20, 7, { x: 3, y: 4 });
    expect(useStore.getState().contextMenu).toEqual({
      x: 10,
      y: 20,
      target: 7,
      circuit: { x: 3, y: 4 },
      focusSearch: false,
    });
  });

  it('openContextMenu over empty canvas stores a null target', () => {
    useStore.getState().openContextMenu(5, 6, null, { x: 0, y: 0 });
    expect(useStore.getState().contextMenu).toEqual({
      x: 5,
      y: 6,
      target: null,
      circuit: { x: 0, y: 0 },
      focusSearch: false,
    });
  });

  it("the '/' key's open asks for the search box to take focus", () => {
    // The keyboard path has no pointer and no click, so the menu has to land
    // the caret in the element search itself; a right-click must not.
    useStore.getState().openContextMenu(5, 6, null, { x: 0, y: 0 }, true);
    expect(useStore.getState().contextMenu?.focusSearch).toBe(true);
    useStore.getState().openContextMenu(5, 6, null, { x: 0, y: 0 });
    expect(useStore.getState().contextMenu?.focusSearch).toBe(false);
  });

  it('closeContextMenu clears it', () => {
    useStore.getState().openContextMenu(10, 20, 7, { x: 3, y: 4 });
    useStore.getState().closeContextMenu();
    expect(useStore.getState().contextMenu).toBeNull();
  });

  it('opening twice replaces rather than stacks', () => {
    useStore.getState().openContextMenu(10, 20, 1, { x: 0, y: 0 });
    useStore.getState().openContextMenu(30, 40, null, { x: 9, y: 8 });
    expect(useStore.getState().contextMenu).toEqual({
      x: 30,
      y: 40,
      target: null,
      circuit: { x: 9, y: 8 },
      focusSearch: false,
    });
  });

  it('right-clicking an element outside the selection selects it alone', () => {
    const a = addResistor();
    const b = addCapacitor();
    useStore.getState().select([b]);
    useStore.getState().openContextMenu(10, 20, a, { x: 0, y: 0 });
    expect(useStore.getState().selectedIds).toEqual([a]);
    expect(useStore.getState().contextMenu?.target).toBe(a);
  });

  it('right-clicking an element already selected keeps the whole selection', () => {
    const a = addResistor();
    const b = addCapacitor();
    useStore.getState().select([a, b]);
    useStore.getState().openContextMenu(10, 20, a, { x: 0, y: 0 });
    expect(useStore.getState().selectedIds).toEqual([a, b]);
  });

  it('right-clicking empty canvas leaves the selection untouched', () => {
    const a = addResistor();
    useStore.getState().select([a]);
    useStore.getState().openContextMenu(10, 20, null, { x: 0, y: 0 });
    expect(useStore.getState().selectedIds).toEqual([a]);
    expect(useStore.getState().contextMenu?.target).toBeNull();
  });

  it('a right-click while an element gesture is armed opens the menu but keeps the selection', () => {
    // Upstream's mousedown returns before mouseSelect for anything but left
    // or middle (MouseManager.java:1071-1075): a click that lands mid-drag
    // must not rewrite what the drag is moving. The menu itself still opens.
    const a = addResistor();
    const b = addCapacitor();
    const c = addResistor();
    useStore.getState().select([a, b]);
    useStore.getState().beginElementGesture('move');
    useStore.getState().openContextMenu(10, 20, c, { x: 0, y: 0 });
    expect(useStore.getState().contextMenu?.target).toBe(c);
    expect(useStore.getState().selectedIds).toEqual([a, b]);
  });

  it('with no gesture armed the select-alone rule applies as before', () => {
    const a = addResistor();
    const b = addCapacitor();
    const c = addResistor();
    useStore.getState().select([a, b]);
    useStore.getState().beginElementGesture('move');
    useStore.getState().endElementGesture();
    useStore.getState().openContextMenu(10, 20, c, { x: 0, y: 0 });
    expect(useStore.getState().selectedIds).toEqual([c]);
  });

  it('selectAll selects every element', () => {
    addResistor();
    addCapacitor();
    useStore.getState().selectAll();
    expect(useStore.getState().selectedIds).toHaveLength(2);
  });
});

describe('unsaved-changes guard', () => {
  const SAMPLE = `$ 1 0.000005 10.2 50 5 43 5e-11
r 176 96 384 96 0 1000
`;

  const loadSample = () => useStore.getState().loadNetlist(SAMPLE);

  /** True when the current circuit differs from the last export baseline. */
  const dirty = () => {
    const s = useStore.getState();
    return hasUnsavedChanges(s.lastSaved, s.toNetlist());
  };

  it('a fresh load is clean', () => {
    loadSample();
    expect(dirty()).toBe(false);
  });

  it('save then edit dirties', () => {
    loadSample();
    useStore.getState().markSaved();
    addResistor();
    expect(dirty()).toBe(true);
  });

  it('save after editing cleans', () => {
    loadSample();
    addResistor();
    useStore.getState().markSaved();
    expect(dirty()).toBe(false);
  });

  it('undo to the saved state is clean', () => {
    loadSample();
    useStore.getState().markSaved();
    addResistor();
    expect(dirty()).toBe(true);
    useStore.getState().undo();
    expect(dirty()).toBe(false);
  });

  it('serialised settings dirty, display-only ones do not', () => {
    loadSample();
    useStore.getState().markSaved();
    useStore.getState().updateSettings({ timeStep: 1e-5 });
    expect(dirty()).toBe(true);
    useStore.getState().markSaved();
    useStore.getState().updateSettings({ showGrid: false });
    expect(dirty()).toBe(false);
  });

  it('newCircuit is clean', () => {
    loadSample();
    useStore.getState().newCircuit();
    expect(dirty()).toBe(false);
  });

  it('null baseline never warns', () => {
    expect(hasUnsavedChanges(null, 'anything')).toBe(false);
  });
});

describe('redo machinery', () => {
  it('a new edit after an undo clears the redo stack', () => {
    addResistor();
    useStore.getState().commit();
    useStore.getState().undo();
    addResistor();
    expect(useStore.getState().redoStack).toEqual([]);
  });

  it('a dedup commit (snapshot equal to the current state) clears the redo stack', () => {
    // Two undos and one redo leave the current state equal to the top of the
    // undo stack again, so this commit hits commit's dedup branch
    // (store.ts:588) while the redo stack is still populated.
    addResistor();
    useStore.getState().commit();
    useStore.getState().undo();
    useStore.getState().undo();
    useStore.getState().redo();
    useStore.getState().commit();
    expect(useStore.getState().redoStack).toEqual([]);
  });

  it('redo on an empty stack is a safe no-op', () => {
    addResistor();
    const elements = useStore.getState().elements;
    useStore.getState().redo();
    expect(useStore.getState().elements).toBe(elements);
  });

  it('pushing more than UNDO_LIMIT commits drops the oldest', () => {
    // UNDO_LIMIT is 100 (store.ts:201). 110 adds commit 110 pre-add states;
    // the slice keeps the newest 100, so after 100 undos ten resistors remain
    // and the first ten pre-add states are unreachable.
    for (let i = 0; i < 110; i++) addResistor();
    for (let i = 0; i < 100; i++) useStore.getState().undo();
    expect(useStore.getState().elements).toHaveLength(10);
  });

  it('undo bumps the revision', () => {
    addResistor();
    useStore.getState().commit();
    const before = useStore.getState().revision;
    useStore.getState().undo();
    expect(useStore.getState().revision).toBeGreaterThan(before);
  });

  it('redo bumps the revision', () => {
    addResistor();
    useStore.getState().commit();
    useStore.getState().undo();
    const before = useStore.getState().revision;
    useStore.getState().redo();
    expect(useStore.getState().revision).toBeGreaterThan(before);
  });

  it('undo clears the selection', () => {
    const id = addResistor();
    useStore.getState().commit();
    useStore.getState().select([id]);
    useStore.getState().undo();
    expect(useStore.getState().selectedIds).toEqual([]);
  });

  it('redo clears the selection', () => {
    const id = addResistor();
    useStore.getState().commit();
    useStore.getState().select([id]);
    useStore.getState().undo();
    useStore.getState().select([id]);
    useStore.getState().redo();
    expect(useStore.getState().selectedIds).toEqual([]);
  });

  it('newCircuit wipes the undo and redo stacks', () => {
    addResistor();
    useStore.getState().commit();
    useStore.getState().undo();
    useStore.getState().newCircuit();
    expect(useStore.getState().undoStack).toHaveLength(0);
    expect(useStore.getState().redoStack).toHaveLength(0);
  });
});

describe('commit fingerprint cache', () => {
  it('a deduping commit reuses the pushed snapshot key instead of restringifying it', () => {
    addResistor();
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      // The baseline push stringifies the live state once to fingerprint it.
      useStore.getState().commit();
      const afterBaseline = useStore.getState().undoStack.length;
      // A second commit with nothing changed must compare against the top
      // through the push-time cache: one further stringify (the live state),
      // never two. On SRAM/ROM sheets each avoided pass is about a megabyte
      // of flat addrN/valN keys.
      useStore.getState().commit();
      expect(stringify).toHaveBeenCalledTimes(2);
      expect(useStore.getState().undoStack).toHaveLength(afterBaseline);
    } finally {
      stringify.mockRestore();
    }
  });

  it('dedup stays content-based across undo and redo pushes', () => {
    // Undo and redo push their own clones onto the opposite stack without a
    // computed key; the first later comparison must fingerprint them by
    // content, so an equal state still dedups byte-identically.
    addResistor();
    useStore.getState().commit();
    const commitsAfterAdd = useStore.getState().undoStack.length;
    useStore.getState().undo();
    useStore.getState().redo();
    useStore.getState().commit();
    expect(useStore.getState().undoStack).toHaveLength(commitsAfterAdd);
  });
});

describe('stale transient state', () => {
  it('undo clears the hover like loadNetlist does', () => {
    const id = addResistor();
    useStore.getState().commit();
    useStore.getState().setHovered(id);
    useStore.getState().undo();
    expect(useStore.getState().hoveredId).toBeNull();
  });

  it('redo clears the hover too', () => {
    const id = addResistor();
    useStore.getState().commit();
    useStore.getState().undo();
    useStore.getState().setHovered(id);
    useStore.getState().redo();
    expect(useStore.getState().hoveredId).toBeNull();
  });
});

describe('the revert epoch', () => {
  it('undo and redo each bump the revert epoch', () => {
    addResistor();
    expect(useStore.getState().revertEpoch).toBe(0);
    useStore.getState().undo();
    expect(useStore.getState().revertEpoch).toBe(1);
    // Redo is the same revert to a live gesture: symmetric bump, tested not
    // special-cased.
    useStore.getState().redo();
    expect(useStore.getState().revertEpoch).toBe(2);
  });

  it('successive undos keep climbing, never rewound by the restored snapshot', () => {
    addResistor();
    useStore.getState().commit();
    addCapacitor();
    useStore.getState().commit();
    useStore.getState().undo();
    const first = useStore.getState().revertEpoch;
    useStore.getState().undo();
    expect(useStore.getState().revertEpoch).toBe(first + 1);
  });

  it('the revert epoch does not ride undo snapshots', () => {
    addResistor();
    useStore.getState().commit();
    useStore.getState().undo();
    // The counter lives outside Snapshot on purpose: undo's {...prev} spread
    // must never carry an old value back over the fresh bump.
    expect('revertEpoch' in useStore.getState().undoStack[0]).toBe(false);
    expect('revertEpoch' in useStore.getState().redoStack[0]).toBe(false);
  });

  it('a revertToBaseline collapse guard bumps it through undo', () => {
    const id = addResistor();
    useStore.getState().commit();
    useStore.getState().updateElement(id, { x2: 0, y2: 0 }); // the refused collapse
    const before = useStore.getState().revertEpoch;
    useStore.getState().revertToBaseline();
    expect(useStore.getState().revertEpoch).toBe(before + 1);
  });

  it('a loadNetlist document replacement bumps it', () => {
    const before = useStore.getState().revertEpoch;
    useStore.getState().loadNetlist('$ 1 0.000005 10 50 5\nr 0 0 160 0 0 1000\n');
    expect(useStore.getState().revertEpoch).toBe(before + 1);
  });

  it('New bumps it like any other wholesale replacement', () => {
    addResistor();
    const before = useStore.getState().revertEpoch;
    useStore.getState().newCircuit();
    expect(useStore.getState().revertEpoch).toBe(before + 1);
  });

  it('a refused load leaves it alone: nothing was replaced', () => {
    useStore.getState().loadNetlist('$ 1 0.000005 10 50 5\nr 0 0 160 0 0 1000\n');
    const before = useStore.getState().revertEpoch;
    // The truncated-XML shape the loaderror suite uses: parseCircuit throws
    // on it, so the early return fires before any state moves.
    expect(useStore.getState().loadNetlist('<cir name="broken">\n<r x="1"/>\n')).not.toBeNull();
    expect(useStore.getState().revertEpoch).toBe(before);
  });

  it('an ordinary parameter edit never bumps it', () => {
    const id = addResistor();
    useStore.getState().commit();
    const before = useStore.getState().revertEpoch;
    useStore.getState().updateElement(id, { params: { resistance: 470 } });
    useStore.getState().commit();
    expect(useStore.getState().revertEpoch).toBe(before);
  });
});
