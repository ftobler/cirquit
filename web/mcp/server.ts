/** The stdio MCP server entry.
 *
 *  It wires the SDK's low-level `Server` to the tool table in `tools.ts` and
 *  two thin resources, then connects a `StdioServerTransport`. stdout is the
 *  protocol channel and carries nothing else: all diagnostics go to stderr
 *  through `log`, and no handler ever throws out (a tool failure is a normal
 *  `isError` result, and a resource failure comes back as error text).
 *
 *  One document per process, fresh at boot. `--load <file>` reads a netlist
 *  once at startup; everything after that goes through `circuit_loadText`.
 *  There is no filesystem tool: the agent's own file tools read and write
 *  files, and this server only ever sees netlist text. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { query } from '../src/commands/queries';
import { SimEngine } from '../src/engine/simulator';
import { useStore } from '../src/state/store';
import { bootWasm } from './boot';
import { createHeadlessSimHost } from './headlessHost';
import { buildTools, callTool, type ToolHost } from './tools';

export const SERVER_NAME = 'cirquit';
export const SERVER_VERSION = '0.1.0';

export const NETLIST_URI = 'cirquit://netlist';
export const KINDS_URI = 'cirquit://kinds';

/** The two resources. They exist for hosts that prefer a resource read over a
 *  tool call; both are thin wrappers over the query table, never a second
 *  implementation of the read. */
export const RESOURCES = [
  {
    uri: NETLIST_URI,
    name: 'Circuit netlist',
    description: 'The current circuit as netlist text, with live state overlaid.',
    mimeType: 'text/plain',
  },
  {
    uri: KINDS_URI,
    name: 'Element kinds',
    description: 'Every element kind the registry knows, with label, category and terminal count.',
    mimeType: 'application/json',
  },
];

/** Diagnostics. The one place this process writes, and never to stdout. */
export function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Reads one resource through the query table. A failure is reported as the
 *  resource text rather than thrown, so a handler cannot take the process down.
 */
function readResource(
  uri: string,
  host: ToolHost,
): { uri: string; mimeType: string; text: string } {
  const id = uri === NETLIST_URI ? 'circuit.netlist' : uri === KINDS_URI ? 'kinds.list' : null;
  if (id === null) {
    return {
      uri,
      mimeType: 'text/plain',
      text: JSON.stringify({ error: 'unknown', message: `Unknown resource "${uri}".` }),
    };
  }
  const result = query(id, {}, { store: host.store });
  if (!result.ok) {
    return {
      uri,
      mimeType: 'text/plain',
      text: JSON.stringify({ error: result.error, message: result.message }),
    };
  }
  const value = result.value;
  const text =
    id === 'circuit.netlist' && typeof value === 'object' && value !== null && 'text' in value
      ? String((value as { text: unknown }).text)
      : JSON.stringify(value);
  return { uri, mimeType: id === 'circuit.netlist' ? 'text/plain' : 'application/json', text };
}

/** Build the server and wire its handlers. Exported so a test can drive the
 *  real server over an in-memory transport without spawning a process. */
export function createCirquitServer(host: ToolHost): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );
  const tools = buildTools();
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return callTool(name, args ?? {}, host);
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
    contents: [readResource(request.params.uri, host)],
  }));
  return server;
}

/** `--load <file>`, or null when absent. */
function parseLoadArg(argv: string[]): string | null {
  const index = argv.indexOf('--load');
  if (index === -1) return null;
  const file = argv[index + 1];
  if (file === undefined || file.startsWith('--')) {
    throw new Error('--load needs a file path');
  }
  return file;
}

export async function main(argv: string[]): Promise<void> {
  const loadFile = parseLoadArg(argv);
  await bootWasm();
  const engine = await SimEngine.create();
  const store = useStore;
  const host: ToolHost = {
    store,
    sim: {
      reset: () => engine.reset(),
      dcOperatingPoint: () => engine.findDcOperatingPoint(),
    },
  };
  store.getState().setSimHost(createHeadlessSimHost(engine, store));
  // Headless starts paused: `sim.run` and `sim.pause` only move this flag, and
  // nothing advances the clock except `sim.step`, which refuses while it is set.
  store.getState().setRunning(false);
  if (loadFile !== null) {
    const failure = store.getState().loadNetlist(readFileSync(loadFile, 'utf8'));
    if (failure !== null) {
      log(`--load ${loadFile}: ${failure}`);
      process.exitCode = 1;
      return;
    }
  }
  const server = createCirquitServer(host);
  await server.connect(new StdioServerTransport());
}

/** True when this module is the process entry point rather than an import
 *  from a test. */
function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    log(`cirquit MCP server failed to start: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
