/** The read side against a real engine: Ohm's law readings, the RC charge
 *  through `sim.step`, the scope sample cap, the browser host's step refusal,
 *  and the port's node-number mirror against the engine's own assignment. */

import { beforeEach, describe, expect, it } from 'vitest';
import { SimEngine } from '../engine/simulator';
import { assignNodes } from '../model/nets';
import type { CircuitElement } from '../model/types';
import { registerScopeWidth, scopeWidth } from '../scope/geometry';
import { traceScopes } from '../scope/embedded';
import { useStore } from '../state/store';
import { fresh } from '../state/store.test-helpers';
import { beginReadoutFrame } from '../ui/useLiveSimReadout';
import { createBrowserSimHost } from '../ui/canvas/browserSimHost';
import { execute } from './execute';
import { query } from './queries';
import type { CommandContext } from './types';

const ctx: CommandContext = { store: useStore, source: 'user' };
const qctx = { store: useStore };

/** Forces the shared per-frame readout cache to refetch, so a read after a run
 *  never returns the previous fetch's arrays. */
let stamp = 0;
function freshFrame(): void {
  beginReadoutFrame(++stamp);
}

function add(e: Omit<CircuitElement, 'id'>): number {
  return useStore.getState().addElement(e);
}

/** Builds a circuit in the store, hands it to the engine with the store's
 *  scopes and settings, and attaches the browser host. Returns the engine. */
async function attach(widthOf = scopeWidth): Promise<SimEngine> {
  const s = useStore.getState();
  const engine = await SimEngine.create();
  const scopes = traceScopes(s.scopes, s.elements);
  expect(engine.setCircuit(s.elements, s.settings, scopes, widthOf)).toBeNull();
  useStore.getState().setSimHost(createBrowserSimHost(engine, useStore));
  return engine;
}

beforeEach(() => {
  useStore.setState(fresh());
});

/** 10 V across 1 kOhm: the source's + at (0,0), the resistor to (100,0), a wire
 *  back to the grounded source minus. */
function ohmCircuit(): { resistor: number } {
  add({ kind: 'voltage', x1: 0, y1: 100, x2: 0, y2: 0, flags: 0, params: { maxVoltage: 10 } });
  const resistor = add({
    kind: 'resistor',
    x1: 0,
    y1: 0,
    x2: 100,
    y2: 0,
    flags: 0,
    params: { resistance: 1000 },
  });
  add({ kind: 'wire', x1: 100, y1: 0, x2: 100, y2: 100, flags: 0, params: {} });
  add({ kind: 'wire', x1: 100, y1: 100, x2: 0, y2: 100, flags: 0, params: {} });
  add({ kind: 'ground', x1: 0, y1: 100, x2: 0, y2: 132, flags: 0, params: {} });
  return { resistor };
}

describe('element.readings', () => {
  it('reports Ohm law values for a 10 V source across 1 kOhm', async () => {
    const { resistor } = ohmCircuit();
    const engine = await attach();
    engine.run(5);
    freshFrame();

    const result = query('element.readings', { ids: [resistor] }, qctx) as {
      ok: true;
      value: {
        readings: {
          posts: { voltage: { value: number; unit: string }; current: { value: number } }[];
          power: { value: number; unit: string };
        }[];
      };
    };
    expect(result.ok).toBe(true);
    const reading = result.value.readings[0];
    expect(Math.abs(reading.posts[0].voltage.value - 10)).toBeLessThan(1e-6);
    expect(Math.abs(reading.posts[1].voltage.value)).toBeLessThan(1e-6);
    // Current into the node: -10 mA at post 0, +10 mA at post 1, within 1e-9
    // relative.
    expect(Math.abs(reading.posts[0].current.value + 0.01)).toBeLessThan(1e-9 * 0.01);
    expect(Math.abs(reading.posts[1].current.value - 0.01)).toBeLessThan(1e-9 * 0.01);
    expect(reading.posts[0].voltage.unit).toBe('V');
    expect(Math.abs(reading.power.value - 0.1)).toBeLessThan(1e-9 * 0.1);
    expect(reading.power.unit).toBe('W');
  });
});

describe('node numbering mirrors the engine', () => {
  it('assigns the same node per post as elementNodes', async () => {
    ohmCircuit();
    const engine = await attach();
    const mine = assignNodes(useStore.getState().elements).nodes;
    expect(Array.from(engine.elementNodes())).toEqual(mine);
  });
});

describe('sim.step', () => {
  /** The ohm circuit with a 1 uF capacitor across the resistor: tau = 1 ms. */
  function rcCircuit(): { capacitor: number } {
    add({ kind: 'voltage', x1: 0, y1: 100, x2: 0, y2: 0, flags: 0, params: { maxVoltage: 10 } });
    add({ kind: 'resistor', x1: 0, y1: 0, x2: 100, y2: 0, flags: 0, params: { resistance: 1000 } });
    const capacitor = add({
      kind: 'capacitor',
      x1: 100,
      y1: 0,
      x2: 100,
      y2: 100,
      flags: 0,
      params: { capacitance: 1e-6, voltDiff: 0 },
    });
    add({ kind: 'wire', x1: 100, y1: 100, x2: 0, y2: 100, flags: 0, params: {} });
    add({ kind: 'ground', x1: 0, y1: 100, x2: 0, y2: 132, flags: 0, params: {} });
    return { capacitor };
  }

  it('charges the capacitor to V(1 - 1/e) at t = RC', async () => {
    const { capacitor } = rcCircuit();
    const engine = await attach();
    useStore.getState().setRunning(false);

    // tau = 1 kOhm * 1 uF = 1 ms.
    const stepped = execute('sim.step', { seconds: 1e-3 }, ctx);
    expect(stepped.ok, JSON.stringify(stepped)).toBe(true);
    expect(engine.time).toBeCloseTo(1e-3, 9);
    freshFrame();

    const result = query('element.readings', { ids: [capacitor] }, qctx) as {
      ok: true;
      value: { readings: { posts: { voltage: { value: number } }[] }[] };
    };
    const posts = result.value.readings[0].posts;
    const v = posts[0].voltage.value - posts[1].voltage.value;
    expect(v).toBeGreaterThan(10 * (1 - 1 / Math.E) * 0.99);
    expect(v).toBeLessThan(10 * (1 - 1 / Math.E) * 1.01);
  });

  it('is disabled while the run is live with the pause reason', async () => {
    rcCircuit();
    await attach();
    useStore.getState().setRunning(true);
    const result = execute('sim.step', { seconds: 1e-3 }, ctx);
    expect(result).toMatchObject({ ok: false, error: 'disabled' });
    expect((result as { message: string }).message).toBe('pause the simulation first');
  });
});

describe('browser host step refusal', () => {
  it('refuses while running with the reason, and steps when paused', async () => {
    const { capacitor } = (() => {
      add({ kind: 'voltage', x1: 0, y1: 100, x2: 0, y2: 0, flags: 0, params: { maxVoltage: 10 } });
      add({ kind: 'resistor', x1: 0, y1: 0, x2: 100, y2: 0, flags: 0, params: { resistance: 1000 } });
      const capacitor = add({
        kind: 'capacitor',
        x1: 100,
        y1: 0,
        x2: 100,
        y2: 100,
        flags: 0,
        params: { capacitance: 1e-6, voltDiff: 0 },
      });
      add({ kind: 'wire', x1: 100, y1: 100, x2: 0, y2: 100, flags: 0, params: {} });
      add({ kind: 'ground', x1: 0, y1: 100, x2: 0, y2: 132, flags: 0, params: {} });
      return { capacitor };
    })();
    const engine = await attach();
    const host = useStore.getState().simHost!;

    useStore.getState().setRunning(true);
    expect(host.step(1e-3, 1000)).toEqual({ time: 0, steps: 0, stopped: 'pause the simulation first' });
    expect(engine.time).toBe(0);

    useStore.getState().setRunning(false);
    const stepped = host.step(1e-3, 1000);
    expect(stepped.steps).toBe(200);
    expect(stepped.stopped).toBeUndefined();
    expect(engine.time).toBeCloseTo(1e-3, 9);
    void capacitor;
  });
});

describe('scope.samples', () => {
  it('respects the point cap and the truncated flag', async () => {
    // A wide, slow scope: a 2048 px ring is 4096 columns and one column per
    // step, so 3000 steps write more points than the cap allows.
    add({ kind: 'voltage', x1: 0, y1: 100, x2: 0, y2: 0, flags: 0, params: { maxVoltage: 10 } });
    const resistor = add({
      kind: 'resistor',
      x1: 0,
      y1: 0,
      x2: 100,
      y2: 0,
      flags: 0,
      params: { resistance: 1000 },
    });
    add({ kind: 'wire', x1: 100, y1: 0, x2: 100, y2: 100, flags: 0, params: {} });
    add({ kind: 'wire', x1: 100, y1: 100, x2: 0, y2: 100, flags: 0, params: {} });
    add({ kind: 'ground', x1: 0, y1: 100, x2: 0, y2: 132, flags: 0, params: {} });
    const scopeId = (execute('scope.add', { elementId: resistor }, ctx) as { value: number })
      .value as number;
    execute('scope.setSpeed', { scopeId, speed: 1 }, ctx);
    registerScopeWidth(scopeId, 2048);

    const engine = await attach();
    engine.run(3000);
    freshFrame();

    const result = query('scope.samples', { scopeId }, qctx) as {
      ok: true;
      value: {
        points: number;
        truncated: boolean;
        time: { values: number[]; unit: string };
        plots: { values: number[]; unit: string; display: string[] }[];
      };
    };
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.value.points).toBe(2048);
    expect(result.value.truncated).toBe(true);
    expect(result.value.time.values).toHaveLength(2048);
    expect(result.value.time.unit).toBe('s');
    expect(result.value.plots[0].values).toHaveLength(2048);
    expect(result.value.plots[0].display).toHaveLength(2048);
    expect(result.value.plots[0].unit).toBe('V');

    const short = query('scope.samples', { scopeId, last: 100 }, qctx) as {
      ok: true;
      value: { points: number; truncated: boolean; time: { values: number[] } };
    };
    expect(short.value.points).toBe(100);
    expect(short.value.truncated).toBe(true);
    expect(short.value.time.values).toHaveLength(100);
  });
});
