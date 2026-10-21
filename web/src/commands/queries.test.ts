/** The read side's contract: queries are pure (the store fingerprint, both
 *  revision counters and the history are untouched), the descriptions round
 *  trip through `element.add`, and the reuse paths (netlist, history, SVG) say
 *  what they claim. All wasm-free; the live-value paths are exercised by the
 *  stub host here and by a real engine in `queries.engine.test.ts`. */

import { beforeEach, describe, expect, it } from 'vitest';
import { parseCircuit } from '../io/netlist';
import { ELEMENT_DEFS, postsOf } from '../model/registry';
import { makeElement } from '../state/helpers';
import { cachedSnapshotKey, snapshotKey } from '../state/history';
import { useStore } from '../state/store';
import { fresh } from '../state/store.test-helpers';
import type { HistorySource } from '../state/history';
import type { SimHost } from '../engine/simHost';
import { execute } from './execute';
import { QUERIES, query, queryById } from './queries';
import type { CommandContext } from './types';

const ctx = { store: useStore };
const cmdCtx = (source: HistorySource = 'user'): CommandContext => ({ store: useStore, source });

/** A deterministic stand-in for the engine: the read paths are exercised, the
 *  values are constants. The real host is in `ui/canvas/browserSimHost.ts`. */
const stubHost = (): SimHost => ({
  sync: () => {},
  time: () => 0.5,
  running: () => false,
  step: () => ({ time: 0.5, steps: 1 }),
  nodeVoltages: () => new Float64Array([0, 5, 10]),
  elementReadings: () => ({ voltages: [0, 5], currents: [-0.01, 0.01], power: 0.05 }),
  infoLines: () => ['resistor'],
  scopeSamples: () => ({ t: [0, 1e-3], plots: [{ label: 'Resistor voltage', values: [0, 5] }] }),
});

const addArgs = (kind = 'resistor', x = 0, y = 0) => ({
  kind,
  x1: x,
  y1: y,
  x2: x + 160,
  y2: y,
  params: kind === 'resistor' ? { resistance: 1000 } : {},
});

/** A store with one resistor, one ground and one scope, enough for every
 *  query's sample args. Returns the resistor id and the scope id. */
function seed(): { resistor: number; scope: number } {
  useStore.setState(fresh());
  const resistor = (execute('element.add', addArgs(), cmdCtx()) as { value: number }).value;
  execute('element.add', addArgs('ground', 160, 0), cmdCtx());
  const scope = (execute('scope.add', { elementId: resistor }, cmdCtx()) as { value: number })
    .value as number;
  useStore.getState().setSimHost(stubHost());
  return { resistor, scope };
}

const sampleArgs = (ids: { resistor: number; scope: number }): Record<string, unknown> => ({
  'kinds.list': {},
  'kind.describe': { kind: 'resistor' },
  'circuit.netlist': {},
  'circuit.summary': {},
  'elements.list': {},
  'element.get': { id: ids.resistor },
  'nodes.list': {},
  'element.readings': { ids: [ids.resistor] },
  'scopes.list': {},
  'scope.samples': { scopeId: ids.scope },
  'sim.state': {},
  'history.list': {},
  'schematic.svg': {},
});

describe('query table', () => {
  it('has unique dotted lowercase ids and a valid schema per query', () => {
    const seen = new Set<string>();
    for (const def of QUERIES) {
      expect(def.id).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/);
      expect(seen.has(def.id)).toBe(false);
      seen.add(def.id);
      expect(def.description.trim().length).toBeGreaterThan(20);
      expect(queryById(def.id)).toBe(def);
    }
  });
});

describe('queries are pure', () => {
  it('leaves the snapshot, revisions and history unchanged for every query', () => {
    const ids = seed();
    const beforeKey = snapshotKey(useStore.getState());
    const beforeCached = cachedSnapshotKey(useStore.getState());
    const before = {
      revision: useStore.getState().revision,
      paramRevision: useStore.getState().paramRevision,
      undo: useStore.getState().history.undo.map((e) => [e.label, e.source]),
      redo: useStore.getState().history.redo.map((e) => [e.label, e.source]),
    };

    for (const [id, args] of Object.entries(sampleArgs(ids))) {
      const result = query(id, args, ctx);
      expect(result.ok, `${id}: ${JSON.stringify(result)}`).toBe(true);
      // The uncached fingerprint catches an in-place mutation the WeakMap-keyed
      // cache would hide; the cached key is the plan's own check.
      expect(snapshotKey(useStore.getState()), id).toBe(beforeKey);
      expect(cachedSnapshotKey(useStore.getState()), id).toBe(beforeCached);
      expect(useStore.getState().revision, id).toBe(before.revision);
      expect(useStore.getState().paramRevision, id).toBe(before.paramRevision);
      expect(useStore.getState().history.undo.map((e) => [e.label, e.source]), id).toEqual(before.undo);
      expect(useStore.getState().history.redo.map((e) => [e.label, e.source]), id).toEqual(before.redo);
    }
  });

  it('returns a copy of the params, not a view into the store', () => {
    const ids = seed();
    const result = query('elements.list', {}, ctx) as {
      ok: true;
      value: { elements: { id: number; params: Record<string, number> }[] };
    };
    const entry = result.value.elements.find((e) => e.id === ids.resistor)!;
    entry.params.resistance = 999;
    expect(useStore.getState().elements.find((e) => e.id === ids.resistor)!.params.resistance).toBe(
      1000,
    );
  });
});

describe('engine-dependent queries without a host', () => {
  beforeEach(() => {
    useStore.setState(fresh());
    const resistor = (execute('element.add', addArgs(), cmdCtx()) as { value: number }).value;
    const scope = (execute('scope.add', { elementId: resistor }, cmdCtx()) as { value: number })
      .value as number;
    useStore.getState().setSimHost(null);
    void scope;
  });

  it('reports no-engine for readings, samples and state', () => {
    expect(query('element.readings', { ids: [1] }, ctx)).toMatchObject({
      ok: false,
      error: 'no-engine',
    });
    expect(query('scope.samples', { scopeId: 1 }, ctx)).toMatchObject({
      ok: false,
      error: 'no-engine',
    });
    expect(query('sim.state', {}, ctx)).toMatchObject({ ok: false, error: 'no-engine' });
  });

  it('still answers the static queries', () => {
    expect(query('elements.list', {}, ctx).ok).toBe(true);
    expect(query('nodes.list', {}, ctx).ok).toBe(true);
    expect(query('circuit.summary', {}, ctx).ok).toBe(true);
  });
});

describe('kind.describe', () => {
  it('round trips every kind through element.add and matches the reference posts', () => {
    useStore.setState(fresh());
    for (const def of ELEMENT_DEFS) {
      const described = query('kind.describe', { kind: def.kind }, ctx);
      expect(described.ok, def.kind).toBe(true);
      if (!described.ok) throw new Error(`${def.kind}: ${described.message}`);
      const value = described.value as {
        posts: { x: number; y: number }[];
        fields: { name: string; type: string; target: string; default: number | null }[];
      };
      expect(value.posts.length, def.kind).toBe(
        postsOf({ ...makeElement(def.kind, 0, 0, 64, 0), id: 0 }).length,
      );

      // The param-bound numeric/choice/bool fields' defaults are exactly what a
      // fresh placement carries, and feeding them back through element.add
      // succeeds: the description is a usable recipe.
      const params: Record<string, number> = {};
      for (const f of value.fields) {
        if (
          f.target === 'param' &&
          f.default !== null &&
          (f.type === 'number' || f.type === 'choice' || f.type === 'bool')
        ) {
          params[f.name] = f.default;
        }
      }
      const placed = execute(
        'element.add',
        { ...addArgs(def.kind), params },
        cmdCtx(),
      );
      expect(placed.ok, `${def.kind}: ${JSON.stringify(placed)}`).toBe(true);
      const added = useStore
        .getState()
        .elements.find((e) => e.id === (placed as { value: number }).value)!;
      for (const [name, v] of Object.entries(params)) {
        expect(added.params[name], `${def.kind}.${name}`).toBe(v);
      }
    }
  });

  it('names the grid terminals snap to', () => {
    const result = query('kind.describe', { kind: 'resistor' }, ctx) as {
      ok: true;
      value: { gridSize: { value: number; unit: string }; description: string };
    };
    expect(result.value.gridSize.value).toBe(16);
    expect(result.value.gridSize.unit).toBe('units');
    expect(result.value.description).toContain('snap to the grid');
  });

  it('refuses an unknown kind', () => {
    expect(query('kind.describe', { kind: 'nope' }, ctx)).toMatchObject({
      ok: false,
      error: 'invalid-args',
    });
  });
});

describe('elements.list and element.get agree', () => {
  it('reports the same params and coordinates', () => {
    const ids = seed();
    const list = query('elements.list', { kind: 'resistor' }, ctx) as {
      ok: true;
      value: { elements: { id: number; params: Record<string, number> }[] };
    };
    const one = query('element.get', { id: ids.resistor }, ctx) as {
      ok: true;
      value: { element: { id: number; params: Record<string, number>; coords: unknown }; posts: unknown[] };
    };
    const fromList = list.value.elements.find((e) => e.id === ids.resistor)!;
    expect(fromList.params).toEqual(one.value.element.params);
    expect(one.value.posts).toHaveLength(2);
  });

  it('filters by rect', () => {
    seed();
    const inside = query('elements.list', { inRect: { x1: -16, y1: -16, x2: 32, y2: 32 } }, ctx) as {
      ok: true;
      value: { elements: { kind: string }[] };
    };
    expect(inside.value.elements.map((e) => e.kind)).toEqual(['resistor']);
  });
});

describe('circuit.netlist', () => {
  const FILE = '$ 1 0.000005 10 50 5 43 5e-11\nr 0 0 16 0 0 1000\ng 16 0 16 32 0 0\n';

  it('equals saveNetlist and parses back to the same elements', () => {
    useStore.setState(fresh());
    useStore.getState().loadNetlist(FILE, { noCenter: true, noBaseline: true });
    const result = query('circuit.netlist', {}, ctx) as {
      ok: true;
      value: { text: string; truncated: boolean };
    };
    expect(result.value.text).toBe(useStore.getState().saveNetlist());
    // A loaded document round trips byte-for-byte.
    expect(result.value.text).toBe(FILE);
    expect(result.value.truncated).toBe(false);
    const reparsed = parseCircuit(result.value.text);
    expect(reparsed.elements).toHaveLength(useStore.getState().elements.length);
    expect(reparsed.elements.map((e) => e.kind)).toEqual(
      useStore.getState().elements.map((e) => e.kind),
    );
  });
});

describe('history.list', () => {
  it('names labels and sources, top first, with the redo side', () => {
    seed();
    const id = useStore.getState().elements[0].id;
    execute('element.move', { ids: [id], dx: 16, dy: 0 }, cmdCtx('agent'));

    const listed = query('history.list', {}, ctx) as {
      ok: true;
      value: {
        undo: { label: string; source: string }[];
        redo: { label: string; source: string }[];
        undoDepth: number;
      };
    };
    // Top first: the agent move then the user add (plus the scope add).
    expect(listed.value.undo[0]).toEqual({ label: 'Move', source: 'agent' });
    expect(listed.value.undo.some((e) => e.label === 'Add Resistor' && e.source === 'user')).toBe(true);

    execute('history.undo', {}, cmdCtx('agent'));
    const after = query('history.list', { limit: 1 }, ctx) as {
      ok: true;
      value: { undo: unknown[]; redo: { label: string }[]; redoDepth: number };
    };
    expect(after.value.undo).toHaveLength(1);
    expect(after.value.redo[0].label).toBe('Move');
    expect(after.value.redoDepth).toBe(1);
  });
});

describe('schematic.svg', () => {
  it('is deterministic and draws the element paths', () => {
    seed();
    const first = query('schematic.svg', {}, ctx) as { ok: true; value: { svg: string } };
    const second = query('schematic.svg', {}, ctx) as { ok: true; value: { svg: string } };
    expect(first.value.svg.startsWith('<svg')).toBe(true);
    expect(first.value.svg).toContain('<path');
    expect(first.value.svg).toBe(second.value.svg);
  });

  it('honours showValues and rect', () => {
    seed();
    const withValues = query('schematic.svg', { showValues: true }, ctx) as {
      ok: true;
      value: { svg: string };
    };
    const without = query('schematic.svg', { showValues: false }, ctx) as {
      ok: true;
      value: { svg: string };
    };
    expect(withValues.value.svg).not.toBe(without.value.svg);
    const empty = query('schematic.svg', { rect: { x1: 10000, y1: 10000, x2: 10010, y2: 10010 } }, ctx) as {
      ok: true;
      value: { svg: string };
    };
    expect(empty.value.svg).toContain('<svg');
  });
});

describe('nodes.list', () => {
  it('pins the ground coordinate to node 0 and lists the wire connections', () => {
    useStore.setState(fresh());
    const resistor = (execute('element.add', addArgs(), cmdCtx()) as { value: number }).value;
    execute('element.add', addArgs('ground', 160, 0), cmdCtx());
    const listed = query('nodes.list', {}, ctx) as {
      ok: true;
      value: { nodes: { node: number; ground: boolean; connections: { id: number }[] }[] };
    };
    const ground = listed.value.nodes.find((n) => n.node === 0)!;
    expect(ground.ground).toBe(true);
    const other = listed.value.nodes.find((n) => n.node !== 0)!;
    expect(other.connections.some((c) => c.id === resistor)).toBe(true);
  });
});

describe('unknown queries', () => {
  it('reports unknown ids and invalid args without throwing', () => {
    expect(query('nope', {}, ctx)).toEqual({
      ok: false,
      error: 'unknown',
      message: 'Unknown query "nope".',
    });
    expect(query('element.get', {}, ctx)).toMatchObject({ ok: false, error: 'invalid-args' });
  });
});
