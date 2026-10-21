/** The command and query tables as MCP tools.
 *
 *  One tool per command and one per query, so the tool surface is exactly the
 *  public mutation API plus its read side: nothing here re-implements a command
 *  or reaches past `execute`/`query`. The name is the dotted id with dots to
 *  underscores, the input schema is the definition's `args` object by
 *  reference (the hand-rolled schema subset is plain JSON Schema, so it
 *  serialises straight into a tool listing), and the annotations carry the two
 *  hints the definitions already imply: every query is read only, and a
 *  `destructive` command says so.
 *
 *  Dispatch is the same one door the UI uses: `execute(id, args, { source:
 *  'agent' })` or `query(id, args)`. A refusal is a normal tool result with
 *  `isError: true` and the error code and message; an unexpected throw is
 *  caught here so no handler ever escapes. */

import { execute } from '../src/commands/execute';
import { QUERIES, query } from '../src/commands/queries';
import { COMMANDS } from '../src/commands/registry';
import type { ArgSchema, CommandStore, SimControls } from '../src/commands/types';

/** The character set a tool name may use. MCP names are conventionally
 *  snake_case and must survive a JSON-RPC method name: lowercase start,
 *  letters, digits and underscores. Every registry id maps into it by replacing
 *  dots, and the registry test already pins the id grammar. */
export const TOOL_NAME_CHARSET = /^[a-z][A-Za-z0-9_]*$/;

/** The MCP tool name for a command or query id. Dots become underscores; no
 *  prefix, because the id grammar already keeps names unambiguous. */
export function toolNameFor(id: string): string {
  return id.replace(/\./g, '_');
}

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

/** The subset of the SDK's `Tool` this server builds. Kept structural so
 *  `tools.test.ts` can assert on it without importing the SDK. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: ArgSchema;
  annotations: McpToolAnnotations;
}

/** A command that opens exactly one undo step gets this sentence appended to
 *  its description, so a listing tells an agent which tools move the undo
 *  stack. `history: 'step'` is the definition of an edit. */
export const UNDO_HINT = 'Writes the document as one undo step.';

function describeEdit(description: string, history: string): string {
  return history === 'step' ? `${description} ${UNDO_HINT}` : description;
}

/** The tool listing, in registry order: every command then every query. */
export function buildTools(): McpTool[] {
  const tools: McpTool[] = [];
  for (const def of COMMANDS) {
    tools.push({
      name: toolNameFor(def.id),
      description: describeEdit(def.description, def.history),
      inputSchema: def.args,
      annotations: def.destructive === true ? { destructiveHint: true } : {},
    });
  }
  for (const def of QUERIES) {
    tools.push({
      name: toolNameFor(def.id),
      description: def.description,
      inputSchema: def.args,
      annotations: { readOnlyHint: true },
    });
  }
  return tools;
}

/** The side a tool name dispatches to, resolved once from the two tables. */
interface ToolRoute {
  id: string;
  side: 'command' | 'query';
}

const ROUTES: ReadonlyMap<string, ToolRoute> = new Map([
  ...COMMANDS.map((def): [string, ToolRoute] => [toolNameFor(def.id), { id: def.id, side: 'command' }]),
  ...QUERIES.map((def): [string, ToolRoute] => [toolNameFor(def.id), { id: def.id, side: 'query' }]),
]);

export interface ToolContentText {
  type: 'text';
  text: string;
}

export interface ToolContentImage {
  type: 'image';
  data: string;
  mimeType: string;
}

export type ToolContent = ToolContentText | ToolContentImage;

/** The tool result shape the server returns. Structural, so the SDK validates
 *  it as its own `CallToolResult` and the tests can read it directly. A type
 *  alias rather than an interface so it carries the implicit index signature
 *  the SDK's handler return type wants. */
export type ToolCallResult = {
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** The host a tool call runs against: the store, plus the engine controls the
 *  two run-control commands need. The server fills `sim` from its `SimEngine`. */
export interface ToolHost {
  store: CommandStore;
  sim?: SimControls;
}

/** True for a plain object (not null, not an array), which is what MCP
 *  `structuredContent` must be. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function okResult(id: string, value: unknown): ToolCallResult {
  const content: ToolContent[] = [{ type: 'text', text: JSON.stringify(value ?? null) }];
  // `schematic.svg` also hands back the drawing itself, so a host that renders
  // images can show it. The data is the SVG text base64-encoded: no rasterising
  // and no native dependency, and a truncated (invalid XML) payload is left out.
  if (
    id === 'schematic.svg' &&
    isRecord(value) &&
    typeof value.svg === 'string' &&
    value.truncated !== true
  ) {
    content.push({
      type: 'image',
      data: Buffer.from(value.svg, 'utf8').toString('base64'),
      mimeType: 'image/svg+xml',
    });
  }
  // `structuredContent` must be an object; a command that returns a number, an
  // array or nothing is wrapped so the field is still present and typed.
  return { content, structuredContent: isRecord(value) ? value : { result: value ?? null } };
}

function failure(error: string, message: string): ToolCallResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error, message }) }],
    structuredContent: { error, message },
  };
}

/** Run one tool call. Unknown names, invalid arguments, refusals and thrown
 *  errors all come back as a result; this function never throws. */
export function callTool(name: string, args: unknown, host: ToolHost): ToolCallResult {
  try {
    const route = ROUTES.get(name);
    if (route === undefined) return failure('unknown', `Unknown tool "${name}".`);
    if (route.side === 'query') {
      const result = query(route.id, args ?? {}, { store: host.store });
      return result.ok ? okResult(route.id, result.value) : failure(result.error, result.message);
    }
    const result = execute(route.id, args ?? {}, {
      store: host.store,
      source: 'agent',
      ...(host.sim !== undefined ? { sim: host.sim } : {}),
    });
    return result.ok ? okResult(route.id, result.value) : failure(result.error, result.message);
  } catch (e) {
    return failure('failed', e instanceof Error ? e.message : String(e));
  }
}
