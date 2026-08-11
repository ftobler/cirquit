import { describe, expect, it, beforeEach } from 'vitest';
import { SimEngine } from './simulator';
import { DEFAULT_SETTINGS } from '../model/types';
import type { CircuitElement } from '../model/types';
import { postsOf } from '../model/registry';
import { useStore } from '../state/store';
import { fresh } from '../state/store.test-helpers';
import { overlayLiveState } from '../io/liveState';

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
