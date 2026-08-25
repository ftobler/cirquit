import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SCOPE_WIDTH } from '../scope/geometry';
import { DEFAULT_SETTINGS, type CircuitElement } from '../model/types';
import type { ElementReadoutSource, Scope, ScopeDrawSource } from '../engine/simulator';
import {
  UNDOCKED_FRAME_TYPE,
  UNDOCKED_HELLO_TYPE,
  scopeWindowTitle,
} from './protocol';
import {
  attachUndockedWindow,
  buildUndockedFrame,
  detachUndockedWindow,
  noteUndockedHello,
  pushUndockedScopeFrame,
  undockedWindowOuterSize,
} from './opener';

function fakeWindow() {
  return {
    closed: false,
    close: vi.fn(function (this: { closed: boolean }) {
      this.closed = true;
    }),
    postMessage: vi.fn(),
  };
}

type FakeWin = ReturnType<typeof fakeWindow>;

/** A two-trace engine stub: the exact surface drawScope reads, which the
 *  builder consumes through the same narrow interface. */
function stubSource(): ElementReadoutSource & { dataCalls: number[] } {
  const traces = new Map<number, Float32Array>([
    [11, new Float32Array([0.1, 0.2, 0.3, 0.4])],
    [12, new Float32Array(4)],
  ]);
  const calls: number[] = [];
  return {
    dataCalls: calls,
    time: 0.005,
    scopeIndexOf(plotId: number) {
      return plotId === 11 ? 0 : plotId === 12 ? 1 : undefined;
    },
    indexOf(id: number) {
      return id === 5 ? 0 : undefined;
    },
    elementCurrents() {
      return new Float64Array([0, 0]);
    },
    elementVoltages() {
      return new Float64Array([0, 0]);
    },
    elementPowers() {
      return new Float64Array([0, 0]);
    },
    elementScopeValues() {
      return new Float64Array();
    },
    scopeData(index: number) {
      calls.push(index);
      return traces.get(index === 0 ? 11 : 12)!;
    },
    scopeDiverged(index: number) {
      return index === 1;
    },
    triggerInfo(index: number, _width: number) {
      calls.push(-index - 100);
      return {
        columns: 512,
        snapshot_start: 0,
        start_index: 7,
        state: 1,
        time: 0.004,
        triggered: true,
        valid_count: 128,
        waiting: false,
        written: 256,
        free: () => undefined,
      };
    },
    recentSamples(index: number) {
      calls.push(index);
      return new Float32Array([1, 2, 3]);
    },
  };
}

const ELEMENTS: CircuitElement[] = [
  {
    id: 5,
    kind: 'resistor',
    x1: 0,
    y1: 0,
    x2: 16,
    y2: 0,
    flags: 0,
    params: {},
  },
];

const SCOPE: Scope = {
  id: 9,
  raw: null,
  plots: [
    { id: 11, elementId: 5, value: 'voltage', manScale: null, manVPosition: 0, acCoupled: false, measurements: null, origValueToken: null, origElementIndex: null },
    { id: 12, elementId: 5, value: 'current', manScale: null, manVPosition: 0, acCoupled: false, measurements: null, origValueToken: null, origElementIndex: null },
    // A plot with no engine trace (an unreadable element line): never pushed.
    { id: 13, elementId: null, value: null, manScale: null, manVPosition: 0, acCoupled: false, measurements: null, origValueToken: null, origElementIndex: null },
  ],
  speed: 64,
  position: 0,
  manualScale: false,
  maxScale: false,
  label: '',
  manDivisions: 8,
  showScale: false,
  showMax: false,
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
  showElmInfo: true,
  showI: true,
  showV: true,
  scaleV: 20,
  scaleA: 0.05,
  trigger: { mode: 'freeRun', edge: 'rising', level: 0 },
};

describe('scopeWindowTitle', () => {
  it('prefers the scope label and falls back to a plain name', () => {
    expect(scopeWindowTitle('in')).toBe('in - Circuit Simulator');
    expect(scopeWindowTitle('')).toBe('Undocked Scope - Circuit Simulator');
  });
});

describe('buildUndockedFrame', () => {
  it('carries one copied trace per registered plot, with no trigger when free-running', () => {
    const message = buildUndockedFrame({
      source: stubSource(),
      scope: SCOPE,
      elements: ELEMENTS,
      settings: DEFAULT_SETTINGS,
      dark: true,
    });
    expect(message.type).toBe(UNDOCKED_FRAME_TYPE);
    expect(message.time).toBeCloseTo(0.005);
    expect(message.title).toBe(scopeWindowTitle(''));
    expect(message.traces.map((t) => t.plotId)).toEqual([11, 12]);
    // Copies, not the engine's own arrays: writing into one must not move
    // the other. Compared as Float32Arrays so the 32-bit rounding matches.
    const first = new Float32Array(message.traces[0].data);
    expect(first).toEqual(new Float32Array([0.1, 0.2, 0.3, 0.4]));
    expect(message.traces[0].diverged).toBe(false);
    expect(message.traces[1].diverged).toBe(true);
    expect(message.traces[0].trigger).toBeNull();
    expect(message.traces[0].xy).toBeNull();
    // The element line list feeds the child's Show Extended Info header, the
    // same getInfo lines the docked panel draws.
    expect(message.elmInfo[5]).toEqual([
      'resistor',
      'I = 0 A',
      'Vd = 0 V',
      'R = 0 Ω',
      'P = 0 W',
    ]);
  });

  it('ships no element lines when Show Extended Info is off', () => {
    // The child only reads elmInfo while drawing that header, and a
    // scope-value kind would pay its on-demand crossing per frame for lines
    // nobody displays, so the opener omits them outright.
    const message = buildUndockedFrame({
      source: stubSource(),
      scope: { ...SCOPE, showElmInfo: false },
      elements: ELEMENTS,
      settings: DEFAULT_SETTINGS,
      dark: true,
    });
    expect(message.elmInfo).toEqual({});
  });

  it('snapshots the trigger ring only in a triggered mode', () => {
    const source = stubSource();
    const message = buildUndockedFrame({
      source,
      scope: { ...SCOPE, trigger: { ...SCOPE.trigger, mode: 'normal' } },
      elements: ELEMENTS,
      settings: DEFAULT_SETTINGS,
      dark: false,
    });
    expect(message.traces[0].trigger).toMatchObject({ valid_count: 128, state: 1 });
    expect(message.dark).toBe(false);
  });

  it('carries X-Y samples only when X-Y mode is on', () => {
    const message = buildUndockedFrame({
      source: stubSource(),
      scope: { ...SCOPE, plotXY: true },
      elements: ELEMENTS,
      settings: DEFAULT_SETTINGS,
      dark: true,
    });
    expect(new Float32Array(message.traces[0].xy!)).toEqual(new Float32Array([1, 2, 3]));
  });
});

describe('pushUndockedScopeFrame', () => {
  let win: FakeWin;

  beforeEach(() => {
    win = fakeWindow();
    attachUndockedWindow(win as unknown as Window, () => undefined);
  });

  afterEach(() => {
    detachUndockedWindow(false);
  });

  it('stays silent until the child says hello, then pushes one frame', () => {
    const args = {
      source: stubSource() as ScopeDrawSource,
      scopes: [SCOPE],
      elements: ELEMENTS,
      settings: DEFAULT_SETTINGS,
      dark: true,
      scopeId: 9,
    };
    pushUndockedScopeFrame(args);
    expect(win.postMessage).not.toHaveBeenCalled();
    noteUndockedHello({ source: win as unknown as Window });
    pushUndockedScopeFrame(args);
    expect(win.postMessage).toHaveBeenCalledTimes(1);
    const [message, options] = vi.mocked(win.postMessage).mock.calls[0];
    expect((message as { type: string }).type).toBe(UNDOCKED_FRAME_TYPE);
    // The copied buffers travel by transfer, not by a second structured clone.
    const transferred = (options as { transfer?: ArrayBuffer[] }).transfer ?? [];
    expect(transferred.length).toBeGreaterThan(0);
    for (const buffer of transferred) expect(buffer.byteLength).toBeGreaterThan(0);
  });

  it('a hello from any other window never starts the push', () => {
    const args = {
      source: stubSource() as ScopeDrawSource,
      scopes: [SCOPE],
      elements: ELEMENTS,
      settings: DEFAULT_SETTINGS,
      dark: true,
      scopeId: 9,
    };
    // Another tab (or a stray iframe) guessing the message type must not
    // arm the mirror: only the attached window's own announcement counts.
    noteUndockedHello({ source: null });
    pushUndockedScopeFrame(args);
    expect(win.postMessage).not.toHaveBeenCalled();
    const stranger = { postMessage: vi.fn() };
    noteUndockedHello({ source: stranger });
    pushUndockedScopeFrame(args);
    expect(win.postMessage).not.toHaveBeenCalled();
    // The real child still gets through afterwards.
    noteUndockedHello({ source: win as unknown as Window });
    pushUndockedScopeFrame(args);
    expect(win.postMessage).toHaveBeenCalledTimes(1);
  });

  it('reaps a window the user closed and reports the loss once', () => {
    const onLost = vi.fn();
    detachUndockedWindow(false);
    attachUndockedWindow(win as unknown as Window, onLost);
    win.closed = true;
    pushUndockedScopeFrame({
      source: stubSource(),
      scopes: [SCOPE],
      elements: ELEMENTS,
      settings: DEFAULT_SETTINGS,
      dark: true,
      scopeId: 9,
    });
    expect(onLost).toHaveBeenCalledTimes(1);
    // The attachment is gone: further frames are quiet no-ops.
    pushUndockedScopeFrame({
      source: stubSource(),
      scopes: [SCOPE],
      elements: ELEMENTS,
      settings: DEFAULT_SETTINGS,
      dark: true,
      scopeId: 9,
    });
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it('closes a window whose scope vanished under it', () => {
    const onLost = vi.fn();
    detachUndockedWindow(false);
    attachUndockedWindow(win as unknown as Window, onLost);
    noteUndockedHello({ source: win as unknown as Window });
    pushUndockedScopeFrame({
      source: stubSource(),
      scopes: [],
      elements: ELEMENTS,
      settings: DEFAULT_SETTINGS,
      dark: true,
      scopeId: 9,
    });
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(win.close).toHaveBeenCalled();
  });

  it('keeps the window while the engine has no readback yet', () => {
    const onLost = vi.fn();
    detachUndockedWindow(false);
    attachUndockedWindow(win as unknown as Window, onLost);
    noteUndockedHello({ source: win as unknown as Window });
    pushUndockedScopeFrame({
      source: null,
      scopes: [SCOPE],
      elements: ELEMENTS,
      settings: DEFAULT_SETTINGS,
      dark: true,
      scopeId: 9,
    });
    // Nothing pushed, nothing torn down: the first frames after a cold start
    // have no readback to copy, and closing the window for that would make
    // the popup race the wasm load.
    expect(win.postMessage).not.toHaveBeenCalled();
    expect(onLost).not.toHaveBeenCalled();
  });

  it('ignores frames when no scope id is given', () => {
    noteUndockedHello({ source: win as unknown as Window });
    pushUndockedScopeFrame({
      source: stubSource(),
      scopes: [SCOPE],
      elements: ELEMENTS,
      settings: DEFAULT_SETTINGS,
      dark: true,
      scopeId: undefined,
    });
    expect(win.postMessage).not.toHaveBeenCalled();
  });
});

describe('hello type pinning', () => {
  it('the child announcement keeps its wire name', () => {
    // Both halves must spell the discriminator identically; this pins the
    // constant so a rename on one side fails here instead of silently
    // never starting the push.
    expect(UNDOCKED_HELLO_TYPE).toBe('undocked-hello');
  });
});

describe('undockedWindowOuterSize', () => {
  it('starts the canvas at the width trigger state is computed against', () => {
    const size = undockedWindowOuterSize(500);
    // Outer size carries the chrome allowance over the wanted canvas area;
    // the point is inner width == docked width at open time.
    expect(size.width).toBeGreaterThan(500);
    expect(size.height).toBeGreaterThan(400);
    expect(size.height).toBeLessThan(600);
  });

  it('a nonsense docked width falls back to the shared default', () => {
    const fallback = undockedWindowOuterSize(Number.NaN);
    expect(fallback.width).toBeGreaterThan(DEFAULT_SCOPE_WIDTH);
  });
});
