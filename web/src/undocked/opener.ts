/**
 * The main-window half of the undocked scope: it owns the popup window handle
 * and turns one frame's engine readback into the snapshot message. The store
 * action calls `attachUndockedWindow` after a successful `window.open`; the
 * frame loop calls `pushUndockedScopeFrame` once per frame; App routes the
 * child's hello message to `noteUndockedHello`. No DOM event listeners live
 * here, so every part is node-testable with a fake window.
 */

import type { CircuitElement, SimSettings } from '../model/types';
import type {
  ElementReadoutSource,
  Scope,
  ScopeDrawSource,
  TriggerInfoLike,
} from '../engine/simulator';
import { DEFAULT_SCOPE_WIDTH, scopeWidth } from '../scope/geometry';
import {
  UNDOCKED_FRAME_TYPE,
  scopeWindowTitle,
  type UndockedFrameMessage,
  type UndockedTraceFrame,
} from './protocol';
import { infoLines } from '../render/infoBox';
import { readElementInfoValues } from '../ui/useLiveSimReadout';

interface Attachment {
  win: Window;
  /** Store drop, invoked when the window turns out closed or its scope has
   *  vanished; the store's own close path detaches without re-closing. */
  onLost: () => void;
  ready: boolean;
}

let attachment: Attachment | null = null;

/** Records the opened window and starts the mirror. Replaces any previous
 *  attachment; the single-window guard in the store means this happens once. */
export function attachUndockedWindow(win: Window, onLost: () => void): void {
  if (attachment) detachUndockedWindow(true);
  attachment = { win, onLost, ready: false };
}

/** Drops the attachment, closing the window unless it is already gone. */
export function detachUndockedWindow(close: boolean): void {
  const current = attachment;
  attachment = null;
  if (current && close) current.win.close();
}

/**
 * The child finished loading; per-frame pushing starts here. The whole event
 * travels in so the sender can be checked: only a hello from the window this
 * module opened counts, never one from an arbitrary tab or iframe that
 * guessed the message type.
 */
export function noteUndockedHello(ev: { source: unknown }): void {
  if (!attachment || ev.source !== attachment.win) return;
  attachment.ready = true;
}

/** The attached window handle, for the store entry. */
export function undockedWindow(): Window | null {
  return attachment?.win ?? null;
}

/** Copies one engine array into a transferable buffer. `slice` because the
 *  engine's arrays are views over wasm memory, which cannot be transferred. */
function copyOf(data: Float32Array): ArrayBuffer {
  return data.slice().buffer;
}

/** Outer-size allowances over the wanted canvas area: window borders and a
 *  title bar. Estimates, not measurements, and they differ per platform and
 *  browser; they only have to land the popup near the docked capture width,
 *  which is what keeps triggered traces lined up at open time. */
const CHROME_WIDTH_PX = 16;
const CHROME_HEIGHT_PX = 96;

/** Feature size for the scope popup whose canvas should be `dockedWidth`
 *  pixels wide: the mirror computes trigger state against exactly that
 *  number (the scope's registered docked width, or the shared default before
 *  a panel has measured), so starting the canvas there aligns the two
 *  windows until the user resizes either one. Height follows no capture
 *  dimension; it is the comfortable minimum a trace needs. */
export function undockedWindowOuterSize(dockedWidth: number): {
  width: number;
  height: number;
} {
  const safeWidth = Number.isFinite(dockedWidth) && dockedWidth > 0 ? Math.round(dockedWidth) : DEFAULT_SCOPE_WIDTH;
  return { width: safeWidth + CHROME_WIDTH_PX, height: 400 + CHROME_HEIGHT_PX };
}

/** Plain-field copy of the wasm trigger object, released right after: the
 *  snapshot must outlive this frame's message without pinning wasm memory. */
function triggerSnapshot(info: TriggerInfoLike & { free(): void }): TriggerInfoLike {
  try {
    return {
      columns: info.columns,
      snapshot_start: info.snapshot_start,
      start_index: info.start_index,
      state: info.state,
      time: info.time,
      triggered: info.triggered,
      valid_count: info.valid_count,
      waiting: info.waiting,
      written: info.written,
    };
  } finally {
    info.free();
  }
}

/** Builds one frame message from the engine readback. Pure with respect to
 *  its inputs apart from the array copies it hands to postMessage; the same
 *  narrow ScopeDrawSource surface the dock draws through feeds it. */
export function buildUndockedFrame(args: {
  source: ScopeDrawSource;
  scope: Scope;
  elements: CircuitElement[];
  settings: SimSettings;
  dark: boolean;
}): UndockedFrameMessage {
  const { source, scope, elements, settings, dark } = args;
  // The docked canvas' registered width: what the ring was sized against and
  // what the dock passes to triggerInfo, so the child reads consistent state.
  const width = scopeWidth(scope.id) ?? DEFAULT_SCOPE_WIDTH;
  const elmById = new Map(elements.map((e) => [e.id, e]));
  const elmInfo: Record<number, string[]> = {};
  const traces: UndockedTraceFrame[] = [];
  for (const plot of scope.plots) {
    const index = source.scopeIndexOf(plot.id);
    // Plots whose element or value the engine never registered have no trace
    // to copy; drawScope skips them too.
    if (index === undefined) continue;
    traces.push({
      plotId: plot.id,
      data: copyOf(source.scopeData(index)),
      diverged: source.scopeDiverged(index),
      trigger:
        scope.trigger.mode !== 'freeRun' ? triggerSnapshot(source.triggerInfo(index, width)) : null,
      xy: scope.plotXY ? copyOf(source.recentSamples(index)) : null,
    });
    // Show Extended Info ships the element's full getInfo lines for the child,
    // computed once here with the same closure the docked panel uses, so the
    // popup needs no engine access (OVERVIEW.md: the undocked window is a
    // display client). The readout rides arrays already read back per frame.
    if (plot.elementId !== null) {
      const element = elmById.get(plot.elementId);
      if (element)
        elmInfo[plot.elementId] = infoLines(
          element.kind,
          element,
          readElementInfoValues(source as ElementReadoutSource, element),
        );
    }
  }
  return {
    type: UNDOCKED_FRAME_TYPE,
    time: source.time,
    scope,
    dark,
    decimalDigits: settings.decimalDigits,
    timeStep: settings.timeStep,
    colors: {
      positiveColor: settings.positiveColor,
      negativeColor: settings.negativeColor,
      neutralColor: settings.neutralColor,
      selectionColor: settings.selectionColor,
      currentColor: settings.currentColor,
    },
    elmInfo,
    title: scopeWindowTitle(scope.label),
    traces,
  };
}

/** Drops a lost attachment: closes the window if it still exists (the
 *  vanished-scope path), then tells the store so its entry goes too. */
function loseAttachment(current: Attachment): void {
  attachment = null;
  current.win.close();
  current.onLost();
}

/** One frame of work for the frame loop: reap a dead window or a vanished
 *  scope, then push the snapshot. Cheap no-op while nothing is attached. */
export function pushUndockedScopeFrame(args: {
  source: ScopeDrawSource | null;
  scopes: Scope[];
  elements: CircuitElement[];
  settings: SimSettings;
  dark: boolean;
  scopeId: number | undefined;
}): void {
  const current = attachment;
  if (!current) return;
  // The user may close the popup at any moment; polling `closed` from the
  // loop we already run catches that without any unload coordination.
  if (current.win.closed) {
    loseAttachment(current);
    return;
  }
  // No engine means the app is still starting or the canvas has no engine
  // yet: nothing can be mirrored, but the window should survive until the
  // real readback flows.
  if (!args.source) return;
  // The scope can disappear under the window (a remove, an undo, a load); a
  // window mirroring nothing closes rather than freezing on stale samples.
  const scope = args.scopes.find((s) => s.id === args.scopeId);
  if (!scope) {
    loseAttachment(current);
    return;
  }
  if (!current.ready) return;
  const message = buildUndockedFrame({
    source: args.source,
    scope,
    elements: args.elements,
    settings: args.settings,
    dark: args.dark,
  });
  // The copied buffers travel by transfer: they are fresh slices, so handing
  // them off costs one ownership move instead of a second copy.
  current.win.postMessage(message, {
    transfer: [
      ...message.traces.map((t) => t.data),
      ...message.traces.flatMap((t) => (t.xy !== null ? [t.xy] : [])),
    ],
  });
}
