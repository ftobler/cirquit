import type { SimEngine } from '../engine/simulator';
import type { CircuitElement, SimSettings } from '../model/types';
import { infoLines, simStatsLines } from '../render/infoBox';
import { cachedBadConnectionPoints } from '../render/junction';
import { readElementInfoValues } from './useLiveSimReadout';

/** The info area's text: the hovered element's getInfo-style readout, or the
 *  `t =` / `time step =` stats when nothing is hovered, then the bad-connection
 *  count. Shared by the main canvas fallback (no scopes) and the info panel
 *  next to the scope strip, so the two renderers cannot drift. */
export function infoBoxLines(
  hoveredId: number | null,
  elements: readonly CircuitElement[],
  engine: SimEngine | null,
  settings: Pick<SimSettings, 'timeStep' | 'iterCount'>,
): string[] {
  const hovered = hoveredId !== null ? elements.find((e) => e.id === hoveredId) : undefined;
  const lines = hovered
    ? infoLines(hovered.kind, hovered, readElementInfoValues(engine, hovered))
    : simStatsLines(engine?.time ?? 0, settings.timeStep, settings.iterCount);
  // The tally of the red dots, appended below whichever block is showing
  // (UIManager.java:879-883). It is the only hint of why a circuit that looks
  // wired reads as open, so it has to sit where the eye already is, not behind
  // a hover. Hovering an element keeps it: upstream appends it after the
  // getInfo lines too.
  const bad = cachedBadConnectionPoints(elements).length;
  if (bad > 0) lines.push(`${bad} bad connection${bad === 1 ? '' : 's'}`);
  return lines;
}

/** Builds the Show Extended Info resolver a scope header uses: for a plotted
 *  element id it returns that element's getInfo-style lines, the same ones the
 *  hover box shows, so the two surfaces cannot drift. Returns null for an id
 *  with no matching element. The docked panel, the undocked window and the
 *  embedded 403 window all draw through `drawScope`, so they share this one
 *  resolver rather than each re-implementing the lookup. */
export function elmInfoResolver(
  elements: readonly CircuitElement[],
  engine: SimEngine | null,
): (elementId: number) => string[] | null {
  return (elementId: number) => {
    const element = elements.find((e) => e.id === elementId);
    if (!element) return null;
    return infoLines(element.kind, element, readElementInfoValues(engine, element));
  };
}
