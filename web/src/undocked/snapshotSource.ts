/**
 * The undocked scope window's stand-in for the engine: a ScopeDrawSource built
 * from the per-frame snapshots the main window pushes. It answers exactly the
 * queries drawScope makes and nothing else, so the child draws through the
 * same code path as the dock with no engine of its own.
 */

import type { ScopeDrawSource, TriggerInfoLike } from '../engine/scopeModel';
import { isUndockedFrameMessage, type UndockedFrameMessage } from './protocol';

const EMPTY = new Float32Array(0);

interface TraceSnapshot {
  data: Float32Array;
  diverged: boolean;
  trigger: Omit<TriggerInfoLike, 'free'> | null;
  xy: Float32Array;
}

/** Zeroed trigger state for the defensive path: drawScope asks for trigger
 *  info only when the scope's mode says one exists, so this only shows if a
 *  malformed message slipped past the guard. */
const IDLE_TRIGGER: TriggerInfoLike & { free(): void } = {
  columns: 0,
  snapshot_start: 0,
  start_index: 0,
  state: 0,
  time: 0,
  triggered: false,
  valid_count: 0,
  waiting: true,
  written: 0,
  free: () => undefined,
};

export class SnapshotScopeSource implements ScopeDrawSource {
  /** Plot ids in frame order; the "index" space scopeData/triggerInfo speak. */
  private order: number[] = [];
  private byPlotId = new Map<number, TraceSnapshot>();
  private simTime = 0;

  /** Installs one frame. The message's ArrayBuffers arrive already owned (the
   *  opener transfers them), so wrapping them in views allocates nothing.
   *  Both fields are built locally and assigned only once complete, so a
   *  throw partway through (a buffer the sender had already transferred away
   *  detaches on view construction) leaves the previous frame intact instead
   *  of an order list pointing at data the map never got. */
  applyFrame(message: UndockedFrameMessage): void {
    const order = message.traces.map((t) => t.plotId);
    const byPlotId = new Map(
      message.traces.map((t) => [
        t.plotId,
        {
          data: new Float32Array(t.data),
          diverged: t.diverged,
          trigger: t.trigger,
          xy: t.xy === null ? EMPTY : new Float32Array(t.xy),
        },
      ]),
    );
    this.simTime = message.time;
    this.order = order;
    this.byPlotId = byPlotId;
  }

  get time(): number {
    return this.simTime;
  }

  scopeIndexOf(plotId: number): number | undefined {
    const index = this.order.indexOf(plotId);
    return index < 0 ? undefined : index;
  }

  scopeData(index: number): Float32Array {
    return this.byPlotId.get(this.order[index])?.data ?? EMPTY;
  }

  scopeDiverged(index: number): boolean {
    return this.byPlotId.get(this.order[index])?.diverged ?? false;
  }

  triggerInfo(index: number, _width: number): TriggerInfoLike & { free(): void } {
    // The width argument is ignored on purpose: the snapshot was taken
    // against the docked canvas' registered width, which is what sized the
    // engine's ring. The window clamps the drawn count to its own width.
    const trigger = this.byPlotId.get(this.order[index])?.trigger;
    if (!trigger) return IDLE_TRIGGER;
    return { ...trigger, free: () => undefined };
  }

  recentSamples(index: number): Float32Array {
    return this.byPlotId.get(this.order[index])?.xy ?? EMPTY;
  }
}

/** Applies an inbound event to a source, ignoring anything that is not a
 *  well-formed frame. Split from the class so the guard is testable without
 *  constructing DOM MessageEvents. */
export function deliverToSource(source: SnapshotScopeSource, data: unknown): boolean {
  if (!isUndockedFrameMessage(data)) return false;
  source.applyFrame(data);
  return true;
}
