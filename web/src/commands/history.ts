/** History commands: undo, redo, and the batch that lets an agent build a
 *  whole sub-circuit as one labelled step. A failed batch restores its own
 *  pre-state and pops the entry it opened, so nothing half-built survives. */

import { clone } from '../state/history';
import { CommandFailure, type CommandDef, type CommandResult } from './types';

interface BatchCall {
  id: string;
  args?: unknown;
}

export const historyCommands: CommandDef[] = [
  {
    id: 'history.undo',
    label: 'Undo',
    description: 'Undoes the top history entry, whatever source created it.',
    args: { type: 'object', properties: {}, additionalProperties: false },
    history: 'history',
    edits: true,
    enabled: (s) => (s.history.undo.length > 0 ? true : 'Nothing to undo.'),
    run: (ctx) => {
      ctx.store.getState().undo();
      return ctx.store.getState().history.undo.length;
    },
  },
  {
    id: 'history.redo',
    label: 'Redo',
    description: 'Redoes the top redo entry.',
    args: { type: 'object', properties: {}, additionalProperties: false },
    history: 'history',
    edits: true,
    enabled: (s) => (s.history.redo.length > 0 ? true : 'Nothing to redo.'),
    run: (ctx) => {
      ctx.store.getState().redo();
      return ctx.store.getState().history.redo.length;
    },
  },
  {
    id: 'history.batch',
    label: 'Batch',
    description:
      'Runs a list of commands inside one undo entry named by `label`. Nested ' +
      'calls keep their own validation and gating. The first failure aborts and ' +
      'restores the pre-batch circuit, reporting the failing call index.',
    args: {
      type: 'object',
      properties: {
        calls: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1 },
              args: { type: 'object', properties: {}, additionalProperties: true },
            },
            required: ['id'],
            additionalProperties: false,
          },
        },
        label: { type: 'string', minLength: 1 },
      },
      required: ['calls', 'label'],
      additionalProperties: false,
    },
    history: 'step',
    edits: false,
    undoLabel: (_s, a) => (a as { label: string }).label,
    run: (ctx, raw) => {
      const a = raw as { calls: BatchCall[]; label: string };
      const state = ctx.store.getState();
      const pre = clone(state);
      const preHistory = state.history;
      const values: unknown[] = [];
      for (let i = 0; i < a.calls.length; i++) {
        const call = a.calls[i];
        const result = ctx.execute
          ? ctx.execute(call.id, call.args ?? {})
          : ({ ok: false, error: 'failed', message: 'nested execution is unavailable' } as CommandResult);
        if (!result.ok) {
          // Restore the whole document and the pre-batch history, then throw so
          // the outer transaction's finally closes and prunes its own entry.
          ctx.store.getState().revertBatch(pre, preHistory);
          throw new CommandFailure(
            'failed',
            `call ${i} (${call.id}) failed: ${result.error}: ${result.message}`,
          );
        }
        values.push(result.value);
      }
      return values;
    },
  },
];
