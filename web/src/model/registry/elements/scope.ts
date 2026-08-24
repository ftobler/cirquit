/**
 * The scope embedded in the schematic (ScopeElm.java, dump 403): a framed
 * viewport with zero posts and no electrical presence, drawing live waveforms
 * inside its frame.
 *
 * After the common fields the element line carries one extra token: the whole
 * embedded scope view's configuration, joined with `_` into a single token
 * (ScopeElm.java:47-50). The token is carried verbatim so a load/save
 * round-trip never loses it and never escapes it; `parseCircuit` decodes a
 * copy onto the element, and when that copy has samplable plots this def
 * renders them through the same `drawScope` the docked panels use, with the
 * frame as the viewport. That is upstream's own arrangement: ScopeElm.draw
 * translates into its rect and calls elmScope.draw (ScopeElm.java:109-124).
 *
 * Without interpreted state (a fresh unattached window, a truncated token) or
 * without any samplable plot (every target an unreadable line) it falls back
 * to the placeholder frame plus caption, which is honest for those cases.
 */

import { canvasFont, closedPolyline, endpoints, limbColor } from '../../../render/draw';
import { boxOfPoints } from '../shared';
import { embeddedScopeOf } from '../../../scope/embedded';
import { drawScope as drawScopePanel, emptyCursor } from '../../../scope/draw';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** The config a freshly placed scope writes: element -1 (nothing traced yet),
 *  the default speed and voltage/current scales, and a zero-plot list. Only
 *  round-trips; the number is never read back. */
const DEFAULT_SCOPE_CONFIG = '-1_64_0_4096_5_0.1_0_0';

/** Shared read-only cursor state: an embedded window accepts no pointer
 *  gestures, so nothing ever mutates it. */
const NO_CURSOR = emptyCursor();

function drawScopeElm(g: DrawContext, e: CircuitElement): void {
  const [p1, p2] = endpoints(e);
  const x = Math.min(p1.x, p2.x);
  const y = Math.min(p1.y, p2.y);
  const w = Math.abs(p2.x - p1.x);
  const h = Math.abs(p2.y - p1.y);

  // Live waveforms first, translated into the frame like upstream's draw.
  // The panel fills its own background, so the frame strokes on top of it and
  // stays crisp. Export paths carry no engine surface in the context, and a
  // synthesized scope needs one, hence the single gate for both.
  const view = g.scopeDraw !== undefined ? embeddedScopeOf(e) : null;
  if (view !== null && g.scopeDraw !== undefined && w >= 2 && h >= 2) {
    const live = g.scopeDraw;
    g.ctx.save();
    g.ctx.translate(x, y);
    // The renderer hands us the real canvas context here; the structural
    // Context2D typing exists so recorders can stand in elsewhere.
    drawScopePanel(
      g.ctx as unknown as CanvasRenderingContext2D,
      live.source,
      view,
      w,
      h,
      NO_CURSOR,
      live.simTime,
      live.timeStep,
      live.dark,
      live.decimalDigits,
      live.themeColors,
      undefined,
      // No settings gear: the window accepts no pointer gestures, so the
      // wheel would advertise a properties dialog nothing can open.
      { settingsWheel: false },
    );
    g.ctx.restore();
  }

  // The frame is the element's axis-aligned bounding box, stroked as a closed
  // loop so a degenerate zero-height box still reads as a scope. The close
  // joins the start corner; the explicit repeated point is kept so the four
  // corners stay readable in the geometry.
  const frame: Point[] = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
    { x, y },
  ];
  closedPolyline(g, frame, limbColor(g, g.theme.text));

  // The "Scope" caption only marks a window with nothing to show yet; a live
  // one has waveforms and its own header instead.
  if (view === null) {
    g.ctx.fillStyle = limbColor(g, g.theme.text);
    g.ctx.font = canvasFont(12);
    g.ctx.textAlign = 'center';
    g.ctx.textBaseline = 'middle';
    g.ctx.fillText('Scope', x + w / 2, y + 10);
  }
}

export const SCOPE_DEF: ElementDef = {
  kind: 'scope',
  label: 'Scope',
  category: 'Other',
  dumpCode: '403',
  postCount: 0,
  posts: () => [],
  // The dragged corners span the default 128x64 viewport upstream's
  // constructor makes (ScopeElm.java:31-33), 8 grid units wide.
  defaultLength: 8,
  // The embedded config is one raw `_`-joined token: upstream writes it
  // without the escape scheme (ScopeElm.java:47-50), so it must not be
  // unescaped on load or escaped on save.
  rawTokens: true,
  parse: (t, e) => {
    // The config is the last and only token after the flags. Carried
    // verbatim here; parseCircuit decodes the interpretation separately.
    if (t[0] !== undefined) e.text = t[0];
  },
  dump: (e) => [e.text ?? DEFAULT_SCOPE_CONFIG],
  // The whole framed viewport is a solid pick zone (ScopeElm.java:121).
  bodyRect: (e) => {
    const [p1, p2] = endpoints(e);
    const x0 = Math.min(p1.x, p2.x);
    const y0 = Math.min(p1.y, p2.y);
    const x1 = Math.max(p1.x, p2.x);
    const y1 = Math.max(p1.y, p2.y);
    return boxOfPoints([{ x: x0, y: y0 }, { x: x1, y: y1 }]);
  },
  draw: drawScopeElm,
};
