import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../model/types';
import type { CompositeEngineSpec, CustomLogicModel } from '../io/netlist/types';
import {
  UNDO_LIMIT,
  abort,
  begin,
  canRedo,
  canUndo,
  checkpoint,
  clearFuture,
  clone,
  emptyHistory,
  end,
  pushExternal,
  redoLabel,
  snapshotKey,
  stepBack,
  stepForward,
  undoLabel,
  type History,
} from './history';
import type { Snapshot } from './types';

/** A snapshot with every nested shape the history owns, so the clone table
 *  below has something to mutate. Deliberately not typed field by field: the
 *  point is the data, and a compile error here would not catch a missing
 *  clone line the way the table does. */
const baseSnapshot = (): Snapshot =>
  ({
    elements: [
      {
        id: 1,
        kind: 'wire',
        x1: 0,
        y1: 0,
        x2: 16,
        y2: 0,
        flags: 0,
        params: { resistance: 1 },
        route: [
          [0, 0],
          [8, 8],
        ],
      },
      {
        id: 2,
        kind: 'scope',
        x1: 0,
        y1: 0,
        x2: 16,
        y2: 16,
        flags: 0,
        params: {},
        embedded: {
          tokens: ['1', '64'],
          plots: [{ id: 1, elementId: 2, value: 'voltage' }],
          display: {
            speed: 64,
            position: 0,
            perPlot: [{ acCoupled: false, manScale: null, manVPosition: 0, measurements: null }],
            showScale: false,
          },
        },
      },
      {
        id: 3,
        kind: 'customLogic',
        x1: 0,
        y1: 0,
        x2: 0,
        y2: 0,
        flags: 0,
        params: {},
        model: {
          name: 'logic',
          flags: 0,
          inputs: ['a'],
          outputs: ['b'],
          infoText: 'info',
          rules: 'a=b',
          rulesLeft: ['a'],
          rulesRight: ['b'],
          triState: false,
        },
      },
      {
        id: 4,
        kind: 'customComposite',
        x1: 0,
        y1: 0,
        x2: 0,
        y2: 0,
        flags: 0,
        params: {},
        model: { model: 'ResistorElm 1 2', external: [1, 2], dumps: ['r 0 0 16 0'] },
      },
      {
        id: 5,
        kind: 'ota',
        x1: 0,
        y1: 0,
        x2: 0,
        y2: 0,
        flags: 0,
        params: {},
        model: ['rail', 'transistor'],
      },
      {
        id: 6,
        kind: 'battery',
        x1: 0,
        y1: 0,
        x2: 0,
        y2: 0,
        flags: 0,
        params: {},
        model: '0,100:3.7',
      },
    ],
    scopes: [
      {
        id: 10,
        raw: ['64', '0'],
        plots: [
          {
            id: 11,
            elementId: 1,
            value: 'voltage',
            manScale: null,
            manVPosition: 0,
            acCoupled: false,
            measurements: {
              showScale: true,
              showMax: false,
              showMin: false,
              showP2P: false,
              showFreq: false,
              showRMS: false,
              showAverage: false,
              showDutyCycle: false,
              showPhaseAngle: false,
            },
            origValueToken: null,
            origElementIndex: null,
          },
        ],
        speed: 64,
        position: 0,
        manualScale: false,
        maxScale: false,
        label: '',
        manDivisions: 8,
        showScale: false,
        showMax: true,
        showMin: false,
        showP2P: false,
        showFreq: false,
        showRMS: false,
        showAverage: false,
        showDutyCycle: false,
        fftPlot: false,
        logSpectrum: false,
        plotXY: false,
        plotX: 0,
        plotY: 1,
        plotBrightness: -1,
        plotColorR: -1,
        plotColorG: -1,
        plotColorB: -1,
        showPhaseAngle: false,
        trailPersistence: 0,
        showElmInfo: false,
        showI: true,
        showV: true,
        scaleV: 20,
        scaleA: 0.05,
        trigger: { mode: 'normal', edge: 'falling', level: 2.5 },
      },
    ],
    sliders: [
      {
        id: 20,
        elementId: 1,
        editItem: 0,
        min: 1,
        max: 1000,
        step: 0,
        text: 'Resistance',
        logarithmic: false,
        shared: null,
        raw: ['e', 'F0'],
      },
    ],
    settings: { ...DEFAULT_SETTINGS },
    view: { x: 1, y: 2, scale: 3 },
    passthrough: ['. model 0 1 1 4', '! logic'],
    order: [{ kind: 'other', line: '. model 0 1 1 4' }],
    unmatchedScopes: [
      {
        id: 30,
        elementIndex: 99,
        raw: ['64', '0'],
        plots: [{ id: 31, elementIndex: 99, valueToken: 1, value: null }],
      },
    ],
  }) as unknown as Snapshot;

const withUndo = (...labels: string[]): History => {
  let h = emptyHistory();
  labels.forEach((label, i) => {
    const snap = baseSnapshot();
    snap.view.x = i;
    h = checkpoint(h, snap, label);
  });
  return h;
};

describe('checkpoint', () => {
  it('pushes one entry carrying the label and source', () => {
    const h = checkpoint(emptyHistory(), baseSnapshot(), 'Add Resistor', 'agent');
    expect(h.undo).toHaveLength(1);
    expect(h.undo[0].label).toBe('Add Resistor');
    expect(h.undo[0].source).toBe('agent');
    expect(h.redo).toHaveLength(0);
  });

  it('defaults the source to user', () => {
    const h = checkpoint(emptyHistory(), baseSnapshot(), 'Move');
    expect(h.undo[0].source).toBe('user');
  });

  it('does not grow on an unchanged fingerprint but still clears redo', () => {
    const a = baseSnapshot();
    const b = baseSnapshot();
    let h = checkpoint(emptyHistory(), a, 'Edit');
    h = { ...h, redo: [{ snap: clone(b), label: 'Redo me', source: 'user' }] };
    const next = checkpoint(h, b, 'Edit');
    expect(next.undo).toHaveLength(1);
    expect(next.redo).toHaveLength(0);
  });

  it('is a no-op on both stacks inside an open transaction', () => {
    const live = baseSnapshot();
    const opened = begin(emptyHistory(), live, 'Move');
    const before = opened;
    const next = checkpoint(opened, live, 'Edit');
    expect(next).toBe(before);
    expect(next.undo).toHaveLength(1);
  });
});

describe('transactions', () => {
  it('nests to one entry labelled by the outer begin', () => {
    const live = baseSnapshot();
    const changed = baseSnapshot();
    changed.elements[0].x1 = 32;
    let h = begin(emptyHistory(), live, 'Combine Scopes');
    h = begin(h, live, 'Inner');
    expect(h.open?.depth).toBe(2);
    h = end(h, live);
    expect(h.open?.depth).toBe(1);
    h = end(h, changed);
    expect(h.open).toBeNull();
    expect(h.undo).toHaveLength(1);
    expect(h.undo[0].label).toBe('Combine Scopes');
  });

  it('end with no open transaction is a no-op', () => {
    const h = withUndo('Edit');
    expect(end(h, baseSnapshot())).toBe(h);
  });

  it('abort closes at any depth and leaves the stacks untouched', () => {
    const live = baseSnapshot();
    let h = begin(emptyHistory(), live, 'Move');
    h = begin(h, live, 'Inner');
    const aborted = abort(h);
    expect(aborted.open).toBeNull();
    expect(aborted.undo).toBe(h.undo);
    expect(aborted.redo).toBe(h.redo);
  });

  it('pops the baseline again when the transaction changed nothing', () => {
    const live = baseSnapshot();
    let h = begin(emptyHistory(), live, 'Move');
    h = end(h, live);
    expect(h.undo).toHaveLength(0);
    expect(h.open).toBeNull();
  });

  it('keeps the entry when the transaction moved the document', () => {
    const live = baseSnapshot();
    const changed = baseSnapshot();
    changed.elements[0].x1 = 32;
    let h = begin(emptyHistory(), live, 'Move');
    h = end(h, changed);
    expect(h.undo).toHaveLength(1);
    expect(h.undo[0].label).toBe('Move');
  });

  it('does not prune a deduped baseline it never pushed', () => {
    const live = baseSnapshot();
    // The stack top already equals the live state, so begin pushes nothing.
    let h = checkpoint(emptyHistory(), live, 'Edit');
    h = begin(h, live, 'Move');
    h = end(h, live);
    expect(h.undo).toHaveLength(1);
    expect(h.undo[0].label).toBe('Edit');
  });
});

describe('undo and redo', () => {
  it('round-trips the state and moves the label with the entry', () => {
    const live = baseSnapshot();
    const moved = baseSnapshot();
    moved.elements[0].x1 = 32;
    let h = begin(emptyHistory(), live, 'Move');
    h = end(h, moved);

    const back = stepBack(h, moved);
    expect(back).not.toBeNull();
    h = back!.history;
    expect(snapshotKey(back!.restore)).toBe(snapshotKey(live));
    expect(undoLabel(h)).toBeNull();
    expect(redoLabel(h)).toBe('Move');

    const forward = stepForward(h, live);
    expect(forward).not.toBeNull();
    h = forward!.history;
    expect(snapshotKey(forward!.restore)).toBe(snapshotKey(moved));
    expect(undoLabel(h)).toBe('Move');
    expect(redoLabel(h)).toBeNull();
  });

  it('stepBack on an empty stack returns null', () => {
    expect(stepBack(emptyHistory(), baseSnapshot())).toBeNull();
  });

  it('stepForward on an empty future returns null', () => {
    expect(stepForward(emptyHistory(), baseSnapshot())).toBeNull();
  });

  it('closes an open transaction when it steps', () => {
    const live = baseSnapshot();
    const changed = baseSnapshot();
    changed.elements[0].x1 = 32;
    let h = begin(emptyHistory(), live, 'Move');
    h = end(h, changed);
    h = begin(h, changed, 'Rotate');
    const back = stepBack(h, changed);
    expect(back!.history.open).toBeNull();
  });
});

describe('the undo cap', () => {
  it('keeps the newest UNDO_LIMIT entries and leaves redo alone', () => {
    let h = emptyHistory();
    for (let i = 0; i <= UNDO_LIMIT; i++) {
      const snap = baseSnapshot();
      snap.elements[0].x1 = i;
      h = checkpoint(h, snap, `Edit ${i}`);
    }
    expect(h.undo).toHaveLength(UNDO_LIMIT);
    expect(h.undo[0].label).toBe('Edit 1');
    expect(h.undo[h.undo.length - 1].label).toBe(`Edit ${UNDO_LIMIT}`);
  });

  it('pushExternal respects the cap', () => {
    let h = emptyHistory();
    for (let i = 0; i < UNDO_LIMIT; i++) {
      const snap = baseSnapshot();
      snap.view.x = i;
      h = checkpoint(h, snap, `Edit ${i}`);
    }
    const pre = baseSnapshot();
    pre.elements[0].x1 = 999;
    const next = pushExternal(h, pre, 'Recovered');
    expect(next.undo).toHaveLength(UNDO_LIMIT);
    expect(next.undo[next.undo.length - 1].label).toBe('Recovered');
  });
});

describe('clearFuture', () => {
  it('drops the redo side and keeps undo', () => {
    const h: History = {
      undo: withUndo('Edit').undo,
      redo: [{ snap: baseSnapshot(), label: 'Redo', source: 'user' }],
      open: null,
    };
    const next = clearFuture(h);
    expect(next.redo).toHaveLength(0);
    expect(next.undo).toBe(h.undo);
  });

  it('returns the same history when there is no future', () => {
    const h = withUndo('Edit');
    expect(clearFuture(h)).toBe(h);
  });
});

describe('derived readouts', () => {
  it('reports depth and the next labels', () => {
    expect(canUndo(emptyHistory())).toBe(false);
    expect(canRedo(emptyHistory())).toBe(false);
    const h = withUndo('Add Resistor', 'Move');
    expect(canUndo(h)).toBe(true);
    expect(undoLabel(h)).toBe('Move');
    expect(redoLabel(h)).toBeNull();
  });
});

describe('clone', () => {
  /** Every nested field the history owns, mutated in place on the clone. A
   *  new field added to Snapshot without a clone line shows up here as the
   *  source fingerprint changing under the mutation. */
  const mutations: [string, (s: Snapshot) => void][] = [
    ['element params', (s) => (s.elements[0].params.resistance = 2)],
    ['element route', (s) => (s.elements[0].route![1] = [9, 9])],
    ['embedded tokens', (s) => s.elements[1].embedded!.tokens.push('x')],
    ['embedded plots', (s) => (s.elements[1].embedded!.plots[0].elementId = 9)],
    ['embedded display', (s) => (s.elements[1].embedded!.display.speed = 1)],
    ['embedded per-plot', (s) => (s.elements[1].embedded!.display.perPlot[0].manScale = 4)],
    ['custom logic inputs', (s) => (s.elements[2].model as CustomLogicModel).inputs.push('c')],
    ['custom logic outputs', (s) => (s.elements[2].model as CustomLogicModel).outputs.push('d')],
    ['custom logic rules', (s) => (s.elements[2].model as CustomLogicModel).rulesLeft.push('x')],
    ['composite external', (s) => (s.elements[3].model as CompositeEngineSpec).external.push(3)],
    [
      'composite dumps',
      (s) => (s.elements[3].model as CompositeEngineSpec).dumps.push('r 1 1 2 2'),
    ],
    ['string-array model', (s) => (s.elements[4].model as string[]).push('extra')],
    ['scope raw', (s) => s.scopes[0].raw!.push('x')],
    ['scope trigger', (s) => (s.scopes[0].trigger.level = 4)],
    ['scope measurements', (s) => (s.scopes[0].plots[0].measurements!.showMin = true)],
    ['slider raw', (s) => s.sliders[0].raw.push('x')],
    ['settings', (s) => (s.settings.decimalDigits = 9)],
    ['view', (s) => (s.view.scale = 4)],
    ['passthrough', (s) => s.passthrough.push('extra')],
    ['order', (s) => s.order.push({ kind: 'other', line: 'extra' })],
    ['unmatched raw', (s) => s.unmatchedScopes[0].raw.push('x')],
    ['unmatched plots', (s) => (s.unmatchedScopes[0].plots[0].value = 'current')],
  ];

  it.each(mutations)(
    "mutating the clone's %s leaves the source fingerprint alone",
    (_name, mutate) => {
      const source = baseSnapshot();
      const key = snapshotKey(source);
      const copy = clone(source);
      mutate(copy);
      expect(snapshotKey(source)).toBe(key);
    },
  );
});
