/** The tool surface without a transport: the listing is exactly the command
 *  and query tables, the schemas are the definitions' own `args` objects, and
 *  dispatch maps a result to content and a refusal to `isError`. */

import { beforeEach, describe, expect, it } from 'vitest';
import { QUERIES } from '../src/commands/queries';
import { COMMANDS } from '../src/commands/registry';
import { useStore } from '../src/state/store';
import { fresh } from '../src/state/store.test-helpers';
import { buildTools, callTool, toolNameFor, TOOL_NAME_CHARSET, UNDO_HINT, type ToolHost } from './tools';

const host = (): ToolHost => ({ store: useStore });

beforeEach(() => useStore.setState(fresh()));

describe('tool listing', () => {
  it('has one tool per command and per query, with unique names', () => {
    const tools = buildTools();
    expect(tools).toHaveLength(COMMANDS.length + QUERIES.length);
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(TOOL_NAME_CHARSET);
  });

  it('derives every name from its id by replacing dots with underscores', () => {
    const ids = [...COMMANDS.map((d) => d.id), ...QUERIES.map((d) => d.id)];
    const tools = buildTools();
    for (const id of ids) {
      expect(toolNameFor(id)).toBe(id.replace(/\./g, '_'));
      expect(tools.some((t) => t.name === toolNameFor(id))).toBe(true);
    }
  });

  it('carries each definition args object by reference as the input schema', () => {
    const tools = buildTools();
    for (const def of COMMANDS) {
      const tool = tools.find((t) => t.name === toolNameFor(def.id));
      expect(tool?.inputSchema).toBe(def.args);
    }
    for (const def of QUERIES) {
      const tool = tools.find((t) => t.name === toolNameFor(def.id));
      expect(tool?.inputSchema).toBe(def.args);
    }
  });

  it('marks every query read only and no command', () => {
    const tools = buildTools();
    for (const def of QUERIES) {
      const tool = tools.find((t) => t.name === toolNameFor(def.id));
      expect(tool?.annotations.readOnlyHint).toBe(true);
    }
    for (const def of COMMANDS) {
      const tool = tools.find((t) => t.name === toolNameFor(def.id));
      expect(tool?.annotations.readOnlyHint).toBeUndefined();
    }
  });

  it('marks only destructive commands destructive', () => {
    const tools = buildTools();
    for (const def of COMMANDS) {
      const tool = tools.find((t) => t.name === toolNameFor(def.id));
      if (def.destructive === true) expect(tool?.annotations.destructiveHint).toBe(true);
      else expect(tool?.annotations.destructiveHint).toBeUndefined();
    }
    // The two document-replacing commands are the ones the flag exists for.
    const destructive = COMMANDS.filter((d) => d.destructive === true).map((d) => d.id);
    expect(destructive).toContain('circuit.new');
    expect(destructive).toContain('circuit.loadText');
  });

  it('appends the one-undo-step hint to edit commands only', () => {
    const tools = buildTools();
    for (const def of COMMANDS) {
      const tool = tools.find((t) => t.name === toolNameFor(def.id));
      // Exact, because one non-step description (settings.update) already
      // mentions the phrase; only a step command gets the appended sentence.
      if (def.history === 'step') expect(tool?.description).toBe(`${def.description} ${UNDO_HINT}`);
      else expect(tool?.description).toBe(def.description);
    }
    for (const def of QUERIES) {
      const tool = tools.find((t) => t.name === toolNameFor(def.id));
      expect(tool?.description).toBe(def.description);
    }
  });
});

describe('tool dispatch', () => {
  it('returns ok JSON text and structured content for a query', () => {
    const result = callTool('circuit_summary', {}, host());
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    const text = result.content[0];
    expect(text.type).toBe('text');
    if (text.type !== 'text') throw new Error('expected text');
    const parsed = JSON.parse(text.text) as { counts: { elements: number } };
    expect(parsed.counts.elements).toBe(0);
    expect(result.structuredContent).toEqual(parsed);
  });

  it('reports an invalid-args refusal as isError with the validator path', () => {
    // `element_add` requires kind and the four coordinates; an empty argument
    // object fails at the first missing one, and the path names it.
    const result = callTool('element_add', {}, host());
    expect(result.isError).toBe(true);
    const text = result.content[0];
    if (text.type !== 'text') throw new Error('expected text');
    const parsed = JSON.parse(text.text) as { error: string; message: string };
    expect(parsed.error).toBe('invalid-args');
    expect(parsed.message).toContain('args.');
    expect(result.structuredContent).toEqual({ error: 'invalid-args', message: parsed.message });
  });

  it('reports an unknown tool without throwing', () => {
    const result = callTool('nope_nothing', {}, host());
    expect(result.isError).toBe(true);
    const text = result.content[0];
    if (text.type !== 'text') throw new Error('expected text');
    expect(JSON.parse(text.text)).toMatchObject({ error: 'unknown' });
  });

  it('wraps a non-object command result so structuredContent stays an object', () => {
    const result = callTool(
      'element_add',
      { kind: 'resistor', x1: 0, y1: 0, x2: 64, y2: 0, params: { resistance: 1000 } },
      host(),
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ result: expect.any(Number) });
    expect(useStore.getState().elements).toHaveLength(1);
  });

  it('adds an SVG image block for schematic.svg and a text block for the rest', () => {
    const svg = callTool('schematic_svg', {}, host());
    expect(svg.isError).toBeUndefined();
    expect(svg.content).toHaveLength(2);
    expect(svg.content[0].type).toBe('text');
    const image = svg.content[1];
    expect(image.type).toBe('image');
    if (image.type !== 'image') throw new Error('expected image');
    expect(image.mimeType).toBe('image/svg+xml');
    expect(Buffer.from(image.data, 'base64').toString('utf8')).toContain('<svg');

    const summary = callTool('circuit_summary', {}, host());
    expect(summary.content).toHaveLength(1);
  });
});
