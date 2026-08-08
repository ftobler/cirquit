/** SVG export via a recording 2D context. The draw layer talks to `g.ctx`
 *  through the standard 2D API, so a recorder that emits one SVG shape per
 *  canvas operation lets the same `def.draw(g, e)` calls produce the export,
 *  pixel-faithful to the PNG path for free. The recorder is a pure-TypeScript
 *  subset of `CanvasRenderingContext2D` (`Context2D`), so `renderCircuitToSvg`
 *  runs headless in node tests, like the approach upstream gets from the
 *  `canvas2svg.js` library (ImageExporter.java:96-127) but with no dependency. */

import type { SimEngine } from '../engine/simulator';
import type { CircuitElement, Context2D, SimSettings } from '../model/types';
import { CENTER_MARGIN_H, CENTER_MARGIN_W, circuitBounds } from '../state/view';
import { makeTheme } from './draw';
import { drawAllElements, exportGeometry } from './export';

/** An affine transform in SVG's `matrix(a b c d e f)` element order. */
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Rounds off float noise: three decimals is far past any grid half-step, and
 *  `-0` has to read as `0` or some paths get a spurious minus. */
function fmt(n: number): string {
  const t = Math.round(n * 1000) / 1000;
  return Object.is(t, -0) ? '0' : String(t);
}

/** Affine multiply `a · b`; points map through `b` first, which is the canvas
 *  post-multiply order (scale then translate lands the translation in the
 *  scaled space). */
function mul(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/** XML-escapes text and attribute values (a lone `&` in an annotation would
 *  otherwise abort the document). */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The drawing state the canvas `save`/`restore` snapshots, all of it: the
 *  per-shape emission happens at draw time, so a stale `globalAlpha` from a
 *  not-restored context would leak opacity onto unrelated shapes. */
interface SavedState {
  ctm: Matrix;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  globalAlpha: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  dash: number[] | null;
}

/** A 2D context that records every drawing call as SVG markup instead of
 *  painting pixels. Only the surface `Context2D` declares is implemented;
 *  anything else the draw layer needs must be added to both, and stays
 *  headless so the export keeps running under node. */
export class SvgRecorder implements Context2D {
  // `Context2D` types these as the full union because a real context can hold
  // a gradient or pattern; the draw layer only ever assigns hex or rgb strings,
  // which is all the recorder stores.
  fillStyle: string = '#000000';
  strokeStyle: string = '#000000';
  lineWidth = 1;
  lineCap = 'butt';
  lineJoin = 'miter';
  globalAlpha = 1;
  font = '10px sans-serif';
  textAlign = 'start';
  textBaseline = 'alphabetic';

  /** The cumulative transform, attached to every emitted shape; no nested
   *  `<g>` groups, per-shape matrices are simpler and always correct. */
  private ctm: Matrix = [...IDENTITY];
  private stack: SavedState[] = [];
  private shapes: string[] = [];
  /** The current path's `d`, kept after stroke/fill like the canvas default
   *  path, so a filled circle can then be stroked with the same geometry. */
  private d = '';
  private hasSubpath = false;
  private subpathStartX = 0;
  private subpathStartY = 0;
  private currentX = 0;
  private currentY = 0;
  private dash: number[] | null = null;

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.ctm = [a, b, c, d, e, f];
  }

  scale(x: number, y: number): void {
    this.ctm = mul(this.ctm, [x, 0, 0, y, 0, 0]);
  }

  translate(x: number, y: number): void {
    this.ctm = mul(this.ctm, [1, 0, 0, 1, x, y]);
  }

  save(): void {
    this.stack.push({
      ctm: [...this.ctm],
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      lineCap: this.lineCap,
      lineJoin: this.lineJoin,
      globalAlpha: this.globalAlpha,
      font: this.font,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
      dash: this.dash ? [...this.dash] : null,
    });
  }

  restore(): void {
    const s = this.stack.pop();
    if (!s) return;
    this.ctm = s.ctm;
    this.fillStyle = s.fillStyle;
    this.strokeStyle = s.strokeStyle;
    this.lineWidth = s.lineWidth;
    this.lineCap = s.lineCap;
    this.lineJoin = s.lineJoin;
    this.globalAlpha = s.globalAlpha;
    this.font = s.font;
    this.textAlign = s.textAlign;
    this.textBaseline = s.textBaseline;
    this.dash = s.dash;
  }

  beginPath(): void {
    this.d = '';
    this.hasSubpath = false;
  }

  moveTo(x: number, y: number): void {
    this.d += `M${fmt(x)} ${fmt(y)}`;
    this.hasSubpath = true;
    this.subpathStartX = x;
    this.subpathStartY = y;
    this.currentX = x;
    this.currentY = y;
  }

  lineTo(x: number, y: number): void {
    this.d += `L${fmt(x)} ${fmt(y)}`;
    this.currentX = x;
    this.currentY = y;
  }

  closePath(): void {
    this.d += 'Z';
    this.currentX = this.subpathStartX;
    this.currentY = this.subpathStartY;
  }

  /** A rectangle subpath, connecting from the current point when one exists
   *  (the canvas behaviour a labeled node relies on after a moveTo). */
  rect(x: number, y: number, w: number, h: number): void {
    if (this.hasSubpath) {
      if (this.currentX !== x || this.currentY !== y) this.d += `L${fmt(x)} ${fmt(y)}`;
    } else {
      this.d += `M${fmt(x)} ${fmt(y)}`;
    }
    this.d +=
      `L${fmt(x + w)} ${fmt(y)}L${fmt(x + w)} ${fmt(y + h)}L${fmt(x)} ${fmt(y + h)}Z`;
    this.hasSubpath = true;
    this.subpathStartX = x;
    this.subpathStartY = y;
    this.currentX = x;
    this.currentY = y;
  }

  /** A circular arc as an `A` segment. The sweep flag follows the canvas
   *  y-down angle convention: the positive (clockwise-on-screen) direction is
   *  sweep 1. A full turn is split at the antipode, because an `A` whose start
   *  and end coincide is degenerate. */
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise = false,
  ): void {
    const sx = x + radius * Math.cos(startAngle);
    const sy = y + radius * Math.sin(startAngle);
    if (radius <= 0) {
      // A zero-radius arc is a point that only moves the current point.
      if (this.hasSubpath) {
        if (this.currentX !== x || this.currentY !== y) this.d += `L${fmt(x)} ${fmt(y)}`;
      } else {
        this.d += `M${fmt(x)} ${fmt(y)}`;
      }
      this.hasSubpath = true;
      this.currentX = x;
      this.currentY = y;
      return;
    }
    // An arc after a moveTo connects from the current point (HTML spec's
    // "if there are subpaths, connect to the arc start").
    if (this.hasSubpath) {
      if (this.currentX !== sx || this.currentY !== sy) this.d += `L${fmt(sx)} ${fmt(sy)}`;
    } else {
      this.d += `M${fmt(sx)} ${fmt(sy)}`;
    }
    this.hasSubpath = true;

    // Canvas arcs always travel in the direction of the flag, wrapping through
    // 2π when the sweep is negative: `counterclockwise=false` from 3π/2 to π/2
    // sweeps 270°→360°→90° (a π arc through the +x axis), not the short way.
    const flag = counterclockwise ? 0 : 1;
    const signedSweep = counterclockwise ? startAngle - endAngle : endAngle - startAngle;
    if (signedSweep >= 2 * Math.PI - 1e-9 || signedSweep <= -2 * Math.PI + 1e-9) {
      // A full turn in either direction paints the whole circle; split at the
      // antipode, because an `A` whose start and end coincide is degenerate.
      const ax = x - radius * Math.cos(startAngle);
      const ay = y - radius * Math.sin(startAngle);
      this.d +=
        `A${fmt(radius)} ${fmt(radius)} 0 1 ${flag} ${fmt(ax)} ${fmt(ay)}` +
        `A${fmt(radius)} ${fmt(radius)} 0 1 ${flag} ${fmt(sx)} ${fmt(sy)}`;
      this.currentX = sx;
      this.currentY = sy;
    } else {
      // The sweep reduced into [0, 2π) is the angle actually travelled, so the
      // large-arc flag agrees with canvas when the arc wraps through 0.
      const reduced = ((signedSweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const largeArc = reduced > Math.PI ? 1 : 0;
      const ex = x + radius * Math.cos(endAngle);
      const ey = y + radius * Math.sin(endAngle);
      this.d += `A${fmt(radius)} ${fmt(radius)} 0 ${largeArc} ${flag} ${fmt(ex)} ${fmt(ey)}`;
      this.currentX = ex;
      this.currentY = ey;
    }
  }

  stroke(): void {
    if (!this.d) return;
    const dash = this.dash ? ` stroke-dasharray="${this.dash.join(',')}"` : '';
    this.shapes.push(
      `<path d="${this.d}" fill="none" stroke="${this.strokeStyle}" stroke-width="${fmt(this.lineWidth)}"` +
        ` stroke-linecap="${this.lineCap}" stroke-linejoin="${this.lineJoin}"${dash}${this.commonAttrs()}/>`,
    );
  }

  fill(): void {
    if (!this.d) return;
    this.shapes.push(`<path d="${this.d}" fill="${this.fillStyle}"${this.commonAttrs()}/>`);
  }

  /** fillRect is a standalone fill, not part of the current path. */
  fillRect(x: number, y: number, w: number, h: number): void {
    this.shapes.push(
      `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" fill="${this.fillStyle}"${this.commonAttrs()}></rect>`,
    );
  }

  fillText(text: string, x: number, y: number): void {
    this.shapes.push(
      `<text x="${fmt(x)}" y="${fmt(y)}" font-size="${fmt(this.fontSize())}" font-family="${escapeXml(this.fontFamily())}"` +
        ` text-anchor="${this.anchor()}" dominant-baseline="${this.baseline()}" fill="${this.fillStyle}"${this.commonAttrs()}>` +
        escapeXml(text) +
        '</text>',
    );
  }

  /** The width heuristic: no real glyph metering, so `text.length * size * 0.6`
   *  like canvas2svg.js's rough estimate. Text centring in the SVG is
   *  approximate for this reason. */
  measureText(text: string): { width: number } {
    return { width: text.length * this.fontSize() * 0.6 };
  }

  setLineDash(segments: number[]): void {
    this.dash = segments.length > 0 ? [...segments] : null;
  }

  /** Emits the whole SVG document for a `width` by `height` canvas. */
  toString(width: number, height: number): string {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}" height="${fmt(height)}">` +
      this.shapes.join('') +
      '</svg>'
    );
  }

  /** The attributes every shape shares: the cumulative transform and the
   *  globalAlpha-derived opacity. The transform is attached even when it is
   *  identity, so each shape carries its own positioning and none depends on a
   *  surrounding group. */
  private commonAttrs(): string {
    const [a, b, c, d, e, f] = this.ctm;
    const t = `transform="matrix(${fmt(a)} ${fmt(b)} ${fmt(c)} ${fmt(d)} ${fmt(e)} ${fmt(f)})"`;
    return this.globalAlpha !== 1 ? ` ${t} opacity="${fmt(this.globalAlpha)}"` : ` ${t}`;
  }

  /** The pixel size of the current `font` string, the canvas default of 10 when
   *  none is set yet. A rail measures its label before setting its font, so the
   *  heuristic has to match what a real context would report there. */
  private fontSize(): number {
    const m = /^(\d+(?:\.\d+)?)px/.exec(this.font);
    return m ? Number(m[1]) : 10;
  }

  /** The family part of the `font` string, already CSS syntax and valid as an
   *  SVG `font-family` value. */
  private fontFamily(): string {
    const m = /^(\d+(?:\.\d+)?)px\s*/.exec(this.font);
    return m ? this.font.slice(m[0].length) : this.font;
  }

  private anchor(): string {
    switch (this.textAlign) {
      case 'center':
        return 'middle';
      case 'right':
      case 'end':
        return 'end';
      case 'left':
      case 'start':
        return 'start';
      default:
        return this.textAlign;
    }
  }

  private baseline(): string {
    switch (this.textBaseline) {
      case 'middle':
        return 'central';
      case 'top':
        return 'text-before-edge';
      case 'bottom':
        return 'text-after-edge';
      default:
        // alphabetic, hanging and ideographic are already SVG values.
        return this.textBaseline;
    }
  }
}

/** Serializes the circuit as an SVG document, replaying the same `def.draw`
 *  calls and transform setup as `renderCircuitToCanvas`, so the two exports
 *  are pixel-faithful to each other. The `dark` argument is always `false`
 *  from the Save As SVG dialog, the same forced-printable white background as
 *  the PNG path; it is kept for symmetry with `renderCircuitToCanvas`. */
export function renderCircuitToSvg(
  elements: CircuitElement[],
  settings: SimSettings,
  dark: boolean,
  engine: SimEngine | null,
): string {
  const bounds = circuitBounds(elements);
  const geo = exportGeometry(bounds);
  const width = Math.max(1, Math.round(geo.width));
  const height = Math.max(1, Math.round(geo.height));

  const rec = new SvgRecorder();
  const theme = makeTheme(dark, settings);
  rec.setTransform(1, 0, 0, 1, 0, 0);
  rec.fillStyle = theme.background;
  rec.fillRect(0, 0, width, height);
  rec.save();
  rec.scale(geo.scale, geo.scale);
  rec.translate(
    -(bounds ? bounds.minX - CENTER_MARGIN_W / 2 : 0),
    -(bounds ? bounds.minY - CENTER_MARGIN_H / 2 : 0),
  );
  drawAllElements(rec, theme, elements, settings, engine, geo.scale);
  rec.restore();
  return rec.toString(width, height);
}
