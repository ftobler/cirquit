/**
 * The undocked scope window: a display-only page with no React and no engine.
 * It announces itself to its opener, then draws whatever per-frame snapshot
 * arrives through the same drawScope the docked panel uses, fed by
 * SnapshotScopeSource instead of the wasm engine. Escape closes the window;
 * the title carries the scope's label from each frame.
 */

import '@fontsource-variable/roboto';
import '../styles.css';
import { emptyCursor, drawScope } from '../scope/draw';
import type { UndockedFrameMessage } from './protocol';
import { UNDOCKED_HELLO_TYPE } from './protocol';
import { SnapshotScopeSource, deliverToSource } from './snapshotSource';

const canvasEl = document.getElementById('scope-win-canvas');
const waiting = document.getElementById('scope-win-waiting');
if (!(canvasEl instanceof HTMLCanvasElement)) throw new Error('missing #scope-win-canvas element');
const canvas: HTMLCanvasElement = canvasEl;
const context = canvas.getContext('2d');
if (!context) throw new Error('missing 2d context');
const ctx: CanvasRenderingContext2D = context;

const source = new SnapshotScopeSource();
// The child has no pointer interactions; an empty cursor keeps the header,
// measurements and settings wheel drawn exactly as the dock shows them at rest.
const cursor = emptyCursor();
let latest: UndockedFrameMessage | null = null;
let receivedFrameAt = -1;

window.addEventListener('message', (ev) => {
  // Only the opener may drive this page: anything else (another tab, a
  // stray iframe) is dropped before its payload is even inspected.
  if (ev.source !== window.opener) return;
  if (ev.data === null || typeof ev.data !== 'object') return;
  if (!deliverToSource(source, ev.data)) return;
  latest = ev.data as UndockedFrameMessage;
  receivedFrameAt = performance.now();
  if (waiting) waiting.hidden = true;
});

// Announce readiness: the opener starts pushing on receipt, so frames sent
// while this page was still loading cannot be lost.
window.opener?.postMessage({ type: UNDOCKED_HELLO_TYPE }, window.location.origin);

document.title = 'Undocked Scope - Circuit Simulator';

// Escape closes, matching how the main window's menus and dialogs dismiss.
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') window.close();
});

// Silence longer than this flips on the hint: either the simulator window is
// closed (its unload closes us when it can) or it is backgrounded, where the
// browser stops its animation loop. Frames resume when samples do.
const WAITING_AFTER_MS = 2000;

function draw(): void {
  requestAnimationFrame(draw);
  if (
    waiting !== null &&
    receivedFrameAt >= 0 &&
    performance.now() - receivedFrameAt > WAITING_AFTER_MS
  ) {
    waiting.hidden = false;
  }
  if (!latest) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w < 2 || h < 2) return;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // The title rides every frame so a label edit in the properties dialog
  // renames this window without any dedicated message.
  if (document.title !== latest.title) document.title = latest.title;
  drawScope(
    ctx,
    source,
    latest.scope,
    w,
    h,
    cursor,
    source.time,
    latest.timeStep,
    latest.dark,
    latest.decimalDigits,
    latest.colors,
    (elementId: number) => latest?.kinds[elementId] ?? null,
  );
}

requestAnimationFrame(draw);
