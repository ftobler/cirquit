/** The read side of the command level: the query table.
 *
 *  A query is the mirror of a command, minus the parts that make a command a
 *  mutation: no `history`, no `edits`, no `enabled` gate, and a `run` that only
 *  reads. Queries never call `set`, never open a transaction and never mutate
 *  the store; `queries.test.ts` pins that over every id. Step 4 lists these as
 *  MCP tools beside the commands.
 *
 *  The engine stays out of the store: live values arrive through a `SimHost`
 *  (`engine/simHost.ts`) that the browser fills in from the frame loop's
 *  per-frame cache and step 4's headless runner fills in from its own build and
 *  step loop. A query that needs the engine refuses with `no-engine` when no
 *  host is attached, instead of reporting a stale zero.
 *
 *  Units contract: every measured number is reported in SI base units with a
 *  `unit` string beside it, and the human-readable `formatValue` output rides a
 *  separate `display` field. An agent computes on the number; a person reads
 *  the display. The display never replaces the number. */

import { cachedBusWidths, postsForRender } from '../model/busWidths';
import { assignNodes } from '../model/nets';
import { ELEMENT_DEFS, defFor, postsOf } from '../model/registry';
import { GRID_SIZE, fieldLabel, type CircuitElement, type FieldDef } from '../model/types';
import { formatValue } from '../render/draw';
import { renderCircuitToSvg } from '../render/svg';
import { sharedPlotElement } from '../engine/scopeModel';
import { UNIT } from '../scope/units';
import { makeGhostElement } from '../state/helpers';
import type { AppState } from '../state/types';
import { circuitBounds } from '../state/view';
import { validateArgs } from './schema';
import type { ArgSchema, CommandStore } from './types';

/** The error a query can report. `no-engine` is the read side's own: the
 *  request needs live values and no `SimHost` is attached. */
export type QueryError = 'unknown' | 'invalid-args' | 'failed' | 'no-engine';

export type QueryResult<R = unknown> =
  | { ok: true; value: R }
  | { ok: false; error: QueryError; message: string };

/** A thrown query refusal, mapped to a `QueryResult` by `query`. Kept separate
 *  from `CommandFailure` so the error union can carry `no-engine` without
 *  widening the command side. */
export class QueryFailure extends Error {
  constructor(
    readonly error: QueryError,
    message: string,
  ) {
    super(message);
    this.name = 'QueryFailure';
  }
}

export interface QueryContext {
  store: CommandStore;
}

export interface QueryDef<A = unknown, R = unknown> {
  /** Stable dotted id, the public name. Shares the command id grammar so an
   *  MCP tool name derives the same way. */
  id: string;
  label: string;
  /** One paragraph for tool listings: what it returns, units, what ids mean. */
  description: string;
  args: ArgSchema;
  run(ctx: QueryContext, args: A): R;
}

// ─── size caps ───

/** `circuit.netlist` is capped at a megabyte. The largest bundled sheet is
 *  about 16 kB, so a real document never reaches it; the cap only stops one
 *  generated or corrupt document from ballooning a tool response. A truncated
 *  payload is a prefix of the text and carries `truncated: true`. */
export const MAX_NETLIST_CHARS = 1_000_000;

/** `schematic.svg` is capped at two megabytes: an SVG of a large schematic is
 *  path data and is several times the netlist's size, while a small one is a
 *  few kB. Truncated markup is not valid XML and is flagged so. */
export const MAX_SVG_CHARS = 2_000_000;

/** `scope.samples` is capped at 2048 points. A scope ring holds up to 8192
 *  columns; 2048 is enough to see a waveform's shape while keeping one tool
 *  response small, and the caller narrows further with `last`. */
export const MAX_SCOPE_SAMPLES = 2048;

// ─── quantity shapes ───

/** A measured number: the SI value, its unit, and the formatted display. */
export interface Quantity {
  value: number;
  unit: string;
  display: string;
}

/** A measured series: SI values, one unit, and the per-value display. */
export interface QuantityList {
  values: number[];
  unit: string;
  display: string[];
}

const quantity = (value: number, unit: string, digits: number): Quantity => ({
  value,
  unit,
  display: formatValue(value, unit, digits),
});

const quantityList = (values: number[], unit: string, digits: number): QuantityList => ({
  values,
  unit,
  display: values.map((v) => formatValue(v, unit, digits)),
});

// ─── shared summaries ───

export interface ElementSummary {
  id: number;
  kind: string;
  label: string;
  text: string | null;
  coords: { x1: number; y1: number; x2: number; y2: number };
  params: Record<string, number>;
}

export interface FieldSummary {
  name: string;
  label: string;
  unit: string | null;
  type: string;
  default: number | null;
  min: number | null;
  max: number | null;
  integer: boolean;
  choices: { value: number; label: string }[] | null;
  flag: number | null;
  target: string;
}

function elementSummary(e: CircuitElement): ElementSummary {
  return {
    id: e.id,
    kind: e.kind,
    label: defFor(e.kind)?.label ?? e.kind,
    text: e.text ?? null,
    coords: { x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2 },
    // A copy, never a live view into the store: a query result is plain data
    // the caller may keep or mutate.
    params: { ...e.params },
  };
}

/** The default a field would carry on a freshly built element: its own `get`
 *  view when derived, the stored param otherwise, and the flag bit for a bool
 *  that binds a flag. Null when the field binds text or a model name. */
function fieldDefault(e: CircuitElement, f: FieldDef): number | null {
  if (f.get) return f.get(e);
  if (f.flag !== undefined) return (e.flags & f.flag) !== 0 ? 1 : 0;
  if ((f.target ?? 'param') !== 'param') return null;
  const v = e.params[f.name];
  return v === undefined ? null : v;
}

function fieldSummary(e: CircuitElement, f: FieldDef): FieldSummary {
  return {
    name: f.name,
    label: fieldLabel(e, f),
    unit: f.unit ?? null,
    type: f.type ?? 'number',
    default: fieldDefault(e, f),
    min: f.min ?? null,
    max: f.max ?? null,
    integer: f.integer ?? false,
    choices: f.choices ? f.choices.map((c) => ({ value: c.value, label: c.label })) : null,
    flag: f.flag ?? null,
    target: f.target ?? 'param',
  };
}

/** The element a kind is described against: a fresh part at the origin in its
 *  default orientation, the same builder a placement ghost uses. */
function referenceElement(kind: string): CircuitElement {
  return { ...makeGhostElement(kind, 0, 0, 0), id: 0 };
}

function requireEngine(ctx: QueryContext): NonNullable<AppState['simHost']> {
  const host = ctx.store.getState().simHost;
  if (host === null) {
    throw new QueryFailure(
      'no-engine',
      'No simulation engine is attached. Attach a SimHost (the browser does this at startup) to read live values.',
    );
  }
  return host;
}

/** Normalised corner box of a `rect` argument. */
function normaliseRect(r: { x1: number; y1: number; x2: number; y2: number }): {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
} {
  return {
    x0: Math.min(r.x1, r.x2),
    y0: Math.min(r.y1, r.y2),
    x1: Math.max(r.x1, r.x2),
    y1: Math.max(r.y1, r.y2),
  };
}

/** Whether an element's stored endpoints reach into a corner box. */
function inRect(e: CircuitElement, box: { x0: number; y0: number; x1: number; y1: number }): boolean {
  const minX = Math.min(e.x1, e.x2);
  const maxX = Math.max(e.x1, e.x2);
  const minY = Math.min(e.y1, e.y2);
  const maxY = Math.max(e.y1, e.y2);
  return maxX >= box.x0 && minX <= box.x1 && maxY >= box.y0 && minY <= box.y1;
}

const rectSchema = {
  type: 'object' as const,
  properties: {
    x1: { type: 'number' as const },
    y1: { type: 'number' as const },
    x2: { type: 'number' as const },
    y2: { type: 'number' as const },
  },
  required: ['x1', 'y1', 'x2', 'y2'],
  additionalProperties: false as const,
};

const noArgs: ArgSchema = { type: 'object', properties: {}, additionalProperties: false };

// ─── the table ───

export const QUERIES: readonly QueryDef[] = [
  {
    id: 'kinds.list',
    label: 'List Element Kinds',
    description:
      'Every element kind the registry knows: its display label, toolbox category and ' +
      'terminal count. Optional `category` filters to one toolbox group.',
    args: {
      type: 'object',
      properties: { category: { type: 'string', enum: [...new Set(ELEMENT_DEFS.map((d) => d.category))] } },
      additionalProperties: false,
    },
    run: (_ctx, raw) => {
      const a = raw as { category?: string };
      const kinds = ELEMENT_DEFS.filter((d) => a.category === undefined || d.category === a.category).map(
        (d) => ({
          kind: d.kind,
          label: d.label,
          category: d.category,
          posts: postsOf(referenceElement(d.kind)).length,
        }),
      );
      return { kinds };
    },
  },
  {
    id: 'kind.describe',
    label: 'Describe Element Kind',
    description:
      'One element kind: its editable fields with labels, units and defaults, its ' +
      'terminal offsets in a reference orientation, and its default flag word. ' +
      'Terminal coordinates snap to the grid reported in `gridSize`.',
    args: {
      type: 'object',
      properties: { kind: { type: 'string', minLength: 1 } },
      required: ['kind'],
      additionalProperties: false,
    },
    run: (_ctx, raw) => {
      const kind = (raw as { kind: string }).kind;
      const def = defFor(kind);
      if (!def) throw new QueryFailure('invalid-args', `Unknown element kind "${kind}".`);
      const e = referenceElement(kind);
      const posts = postsOf(e).map((p) => ({ x: p.x, y: p.y }));
      return {
        kind,
        label: def.label,
        category: def.category,
        dumpCode: def.dumpCode,
        description: `${def.label} (${def.category}), ${posts.length} terminal(s). Terminals snap to the grid.`,
        gridSize: quantity(GRID_SIZE, 'units', 0),
        posts,
        fields: (def.fields ?? []).map((f) => fieldSummary(e, f)),
        defaultFlags: def.defaultFlags ?? 0,
        simulated: def.simulated !== false,
      };
    },
  },
  {
    id: 'circuit.netlist',
    label: 'Circuit Netlist',
    description:
      'The current circuit as netlist text, with the engine\'s live state (capacitor ' +
      'charge, inductor current) overlaid. Capped; a truncated payload is a prefix ' +
      'and carries `truncated: true`.',
    args: noArgs,
    run: (ctx) => {
      const text = ctx.store.getState().saveNetlist();
      const capped = text.slice(0, MAX_NETLIST_CHARS);
      return { text: capped, chars: capped.length, truncated: text.length > capped.length };
    },
  },
  {
    id: 'circuit.summary',
    label: 'Circuit Summary',
    description:
      'Circuit counts, bounds in circuit units, the header settings subset, the ' +
      'problem and notice banners, and the revision counters. `gridSize` is the ' +
      'coordinate step terminals snap to.',
    args: noArgs,
    run: (ctx) => {
      const s = ctx.store.getState();
      const digits = s.settings.decimalDigits;
      const byKind: Record<string, number> = {};
      for (const e of s.elements) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
      const bounds = circuitBounds(s.elements);
      return {
        gridSize: quantity(GRID_SIZE, 'units', 0),
        revision: s.revision,
        paramRevision: s.paramRevision,
        counts: {
          elements: s.elements.length,
          wires: s.elements.filter((e) => e.kind === 'wire').length,
          scopes: s.scopes.length,
          sliders: s.sliders.length,
          byKind,
        },
        bounds:
          bounds === null
            ? null
            : {
                minX: quantity(bounds.minX, 'units', digits),
                minY: quantity(bounds.minY, 'units', digits),
                width: quantity(bounds.width, 'units', digits),
                height: quantity(bounds.height, 'units', digits),
              },
        settings: {
          timeStep: quantity(s.settings.timeStep, 's', digits),
          minTimeStep: quantity(s.settings.minTimeStep, 's', digits),
          voltageRange: quantity(s.settings.voltageRange, 'V', digits),
          stepsPerFrame: s.settings.stepsPerFrame,
          iterCount: s.settings.iterCount,
          adaptiveTimeStep: s.settings.adaptiveTimeStep,
          autoDC: s.settings.autoDC,
          showCurrent: s.settings.showCurrent,
          showValues: s.settings.showValues,
          showVoltageColor: s.settings.showVoltageColor,
          showPowerColor: s.settings.showPowerColor,
          showGrid: s.settings.showGrid,
          conventional: s.settings.conventional,
        },
        problem: s.problem,
        notice: s.notice,
        unsupportedProblem: s.unsupportedProblem,
      };
    },
  },
  {
    id: 'elements.list',
    label: 'List Elements',
    description:
      'Every element with its id, kind, coordinates, label/text and parameter map. ' +
      'Optional `kind` filters by kind and `inRect` keeps elements whose endpoints ' +
      'reach into the box.',
    args: {
      type: 'object',
      properties: { kind: { type: 'string', minLength: 1 }, inRect: rectSchema },
      additionalProperties: false,
    },
    run: (ctx, raw) => {
      const a = raw as { kind?: string; inRect?: { x1: number; y1: number; x2: number; y2: number } };
      const box = a.inRect === undefined ? null : normaliseRect(a.inRect);
      const elements = ctx.store
        .getState()
        .elements.filter((e) => (a.kind === undefined || e.kind === a.kind) && (box === null || inRect(e, box)))
        .map(elementSummary);
      return { elements };
    },
  },
  {
    id: 'element.get',
    label: 'Get Element',
    description:
      'One element by id: the list fields plus its terminals with their node numbers, ' +
      'field labels and units. Node voltages are included when an engine is attached.',
    args: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: (ctx, raw) => {
      const id = (raw as { id: number }).id;
      const s = ctx.store.getState();
      const e = s.elements.find((x) => x.id === id);
      if (!e) throw new QueryFailure('failed', `No element with id ${id} exists.`);
      const digits = s.settings.decimalDigits;
      const nets = assignNodes(s.elements);
      const readings = s.simHost === null ? null : s.simHost.elementReadings(id);
      const posts = postsForRender(e, cachedBusWidths(s.elements)).map((p, i) => ({
        x: p.x,
        y: p.y,
        node: nets.nodeOf.get(`${id}:${i}`) ?? null,
        voltage: readings === null ? null : quantity(readings.voltages[i] ?? 0, 'V', digits),
      }));
      return {
        element: elementSummary(e),
        posts,
        fields: (defFor(e.kind)?.fields ?? []).map((f) => fieldSummary(e, f)),
      };
    },
  },
  {
    id: 'nodes.list',
    label: 'List Nodes',
    description:
      'Every node: its number, whether it is the ground reference, the (element id, ' +
      'post) pairs on it, and its voltage when an engine is attached. Node numbers ' +
      'mirror the engine\'s assignment (ground is 0).',
    args: noArgs,
    run: (ctx) => {
      const s = ctx.store.getState();
      const digits = s.settings.decimalDigits;
      const widths = cachedBusWidths(s.elements);
      const nets = assignNodes(s.elements, widths);
      const connections = new Map<number, { id: number; post: number }[]>();
      for (const e of s.elements) {
        const count = postsForRender(e, widths).length;
        for (let i = 0; i < count; i++) {
          const node = nets.nodeOf.get(`${e.id}:${i}`);
          if (node === undefined) continue;
          const list = connections.get(node) ?? [];
          list.push({ id: e.id, post: i });
          connections.set(node, list);
        }
      }
      const volts = s.simHost === null ? null : s.simHost.nodeVoltages();
      const nodes = [...connections.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([node, list]) => ({
          node,
          ground: node === 0,
          connections: list,
          voltage: volts === null ? null : quantity(volts[node] ?? 0, 'V', digits),
        }));
      return { nodes };
    },
  },
  {
    id: 'element.readings',
    label: 'Element Readings',
    description:
      'Live readings for the named elements: voltage at each terminal, the current ' +
      'each terminal exchanges with its node, the dissipated power, and the info box ' +
      'lines. Requires an attached engine.',
    args: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'integer' }, minItems: 1 } },
      required: ['ids'],
      additionalProperties: false,
    },
    run: (ctx, raw) => {
      const ids = (raw as { ids: number[] }).ids;
      const s = ctx.store.getState();
      const host = requireEngine(ctx);
      const digits = s.settings.decimalDigits;
      const readings = ids.map((id) => {
        const e = s.elements.find((x) => x.id === id);
        if (!e) throw new QueryFailure('failed', `No element with id ${id} exists.`);
        const r = host.elementReadings(id);
        const posts =
          r === null
            ? []
            : r.voltages.map((v, i) => ({
                voltage: quantity(v, 'V', digits),
                current: quantity(r.currents[i] ?? 0, 'A', digits),
              }));
        return {
          id,
          posts,
          power: quantity(r?.power ?? 0, 'W', digits),
          infoLines: host.infoLines(id),
        };
      });
      return { readings };
    },
  },
  {
    id: 'scopes.list',
    label: 'List Scopes',
    description: 'Every scope: its id, label, horizontal speed and traces with their target element and unit.',
    args: noArgs,
    run: (ctx) => {
      const s = ctx.store.getState();
      const scopes = s.scopes.map((scope, i) => ({
        id: scope.id,
        label: scope.label.trim() !== '' ? scope.label : `Scope ${i + 1}`,
        speed: scope.speed,
        targetElement: sharedPlotElement(scope.plots),
        plots: scope.plots.map((p) => ({
          id: p.id,
          elementId: p.elementId,
          value: p.value,
          unit: p.value === null ? null : UNIT[p.value],
        })),
      }));
      return { scopes };
    },
  },
  {
    id: 'scope.samples',
    label: 'Scope Samples',
    description:
      'The most recent captured waveform of one scope, in seconds, one series per ' +
      'trace. `last` limits the point count; the payload is capped and carries ' +
      '`truncated: true` when the capture was longer. Requires an attached engine.',
    args: {
      type: 'object',
      properties: {
        scopeId: { type: 'integer' },
        last: { type: 'integer', minimum: 1 },
      },
      required: ['scopeId'],
      additionalProperties: false,
    },
    run: (ctx, raw) => {
      const a = raw as { scopeId: number; last?: number };
      const s = ctx.store.getState();
      const host = requireEngine(ctx);
      const scope = s.scopes.find((x) => x.id === a.scopeId);
      if (!scope) throw new QueryFailure('failed', `No scope with id ${a.scopeId} exists.`);
      const samples = host.scopeSamples(a.scopeId);
      if (samples === null) throw new QueryFailure('failed', `No scope with id ${a.scopeId} exists.`);
      const available = samples.plots[0]?.values.length ?? 0;
      const limit = Math.min(MAX_SCOPE_SAMPLES, a.last ?? MAX_SCOPE_SAMPLES);
      const n = Math.min(available, limit);
      const digits = s.settings.decimalDigits;
      const units = scope.plots
        .filter((p) => p.elementId !== null && p.value !== null)
        .map((p) => UNIT[p.value as keyof typeof UNIT]);
      // A plot whose element left the engine is dropped from the samples but
      // not from the store list, which would shift every later unit; fall back
      // to no unit rather than mislabel the traces.
      const unitAt = (i: number): string => (units.length === samples.plots.length ? units[i] : '');
      const t = samples.t.slice(samples.t.length - n);
      return {
        scopeId: a.scopeId,
        time: quantityList(t, 's', digits),
        plots: samples.plots.map((p, i) => {
          const unit = unitAt(i);
          const values = p.values.slice(p.values.length - n);
          return { label: p.label, unit, values, display: values.map((v) => formatValue(v, unit, digits)) };
        }),
        points: n,
        truncated: available > n,
      };
    },
  },
  {
    id: 'sim.state',
    label: 'Simulation State',
    description:
      'Simulated time and timestep in seconds, whether the run is live, whether the ' +
      'last frame converged, and the current problem banner. Requires an attached engine.',
    args: noArgs,
    run: (ctx) => {
      const s = ctx.store.getState();
      const host = requireEngine(ctx);
      const digits = s.settings.decimalDigits;
      return {
        time: quantity(host.time(), 's', digits),
        timeStep: quantity(s.settings.timeStep, 's', digits),
        running: host.running(),
        // The host carries no per-frame convergence flag by design (the frame
        // loop owns the run), so convergence mirrors the absence of a problem
        // banner: a failed build or a non-convergent frame is what raises it.
        converged: s.problem === null,
        problem: s.problem,
      };
    },
  },
  {
    id: 'history.list',
    label: 'List History',
    description:
      'The undo and redo stacks, top first, each entry with its label and source ' +
      '(user, agent or system). `limit` caps the entries per side.',
    args: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 0 } },
      additionalProperties: false,
    },
    run: (ctx, raw) => {
      const a = raw as { limit?: number };
      const s = ctx.store.getState();
      const cap = a.limit ?? Number.POSITIVE_INFINITY;
      const entry = (x: { label: string; source: string }) => ({ label: x.label, source: x.source });
      const undo = [...s.history.undo].reverse().slice(0, cap).map(entry);
      const redo = [...s.history.redo].reverse().slice(0, cap).map(entry);
      return {
        undo,
        redo,
        undoDepth: s.history.undo.length,
        redoDepth: s.history.redo.length,
      };
    },
  },
  {
    id: 'schematic.svg',
    label: 'Schematic SVG',
    description:
      'The circuit drawn to SVG text through the same recorder the Save As SVG ' +
      'export uses, without live engine values. `rect` keeps elements reaching into ' +
      'the box and `showValues` overrides the value-label setting. Capped; a ' +
      'truncated payload carries `truncated: true` and is not valid XML.',
    args: {
      type: 'object',
      properties: { rect: rectSchema, showValues: { type: 'boolean' } },
      additionalProperties: false,
    },
    run: (ctx, raw) => {
      const a = raw as {
        rect?: { x1: number; y1: number; x2: number; y2: number };
        showValues?: boolean;
      };
      const s = ctx.store.getState();
      const box = a.rect === undefined ? null : normaliseRect(a.rect);
      const elements = box === null ? s.elements : s.elements.filter((e) => inRect(e, box));
      const settings = a.showValues === undefined ? s.settings : { ...s.settings, showValues: a.showValues };
      const svg = renderCircuitToSvg(elements, settings, false, null);
      const capped = svg.slice(0, MAX_SVG_CHARS);
      return { svg: capped, chars: capped.length, truncated: svg.length > capped.length };
    },
  },
];

const byId = new Map(QUERIES.map((q) => [q.id, q]));

export function queryById(id: string): QueryDef | undefined {
  return byId.get(id);
}

/** Look up, validate and run one query. Mirrors `execute`'s contract: a bad id,
 *  bad args or a refusal come back as a `QueryResult`, never as a throw. */
export function query<R = unknown>(id: string, args: unknown, ctx: QueryContext): QueryResult<R> {
  const def = byId.get(id) as QueryDef | undefined;
  if (!def) return { ok: false, error: 'unknown', message: `Unknown query "${id}".` };
  const value = args === undefined ? {} : args;
  const invalid = validateArgs(def.args, value);
  if (invalid) return { ok: false, error: 'invalid-args', message: invalid.message };
  try {
    return { ok: true, value: def.run(ctx, value) as R };
  } catch (e) {
    if (e instanceof QueryFailure) return { ok: false, error: e.error, message: e.message };
    return {
      ok: false,
      error: 'failed',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
