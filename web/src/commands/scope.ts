/** Scope commands: panels, traces, display flags and layout. Ids are the
 *  session scope/plot ids the store already uses. */

import type { ScopeValue } from '../engine/scopeModel';
import { PLOT_MEASUREMENT_KEYS } from '../engine/scopeModel';
import type { ScopeDropTarget } from '../state/scopeLayout';
import type { AppState } from '../state/types';
import type { CommandDef } from './types';

const scopeValues: ScopeValue[] = [
  'voltage',
  'current',
  'power',
  'charge',
  'resistance',
  'ib',
  'ic',
  'ie',
  'vbe',
  'vbc',
  'vce',
];

const scopeId = { type: 'integer' as const };
const valueArgs = {
  type: 'string' as const,
  enum: scopeValues,
  description: 'Trace quantity. Defaults to voltage where optional.',
};

const flagsSchema = {
  type: 'object' as const,
  properties: {
    manualScale: { type: 'boolean' as const },
    maxScale: { type: 'boolean' as const },
    label: { type: 'string' as const },
    manDivisions: { type: 'number' as const },
    showScale: { type: 'boolean' as const },
    showMax: { type: 'boolean' as const },
    showMin: { type: 'boolean' as const },
    showP2P: { type: 'boolean' as const },
    showFreq: { type: 'boolean' as const },
    showRMS: { type: 'boolean' as const },
    showAverage: { type: 'boolean' as const },
    showDutyCycle: { type: 'boolean' as const },
    fftPlot: { type: 'boolean' as const },
    logSpectrum: { type: 'boolean' as const },
    plotXY: { type: 'boolean' as const },
    showPhaseAngle: { type: 'boolean' as const },
    trailPersistence: { type: 'number' as const },
    plotX: { type: 'integer' as const },
    plotY: { type: 'integer' as const },
    plotBrightness: { type: 'integer' as const },
    plotColorR: { type: 'integer' as const },
    plotColorG: { type: 'integer' as const },
    plotColorB: { type: 'integer' as const },
    showElmInfo: { type: 'boolean' as const },
    showI: { type: 'boolean' as const },
    showV: { type: 'boolean' as const },
    scaleV: { type: 'number' as const },
    scaleA: { type: 'number' as const },
  },
  additionalProperties: false as const,
  description: 'Display fields to merge into the scope. Omitted fields are untouched.',
};

const hasScope = (s: AppState, id: number) => s.scopes.some((x) => x.id === id);
const noScope = (id: number) => `No scope with id ${id} exists.`;
const hasPlot = (s: AppState, id: number) => s.scopes.some((x) => x.plots.some((p) => p.id === id));
const noPlot = (id: number) => `No plot with id ${id} exists.`;

export const scopeCommands: CommandDef[] = [
  {
    id: 'scope.add',
    label: 'Add Scope',
    description:
      'Creates a scope for one element, voltage by default. A voltage scope also ' +
      'gets a current companion when Show Current is on. Returns the scope id.',
    args: {
      type: 'object',
      properties: { elementId: { type: 'integer' }, value: valueArgs },
      required: ['elementId'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s, a) =>
      s.elements.some((e) => e.id === (a as { elementId: number }).elementId)
        ? true
        : `No element with id ${(a as { elementId: number }).elementId} exists.`,
    run: (ctx, raw) => {
      const a = raw as { elementId: number; value?: ScopeValue };
      const s = ctx.store.getState();
      const before = new Set(s.scopes.map((x) => x.id));
      s.addScope(a.elementId, a.value ?? 'voltage');
      return ctx.store.getState().scopes.find((x) => !before.has(x.id))?.id ?? null;
    },
  },
  {
    id: 'scope.addTo',
    label: 'Add to Scope',
    description:
      'Adds a trace for one element to an existing scope. Dedup is per scope, so ' +
      'another panel may already show the same quantity.',
    args: {
      type: 'object',
      properties: {
        elementId: { type: 'integer' },
        scopeId: { type: 'integer' },
        value: valueArgs,
      },
      required: ['elementId', 'scopeId'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s, a) => {
      const args = a as { elementId: number; scopeId: number };
      if (!hasScope(s, args.scopeId)) return noScope(args.scopeId);
      return s.elements.some((e) => e.id === args.elementId)
        ? true
        : `No element with id ${args.elementId} exists.`;
    },
    run: (ctx, raw) => {
      const a = raw as { elementId: number; scopeId: number; value?: ScopeValue };
      ctx.store.getState().addToScope(a.elementId, a.scopeId, a.value ?? 'voltage');
    },
  },
  ...[
    ['scope.remove', 'Remove Scope', 'Removes a scope panel.', 'removeScope'],
    ['scope.reset', 'Reset Scope', 'Clears a scope capture buffer and its sticky scale.', 'resetScope'],
    ['scope.separate', 'Separate Scope', 'Splits a panel into one per trace, keeping a V+I pair together.', 'separateScope'],
    ['scope.stack', 'Stack Scope', 'Moves a scope into the previous column, closing the gap it left.', 'stackScope'],
    ['scope.unstack', 'Unstack Scope', 'Moves a scope into a column of its own.', 'unstackScope'],
    ['scope.resetDefaults', 'Reset Scope to Defaults', "Puts a scope's display settings back to a fresh panel's defaults.", 'resetScopeToDefaults'],
    ['scope.setVceIc', 'Show Vce vs Ic', "Replaces a transistor scope's plots with the Vce/Ic pair and turns X-Y on.", 'setScopeVceIc'],
    ['scope.clearPlotMeasurements', 'Clear Plot Readouts', 'Drops every per-trace readout override so all traces inherit the scope settings.', 'clearPlotMeasurementOverrides'],
  ].map(([id, label, description, action]): CommandDef => ({
    id,
    label,
    description,
    args: {
      type: 'object',
      properties: { scopeId },
      required: ['scopeId'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s, a) => {
      const key = (a as { scopeId: number }).scopeId;
      return hasScope(s, key) ? true : noScope(key);
    },
    run: (ctx, raw) => {
      const key = (raw as { scopeId: number }).scopeId;
      const s = ctx.store.getState();
      (s as unknown as Record<string, (id: number) => void>)[action](key);
    },
  })),
  {
    id: 'scope.combine',
    label: 'Combine Scopes',
    description: "Merges one scope's plots into another and removes the first.",
    args: {
      type: 'object',
      properties: { intoId: { type: 'integer' }, fromId: { type: 'integer' } },
      required: ['intoId', 'fromId'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s, a) => {
      const args = a as { intoId: number; fromId: number };
      if (!hasScope(s, args.intoId)) return noScope(args.intoId);
      if (!hasScope(s, args.fromId)) return noScope(args.fromId);
      return args.intoId === args.fromId ? 'A scope cannot be combined with itself.' : true;
    },
    run: (ctx, a) => {
      const args = a as { intoId: number; fromId: number };
      ctx.store.getState().combineScopes(args.intoId, args.fromId);
    },
  },
  ...[
    ['scope.stackAll', 'Stack All', 'Puts every scope in one column.', 'stackAllScopes'],
    ['scope.unstackAll', 'Unstack All', 'Gives every scope its own column.', 'unstackAllScopes'],
    ['scope.combineAll', 'Combine All', 'Folds every scope into the first panel.', 'combineAllScopes'],
    ['scope.separateAll', 'Separate All', 'Splits every panel into one per trace.', 'separateAllScopes'],
  ].map(([id, label, description, action]): CommandDef => ({
    id,
    label,
    description,
    args: { type: 'object', properties: {}, additionalProperties: false },
    history: 'step',
    edits: true,
    run: (ctx) => {
      const s = ctx.store.getState();
      (s as unknown as Record<string, () => void>)[action]();
    },
  })),
  {
    id: 'scope.move',
    label: 'Move Scope',
    description:
      'Drops a scope into a column: stack it under `withId`, or give it a column ' +
      'of its own before `beforeId` (null means the last column).',
    args: {
      type: 'object',
      properties: {
        scopeId,
        target: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['stack', 'column'] },
            withId: { type: 'integer' },
            beforeId: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          },
          required: ['kind'],
          additionalProperties: false,
        },
      },
      required: ['scopeId', 'target'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s, a) => {
      const args = a as { scopeId: number; target: ScopeDropTarget };
      if (!hasScope(s, args.scopeId)) return noScope(args.scopeId);
      if (args.target.kind === 'stack') {
        return hasScope(s, args.target.withId) ? true : noScope(args.target.withId);
      }
      return args.target.beforeId === null || hasScope(s, args.target.beforeId)
        ? true
        : noScope(args.target.beforeId);
    },
    run: (ctx, a) => {
      const args = a as { scopeId: number; target: ScopeDropTarget };
      ctx.store.getState().moveScope(args.scopeId, args.target);
    },
  },
  {
    id: 'scope.setSpeed',
    label: 'Edit Scope Speed',
    description: 'Sets the horizontal zoom: simulation timesteps per scope column.',
    args: {
      type: 'object',
      properties: { scopeId, speed: { type: 'number', minimum: 1 } },
      required: ['scopeId', 'speed'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s, a) =>
      hasScope(s, (a as { scopeId: number }).scopeId)
        ? true
        : noScope((a as { scopeId: number }).scopeId),
    run: (ctx, a) => {
      const args = a as { scopeId: number; speed: number };
      ctx.store.getState().setScopeSpeed(args.scopeId, args.speed);
    },
  },
  {
    id: 'scope.setTrigger',
    label: 'Edit Scope Trigger',
    description: 'Sets the trigger mode, edge and level (level in the first trace unit).',
    args: {
      type: 'object',
      properties: {
        scopeId,
        mode: { type: 'string', enum: ['freeRun', 'normal', 'auto'] },
        edge: { type: 'string', enum: ['rising', 'falling'] },
        level: { type: 'number' },
      },
      required: ['scopeId'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s, a) =>
      hasScope(s, (a as { scopeId: number }).scopeId)
        ? true
        : noScope((a as { scopeId: number }).scopeId),
    run: (ctx, a) => {
      const args = a as {
        scopeId: number;
        mode?: 'freeRun' | 'normal' | 'auto';
        edge?: 'rising' | 'falling';
        level?: number;
      };
      const patch: Record<string, unknown> = {};
      if (args.mode !== undefined) patch.mode = args.mode;
      if (args.edge !== undefined) patch.edge = args.edge;
      if (args.level !== undefined) patch.level = args.level;
      ctx.store.getState().setScopeTrigger(args.scopeId, patch);
    },
  },
  {
    id: 'scope.setFlags',
    label: 'Edit Scope',
    description: 'Merges display fields (scale mode, overlays, FFT, X-Y axes, label) into a scope.',
    args: {
      type: 'object',
      properties: { scopeId, flags: flagsSchema },
      required: ['scopeId', 'flags'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s, a) =>
      hasScope(s, (a as { scopeId: number }).scopeId)
        ? true
        : noScope((a as { scopeId: number }).scopeId),
    run: (ctx, a) => {
      const args = a as { scopeId: number; flags: Record<string, unknown> };
      ctx.store.getState().setScopeFlags(args.scopeId, args.flags);
    },
  },
  {
    id: 'scope.setShowValue',
    label: 'Show Scope Value',
    description:
      'Shows or hides every voltage or current trace on a scope. Turning one on ' +
      'with no such plot adds one for the first element.',
    args: {
      type: 'object',
      properties: {
        scopeId,
        value: { type: 'string', enum: ['voltage', 'current'] },
        show: { type: 'boolean' },
      },
      required: ['scopeId', 'value', 'show'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s, a) =>
      hasScope(s, (a as { scopeId: number }).scopeId)
        ? true
        : noScope((a as { scopeId: number }).scopeId),
    run: (ctx, a) => {
      const args = a as { scopeId: number; value: 'voltage' | 'current'; show: boolean };
      ctx.store.getState().setScopeShowValue(args.scopeId, args.value, args.show);
    },
  },
  {
    id: 'scope.setPlotCoupling',
    label: 'Set Plot Coupling',
    description: 'Sets one plot dc or ac coupled. AC coupling applies to voltage plots only.',
    args: {
      type: 'object',
      properties: { scopeId, plotId: { type: 'integer' }, acCoupled: { type: 'boolean' } },
      required: ['scopeId', 'plotId', 'acCoupled'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s, a) => {
      const args = a as { scopeId: number; plotId: number };
      if (!hasScope(s, args.scopeId)) return noScope(args.scopeId);
      return hasPlot(s, args.plotId) ? true : noPlot(args.plotId);
    },
    run: (ctx, a) => {
      const args = a as { scopeId: number; plotId: number; acCoupled: boolean };
      ctx.store.getState().setPlotCoupling(args.scopeId, args.plotId, args.acCoupled);
    },
  },
  {
    id: 'scope.setPlotManScale',
    label: 'Set Plot Scale',
    description: 'Sets one plot manual units per division, or null to return it to automatic.',
    args: {
      type: 'object',
      properties: { plotId: { type: 'integer' }, manScale: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] } },
      required: ['plotId', 'manScale'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s, a) => (hasPlot(s, (a as { plotId: number }).plotId) ? true : noPlot((a as { plotId: number }).plotId)),
    run: (ctx, a) => {
      const args = a as { plotId: number; manScale: number | null };
      ctx.store.getState().setPlotManScale(args.plotId, args.manScale);
    },
  },
  {
    id: 'scope.setPlotPosition',
    label: 'Set Plot Position',
    description: 'Sets one plot vertical position in -200..200 steps, 0 centred.',
    args: {
      type: 'object',
      properties: {
        plotId: { type: 'integer' },
        position: { type: 'number', minimum: -200, maximum: 200 },
      },
      required: ['plotId', 'position'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s, a) => (hasPlot(s, (a as { plotId: number }).plotId) ? true : noPlot((a as { plotId: number }).plotId)),
    run: (ctx, a) => {
      const args = a as { plotId: number; position: number };
      ctx.store.getState().setPlotManPosition(args.plotId, args.position);
    },
  },
  {
    id: 'scope.setPlotMeasurement',
    label: 'Set Plot Readout',
    description: 'Turns one per-trace measurement readout on or off.',
    args: {
      type: 'object',
      properties: {
        plotId: { type: 'integer' },
        key: { type: 'string', enum: [...PLOT_MEASUREMENT_KEYS] },
        on: { type: 'boolean' },
      },
      required: ['plotId', 'key', 'on'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s, a) => (hasPlot(s, (a as { plotId: number }).plotId) ? true : noPlot((a as { plotId: number }).plotId)),
    run: (ctx, a) => {
      const args = a as {
        plotId: number;
        key: (typeof PLOT_MEASUREMENT_KEYS)[number];
        on: boolean;
      };
      ctx.store.getState().setPlotMeasurementFlag(args.plotId, args.key, args.on);
    },
  },
  {
    id: 'scope.togglePlot',
    label: 'Toggle Scope Plot',
    description: 'Adds a trace of `value` to a scope, or removes it if already shown. Never empties a panel.',
    args: {
      type: 'object',
      properties: { scopeId, value: valueArgs },
      required: ['scopeId', 'value'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s, a) =>
      hasScope(s, (a as { scopeId: number }).scopeId)
        ? true
        : noScope((a as { scopeId: number }).scopeId),
    run: (ctx, a) => {
      const args = a as { scopeId: number; value: ScopeValue };
      ctx.store.getState().togglePlot(args.scopeId, args.value);
    },
  },
  {
    id: 'scope.removePlot',
    label: 'Remove Plot',
    description: 'Removes exactly one plot by id. Refuses raw-only plots and the last plot.',
    args: {
      type: 'object',
      properties: { scopeId, plotId: { type: 'integer' } },
      required: ['scopeId', 'plotId'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s, a) => {
      const args = a as { scopeId: number; plotId: number };
      if (!hasScope(s, args.scopeId)) return noScope(args.scopeId);
      return hasPlot(s, args.plotId) ? true : noPlot(args.plotId);
    },
    run: (ctx, a) => {
      const args = a as { scopeId: number; plotId: number };
      ctx.store.getState().removePlot(args.scopeId, args.plotId);
    },
  },
  {
    id: 'slider.add',
    label: 'Add Slider',
    description:
      "Creates a slider bound to one of an element's adjustable fields. " +
      '`editItem` is the field index; `caption` is an optional label.',
    args: {
      type: 'object',
      properties: {
        elementId: { type: 'integer' },
        editItem: { type: 'integer', minimum: 0 },
        caption: { type: 'string' },
      },
      required: ['elementId', 'editItem'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s, a) =>
      s.elements.some((e) => e.id === (a as { elementId: number }).elementId)
        ? true
        : `No element with id ${(a as { elementId: number }).elementId} exists.`,
    run: (ctx, a) => {
      const args = a as { elementId: number; editItem: number; caption?: string };
      ctx.store.getState().addSlider(args.elementId, args.editItem, args.caption);
    },
  },
  {
    id: 'slider.remove',
    label: 'Remove Slider',
    description: 'Removes a slider by slider id.',
    args: {
      type: 'object',
      properties: { sliderId: { type: 'integer' } },
      required: ['sliderId'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s, a) =>
      s.sliders.some((x) => x.id === (a as { sliderId: number }).sliderId)
        ? true
        : `No slider with id ${(a as { sliderId: number }).sliderId} exists.`,
    run: (ctx, a) => {
      ctx.store.getState().removeSlider((a as { sliderId: number }).sliderId);
    },
  },
  {
    id: 'slider.set',
    label: 'Set Slider',
    description:
      'Writes a slider position value into its bound parameter through the live ' +
      'engine path. The value is in the slider range, before unit scaling.',
    args: {
      type: 'object',
      properties: {
        sliderId: { type: 'integer' },
        value: { type: 'number' },
      },
      required: ['sliderId', 'value'],
      additionalProperties: false,
    },
    history: 'none',
    edits: true,
    enabled: (s, a) =>
      s.sliders.some((x) => x.id === (a as { sliderId: number }).sliderId)
        ? true
        : `No slider with id ${(a as { sliderId: number }).sliderId} exists.`,
    run: (ctx, a) => {
      const args = a as { sliderId: number; value: number };
      ctx.store.getState().setSliderValue(args.sliderId, args.value);
    },
  },
];
