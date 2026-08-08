/**
 * The scope embedded in the schematic (ScopeElm.java, dump 403): a framed
 * viewport with zero posts and no electrical presence. Upstream draws a live
 * oscilloscope inside the frame; this port draws an honest placeholder
 * viewport, because the real waveform rendering belongs to the scope panel.
 *
 * After the common fields the element line carries one extra token: the whole
 * embedded scope view's configuration, joined with `_` into a single token
 * (ScopeElm.java:47-50). It is opaque here: carried verbatim so a load/save
 * round-trip never loses it and never escapes it, the same spirit as the `o`
 * line fidelity work.
 */

import { canvasFont, endpoints, limbColor, polyline } from '../../../render/draw';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** The config a freshly placed scope writes: element -1 (nothing traced yet),
 *  the default speed and voltage/current scales, and a zero-plot list. Only
 *  round-trips; the number is never read back. */
const DEFAULT_SCOPE_CONFIG = '-1_64_0_4096_5_0.1_0_0';

function drawScope(g: DrawContext, e: CircuitElement): void {
  const [p1, p2] = endpoints(e);
  const x = Math.min(p1.x, p2.x);
  const y = Math.min(p1.y, p2.y);
  const w = Math.abs(p2.x - p1.x);
  const h = Math.abs(p2.y - p1.y);
  // The frame is the element's axis-aligned bounding box, stroked as a closed
  // loop so a degenerate zero-height box still reads as a scope.
  const frame: Point[] = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
    { x, y },
  ];
  polyline(g, frame, limbColor(g, g.theme.text));
  // The "Scope" caption sits at the top edge, clear of the viewport centre.
  g.ctx.fillStyle = limbColor(g, g.theme.text);
  g.ctx.font = canvasFont(12);
  g.ctx.textAlign = 'center';
  g.ctx.textBaseline = 'middle';
  g.ctx.fillText('Scope', x + w / 2, y + 10);
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
    // verbatim; nothing here interprets it.
    if (t[0] !== undefined) e.text = t[0];
  },
  dump: (e) => [e.text ?? DEFAULT_SCOPE_CONFIG],
  draw: drawScope,
};
