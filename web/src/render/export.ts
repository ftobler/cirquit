/** Offscreen circuit rendering for Save As Image, the clipboard copy and the
 *  SVG export: the same `def.draw` calls the frame loop makes, replayed at the
 *  upstream print margins (ImageExporter.java:137-153, 202-214). The geometry
 *  math is pure and tested; the drawing needs a 2D context (a canvas for the
 *  PNG, the SVG recorder for markup) and is verified by hand, exactly like the
 *  live canvas. */

import type { SimEngine } from '../engine/simulator';
import { defFor } from '../model/registry';
import type { CircuitElement, Context2D, DrawContext, SimSettings, Theme } from '../model/types';
import { CENTER_MARGIN_H, CENTER_MARGIN_W, circuitBounds, type Rect } from '../state/view';
import { makeTheme } from './draw';

export interface ExportGeometry {
  width: number;
  height: number;
  scale: number;
}

/** Canvas size and draw scale for an image export, matching ImageExporter.java:145-146,
 *  205-206: the canvas doubles the circuit and adds the margin, the draw scale
 *  fits the bounds plus the margin. A null bounds (empty circuit) uses a 0-size
 *  box so the dialog can never feed NaN to `toDataURL`. */
export function exportGeometry(
  bounds: Rect | null,
  marginW = CENTER_MARGIN_W,
  marginH = CENTER_MARGIN_H,
): ExportGeometry {
  const width = (bounds?.width ?? 0) * 2 + marginW;
  const height = (bounds?.height ?? 0) * 2 + marginH;
  const scale = Math.min(
    width / ((bounds?.width ?? 0) + marginW),
    height / ((bounds?.height ?? 0) + marginH),
  );
  return { width, height, scale };
}

/** Replays every element's `def.draw` with a per-element DrawContext, the loop
 *  the canvas and SVG exporters share (and the frame loop's per-element work
 *  when it needs no selection or hover). Selection, hover and the highlighted
 *  net are always off for an export, so both exporters hand zeros for them. */
export function drawAllElements(
  ctx: Context2D,
  theme: Theme,
  elements: CircuitElement[],
  settings: SimSettings,
  engine: SimEngine | null,
  scale: number,
): void {
  const nodeVoltages = engine?.nodeVoltages() ?? null;
  const elementNodes = engine?.elementNodes() ?? null;
  const currents = engine?.elementCurrents() ?? null;
  const values = engine?.elementValues() ?? null;
  const states = engine?.elementStates() ?? null;

  for (const e of elements) {
    const def = defFor(e.kind);
    if (!def) continue;
    const idx = engine?.indexOf(e.id);
    const offset = engine?.postOffset(e.id);
    const posts = def.posts(e);
    const voltages = posts.map((_, i) => {
      if (!nodeVoltages || !elementNodes || offset === undefined) return 0;
      const node = elementNodes[offset + i];
      return node === undefined ? 0 : (nodeVoltages[node] ?? 0);
    });
    const current = idx !== undefined && currents ? (currents[idx] ?? 0) : 0;
    const voltage = voltages.length >= 2 ? voltages[0] - voltages[1] : (voltages[0] ?? 0);
    const value = idx !== undefined && values ? (values[idx] ?? 0) : 0;
    const state = idx !== undefined && states ? (states[idx] ?? 0) : 0;

    const g: DrawContext = {
      ctx,
      theme,
      voltages,
      current,
      voltage,
      power: current * voltage,
      value,
      state,
      dotPhase: 0,
      // Exports draw with `showCurrent: false`, so per-post currents and
      // phases are handed as zeros like the scalar phase.
      postCurrents: [],
      postDotPhases: [],
      showCurrent: false,
      showValues: settings.showValues,
      showVoltageColor: settings.showVoltageColor,
      showPowerColor: settings.showPowerColor,
      conventional: settings.conventional,
      euroResistors: settings.euroResistors,
      euroGates: settings.euroGates,
      selected: false,
      hovered: false,
      onHighlightedNet: false,
      voltageRange: settings.voltageRange,
      powerRange: settings.powerRange,
      scale,
      valueDigits: settings.shortDecimalDigits,
      valueFontSize: settings.valueFontSize,
    };
    def.draw(g, e);
  }
}

/** Replays the frame loop's draw calls onto `canvas`: white or themed
 *  background (the image dialogs pass `dark: false` so the PNG always prints
 *  on white like upstream's forced-printable export), no grid, no current
 *  dots, and the bounds-fitted transform in place of the live view. Live node
 *  voltages, currents, values and render states colour the schematic when
 *  `engine` is given; zeros otherwise, which is what a null engine (no wasm
 *  handle) produces. */
export function renderCircuitToCanvas(
  canvas: HTMLCanvasElement,
  elements: CircuitElement[],
  settings: SimSettings,
  dark: boolean,
  engine: SimEngine | null,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const bounds = circuitBounds(elements);
  const geo = exportGeometry(bounds);
  canvas.width = Math.max(1, Math.round(geo.width));
  canvas.height = Math.max(1, Math.round(geo.height));

  const theme = makeTheme(dark, settings);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.scale(geo.scale, geo.scale);
  ctx.translate(
    -(bounds ? bounds.minX - CENTER_MARGIN_W / 2 : 0),
    -(bounds ? bounds.minY - CENTER_MARGIN_H / 2 : 0),
  );
  drawAllElements(ctx, theme, elements, settings, engine, geo.scale);
  ctx.restore();
}
