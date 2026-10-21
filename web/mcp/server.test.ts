/** The real server over the SDK's in-memory transport, with the wasm engine
 *  loaded the way `engine/simulator.test.ts` loads it. Every scenario goes
 *  through tools only, so the test exercises the same path an agent does: the
 *  listing, the dispatch, the store, the headless host and the engine. */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { SimEngine } from '../src/engine/simulator';
import { useStore } from '../src/state/store';
import { fresh } from '../src/state/store.test-helpers';
import { bootWasm } from './boot';
import { createHeadlessSimHost } from './headlessHost';
import { createCirquitServer, KINDS_URI, NETLIST_URI } from './server';
import type { ToolCallResult } from './tools';

/** One live client/server pair with the wasm engine attached. */
async function connect(): Promise<{ client: Client; engine: SimEngine }> {
  await bootWasm();
  const engine = await SimEngine.create();
  const store = useStore;
  store.getState().setSimHost(createHeadlessSimHost(engine, store));
  // The headless server starts paused, and so does this harness: `sim.step` is
  // refused while the run is live.
  store.getState().setRunning(false);
  const server = createCirquitServer({
    store,
    sim: {
      reset: () => engine.reset(),
      dcOperatingPoint: () => engine.findDcOperatingPoint(),
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'cirquit-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, engine };
}

/** A tool call that must succeed, returning its structured content. */
async function callOk(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args })) as ToolCallResult;
  expect(result.isError, `${name} failed: ${JSON.stringify(result.content)}`).toBeUndefined();
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

beforeEach(() => useStore.setState(fresh()));

describe('tools/list round trip', () => {
  it('lists every command and query as a tool', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(30);
    const names = tools.map((t) => t.name);
    expect(names).toContain('element_add');
    expect(names).toContain('kind_describe');
    expect(names).toContain('schematic_svg');
    // Every listed schema is the plain JSON Schema object the definitions use.
    for (const tool of tools) expect(tool.inputSchema.type).toBe('object');
  });
});

describe('Ohm law through tools only', () => {
  it('reads 10 mA through a 1 kOhm resistor on a 10 V source', async () => {
    const { client } = await connect();

    // Coordinates come from the registry, never hard-coded: the reference
    // orientation of each kind is what the server reports.
    const voltage = await callOk(client, 'kind_describe', { kind: 'voltage' });
    const vPosts = voltage.posts as { x: number; y: number }[];
    const resistor = await callOk(client, 'kind_describe', { kind: 'resistor' });
    const rPosts = resistor.posts as { x: number; y: number }[];
    const v0 = vPosts[0];
    const v1 = vPosts[1];
    const r0 = rPosts[0];
    const r1 = rPosts[1];

    await callOk(client, 'element_add', {
      kind: 'voltage',
      x1: v0.x,
      y1: v0.y,
      x2: v1.x,
      y2: v1.y,
      params: { maxVoltage: 10 },
    });
    const added = await callOk(client, 'element_add', {
      kind: 'resistor',
      x1: r0.x + v0.x,
      y1: r0.y + v0.y,
      x2: r1.x + v0.x,
      y2: r1.y + v0.y,
      params: { resistance: 1000 },
    });
    const resistorId = added.result as number;
    // A wire from the resistor's far post, around to the source's other post.
    await callOk(client, 'wire_add', {
      points: [
        [r1.x + v0.x, r1.y + v0.y],
        [r1.x + v0.x, v1.y],
        [v1.x, v1.y],
      ],
    });
    await callOk(client, 'element_add', {
      kind: 'ground',
      x1: v1.x,
      y1: v1.y,
      x2: v1.x,
      y2: v1.y + 64,
    });

    await callOk(client, 'sim_step', { seconds: 0.001 });
    const readings = await callOk(client, 'element_readings', { ids: [resistorId] });
    const first = (readings.readings as {
      posts: { voltage: { value: number }; current: { value: number } }[];
      power: { value: number };
    }[])[0];
    // 10 V across 1 kOhm: the drop is 10 V and each terminal exchanges 10 mA.
    // The signs depend on which way the source is drawn, so the magnitude is
    // the invariant the test asserts.
    const drop = Math.abs(first.posts[0].voltage.value - first.posts[1].voltage.value);
    expect(Math.abs(drop - 10)).toBeLessThan(1e-6);
    expect(Math.abs(Math.abs(first.posts[0].current.value) - 0.01)).toBeLessThan(1e-9);
    expect(Math.abs(Math.abs(first.posts[1].current.value) - 0.01)).toBeLessThan(1e-9);
    expect(Math.abs(first.power.value - 0.1)).toBeLessThan(1e-9);
  });
});

describe('reads build the circuit on demand', () => {
  it('reads engine values of a freshly built circuit without a sim.step', async () => {
    const { client } = await connect();
    await callOk(client, 'element_add', {
      kind: 'voltage',
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 64,
      params: { maxVoltage: 10 },
    });
    const added = await callOk(client, 'element_add', {
      kind: 'resistor',
      x1: 0,
      y1: 0,
      x2: 64,
      y2: 0,
      params: { resistance: 1000 },
    });
    await callOk(client, 'wire_add', {
      points: [
        [64, 0],
        [64, 64],
        [0, 64],
      ],
    });
    await callOk(client, 'element_add', { kind: 'ground', x1: 0, y1: 64, x2: 0, y2: 128 });

    // No `sim_step`: the read itself must build the engine. A missing build
    // would make the host return null for the element and the query report no
    // posts at all.
    const readings = await callOk(client, 'element_readings', { ids: [added.result as number] });
    const first = (readings.readings as { posts: unknown[] }[])[0];
    expect(first.posts).toHaveLength(2);
  });
});

describe('history batch and undo', () => {
  it('builds a divider as one agent entry, then undoes it in one step', async () => {
    const { client } = await connect();
    const before = useStore.getState().elements.length;

    await callOk(client, 'history_batch', {
      label: 'Build divider',
      calls: [
        { id: 'element.add', args: { kind: 'voltage', x1: 0, y1: 0, x2: 0, y2: 64, params: { maxVoltage: 10 } } },
        { id: 'element.add', args: { kind: 'resistor', x1: 0, y1: 0, x2: 64, y2: 0, params: { resistance: 1000 } } },
        { id: 'element.add', args: { kind: 'resistor', x1: 64, y1: 0, x2: 128, y2: 0, params: { resistance: 1000 } } },
        { id: 'element.add', args: { kind: 'wire', x1: 128, y1: 0, x2: 128, y2: 64, params: {} } },
        { id: 'element.add', args: { kind: 'wire', x1: 128, y1: 64, x2: 0, y2: 64, params: {} } },
        { id: 'element.add', args: { kind: 'ground', x1: 0, y1: 64, x2: 0, y2: 128, params: {} } },
      ],
    });
    expect(useStore.getState().elements.length).toBe(before + 6);

    const history = await callOk(client, 'history_list', {});
    const undo = history.undo as { label: string; source: string }[];
    expect(undo[0]).toEqual({ label: 'Build divider', source: 'agent' });

    await callOk(client, 'history_undo', {});
    expect(useStore.getState().elements.length).toBe(before);
    const after = await callOk(client, 'history_list', {});
    expect((after.undo as unknown[]).length).toBe(0);
  });
});

describe('circuit load and save', () => {
  // A corpus file whose every line the port round-trips byte for byte. The
  // `web/src/io/__fixtures__` files are parse fixtures, not round-trip
  // fixtures: the port re-emits capacitor and ground lines with their full
  // default token list, so byte identity is asserted against a real corpus
  // file that is already canonical.
  const CORPUS = readFileSync(
    fileURLToPath(new URL('../public/circuits/fanout.txt', import.meta.url)),
    'utf8',
  );

  it('loads a corpus file and saves it byte for byte', async () => {
    const { client } = await connect();
    await callOk(client, 'circuit_loadText', { text: CORPUS });
    const netlist = await callOk(client, 'circuit_netlist', {});
    expect(netlist.text).toBe(CORPUS);
  });

  it('preserves comment and unknown lines across a load and save', async () => {
    const file = [
      '$ 1 0.000005 10.20027730826997 50 5 43 5e-11',
      '',
      '# a note from the author',
      'r 0 0 16 0 0 100',
      '999 1 abc 0 100',
      'r 16 0 32 0 0 220',
      '',
    ].join('\n');
    const { client } = await connect();
    await callOk(client, 'circuit_loadText', { text: file });
    const netlist = await callOk(client, 'circuit_netlist', {});
    expect(netlist.text).toBe(file);
  });
});

describe('sim.step budget', () => {
  it('returns a stopped reason for an absurd duration instead of hanging', async () => {
    const { client } = await connect();
    await callOk(client, 'element_add', {
      kind: 'voltage',
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 64,
      params: { maxVoltage: 10 },
    });
    await callOk(client, 'element_add', {
      kind: 'resistor',
      x1: 0,
      y1: 0,
      x2: 64,
      y2: 0,
      params: { resistance: 1000 },
    });
    await callOk(client, 'wire_add', {
      points: [
        [64, 0],
        [64, 64],
        [0, 64],
      ],
    });
    await callOk(client, 'element_add', { kind: 'ground', x1: 0, y1: 64, x2: 0, y2: 128 });

    const started = Date.now();
    const stepped = await callOk(client, 'sim_step', { seconds: 1e9 });
    const elapsed = Date.now() - started;
    expect(typeof stepped.stopped).toBe('string');
    expect(stepped.steps).toBeLessThanOrEqual(50_000);
    expect(elapsed).toBeLessThan(10_000);
  });
});

describe('resources', () => {
  it('lists and reads the netlist and kinds resources', async () => {
    const { client } = await connect();
    await callOk(client, 'element_add', {
      kind: 'resistor',
      x1: 0,
      y1: 0,
      x2: 64,
      y2: 0,
      params: { resistance: 1000 },
    });

    const listed = await client.listResources();
    const uris = listed.resources.map((r) => r.uri);
    expect(uris).toContain(NETLIST_URI);
    expect(uris).toContain(KINDS_URI);

    const netlist = await client.readResource({ uri: NETLIST_URI });
    const netlistText = netlist.contents[0];
    expect(netlistText.mimeType).toBe('text/plain');
    expect('text' in netlistText && netlistText.text).toContain('r 0 0 64 0 0 1000');

    const kinds = await client.readResource({ uri: KINDS_URI });
    const kindsText = kinds.contents[0];
    expect(kindsText.mimeType).toBe('application/json');
    if ('text' in kindsText) {
      const parsed = JSON.parse(kindsText.text) as { kinds: { kind: string }[] };
      expect(parsed.kinds.some((k) => k.kind === 'resistor')).toBe(true);
    }
  });
});

// The purity check spawns the built artifact, which only exists after
// `just mcp-build` (part of `just build`). It is skipped when the artifact is
// absent so `just test-web` on a clean tree still runs; `just ci` builds the
// artifact in its build step, so the entry is still gated there.
const ARTIFACT = fileURLToPath(new URL('../dist-mcp/cirquit-mcp.mjs', import.meta.url));
const hasArtifact = existsSync(ARTIFACT);

describe.skipIf(!hasArtifact)('stdio stdout purity', () => {
  it('writes nothing to stdout but protocol frames', () => {
    const frames = [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'purity', version: '0' },
        },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ];
    const input = `${frames.map((f) => JSON.stringify(f)).join('\n')}\n`;
    const proc = spawnSync(process.execPath, [ARTIFACT], { input, encoding: 'utf8' });
    expect(proc.status).toBe(0);
    const lines = proc.stdout.split('\n').filter((line) => line.trim() !== '');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const message = JSON.parse(line) as { jsonrpc?: string };
      expect(message.jsonrpc).toBe('2.0');
    }
    expect(proc.stderr).toBe('');
  }, 30_000);
});
