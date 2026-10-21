/** Element, wire and clipboard commands: the editing verbs. Every one names
 *  its targets explicitly when the caller supplies ids, and falls back to the
 *  selection only for the UI doors, which deliberately omit them. */

import { defFor } from '../model/registry';
import {
  canMirrorSelection,
  canRotate,
  canRotateSelection,
  canSwap,
} from '../model/transform';
import { makeElement, makeGhostElement } from '../state/helpers';
import type { CircuitElement, Point } from '../model/types';
import { parsesToElements } from '../io/importSummary';
import { pointOnWireInterior } from '../render/geometry';
import type { AppState } from '../state/types';
import { CommandFailure, type CommandDef } from './types';

const ids = (description: string) => ({
  type: 'array' as const,
  items: { type: 'integer' as const },
  minItems: 1,
  description,
});

const optionalIds = {
  type: 'object' as const,
  properties: {
    ids: ids('Element ids. Omit to act on the current selection.'),
  },
  additionalProperties: false as const,
};

const paramsSchema = {
  type: 'object' as const,
  properties: {},
  additionalProperties: { type: 'number' as const },
  description: 'Parameter values keyed by the element registry field name.',
};

function chosen(s: AppState, list?: number[]): number[] {
  return list ?? s.selectedIds;
}

function targets(s: AppState, list?: number[]): CircuitElement[] {
  const set = new Set(chosen(s, list));
  return s.elements.filter((e) => set.has(e.id));
}

function requireElement(s: AppState, id: number): CircuitElement {
  const e = s.elements.find((x) => x.id === id);
  if (!e) throw new CommandFailure('failed', `No element with id ${id} exists.`);
  return e;
}

export const editCommands: CommandDef[] = [
  {
    id: 'element.add',
    label: 'Add Element',
    description:
      'Places a new element of `kind` spanning (x1,y1) to (x2,y2) in circuit units. ' +
      'Registry defaults are applied first and `params` overrides named fields. ' +
      'Returns the new element id.',
    args: {
      type: 'object',
      properties: {
        kind: { type: 'string', minLength: 1 },
        tool: {
          type: 'string',
          minLength: 1,
          description: 'Toolbox tool id, when the placement carries its own defaults (pnp, pmos).',
        },
        turns: { type: 'integer', minimum: 0, maximum: 3 },
        x1: { type: 'number' },
        y1: { type: 'number' },
        x2: { type: 'number' },
        y2: { type: 'number' },
        params: paramsSchema,
        flags: { type: 'integer' },
        text: { type: 'string' },
        state: { type: 'integer' },
      },
      required: ['kind', 'x1', 'y1', 'x2', 'y2'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    undoLabel: (_s, a) => `Add ${defFor((a as { kind: string }).kind)?.label ?? 'Element'}`,
    run: (ctx, raw) => {
      const a = raw as {
        kind: string;
        tool?: string;
        turns?: number;
        x1: number;
        y1: number;
        x2: number;
        y2: number;
        params?: Record<string, number>;
        flags?: number;
        text?: string;
        state?: number;
      };
      // A tool id is the placement path: its toolbox entry is the source of
      // the kind (the PNP/PMOS splits), and the synthetic tool ids the canvas
      // tests use are not registry kinds, so only the plain kind form is
      // validated here.
      if (!a.tool && !defFor(a.kind)) {
        throw new CommandFailure('invalid-args', `args.kind: unknown element kind "${a.kind}"`);
      }
      // A placement carries its toolbox tool's own defaults (the PNP/PMOS
      // splits) and its banked quarter turns; makeGhostElement is the one
      // builder the canvas ghost and the drop share, so the part cannot shift
      // under the cursor when the click lands.
      const base = a.tool
        ? makeGhostElement(a.tool, a.x1, a.y1, a.turns ?? 0)
        : makeElement(a.kind, a.x1, a.y1, a.x2, a.y2);
      const element = {
        ...base,
        ...(a.flags !== undefined ? { flags: a.flags } : {}),
        ...(a.text !== undefined ? { text: a.text } : {}),
        ...(a.state !== undefined ? { state: a.state } : {}),
        params: { ...base.params, ...(a.params ?? {}) },
      };
      return ctx.store.getState().addElement(element);
    },
  },
  {
    id: 'element.update',
    label: 'Edit Element',
    description:
      'Updates one element. `params` sets registry fields by name (unit values, ' +
      'clamped like the properties dialog), `text` replaces its annotation or ' +
      'label, `flags` replaces the flag word, `model` sets a battery table, and ' +
      '`keyShortcut` sets a switch key.',
    args: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        params: paramsSchema,
        text: { type: 'string' },
        flags: { type: 'integer' },
        model: { type: 'string' },
        modelName: { type: 'string' },
        keyShortcut: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    undoLabel: (s, a) =>
      `Edit ${defFor(s.elements.find((e) => e.id === (a as { id: number }).id)?.kind ?? '')?.label ?? 'Element'}`,
    enabled: (s, a) =>
      s.elements.some((e) => e.id === (a as { id: number }).id)
        ? true
        : `No element with id ${(a as { id: number }).id} exists.`,
    run: (ctx, raw) => {
      const a = raw as {
        id: number;
        params?: Record<string, number>;
        text?: string;
        flags?: number;
        model?: string;
        modelName?: string;
        keyShortcut?: string;
      };
      const s = ctx.store.getState();
      requireElement(s, a.id);
      for (const [name, value] of Object.entries(a.params ?? {})) s.setParam(a.id, name, value);
      if (a.text !== undefined) s.setText(a.id, a.text);
      if (a.flags !== undefined) s.updateElement(a.id, { flags: a.flags });
      if (a.model !== undefined) s.updateElement(a.id, { model: a.model });
      if (a.modelName !== undefined) s.setModelName(a.id, a.modelName);
      if (a.keyShortcut !== undefined) s.setKeyShortcut(a.id, a.keyShortcut);
      return a.id;
    },
  },
  {
    id: 'element.resetDefaults',
    label: 'Reset Element',
    description: "Puts one element's editable surface back to a freshly placed part's defaults.",
    args: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s, a) =>
      s.elements.some((e) => e.id === (a as { id: number }).id)
        ? true
        : `No element with id ${(a as { id: number }).id} exists.`,
    run: (ctx, a) => ctx.store.getState().resetElementToDefaults((a as { id: number }).id),
  },
  {
    id: 'element.delete',
    label: 'Delete',
    description: 'Deletes the named elements, or the current selection when `ids` is omitted.',
    args: optionalIds,
    history: 'step',
    edits: true,
    enabled: (s, a) => (chosen(s, (a as { ids?: number[] }).ids).length > 0 ? true : 'Nothing is selected.'),
    run: (ctx, raw) => {
      const a = raw as { ids?: number[] };
      const s = ctx.store.getState();
      const list = chosen(s, a.ids);
      if (a.ids === undefined) s.deleteSelected();
      else s.deleteElements(a.ids);
      return list;
    },
  },
  {
    id: 'element.move',
    label: 'Move',
    description:
      'Moves the named elements, or the selection, by (dx,dy) circuit units. ' +
      'One undo entry per call.',
    args: {
      type: 'object',
      properties: {
        ids: ids('Element ids. Omit to move the current selection.'),
        dx: { type: 'number' },
        dy: { type: 'number' },
      },
      required: ['dx', 'dy'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s, a) => {
      const args = a as { ids?: number[]; dx: number; dy: number };
      if (chosen(s, args.ids).length === 0) return 'Nothing is selected.';
      if (args.dx === 0 && args.dy === 0) return 'The move distance is zero.';
      return true;
    },
    run: (ctx, raw) => {
      const a = raw as { ids?: number[]; dx: number; dy: number };
      const s = ctx.store.getState();
      const list = chosen(s, a.ids);
      if (a.ids === undefined) s.nudgeSelection(a.dx, a.dy);
      else s.moveElements(a.ids, a.dx, a.dy);
      return list;
    },
  },
  {
    id: 'element.movePost',
    label: 'Move Terminal',
    description:
      'Moves one stored endpoint of an element. `post` 0 is (x1,y1), 1 is ' +
      '(x2,y2); `x` and `y` are absolute circuit coordinates.',
    args: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        post: { type: 'integer', minimum: 0, maximum: 1 },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['id', 'post', 'x', 'y'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s, a) =>
      s.elements.some((e) => e.id === (a as { id: number }).id)
        ? true
        : `No element with id ${(a as { id: number }).id} exists.`,
    run: (ctx, raw) => {
      const a = raw as { id: number; post: 0 | 1; x: number; y: number };
      const s = ctx.store.getState();
      const e = requireElement(s, a.id);
      const from = a.post === 0 ? { x: e.x1, y: e.y1 } : { x: e.x2, y: e.y2 };
      s.movePoint(a.id, a.post, a.x - from.x, a.y - from.y);
      return a.id;
    },
  },
  {
    id: 'element.rotate',
    label: 'Rotate',
    description:
      'Rotates the named elements, or the selection, one quarter turn as one ' +
      'rigid body about a shared pivot.',
    args: optionalIds,
    history: 'step',
    edits: true,
    enabled: (s, a) => {
      const list = (a as { ids?: number[] }).ids;
      if (list === undefined && s.tool !== null) {
        return canRotate({ ...makeGhostElement(s.tool, 0, 0, 0), id: -1 })
          ? true
          : 'This part cannot be rotated.';
      }
      const set = targets(s, list);
      if (set.length === 0) return 'Nothing is selected.';
      return canRotateSelection(set) ? true : 'The selection cannot be rotated.';
    },
    run: (ctx, raw) => {
      const a = raw as { ids?: number[] };
      const s = ctx.store.getState();
      if (a.ids === undefined) s.rotateSelection();
      else s.rotateElements(a.ids);
    },
  },
  {
    id: 'element.mirror',
    label: 'Mirror Horizontally',
    description:
      'Mirrors the named elements, or the selection, left to right across the ' +
      "set's shared vertical axis.",
    args: optionalIds,
    history: 'step',
    edits: true,
    enabled: (s, a) => {
      const set = targets(s, (a as { ids?: number[] }).ids);
      if (set.length === 0) return 'Nothing is selected.';
      return canMirrorSelection(set) ? true : 'The selection cannot be mirrored.';
    },
    run: (ctx, raw) => {
      const a = raw as { ids?: number[] };
      const s = ctx.store.getState();
      if (a.ids === undefined) s.mirrorSelection('horizontal');
      else s.mirrorElements(a.ids, 'horizontal');
    },
  },
  {
    id: 'element.mirrorVertical',
    label: 'Mirror Vertically',
    description:
      'Mirrors the named elements, or the selection, top to bottom across the ' +
      "set's shared horizontal axis.",
    args: optionalIds,
    history: 'step',
    edits: true,
    enabled: (s, a) => {
      const set = targets(s, (a as { ids?: number[] }).ids);
      if (set.length === 0) return 'Nothing is selected.';
      return canMirrorSelection(set) ? true : 'The selection cannot be mirrored.';
    },
    run: (ctx, raw) => {
      const a = raw as { ids?: number[] };
      const s = ctx.store.getState();
      if (a.ids === undefined) s.mirrorSelection('vertical');
      else s.mirrorElements(a.ids, 'vertical');
    },
  },
  {
    id: 'element.swapTerminals',
    label: 'Swap Terminals',
    description:
      'Exchanges posts 0 and 1 on each named two-terminal element, or on the selection.',
    args: optionalIds,
    history: 'step',
    edits: true,
    enabled: (s, a) => {
      const set = targets(s, (a as { ids?: number[] }).ids);
      if (set.length === 0) return 'Nothing is selected.';
      return set.every(canSwap) ? true : 'The selection cannot have its terminals swapped.';
    },
    run: (ctx, raw) => {
      const a = raw as { ids?: number[] };
      const s = ctx.store.getState();
      if (a.ids === undefined) s.swapTerminals();
      else s.swapTerminalsOf(a.ids);
    },
  },
  {
    id: 'element.setState',
    label: 'Toggle Switch',
    description: "Sets an interactive element's runtime state (a switch position).",
    args: {
      type: 'object',
      properties: { id: { type: 'integer' }, state: { type: 'integer' } },
      required: ['id', 'state'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s, a) =>
      s.elements.some((e) => e.id === (a as { id: number }).id)
        ? true
        : `No element with id ${(a as { id: number }).id} exists.`,
    run: (ctx, a) => {
      const args = a as { id: number; state: number };
      const s = ctx.store.getState();
      s.setElementState(args.id, args.state);
      return args.state;
    },
  },
  {
    id: 'element.toggleSwitch',
    label: 'Toggle Switch',
    description: 'Throws a switch to its next position, fanning out to a linked group.',
    args: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
      additionalProperties: false,
    },
    history: 'none',
    edits: false,
    enabled: (s, a) =>
      s.elements.some((e) => e.id === (a as { id: number }).id)
        ? true
        : `No element with id ${(a as { id: number }).id} exists.`,
    run: (ctx, a) => {
      const s = ctx.store.getState();
      s.toggleSwitch((a as { id: number }).id);
      s.discardRedoFuture();
      return s.elements.find((e) => e.id === (a as { id: number }).id)?.state ?? 0;
    },
  },
  {
    id: 'element.setModel',
    label: 'Set Model',
    description: "Sets or clears an element's named device model (empty string deletes it).",
    args: {
      type: 'object',
      properties: { id: { type: 'integer' }, model: { type: 'string' } },
      required: ['id', 'model'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s, a) =>
      s.elements.some((e) => e.id === (a as { id: number }).id)
        ? true
        : `No element with id ${(a as { id: number }).id} exists.`,
    run: (ctx, a) => {
      const args = a as { id: number; model: string };
      ctx.store.getState().setModelName(args.id, args.model);
      return args.model;
    },
  },
  {
    id: 'element.setKeyShortcut',
    label: 'Set Switch Key',
    description: "Assigns a session-only keyboard shortcut to a switch (first character, lowercased).",
    args: {
      type: 'object',
      properties: { id: { type: 'integer' }, key: { type: 'string' } },
      required: ['id', 'key'],
      additionalProperties: false,
    },
    history: 'none',
    edits: true,
    enabled: (s, a) =>
      s.elements.some((e) => e.id === (a as { id: number }).id)
        ? true
        : `No element with id ${(a as { id: number }).id} exists.`,
    run: (ctx, a) => {
      const args = a as { id: number; key: string };
      ctx.store.getState().setKeyShortcut(args.id, args.key);
      return args.key;
    },
  },
  {
    id: 'element.loadAudio',
    label: 'Load Audio File',
    description:
      'Binds decoded audio samples to an audio-input element and labels it with ' +
      'the file name. The samples are mono values, the rate is Hz.',
    args: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        samples: { type: 'array', items: { type: 'number' } },
        samplingRate: { type: 'number', minimum: 1 },
        fileName: { type: 'string' },
      },
      required: ['id', 'samples', 'samplingRate', 'fileName'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s, a) =>
      s.elements.some((e) => e.id === (a as { id: number }).id)
        ? true
        : `No element with id ${(a as { id: number }).id} exists.`,
    run: (ctx, a) => {
      const args = a as { id: number; samples: number[]; samplingRate: number; fileName: string };
      ctx.store.getState().loadAudioFile(args.id, args.samples, args.samplingRate, args.fileName);
    },
  },
  {
    id: 'element.loadData',
    label: 'Load Data File',
    description: 'Binds parsed data values to a data-input element and labels it with the file name.',
    args: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        samples: { type: 'array', items: { type: 'number' } },
        fileName: { type: 'string' },
      },
      required: ['id', 'samples', 'fileName'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s, a) =>
      s.elements.some((e) => e.id === (a as { id: number }).id)
        ? true
        : `No element with id ${(a as { id: number }).id} exists.`,
    run: (ctx, a) => {
      const args = a as { id: number; samples: number[]; fileName: string };
      ctx.store.getState().loadDataFile(args.id, args.samples, args.fileName);
    },
  },
  {
    id: 'element.setMemoryContents',
    label: 'Edit Memory',
    description:
      'Replaces an SRAM/ROM element contents atomically with [address,value] pairs, ' +
      'so a shrink cannot leave a stale trailing pair.',
    args: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        pairs: {
          type: 'array',
          items: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 },
        },
      },
      required: ['id', 'pairs'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s, a) =>
      s.elements.some((e) => e.id === (a as { id: number }).id)
        ? true
        : `No element with id ${(a as { id: number }).id} exists.`,
    run: (ctx, a) => {
      const args = a as { id: number; pairs: [number, number][] };
      ctx.store.getState().setMemoryContents(args.id, args.pairs);
    },
  },
  {
    id: 'wire.add',
    label: 'Add Wire',
    description:
      'Lays a wire polyline through `points`, one [x,y] pair per corner, and ' +
      'splits what its free ends land on. Returns the surviving wire ids.',
    args: {
      type: 'object',
      properties: {
        points: {
          type: 'array',
          items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
          minItems: 2,
        },
      },
      required: ['points'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    run: (ctx, raw) => {
      const a = raw as { points: [number, number][] };
      const segments = a.points.slice(0, -1).map((p, i) => ({
        x1: p[0],
        y1: p[1],
        x2: a.points[i + 1][0],
        y2: a.points[i + 1][1],
      }));
      return ctx.store.getState().addWires(segments);
    },
  },
  {
    id: 'wire.split',
    label: 'Split Wire',
    description:
      'Splits a wire at circuit point (x,y). `id` names the wire; omit it to ' +
      "split the wire whose interior holds the point.",
    args: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s, a) => {
      const args = a as { id?: number; x: number; y: number };
      if (args.id !== undefined) {
        return s.elements.some((e) => e.id === args.id && e.kind === 'wire')
          ? true
          : `No wire with id ${args.id} exists.`;
      }
      const p: Point = { x: args.x, y: args.y };
      return s.elements.some((e) => e.kind === 'wire' && pointOnWireInterior(p, e))
        ? true
        : 'No wire passes through that point.';
    },
    run: (ctx, raw) => {
      const a = raw as { id?: number; x: number; y: number };
      const s = ctx.store.getState();
      const point = { x: a.x, y: a.y };
      const id =
        a.id ?? s.elements.find((e) => e.kind === 'wire' && pointOnWireInterior(point, e))?.id;
      if (id === undefined) throw new CommandFailure('failed', 'No wire passes through that point.');
      s.splitWireAt(id, point);
      return id;
    },
  },
  {
    id: 'wire.convertToRouted',
    label: 'Convert Wires to Routed Wires',
    description: 'Merges plain-wire chains among the named wires, or the selection, into routed wires.',
    args: optionalIds,
    history: 'step',
    edits: true,
    enabled: (s, a) => {
      const list = (a as { ids?: number[] }).ids;
      if (list === undefined && s.selectedIds.length === 0) {
        return s.elements.some((e) => e.kind === 'wire' && !e.route)
          ? true
          : 'There is no plain wire to convert.';
      }
      const set = targets(s, list);
      return set.some((e) => e.kind === 'wire' && !e.route)
        ? true
        : 'No named wire can be converted.';
    },
    run: (ctx, raw) => {
      const a = raw as { ids?: number[] };
      ctx.store.getState().convertWiresToRouted(a.ids);
    },
  },
  {
    id: 'clipboard.copy',
    label: 'Copy',
    description: 'Copies the named elements, or the selection, to the internal clipboard.',
    args: optionalIds,
    history: 'none',
    edits: true,
    enabled: (s, a) => (chosen(s, (a as { ids?: number[] }).ids).length > 0 ? true : 'Nothing is selected.'),
    run: (ctx, raw) => {
      const a = raw as { ids?: number[] };
      const s = ctx.store.getState();
      if (a.ids === undefined) s.copySelection();
      else s.copyElements(a.ids);
      return s.clipboard;
    },
  },
  {
    id: 'clipboard.cut',
    label: 'Cut',
    description: 'Copies the named elements, or the selection, then deletes them as one undo step.',
    args: optionalIds,
    history: 'step',
    edits: true,
    enabled: (s, a) => (chosen(s, (a as { ids?: number[] }).ids).length > 0 ? true : 'Nothing is selected.'),
    run: (ctx, raw) => {
      const a = raw as { ids?: number[] };
      const s = ctx.store.getState();
      const list = chosen(s, a.ids);
      if (a.ids === undefined) s.cutSelection();
      else s.cutElements(a.ids);
      return list;
    },
  },
  {
    id: 'clipboard.paste',
    label: 'Paste',
    description:
      'Pastes the internal clipboard. `at` places the copy\'s top-left corner ' +
      'at that circuit point; omitted, it fans out from the circuit bounds. ' +
      'Returns the new element ids.',
    args: {
      type: 'object',
      properties: {
        at: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    history: 'step',
    edits: true,
    enabled: (s) =>
      s.clipboard !== null && parsesToElements(s.clipboard)
        ? true
        : 'The clipboard does not hold a circuit.',
    run: (ctx, raw) => {
      const a = raw as { at?: Point };
      const s = ctx.store.getState();
      s.pasteFromClipboard(a.at);
      return s.selectedIds;
    },
  },
  {
    id: 'clipboard.duplicate',
    label: 'Duplicate',
    description: 'Duplicates the named elements, or the selection, without touching the clipboard.',
    args: optionalIds,
    history: 'step',
    edits: true,
    enabled: (s, a) => (chosen(s, (a as { ids?: number[] }).ids).length > 0 ? true : 'Nothing is selected.'),
    run: (ctx, raw) => {
      const a = raw as { ids?: number[] };
      const s = ctx.store.getState();
      if (a.ids === undefined) s.duplicateSelection();
      else s.duplicateElements(a.ids);
      return s.selectedIds;
    },
  },
];
