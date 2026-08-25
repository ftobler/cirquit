import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frameStatsOf, scopePlotsToSpecs, sharedPlotElement, SimEngine } from './simulator';
import type { ScopePlot } from './simulator';
import { traceScopes, embeddedScopeOf } from '../scope/embedded';
import { decodeEmbeddedScope } from '../io/embeddedScope';
import { SvgRecorder } from '../render/svg';
import { makeTheme } from '../render/draw';
import type { CircuitElement, DrawContext } from '../model/types';
import { DEFAULT_SETTINGS } from '../model/types';
import { defFor, postsOf } from '../model/registry';
import { useStore } from '../state/store';
import { fresh } from '../state/store.test-helpers';
import { overlayLiveState } from '../io/liveState';
import { parseCircuit, serializeCircuit } from '../io/netlist';
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

  it('a saved mid-discharge file resumes and saves the discharged soc', async () => {
    // The full save path the file menu takes: a battery saved at 42 percent,
    // that text loaded back, discharged past it, and saved again. The new
    // file must carry the running charge, not the original 42.
    const saved = serializeCircuit(
      [
        {
          id: 1,
          kind: 'battery',
          x1: 0,
          y1: 100,
          x2: 0,
          y2: 0,
          flags: 3,
          params: { r0: 0.01, r1: 0.02, c1: 2000, capacityAh: 0.01, initialSoc: 0.42, batteryType: 0 },
          model: '0=0.8\n10=0.95\n20=1.05\n40=1.18\n60=1.28\n80=1.38\n90=1.43\n100=1.55\n',
        },
        { id: 2, kind: 'ground', x1: 0, y1: 100, x2: 0, y2: 132, flags: 0, params: {} },
        { id: 3, kind: 'resistor', x1: 0, y1: 0, x2: 0, y2: -100, flags: 0, params: { resistance: 1 } },
        { id: 4, kind: 'ground', x1: 0, y1: -100, x2: 0, y2: -68, flags: 0, params: {} },
      ],
      DEFAULT_SETTINGS,
    );
    const parsed = parseCircuit(saved);
    expect(parsed.elements[0].params.initialSoc).toBe(0.42);

    const engine = await SimEngine.create();
    expect(engine.setCircuit(parsed.elements, DEFAULT_SETTINGS, [])).toBeNull();
    const batId = parsed.elements[0].id;

    // Discharge until the live SOC crosses below the saved 42 percent; the
    // guard only bounds a broken build where nothing discharges.
    let live = engine.elementStateTokens();
    for (let guard = 0; (live[batId]?.soc ?? 1) >= 0.42 && guard < 400; guard++) {
      engine.run(1000);
      live = engine.elementStateTokens();
    }
    expect(live[batId].soc).toBeLessThan(0.42);

    // Saving through overlayLiveState writes the running fraction into the
    // initialSocPercent token, so a reload of this file resumes below 42.
    const resaved = parseCircuit(
      serializeCircuit(overlayLiveState(parsed.elements, live), DEFAULT_SETTINGS),
    );
    expect(resaved.elements[0].params.initialSoc).toBeLessThan(0.42);
  });

  it('an over-discharged save reloads negative and keeps draining, not recharging to 0', async () => {
    // The engine seeds soc from the param with only an upper cap
    // (battery.rs), so the negative a save carries survives the rebuild and
    // the coulomb count keeps sinking below zero, upstream's modelled
    // over-discharge.
    const saved = serializeCircuit(
      [
        {
          id: 1,
          kind: 'battery',
          x1: 0,
          y1: 100,
          x2: 0,
          y2: 0,
          flags: 3,
          params: { r0: 0.01, r1: 0.02, c1: 2000, capacityAh: 0.01, initialSoc: 1, soc: -0.05, batteryType: 0 },
          model: '0=0.8\n10=0.95\n20=1.05\n40=1.18\n60=1.28\n80=1.38\n90=1.43\n100=1.55\n',
        },
        { id: 2, kind: 'ground', x1: 0, y1: 100, x2: 0, y2: 132, flags: 0, params: {} },
        { id: 3, kind: 'resistor', x1: 0, y1: 0, x2: 0, y2: -100, flags: 0, params: { resistance: 1 } },
        { id: 4, kind: 'ground', x1: 0, y1: -100, x2: 0, y2: -68, flags: 0, params: {} },
      ],
      DEFAULT_SETTINGS,
    );
    expect(saved).toContain(' -5 ');

    const parsed = parseCircuit(saved);
    expect(parsed.elements[0].params.soc).toBe(-0.05);
    expect(parsed.elements[0].params.initialSoc).toBe(0);  // config floors, state does not

    const engine = await SimEngine.create();
    expect(engine.setCircuit(parsed.elements, DEFAULT_SETTINGS, [])).toBeNull();
    const batId = parsed.elements[0].id;
    const idx = engine.indexOf(batId)!;
    expect(engine.elementStates()[idx]).toBe(-0.05);

    engine.run(1000);
    const live = engine.elementStateTokens();
    expect(live[batId].soc).toBeLessThan(-0.05);

    // Saving the deeper discharge carries a negative token again.
    const resaved = parseCircuit(
      serializeCircuit(overlayLiveState(parsed.elements, live), DEFAULT_SETTINGS),
    );
    expect(resaved.elements[0].params.soc).toBeLessThan(-0.05);
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

  it('stamps the table value, which needs the raw string carrier', async () => {
    // The spec carries the battery's table as a plain string; quoting it like
    // the composite blobs would leave one line no f64 parse accepts, the
    // table would parse empty and the engine would fall back to flat 3.7 V.
    const ALKALINE_PROBE: CircuitElement[] = [
      {
        id: 1,
        kind: 'battery',
        x1: 0,
        y1: 100,
        x2: 0,
        y2: 0,
        flags: 3,
        params: { r0: 0.01, r1: 0.02, c1: 2000, capacityAh: 2, initialSoc: 0.5, batteryType: -1 },
        model: '0=0.8\n10=0.95\n20=1.05\n40=1.18\n60=1.28\n80=1.38\n90=1.43\n100=1.55\n',
      },
      { id: 2, kind: 'ground', x1: 0, y1: 100, x2: 0, y2: 132, flags: 0, params: {} },
      {
        id: 3,
        kind: 'resistor',
        x1: 0,
        y1: 0,
        x2: 0,
        y2: -100,
        flags: 0,
        params: { resistance: 10e6 },
      },
      { id: 4, kind: 'ground', x1: 0, y1: -100, x2: 0, y2: -68, flags: 0, params: {} },
    ];
    const engine = await SimEngine.create();
    expect(
      engine.setCircuit(ALKALINE_PROBE, { ...DEFAULT_SETTINGS, autoDC: true }, []),
    ).toBeNull();
    engine.run(1);
    const idx = engine.indexOf(1)!;
    // Alkaline at 50% interpolates halfway between the 40% 1.18 V and the
    // 60% 1.28 V pairs, so 1.23 V; the probe sags it through r0 + r1 only.
    expect(engine.elementVoltages()[idx]).toBeCloseTo(1.23 * (10e6 / (10e6 + 0.03)), 5);
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

describe('SimEngine findDcOperatingPoint', () => {
  // The command is a whole reset under a temporarily-true DC option: success
  // rewinds the clock and commits the found steady state into the reactive
  // elements, so the RC fixture reads charged at t = 0 afterwards.
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
      params: { capacitance: 1e-6, voltDiff: 0 },
    },
    { id: 4, kind: 'wire', x1: 100, y1: 100, x2: 0, y2: 100, flags: 0, params: {} },
    { id: 5, kind: 'ground', x1: 0, y1: 100, x2: 0, y2: 132, flags: 0, params: {} },
  ];

  it('returns null on success, the setCircuit convention', async () => {
    const engine = await SimEngine.create();
    expect(engine.setCircuit(RC, DEFAULT_SETTINGS, [])).toBeNull();
    expect(engine.findDcOperatingPoint()).toBeNull();

    // Found means solved and committed: back at t = 0 with the cap charged to
    // the divider's steady value through the DC open's tiny drop.
    expect(engine.time).toBe(0);
    const idx = engine.indexOf(3)!;
    expect(engine.elementVoltages()[idx]).toBeGreaterThan(9.99);
  });

  it('returns "degraded" when the nonlinear solve finds no operating point', async () => {
    // A current source into a reverse diode has none; the documented
    // degradation leaves the uncharged start.
    const NO_POINT: CircuitElement[] = [
      { id: 1, kind: 'current', x1: 0, y1: 0, x2: 100, y2: 0, flags: 0, params: { current: 0.01 } },
      { id: 2, kind: 'diode', x1: 200, y1: 0, x2: 100, y2: 0, flags: 0, params: {} },
      { id: 3, kind: 'ground', x1: 0, y1: 0, x2: 0, y2: 32, flags: 0, params: {} },
      { id: 4, kind: 'ground', x1: 200, y1: 0, x2: 200, y2: 32, flags: 0, params: {} },
    ];
    const engine = await SimEngine.create();
    expect(engine.setCircuit(NO_POINT, DEFAULT_SETTINGS, [])).toBeNull();
    expect(engine.findDcOperatingPoint()).toBe('degraded');
    expect(engine.nodeVoltages().every((v) => v === 0)).toBe(true);
  });

  it('returns an error string on singular input', async () => {
    // A rail and a source fighting over one node is singular. As a linear
    // circuit it is rejected by setCircuit's eager factor before any command
    // could run, so this pins that the rejection carries the engine message
    // the menubar routes to the problem banner.
    const SINGULAR: CircuitElement[] = [
      { id: 1, kind: 'rail', x1: 0, y1: 0, x2: 0, y2: 0, flags: 0, params: { maxVoltage: 5 } },
      { id: 2, kind: 'voltage', x1: 0, y1: 0, x2: 0, y2: 100, flags: 0, params: { maxVoltage: 10 } },
      { id: 3, kind: 'ground', x1: 0, y1: 100, x2: 0, y2: 132, flags: 0, params: {} },
    ];
    const engine = await SimEngine.create();
    const err = engine.setCircuit(SINGULAR, DEFAULT_SETTINGS, []);
    expect(err).toContain('no solution');
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

describe('embedded scope registration', () => {
  const CIRCUITS_DIR = fileURLToPath(new URL('../../public/circuits', import.meta.url));
  const MULTIVIB = readFileSync(join(CIRCUITS_DIR, 'multivib-a.txt'), 'utf8');

  /** A neutral draw context for the placeholder-degradation checks, the same
   *  shape the render tests build. */
  const context = (ctx: SvgRecorder): DrawContext => ({
    ctx,
    theme: makeTheme(),
    voltages: [],
    current: 0,
    voltage: 0,
    power: 0,
    value: 0,
    state: 0,
    wave: [],
    dotPhase: 0,
    postCurrents: [],
    postDotPhases: [],
    showCurrent: false,
    showValues: false,
    showVoltageColor: true,
    showPowerColor: false,
    conventional: true,
    euroResistors: true,
    euroGates: true,
    selected: false,
    hovered: false,
    onHighlightedNet: false,
    voltageRange: 5,
    powerRange: 50,
    scale: 1,
    valueDigits: 1,
    valueFontSize: 12,
  });

  /** Loads multivib-a through the store, exactly like opening the file. */
  const loadMultivib = () => {
    useStore.setState(fresh());
    useStore.getState().loadNetlist(MULTIVIB, { noCenter: true, noBaseline: true });
    return useStore.getState();
  };

  it('yields two docked plus eight embedded traces over the loaded document', () => {
    const state = loadMultivib();
    const specs = scopePlotsToSpecs(traceScopes(state.scopes, state.elements), state.settings);
    expect(specs).toHaveLength(10);

    // The docked o line contributes two vce traces at speed 64; each embedded
    // window a voltage+current pair, two at 256 and two at 128.
    const bySpeed = (n: number) => specs.filter((s) => s.stepsPerColumn === n);
    expect(bySpeed(64)).toHaveLength(2);
    expect(bySpeed(256)).toHaveLength(4);
    expect(bySpeed(128)).toHaveLength(4);

    const ids = new Set(state.elements.map((e) => e.id));
    for (const spec of specs) {
      expect(ids.has(spec.elementId)).toBe(true);
      expect(spec.trigger.mode).toBe('freeRun');
    }
    // Every embedded pair samples one element as voltage then current.
    const embedded = specs.slice(2);
    for (let i = 0; i < embedded.length; i += 2) {
      expect(embedded[i].value).toBe('voltage');
      expect(embedded[i + 1].value).toBe('current');
      expect(embedded[i].elementId).toBe(embedded[i + 1].elementId);
      expect(embedded[i].plotId).not.toBe(embedded[i + 1].plotId);
    }
  });

  it('fills engine rings for embedded traces like docked ones', async () => {
    // A hand-built window keeps the physics deterministic: a 1 kHz sine into
    // 1 k, with one embedded scope on the resistor tracing V+I. Both samples
    // swing for the whole run, so an unfilled ring could only mean the trace
    // never registered.
    const decoded = decodeEmbeddedScope('2_64_0_4102_5_0.1_0_2_2_3', () => 'resistor')!;
    const scopeElm: CircuitElement = {
      id: 4,
      kind: 'scope',
      x1: 200,
      y1: 0,
      x2: 264,
      y2: 64,
      flags: 0,
      params: {},
      text: '2_64_0_4102_5_0.1_0_2_2_3',
      embedded: {
        tokens: decoded.tokens,
        display: decoded.display,
        plots: decoded.plots.map((p, i) => ({
          id: 100 + i,
          elementId: p.elementIndex === 2 ? 2 : null,
          value: p.value,
        })),
      },
    };
    const elements: CircuitElement[] = [
      {
        id: 1,
        kind: 'voltage',
        x1: 0,
        y1: 100,
        x2: 0,
        y2: 0,
        flags: 0,
        params: { waveform: 1, frequency: 1000, maxVoltage: 5, bias: 0, phaseShift: 0, duty: 0.5 },
      },
      { id: 2, kind: 'resistor', x1: 0, y1: 0, x2: 100, y2: 0, flags: 0, params: { resistance: 1000 } },
      { id: 3, kind: 'ground', x1: 0, y1: 100, x2: 0, y2: 132, flags: 0, params: {} },
      scopeElm,
    ];
    const engine = await SimEngine.create();
    const scopes = traceScopes([], elements);
    expect(scopes).toHaveLength(1);
    expect(engine.setCircuit(elements, DEFAULT_SETTINGS, scopes)).toBeNull();
    engine.run(300);
    const specs = scopePlotsToSpecs(scopes, DEFAULT_SETTINGS);
    expect(specs).toHaveLength(2);
    for (const spec of specs) {
      const index = engine.scopeIndexOf(spec.plotId);
      expect(index).toBeDefined();
      expect(engine.scopeData(index!).some((v) => v !== 0)).toBe(true);
    }
    expect(engine.scopeIndexOf(-1)).toBeUndefined();
  });

  it('deleting a traced source drops its traces and degrades the window', async () => {
    useStore.setState(fresh());
    useStore.getState().loadNetlist(MULTIVIB, { noCenter: true, noBaseline: true });
    const st0 = useStore.getState();
    // One docked panel plus four windows, ten engine traces in all.
    const beforeScopes = traceScopes(st0.scopes, st0.elements);
    expect(beforeScopes).toHaveLength(5);
    expect(scopePlotsToSpecs(beforeScopes, st0.settings)).toHaveLength(10);

    // C1 is the capacitor the fourth window (the `7_128` token) traces; both
    // of its plots die with it, the way a docked scope's whole line would.
    const c1 = st0.elements.find(
      (e) => e.kind === 'capacitor' && e.x1 === 112 && e.y1 === 176,
    )!;
    useStore.getState().select([c1.id]);
    useStore.getState().deleteSelected();

    const state = useStore.getState();
    expect(state.elements.some((e) => e.id === c1.id)).toBe(false);
    const orphaned = state.elements.find(
      (e) => e.kind === 'scope' && e.text!.startsWith('7_'),
    )!;
    expect(orphaned.embedded!.plots.every((p) => p.elementId === null)).toBe(true);
    // The surviving windows are untouched and the spec count dropped by the
    // orphaned pair alone.
    const afterScopes = traceScopes(state.scopes, state.elements);
    expect(afterScopes).toHaveLength(4);
    expect(embeddedScopeOf(orphaned)).toBeNull();

    // The engine still accepts the reduced list.
    const engine = await SimEngine.create();
    expect(engine.setCircuit(state.elements, state.settings, afterScopes)).toBeNull();
    expect(scopePlotsToSpecs(afterScopes, state.settings)).toHaveLength(8);

    // The draw degrades to the placeholder frame without throwing.
    const rec = new SvgRecorder();
    defFor('scope')!.draw(context(rec), orphaned);
    expect(rec.toString(64, 32)).toContain('>Scope<');
  });

  it('duplicating a window and its source allocates disjoint plot ids', () => {
    useStore.setState(fresh());
    useStore.getState().loadNetlist(MULTIVIB, { noCenter: true, noBaseline: true });
    const st0 = useStore.getState();
    const win = st0.elements.find((e) => e.kind === 'scope')!;
    const source = st0.elements.find((e) => e.id === win.embedded!.plots[0].elementId)!;
    const originalIds = new Set(win.embedded!.plots.map((p) => p.id));

    useStore.getState().select([win.id, source.id]);
    useStore.getState().duplicateSelection();

    const st1 = useStore.getState();
    const copies = st1.elements.filter(
      (e) => e.kind === 'scope' && !st0.elements.some((old) => old.id === e.id),
    );
    expect(copies).toHaveLength(1);
    // The copy re-parsed its config token, so every plot got a fresh session
    // id: two windows must never share a trace identity, or one would draw
    // the other's ring.
    const copyIds = copies[0].embedded!.plots.map((p) => p.id);
    expect(copyIds).toHaveLength(2);
    for (const id of copyIds) {
      expect(originalIds.has(id)).toBe(false);
    }
    // And every other window in the document still owns its own ids.
    const allWindowPlotIds = st1.elements
      .filter((e) => e.kind === 'scope')
      .flatMap((e) => e.embedded!.plots.map((p) => p.id));
    expect(new Set(allWindowPlotIds).size).toBe(allWindowPlotIds.length);
  });
});

describe('sharedPlotElement', () => {
  // The Properties dialog's per-element Plots rows (a transistor's pin plots,
  // Show Charge, Show Resistance) are offered only when every plot names the
  // same element, upstream's allPlotsOneElm gate (Scope.java:1239-1246).
  const p = (id: number, elementId: number | null): ScopePlot => ({
    id,
    elementId,
    value: 'voltage',
    manScale: null,
    manVPosition: 0,
    acCoupled: false,
    measurements: null,
    origValueToken: null,
    origElementIndex: null,
  });

  it('returns the one element when every plot shares it', () => {
    expect(sharedPlotElement([p(1, 5), p(2, 5)])).toBe(5);
    expect(sharedPlotElement([p(1, 5)])).toBe(5);
  });

  it('returns null when two plots name different elements', () => {
    expect(sharedPlotElement([p(1, 5), p(2, 6)])).toBe(null);
  });

  it('ignores raw-only plots that carry no element', () => {
    // A preserved raw plot has no element id and no opinion about the shared
    // one; the resolvable plots still agree.
    expect(sharedPlotElement([p(1, 5), p(2, null), p(3, 5)])).toBe(5);
  });

  it('returns null when nothing resolves or the list is empty', () => {
    expect(sharedPlotElement([p(1, null)])).toBe(null);
    expect(sharedPlotElement([])).toBe(null);
  });
});
