import { describe, expect, it, beforeEach } from 'vitest';
import { frameStatsOf, SimEngine } from './simulator';
import { DEFAULT_SETTINGS } from '../model/types';
import type { CircuitElement } from '../model/types';
import { postsOf } from '../model/registry';
import { useStore } from '../state/store';
import { fresh } from '../state/store.test-helpers';
import { overlayLiveState } from '../io/liveState';
import {
  clearSessionModels,
  modelToEngineSpec,
  parseCompositeModelLine,
  registerSessionModel,
} from '../io/subcircuits';

describe('SimEngine per-post arrays', () => {
  it('postOffset indexes elementPostCurrents slices for mixed post counts', async () => {
    // The engine flattens per-post currents in element order, so the
    // postOffset map must slice the right element's entries when post counts
    // differ: resistor 2, ground 1, transistor 3.
    const engine = await SimEngine.create();
    const elements: CircuitElement[] = [
      {
        id: 1,
        kind: 'resistor',
        x1: 0,
        y1: 0,
        x2: 100,
        y2: 0,
        flags: 0,
        params: { resistance: 1000 },
      },
      { id: 2, kind: 'ground', x1: 100, y1: 0, x2: 100, y2: 32, flags: 0, params: {} },
      { id: 3, kind: 'transistor', x1: 0, y1: 0, x2: 100, y2: 0, flags: 0, params: { pnp: 1 } },
    ];
    expect(engine.setCircuit(elements, DEFAULT_SETTINGS, [])).toBeNull();
    expect(engine.postOffset(1)).toBe(0); // resistor leads the array
    expect(engine.postOffset(2)).toBe(2); // one resistor post per entry
    expect(engine.postOffset(3)).toBe(3); // resistor + ground posts

    const postCurrents = engine.elementPostCurrents();
    const elementNodes = engine.elementNodes();
    expect(postCurrents.length).toBe(6); // 2 + 1 + 3
    expect(postCurrents.length).toBe(elementNodes.length);
  });
});

describe('SimEngine live state read-back', () => {
  const RC: CircuitElement[] = [
    { id: 1, kind: 'voltage', x1: 0, y1: 100, x2: 0, y2: 0, flags: 0, params: { maxVoltage: 10 } },
    {
      id: 2,
      kind: 'resistor',
      x1: 0,
      y1: 0,
      x2: 100,
      y2: 0,
      flags: 0,
      params: { resistance: 1000 },
    },
    {
      id: 3,
      kind: 'capacitor',
      x1: 100,
      y1: 0,
      x2: 100,
      y2: 100,
      flags: 0,
      params: { capacitance: 1e-6, voltDiff: 5 },
    },
    { id: 4, kind: 'wire', x1: 100, y1: 100, x2: 0, y2: 100, flags: 0, params: {} },
    { id: 5, kind: 'ground', x1: 0, y1: 100, x2: 0, y2: 132, flags: 0, params: {} },
  ];

  it('elementStateTokens reports the live charge and a rebuild keeps it', async () => {
    const engine = await SimEngine.create();
    expect(engine.setCircuit(RC, DEFAULT_SETTINGS, [])).toBeNull();

    // Five time constants at the default 5e-6 step: the cap charges from the
    // seeded 5 V to near the 10 V supply.
    engine.run(1000);
    const live = engine.elementStateTokens();
    expect(live[3]).toBeDefined();
    const voltDiff = live[3].voltDiff;
    expect(voltDiff).toBeDefined();
    expect(voltDiff).toBeGreaterThan(8);
    expect(voltDiff).toBeLessThan(9.99);

    // Rebuild with the overlay: the engine reads the live voltDiff straight
    // off the param, so the charge survives the first step of the new build.
    const overlaid = overlayLiveState(RC, live);
    expect(engine.setCircuit(overlaid, DEFAULT_SETTINGS, [])).toBeNull();
    engine.run(1);
    const idx = engine.indexOf(3);
    expect(idx).toBeDefined();
    const v = engine.elementVoltages()[idx!];
    expect(v).toBeGreaterThan(8);
  });

  it('elementStateTokens is empty for an element set with no operating tokens', async () => {
    const engine = await SimEngine.create();
    expect(
      engine.setCircuit(
        [
          {
            id: 1,
            kind: 'resistor',
            x1: 0,
            y1: 0,
            x2: 100,
            y2: 0,
            flags: 0,
            params: { resistance: 1000 },
          },
        ],
        DEFAULT_SETTINGS,
        [],
      ),
    ).toBeNull();
    engine.run(10);
    const live = engine.elementStateTokens();
    expect(live[1]).toEqual({});
  });
});

describe('SimEngine battery live state', () => {
  // A discharging alkaline battery: minus grounded, a 1 ohm load from plus to
  // ground. The small capacity makes the SOC move measurably in 0.01 s.
  const BATTERY: CircuitElement[] = [
    {
      id: 1,
      kind: 'battery',
      x1: 0,
      y1: 100,
      x2: 0,
      y2: 0,
      flags: 3, // FLAG_SHOW_VOLTAGE | FLAG_SHOW_SOC
      params: { r0: 0.01, r1: 0.02, c1: 2000, capacityAh: 0.01, initialSoc: 1, batteryType: 0 },
      model: '0=0.8\n10=0.95\n20=1.05\n40=1.18\n60=1.28\n80=1.38\n90=1.43\n100=1.55\n',
    },
    { id: 2, kind: 'ground', x1: 0, y1: 100, x2: 0, y2: 132, flags: 0, params: {} },
    { id: 3, kind: 'resistor', x1: 0, y1: 0, x2: 0, y2: -100, flags: 0, params: { resistance: 1 } },
    { id: 4, kind: 'ground', x1: 0, y1: -100, x2: 0, y2: -68, flags: 0, params: {} },
  ];

  it('reports the live soc token and a save-and-rebuild continues it', async () => {
    const engine = await SimEngine.create();
    expect(engine.setCircuit(BATTERY, DEFAULT_SETTINGS, [])).toBeNull();

    engine.run(2000); // 0.01 s at the default 5e-6 step
    const live = engine.elementStateTokens();
    expect(live[1]).toBeDefined();
    const soc = live[1].soc;
    expect(soc).toBeDefined();
    expect(soc).toBeLessThan(1);
    expect(soc).toBeGreaterThan(0.99);
    expect(live[1].capVoltDiff).toBeDefined();

    // The draw's SOC caption reads the same number from elementStates.
    const idx = engine.indexOf(1)!;
    expect(engine.elementStates()[idx]).toBeCloseTo(soc, 9);

    // Save mid-discharge and rebuild: the engine reads the live soc straight
    // off the param, so the first step of the new build continues it.
    const overlaid = overlayLiveState(BATTERY, live);
    expect(engine.setCircuit(overlaid, DEFAULT_SETTINGS, [])).toBeNull();
    engine.run(1);
    const socAfter = engine.elementStateTokens()[1].soc;
    expect(socAfter).toBeLessThan(soc);
  });

  it('reset restores the initial soc, which an edit updates', async () => {
    const engine = await SimEngine.create();
    expect(engine.setCircuit(BATTERY, DEFAULT_SETTINGS, [])).toBeNull();
    engine.run(2000);
    expect(engine.elementStateTokens()[1].soc).toBeLessThan(1);

    engine.reset();
    const idx = engine.indexOf(1)!;
    expect(engine.elementStates()[idx]).toBe(1); // the file's initialSoc

    engine.setParam(1, 'initialSoc', 0.5);
    engine.reset();
    expect(engine.elementStates()[idx]).toBe(0.5);
  });
});

describe('SimEngine preserveRun', () => {
  const DIVIDER: CircuitElement[] = [
    { id: 1, kind: 'voltage', x1: 0, y1: 100, x2: 0, y2: 0, flags: 0, params: { maxVoltage: 10 } },
    {
      id: 2,
      kind: 'resistor',
      x1: 0,
      y1: 0,
      x2: 100,
      y2: 0,
      flags: 0,
      params: { resistance: 1000 },
    },
    { id: 3, kind: 'wire', x1: 100, y1: 0, x2: 100, y2: 100, flags: 0, params: {} },
    { id: 4, kind: 'ground', x1: 100, y1: 100, x2: 100, y2: 132, flags: 0, params: {} },
  ];

  /** The divider with a second resistor hung off the midpoint: a shape change
   *  that adds an element and a node, exactly what dragging a new part onto a
   *  running circuit does. */
  const RESHAPED: CircuitElement[] = [
    ...DIVIDER,
    {
      id: 5,
      kind: 'resistor',
      x1: 100,
      y1: 0,
      x2: 200,
      y2: 0,
      flags: 0,
      params: { resistance: 2000 },
    },
  ];

  it('defaults to restarting the clock, for a load or a New', async () => {
    const engine = await SimEngine.create();
    expect(engine.setCircuit(DIVIDER, DEFAULT_SETTINGS, [])).toBeNull();
    engine.run(100);
    expect(engine.time).toBeGreaterThan(0);

    expect(engine.setCircuit(DIVIDER, DEFAULT_SETTINGS, [])).toBeNull();
    expect(engine.time).toBe(0);
  });

  it('keeps the clock through a shape change when asked to', async () => {
    const engine = await SimEngine.create();
    expect(engine.setCircuit(DIVIDER, DEFAULT_SETTINGS, [])).toBeNull();
    engine.run(100);
    const t = engine.time;
    expect(t).toBeGreaterThan(0);

    // The fifth argument is the flag the frame loop passes from its
    // still-the-same-document gate.
    expect(engine.setCircuit(RESHAPED, DEFAULT_SETTINGS, [], undefined, true)).toBeNull();
    expect(engine.time).toBe(t);

    // And the new element really is in the circuit, so this is a genuine
    // topology rebuild rather than a skipped one.
    expect(engine.indexOf(5)).toBeDefined();
    engine.run(10);
    expect(engine.time).toBeGreaterThan(t);
  });
});

describe('fractional controlled-source input counts rebuild cleanly', () => {
  beforeEach(() => useStore.setState(fresh()));

  it.each([
    ['vcvs', 2.5, 2],
    ['vccs', 2.5, 2],
    ['ccvs', 2.5, 2],
    ['cccs', 2.5, 2],
  ])('editing %s to %s stores an integer and builds without the post-count guard', async (kind, given, n) => {
    // The UI's "# of Inputs" slider can hand the store a fraction; setParam
    // must write back the integer the engine truncates to, or the rebuild's
    // post-count guard (circuit.rs:261-269) rejects the spec and the circuit
    // never comes back.
    const id = useStore.getState().addElement({
      kind,
      x1: 0,
      y1: 0,
      x2: 192,
      y2: 0,
      flags: 0,
      params: { inputCount: 2 },
    });
    useStore.getState().setParam(id, 'inputCount', given);
    const e = useStore.getState().elements.find((x) => x.id === id)!;
    expect(e.params.inputCount).toBe(n);

    const engine = await SimEngine.create();
    expect(engine.setCircuit(useStore.getState().elements, DEFAULT_SETTINGS, [])).toBeNull();
    // The engine's node array and the renderer's post list hold one entry per
    // post, so equal lengths prove the two halves agree on the post count and
    // the renderer's index cannot drift off the engine's elementNodes.
    expect(postsOf(e).length).toBe(engine.elementNodes().length);
  });
});

describe('fractional gate input counts rebuild cleanly', () => {
  beforeEach(() => useStore.setState(fresh()));

  it.each([
    ['andGate', 2.5, 2],
    ['nandGate', 2.5, 2],
    ['orGate', 2.5, 2],
    ['norGate', 2.5, 2],
    ['xorGate', 2.5, 2],
    ['xnorGate', 2.5, 2],
  ])('editing %s to %s stores an integer and builds without the post-count guard', async (kind, given, n) => {
    // The UI's "# of Inputs" slider can hand the store a fraction; setParam
    // must write back the integer the engine truncates to, or the rebuild's
    // post-count guard (circuit.rs:261-269) rejects the spec and the circuit
    // never comes back.
    const id = useStore.getState().addElement({
      kind,
      x1: 0,
      y1: 0,
      x2: 192,
      y2: 0,
      flags: 0,
      params: { inputCount: 2 },
    });
    useStore.getState().setParam(id, 'inputCount', given);
    const e = useStore.getState().elements.find((x) => x.id === id)!;
    expect(e.params.inputCount).toBe(n);

    const engine = await SimEngine.create();
    expect(engine.setCircuit(useStore.getState().elements, DEFAULT_SETTINGS, [])).toBeNull();
    expect(postsOf(e).length).toBe(engine.elementNodes().length);
  });
});

describe('fractional multiplexer select-bit counts rebuild cleanly', () => {
  beforeEach(() => useStore.setState(fresh()));

  it.each([
    ['multiplexer', 'bits', 2.5, 2],
    ['deMultiplexer', 'selectBits', 2.5, 3],
  ])('editing %s to %s stores an integer and builds without the post-count guard', async (kind, name, given, n) => {
    // The "# of Select Bits" number field can hand the store a fraction;
    // setParam must write back the integer the engine derives or the rebuild's
    // post-count guard (circuit.rs:261-269) rejects the spec and the circuit
    // never comes back.
    const id = useStore.getState().addElement({
      kind,
      x1: 0,
      y1: 0,
      x2: 192,
      y2: 0,
      flags: 0,
      params: kind === 'deMultiplexer' ? { selectBits: 2 } : { bits: 2 },
    });
    useStore.getState().setParam(id, name, given);
    let e = useStore.getState().elements.find((x) => x.id === id)!;
    expect(e.params[name]).toBe(n);

    // A demultiplexer alone is electrically singular: every output is a
    // voltage source to ground and the floating data input leaves the matrix
    // rank-deficient, so pin the data input down. The multiplexer's single
    // output builds unloaded.
    let groundId: number | undefined;
    if (kind === 'deMultiplexer') {
      const data = postsOf(e)[postsOf(e).length - 1];
      groundId = useStore.getState().addElement({
        kind: 'ground',
        x1: data.x,
        y1: data.y,
        x2: data.x,
        y2: data.y + 32,
        flags: 0,
        params: {},
      });
      e = useStore.getState().elements.find((x) => x.id === id)!;
    }

    const engine = await SimEngine.create();
    expect(engine.setCircuit(useStore.getState().elements, DEFAULT_SETTINGS, [])).toBeNull();
    // The engine's node array and the renderer's post list hold one entry per
    // post, so equal spans prove the two halves agree on the post count and
    // the renderer's index cannot drift off the engine's elementNodes. The
    // ground follows the chip in element order, so its offset ends the chip's
    // span.
    const nodes = engine.elementNodes();
    const start = engine.postOffset(id)!;
    const end = groundId === undefined ? nodes.length : engine.postOffset(groundId)!;
    expect(end - start).toBe(postsOf(e).length);
  });
});

describe('fractional chip bit-width edits rebuild cleanly', () => {
  beforeEach(() => useStore.setState(fresh()));

  it.each([
    ['adc', 2.5, 2, true],
    ['dac', 2.5, 2, false],
    ['decimalDisplay', 2.5, 2, false],
    ['latch', 2.5, 2, false],
    ['counter', 2.5, 3, false],
    ['ringCounter', 2.5, 2, false],
  ])(
    'editing %s to %s stores an integer and builds without the post-count guard',
    async (kind, given, n, needsGround) => {
      // The "# of Bits" number field can hand the store a fraction; setParam
      // must write back the integer the engine's `(x as usize)` truncation and
      // clamp derive (adc.rs:28, dac.rs:36, decimal_display.rs:24, latch.rs:40,
      // counter.rs:27, ring_counter.rs:26), or the rebuild's post-count guard
      // (circuit.rs:261-269) rejects the spec and the circuit never comes back.
      const id = useStore.getState().addElement({
        kind,
        x1: 0,
        y1: 0,
        x2: 192,
        y2: 0,
        flags: 0,
        params: { bits: 4 },
      });
      useStore.getState().setParam(id, 'bits', given);
      let e = useStore.getState().elements.find((x) => x.id === id)!;
      expect(e.params.bits).toBe(n);

      // An adc's first post is an output voltage source; with no ground symbol
      // the engine grounds the first node as its reference, shorting that
      // source, so pin the V+ sense input down like the demultiplexer test
      // does its data input. The other five chips build unloaded.
      let groundId: number | undefined;
      if (needsGround) {
        const ref = postsOf(e)[postsOf(e).length - 1];
        groundId = useStore.getState().addElement({
          kind: 'ground',
          x1: ref.x,
          y1: ref.y,
          x2: ref.x,
          y2: ref.y + 32,
          flags: 0,
          params: {},
        });
        e = useStore.getState().elements.find((x) => x.id === id)!;
      }

      const engine = await SimEngine.create();
      expect(engine.setCircuit(useStore.getState().elements, DEFAULT_SETTINGS, [])).toBeNull();
      // The engine's node array and the renderer's post list hold one entry
      // per post, so equal spans prove the two halves agree on the post count
      // and the renderer's index cannot drift off the engine's elementNodes.
      // The ground follows the chip in element order, so its offset ends the
      // chip's span.
      const nodes = engine.elementNodes();
      const start = engine.postOffset(id)!;
      const end = groundId === undefined ? nodes.length : engine.postOffset(groundId)!;
      expect(end - start).toBe(postsOf(e).length);
    },
  );
});

describe('custom composite reaches the engine', () => {
  beforeEach(() => clearSessionModels());

  /** A two-pin divider model: `in` on node 1 (west), `out` on node 3 (east),
   *  whose chip geometry puts the posts at (0,0) and (64,0). */
  const MODEL_LINE =
    '. myCirc 0 1 2 2 in 1 0 2 out 3 0 3 ' +
    'ResistorElm\\s1\\s2\\rResistorElm\\s2\\s3 ' +
    '0\\\\s1000\\s0\\\\s1000';

  it('a resolved customComposite builds as the composite kind and simulates', async () => {
    // The engine registers `composite`, never `customComposite` (mod.rs:152),
    // so the spec builder must bridge the resolved kind or the element is
    // silently dropped and its wires float. Mirror the engine's analytic
    // ground-model test: 10 V in, two 1k legs to ground, midpoint at 5 V.
    const model = parseCompositeModelLine(MODEL_LINE)!;
    registerSessionModel(model);
    const composite: CircuitElement = {
      id: 2,
      kind: 'customComposite',
      x1: 0,
      y1: 0,
      x2: 64,
      y2: 0,
      flags: 0,
      params: {},
      text: 'myCirc',
      model: modelToEngineSpec(model),
    };
    expect(postsOf(composite)).toHaveLength(2);
    const elements: CircuitElement[] = [
      {
        id: 1,
        kind: 'voltage',
        x1: 0,
        y1: 200,
        x2: 0,
        y2: 0,
        flags: 0,
        params: { maxVoltage: 10 },
      },
      composite,
      { id: 3, kind: 'ground', x1: 64, y1: 0, x2: 64, y2: 32, flags: 0, params: {} },
      { id: 4, kind: 'ground', x1: 0, y1: 200, x2: 0, y2: 232, flags: 0, params: {} },
    ];
    const engine = await SimEngine.create();
    expect(engine.setCircuit(elements, DEFAULT_SETTINGS, [])).toBeNull();
    engine.run(20);
    const idx = engine.indexOf(2);
    expect(idx).toBeDefined();
    const v = engine.elementVoltages()[idx!];
    expect(v).toBeGreaterThan(9.9);  // post 0 at 10 V, post 1 grounded
  });

  it('an unresolved customComposite is dropped without failing the build', async () => {
    // Bridging every composite to `composite` would fail the whole build
    // (`from_spec` returns None on a missing payload, circuit.rs:259-260), so
    // a part with no resolved model must be filtered out like any unsupported
    // element, leaving the rest of the circuit to run.
    const elements: CircuitElement[] = [
      {
        id: 1,
        kind: 'customComposite',
        x1: 0,
        y1: 0,
        x2: 64,
        y2: 0,
        flags: 0,
        params: {},
        text: 'nope',
      },
      {
        id: 2,
        kind: 'resistor',
        x1: 0,
        y1: 0,
        x2: 100,
        y2: 0,
        flags: 0,
        params: { resistance: 1000 },
      },
    ];
    const engine = await SimEngine.create();
    expect(engine.setCircuit(elements, DEFAULT_SETTINGS, [])).toBeNull();
    expect(engine.indexOf(1)).toBeUndefined();
    expect(engine.indexOf(2)).toBeDefined();
    expect(engine.elementNodes().length).toBe(2);  // the resistor's two posts only
  });
});

describe('SimEngine recordedData facade', () => {
  const RECORDER: CircuitElement[] = [
    {
      id: 1,
      kind: 'voltage',
      x1: 0,
      y1: 100,
      x2: 0,
      y2: 0,
      flags: 0,
      params: { maxVoltage: 5 },
    },
    {
      id: 2,
      kind: 'resistor',
      x1: 0,
      y1: 0,
      x2: 100,
      y2: 0,
      flags: 0,
      params: { resistance: 1000 },
    },
    {
      id: 3,
      kind: 'dataRecorder',
      x1: 0,
      y1: 0,
      x2: 64,
      y2: 0,
      flags: 0,
      params: { dataCount: 8 },
    },
    { id: 4, kind: 'ground', x1: 0, y1: 100, x2: 0, y2: 132, flags: 0, params: {} },
    { id: 5, kind: 'ground', x1: 100, y1: 0, x2: 100, y2: 32, flags: 0, params: {} },
  ];

  it('returns the recorded samples oldest-first and wraps the ring', async () => {
    const engine = await SimEngine.create();
    expect(engine.setCircuit(RECORDER, DEFAULT_SETTINGS, [])).toBeNull();
    expect(engine.recordedData(3).length).toBe(0);  // nothing recorded yet

    engine.run(5);
    const first = Array.from(engine.recordedData(3));
    expect(first.length).toBe(5);
    expect(first.every((v) => Math.abs(v - 5) < 1e-9)).toBe(true);

    // Drop the source to 1 V and run past the 8-sample ring: ten samples into
    // an eight-slot ring keep the three oldest 5 V samples, then the newest
    // 1 V ones, oldest-first (DataRecorderElm.java:108-114).
    engine.setParam(1, 'maxVoltage', 1);
    engine.run(5);
    const wrapped = Array.from(engine.recordedData(3));
    expect(wrapped.length).toBe(8);
    expect(wrapped.slice(0, 3).every((v) => Math.abs(v - 5) < 1e-9)).toBe(true);
    expect(wrapped.slice(3).every((v) => Math.abs(v - 1) < 1e-9)).toBe(true);

    // A non-recorder element reports nothing.
    expect(engine.recordedData(2).length).toBe(0);
    expect(engine.recordedData(99).length).toBe(0);
  });
});

describe('SimEngine run converts wasm throws into error flags', () => {
  // The wasm FrameResult cannot be made to throw from a test (the real module
  // is loaded by SimEngine.create), so frameStatsOf is the seam: a structural
  // stub stands in for the wasm object. These tests pin the two guarantees the
  // frame loop depends on: a throw surfaces as `{converged:false, error:...}`
  // instead of escaping, and free() runs even when the read throws.

  it('returns an error flag and still releases the result when a read throws', () => {
    let freed = 0;
    const result = {
      steps: 3,
      iterations: 7,
      time: 1e-5,
      converged: true,
      error: undefined as string | undefined,
      failingElementIds: () => {
        throw new Error('wasm panicked');
      },
      free: () => {
        freed++;
      },
    };
    const stats = frameStatsOf(result);
    expect(stats.converged).toBe(false);
    expect(stats.error).toContain('wasm panicked');
    expect(stats.steps).toBe(0);
    expect(stats.failingElementIds).toEqual([]);
    expect(freed).toBe(1);
  });

  it('converts a non-Error throw into a string error flag', () => {
    let freed = 0;
    const stats = frameStatsOf({
      steps: 3,
      iterations: 7,
      time: 1e-5,
      converged: true,
      error: undefined,
      failingElementIds: () => {
        throw 'boom';
      },
      free: () => {
        freed++;
      },
    });
    expect(stats.converged).toBe(false);
    expect(stats.error).toBe('boom');
    expect(freed).toBe(1);
  });

  it('releases the result on a healthy read as well', () => {
    let freed = 0;
    const stats = frameStatsOf({
      steps: 3,
      iterations: 7,
      time: 1e-5,
      converged: true,
      error: null,
      failingElementIds: () => new Uint32Array([1, 2]),
      free: () => {
        freed++;
      },
    });
    expect(stats.converged).toBe(true);
    expect(stats.steps).toBe(3);
    expect(stats.iterations).toBe(7);
    expect(stats.error).toBeUndefined();
    expect(stats.failingElementIds).toEqual([1, 2]);
    expect(freed).toBe(1);
  });
});

describe('SimEngine clearStops facade', () => {
  const STOP: CircuitElement[] = [
    {
      id: 1,
      kind: 'voltage',
      x1: 0,
      y1: 100,
      x2: 0,
      y2: 0,
      flags: 0,
      params: { maxVoltage: 0 },
    },
    {
      id: 2,
      kind: 'stopTrigger',
      x1: 0,
      y1: 0,
      x2: 64,
      y2: 0,
      flags: 0,
      params: { triggerVoltage: 1, type: 0, delay: 0, count: 1 },
    },
    { id: 3, kind: 'ground', x1: 0, y1: 100, x2: 0, y2: 132, flags: 0, params: {} },
  ];

  it('clearStops re-arms a fired stop trigger without rewinding time', async () => {
    const engine = await SimEngine.create();
    expect(engine.setCircuit(STOP, DEFAULT_SETTINGS, [])).toBeNull();

    engine.run(2);
    expect(engine.elementStates()[engine.indexOf(2)!]).toBe(0);

    // Crossing the 1 V threshold with a 0-delay trigger fires on the first
    // step after the edit and latches stopped.
    engine.setParam(1, 'maxVoltage', 2);
    engine.run(2);
    expect(engine.elementStates()[engine.indexOf(2)!]).toBe(1);

    // clearStops re-arms the latch without rewinding time: dropping below the
    // threshold first, then clearing, the circuit keeps stepping and reports 0
    // until the threshold is crossed again.
    engine.setParam(1, 'maxVoltage', 0);
    engine.run(2);
    engine.clearStops();
    expect(engine.elementStates()[engine.indexOf(2)!]).toBe(0);
    engine.run(2);
    expect(engine.elementStates()[engine.indexOf(2)!]).toBe(0);

    // The next crossing fires the re-armed trigger.
    engine.setParam(1, 'maxVoltage', 2);
    engine.run(2);
    expect(engine.elementStates()[engine.indexOf(2)!]).toBe(1);
  });
});
