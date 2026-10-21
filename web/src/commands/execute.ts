/** The one door: look up, validate, gate, run. Every UI door and the later
 *  MCP server call this, so a command cannot behave differently depending on
 *  who asked. */

import type { AppState } from '../state/types';
import { commandById } from './registry';
import { validateArgs } from './schema';
import {
  CommandFailure,
  type CommandContext,
  type CommandDef,
  type CommandResult,
} from './types';

/** True while a human owns a live document transaction: a pointer drag, a
 *  wheel session, or a focused field. An agent must never write into the
 *  middle of one; a user-sourced command keeps today's behaviour (Space may
 *  rotate during a drag). */
export function userBusy(s: AppState): boolean {
  return (
    (s.history.open !== null && s.history.open.source === 'user') ||
    s.elementGesture !== null ||
    s.scrollValuePopover !== null
  );
}

/** Validate and gate one call without running it, for a menu that needs the
 *  disabled state and its tooltip before the click. */
export function commandState(
  id: string,
  args: unknown,
  s: AppState,
): { enabled: boolean; reason?: string } {
  const def = commandById(id);
  if (!def) return { enabled: false, reason: `Unknown command "${id}".` };
  const value = args === undefined ? {} : args;
  const invalid = validateArgs(def.args, value);
  if (invalid) return { enabled: false, reason: invalid.message };
  if (def.edits && !s.settings.editable) {
    return { enabled: false, reason: 'Editing disabled. Re-enable from the Options menu.' };
  }
  const gate = def.enabled?.(s, value);
  if (gate !== true && gate !== undefined) return { enabled: false, reason: gate };
  return { enabled: true };
}

export function execute<R = unknown>(
  id: string,
  args: unknown,
  ctx: CommandContext,
): CommandResult<R> {
  const def = commandById(id) as CommandDef | undefined;
  if (!def) {
    return { ok: false, error: 'unknown', message: `Unknown command "${id}".` };
  }
  const value = args === undefined ? {} : args;
  const invalid = validateArgs(def.args, value);
  if (invalid) {
    return { ok: false, error: 'invalid-args', message: invalid.message };
  }
  const state = ctx.store.getState();
  if (def.edits && !state.settings.editable) {
    return {
      ok: false,
      error: 'disabled',
      message: 'Editing disabled. Re-enable from the Options menu.',
    };
  }
  const gate = def.enabled?.(state, value);
  if (gate !== true && gate !== undefined) {
    return { ok: false, error: 'disabled', message: gate };
  }
  if (ctx.source !== 'user' && userBusy(state)) {
    return {
      ok: false,
      error: 'busy',
      message: 'A user gesture is in progress; try again when it ends.',
    };
  }
  const runCtx: CommandContext = {
    ...ctx,
    execute: (nestedId, nestedArgs) => execute(nestedId, nestedArgs, ctx),
  };
  try {
    if (def.history === 'step') {
      const label = def.undoLabel?.(state, value) ?? def.label;
      const result = ctx.store
        .getState()
        .transact(label, () => def.run(runCtx, value), ctx.source);
      return { ok: true, value: result as R };
    }
    return { ok: true, value: def.run(runCtx, value) as R };
  } catch (e) {
    if (e instanceof CommandFailure) {
      return { ok: false, error: e.error, message: e.message };
    }
    return {
      ok: false,
      error: 'failed',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

