/** Selection commands: presentation state, never an undo step. They exist so
 *  a caller can name what the following edit acts on without firing a canvas
 *  gesture. */

import type { CommandDef } from './types';

export const selectionCommands: CommandDef[] = [
  {
    id: 'selection.set',
    label: 'Select',
    description: 'Replaces the selection with exactly the named element ids.',
    args: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'integer' } },
      },
      required: ['ids'],
      additionalProperties: false,
    },
    history: 'none',
    edits: true,
    run: (ctx, raw) => {
      const a = raw as { ids: number[] };
      ctx.store.getState().select(a.ids);
      return a.ids;
    },
  },
  {
    id: 'selection.all',
    label: 'Select All',
    description: 'Selects every element in the circuit.',
    args: { type: 'object', properties: {}, additionalProperties: false },
    history: 'none',
    edits: true,
    run: (ctx) => {
      ctx.store.getState().selectAll();
      return ctx.store.getState().selectedIds;
    },
  },
  {
    id: 'selection.clear',
    label: 'Clear Selection',
    description: 'Deselects everything.',
    args: { type: 'object', properties: {}, additionalProperties: false },
    history: 'none',
    edits: true,
    run: (ctx) => {
      ctx.store.getState().select([]);
      return [];
    },
  },
];
