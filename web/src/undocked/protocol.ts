/**
 * The wire format between the main window and an undocked scope window.
 *
 * The protocol is push-only and one message per frame: the main window's frame
 * loop copies the trace snapshots it has already read back from the engine and
 * posts them, and every display input (the scope's own draw state, the theme,
 * the element kinds) rides inside that one message. A properties-dialog edit
 * therefore reaches the child on the next pushed frame with no change-detection
 * protocol of its own. The child never talks to the engine; it is a display
 * client, so there is no per-element crossing anywhere on this path, only one
 * flat-array copy per trace.
 */

import type { Scope, TriggerInfoLike } from '../engine/simulator';
import type { ThemeColors } from '../model/types';

/** Child to opener, sent once when the scope page finishes loading. Pushing
 *  starts on receipt, so frames posted into a still-loading child are not
 *  lost: the opener simply has not started yet. */
export interface UndockedHello {
  type: typeof UNDOCKED_HELLO_TYPE;
}

/** One trace's snapshot for a frame. `data` holds min/max column pairs in the
 *  engine's ring order (the exact array `scopeData` returns); `xy` carries the
 *  recent raw samples only when X-Y mode is on, since that is the one reader.
 *
 *  The trigger snapshot was computed by the opener against ITS registered
 *  docked width, and the child draws at its own client size. The popup opens
 *  sized to that same width (undockedWindowOuterSize), so the windows line up
 *  until the user resizes either one; after that a triggered trace may show
 *  fewer or more pre-trigger columns than its canvas could hold. Fixing that
 *  properly needs the child's live size on every frame, a per-frame handshake
 *  this deliberately small wire format does not carry. */
export interface UndockedTraceFrame {
  plotId: number;
  data: ArrayBuffer;
  diverged: boolean;
  /** Trigger ring state, present only when the scope's trigger is not freeRun:
   *  the dock reads it only then either. Field copy of the wasm object; the
   *  child wraps it with its own no-op free. */
  trigger: Omit<TriggerInfoLike, 'free'> | null;
  xy: ArrayBuffer | null;
}

/** Opener to child, once per animation frame while the window is open. The
 *  full draw state travels with the samples on purpose: the message is the
 *  child's whole world, so a speed zoom or a White Background toggle lands on
 *  the very next frame and no second "spec changed" message exists to forget. */
export interface UndockedFrameMessage {
  type: 'undocked-frame';
  /** Sim time of the snapshot; the child anchors its time axis here. */
  time: number;
  /** The mirrored scope's complete display state (plots, speed, flags). */
  scope: Scope;
  dark: boolean;
  decimalDigits: number;
  timeStep: number;
  /** The five user-settable colours makeTheme overlays; a null key keeps the
   *  palette default, exactly as in the main window. */
  colors: ThemeColors;
  /** Element id to kind, for the Show Extended Info header line. */
  kinds: Record<number, string>;
  /** Window title: the scope label, or the fallback when it is unset. */
  title: string;
  traces: UndockedTraceFrame[];
}

export const UNDOCKED_HELLO_TYPE = 'undocked-hello';
export const UNDOCKED_FRAME_TYPE = 'undocked-frame';

/** Window title for the undocked scope: the scope's own label when it set
 *  one, a plain fallback otherwise, suffixed like the docs pages. */
export function scopeWindowTitle(label: string): string {
  return `${label || 'Undocked Scope'} - Circuit Simulator`;
}

/** Runtime guard for messages arriving in the child: anything not a frame
 *  shaped like this (the opener is the only intended sender) is ignored, so a
 *  stray postMessage from another tab cannot crash the draw loop. Traces are
 *  validated per item, not just as an array: applyFrame constructs typed
 *  views from these buffers, and one malformed entry (a missing or detached
 *  buffer) must be rejected whole rather than leave half-installed state. */
export function isUndockedFrameMessage(value: unknown): value is UndockedFrameMessage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (
    v.type !== UNDOCKED_FRAME_TYPE ||
    typeof v.time !== 'number' ||
    typeof v.scope === 'undefined' ||
    v.scope === null ||
    !Array.isArray(v.traces)
  ) {
    return false;
  }
  for (const trace of v.traces as unknown[]) {
    if (typeof trace !== 'object' || trace === null) return false;
    const t = trace as Record<string, unknown>;
    // A detached buffer (transferred away by an earlier window) throws on
    // view construction, so it is refused here like any other non-buffer.
    if (
      typeof t.plotId !== 'number' ||
      !(t.data instanceof ArrayBuffer) ||
      typeof t.diverged !== 'boolean'
    ) {
      return false;
    }
    if (t.xy !== null && !(t.xy instanceof ArrayBuffer)) return false;
    if (t.trigger === null) continue;
    if (typeof t.trigger !== 'object') return false;
    const g = t.trigger as Record<string, unknown>;
    if (
      typeof g.columns !== 'number' ||
      typeof g.snapshot_start !== 'number' ||
      typeof g.start_index !== 'number' ||
      typeof g.state !== 'number' ||
      typeof g.time !== 'number' ||
      typeof g.triggered !== 'boolean' ||
      typeof g.valid_count !== 'number' ||
      typeof g.waiting !== 'boolean' ||
      typeof g.written !== 'number'
    ) {
      return false;
    }
  }
  return true;
}
