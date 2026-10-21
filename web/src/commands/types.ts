/** The public command vocabulary: every document mutation the app or a later
 *  MCP tool may ask for goes through one of these definitions. Ids are stable
 *  and machine-facing, arguments are a serialisable JSON-Schema subset, and a
 *  command never touches the DOM. */

import type { AppState } from '../state/types';
import type { HistorySource } from '../state/history';

/** The store surface a command may use. Every write goes through an action on
 *  the live state, never through `setState`, so gating and undo stay in one
 *  place. A full zustand `StoreApi<AppState>` satisfies this. */
export interface CommandStore {
  getState(): AppState;
}

/** The host-only effects that cannot be commands: the file picker, printing,
 *  the fullscreen API and the run controls that live on the wasm engine. A
 *  command that needs one receives it here. */
export interface SimControls {
  /** Engine reset, then the caller's store half (fuse unblow) runs in the
   *  command. Returns nothing: a reset cannot fail. */
  reset(): void;
  /** The one-shot DC operating point. `null` means found, `'degraded'` means
   *  the solve converged on nothing, any other string is the engine's own
   *  refusal message, and undefined means the engine is not up yet. */
  dcOperatingPoint(): string | null | undefined;
}

export interface CommandContext {
  store: CommandStore;
  source: HistorySource;
  /** Present in the app and in the later MCP host; absent in a headless test
   *  that does not exercise run control. */
  sim?: SimControls;
  /** Filled in by `execute` for nested calls (history.batch). Keeping it on
   *  the context avoids a registry <-> execute import cycle. */
  execute?: (id: string, args: unknown) => CommandResult<unknown>;
}

export type CommandError = 'unknown' | 'invalid-args' | 'disabled' | 'busy' | 'failed';

export type CommandResult<R = unknown> =
  | { ok: true; value: R }
  | { ok: false; error: CommandError; message: string };

/** A thrown refusal a command can raise when the argument schema cannot say
 *  what is wrong (an unknown element kind, a stale id). `execute` maps it to
 *  the matching CommandResult error instead of a generic `failed`. */
export class CommandFailure extends Error {
  constructor(
    readonly error: CommandError,
    message: string,
  ) {
    super(message);
    this.name = 'CommandFailure';
  }
}

/** The JSON-Schema subset the registry uses. It is plain data so step 4 can
 *  serialise a definition straight into an MCP `inputSchema`. */
export type ArgSchema =
  | {
      type: 'object';
      properties: Record<string, ArgSchema>;
      required?: string[];
      /** false (the default) rejects unknown keys so a typo surfaces; a schema
       *  accepts a closed family of values; true accepts anything. */
      additionalProperties?: boolean | ArgSchema;
      description?: string;
    }
  | {
      type: 'array';
      items: ArgSchema;
      minItems?: number;
      maxItems?: number;
      description?: string;
    }
  | {
      type: 'number';
      minimum?: number;
      maximum?: number;
      description?: string;
    }
  | {
      type: 'integer';
      minimum?: number;
      maximum?: number;
      description?: string;
    }
  | {
      type: 'string';
      enum?: string[];
      minLength?: number;
      maxLength?: number;
      description?: string;
    }
  | { type: 'boolean'; description?: string }
  | { type: 'null'; description?: string }
  /** Any one of the subschemas, for a genuinely nullable field (a plot's
   *  manual scale is a number or null). The first failing branch's error is
   *  reported. */
  | { anyOf: ArgSchema[]; description?: string };

/** True when the command opens exactly one labelled undo step. `none` never
 *  touches history (selection, view, run control, clipboard copy), `history`
 *  is undo/redo itself. */
export type HistoryMode = 'step' | 'none' | 'history';

export interface CommandDef<A = unknown, R = unknown> {
  /** Stable dotted id, the public name. MCP tool names derive from it, so a
   *  rename is a breaking change. */
  id: string;
  /** Edit-menu wording, also the undo label unless `undoLabel` overrides. */
  label: string;
  /** One paragraph for tool listings: what it does, units, what ids mean. */
  description: string;
  args: ArgSchema;
  history: HistoryMode;
  /** Editing commands are refused when settings.editable is false. */
  edits: boolean;
  /** True for commands that replace the document and wipe the undo history.
   *  The live bridge uses this to ask before running one. */
  destructive?: boolean;
  /** Returns true when the command may run, or the reason it may not. */
  enabled?(s: AppState, args: A): true | string;
  /** The undo label, when the generic label is too vague (`Add Resistor`). */
  undoLabel?(s: AppState, args: A): string;
  run(ctx: CommandContext, args: A): R;
}
