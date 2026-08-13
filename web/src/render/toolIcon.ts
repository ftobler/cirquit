/** Static toolbox icons: each tool's own `def.draw` rendered once onto a small
 *  canvas, so the sidebar shows the real symbol instead of a hand-drawn
 *  substitute. Headless-testable: the helper takes a surface, not a DOM canvas,
 *  so the node suite can hand it the mkCtx fake. */

import type { CircuitElement, Context2D, DrawContext, ElementDef, SimSettings } from '../model/types';
import { GRID_SIZE } from '../model/types';
import { toolDef } from '../model/registry';
import { makeToolElement } from '../state/helpers';
import { makeTheme } from './draw';
import { elementBox } from './selection';

/** Pixel side of a toolbox icon canvas, upstream's 24 px toolbar icons
 *  (Toolbar.java `makeSvg(..., 24)`). */
export const TOOL_ICON_SIZE = 24;

/** Circuit-unit padding around the drawn body, so leads, stems and round caps
 *  stay inside the icon after the fit scale. */
const ICON_MARGIN = 10;

/** The canvas surface an icon draws onto. A real `<canvas>` element satisfies
 *  this structurally; the headless tests hand it the mkCtx fake. */
export interface ToolIconSurface {
  getContext(kind: '2d'): Context2D | null;
}

/** Scale and translation mapping the element's drawn box onto the icon, fitted
 *  and centred the way upstream hand-tunes its toolbar transforms. The box
 *  unions the hit-test body rect (the chips) with the posts, so a wide chip
 *  and a tall transistor both fit. Capped at scale 1 so a small symbol does
 *  not dwarf the icon with an enormous line weight. */
function iconFit(e: CircuitElement, def: ElementDef | undefined) {
  const body = def?.bodyRect?.(e);
  const posts = elementBox(e);
  const x0 = Math.min(body?.x0 ?? Infinity, posts.x0);
  const y0 = Math.min(body?.y0 ?? Infinity, posts.y0);
  const x1 = Math.max(body?.x1 ?? -Infinity, posts.x1);
  const y1 = Math.max(body?.y1 ?? -Infinity, posts.y1);
  const w = x1 - x0 + 2 * ICON_MARGIN;
  const h = y1 - y0 + 2 * ICON_MARGIN;
  const scale = Math.min(1, TOOL_ICON_SIZE / Math.max(w, h, 1));
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return {
    scale,
    tx: TOOL_ICON_SIZE / 2 - cx * scale,
    ty: TOOL_ICON_SIZE / 2 - cy * scale,
  };
}

/** Draws the tool's own symbol for `toolId` onto `canvas` in the given theme.
 *  The stub element spans the same default-length geometry a placement drag
 *  starts with (the vertical kinds drop downward, pointerDown.ts:209-213), and
 *  the draw context carries neutral values so no symbol can read live sim
 *  data. The background fills first at the identity transform, so a cached
 *  icon re-renders cleanly when the theme flips. */
export function renderToolIcon(
  toolId: string,
  canvas: ToolIconSurface,
  dark: boolean,
  settings?: SimSettings,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const def = toolDef(toolId);
  if (!def) return;
  const grid = GRID_SIZE;
  // A kind with no `defaultLength` places as a point, which the icon cannot
  // afford: `interp` ignores its perpendicular offset when the segment length
  // is 0 (draw.ts:45-55), so every body built from interp points collapses to
  // a 3 px dot. Fall back to the wire's default (4, upstream's 64 px
  // getDragLength), kept inside the icon helper so live placement geometry is
  // untouched. The vertical kinds carry their own defaultLength, so their
  // drop is unaffected.
  const len = (def.defaultLength ?? 4) * grid;
  const x2 = def.vertical ? 0 : len;
  const y2 = def.vertical ? len : 0;
  const e: CircuitElement = { ...makeToolElement(toolId, 0, 0, x2, y2), id: 0 };
  const fit = iconFit(e, def);
  const theme = makeTheme(dark, settings);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, TOOL_ICON_SIZE, TOOL_ICON_SIZE);
  ctx.setTransform(fit.scale, 0, 0, fit.scale, fit.tx, fit.ty);

  const g: DrawContext = {
    ctx,
    theme,
    voltages: [],
    current: 0,
    voltage: 0,
    power: 0,
    value: 0,
    state: 0,
    wave: [],
    dotPhase: 0,
    postCurrents: [],
    postDotPhases: [],
    showCurrent: false,
    showValues: false,
    showVoltageColor: false,
    showPowerColor: false,
    conventional: true,
    // The app defaults to the IEC symbols, so the icon matches a freshly
    // placed part (DEFAULT_SETTINGS euroResistors/euroGates true). The
    // settings object flows through like every other makeTheme call site
    // (useFrameLoop.ts:223, export.ts), so the user's custom theme colours
    // and symbol choices paint into the icons too.
    euroResistors: settings?.euroResistors ?? true,
    euroGates: settings?.euroGates ?? true,
    selected: false,
    hovered: false,
    onHighlightedNet: false,
    voltageRange: 5,
    powerRange: 50,
    scale: 1,
    valueDigits: 1,
    valueFontSize: 12,
  };
  def.draw(g, e);
}
