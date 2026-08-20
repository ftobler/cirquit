import type { SimEngine } from '../engine/simulator';
import type { CircuitElement, SimSettings } from '../model/types';
import { infoLines, simStatsLines } from '../render/infoBox';
import { readElementReadout } from './useLiveSimReadout';

/** The info area's text: the hovered element's getInfo-style readout, or the
 *  `t =` / `time step =` stats when nothing is hovered. Shared by the main
 *  canvas fallback (no scopes) and the info panel next to the scope strip, so
 *  the two renderers cannot drift. */
export function infoBoxLines(
  hoveredId: number | null,
  elements: readonly CircuitElement[],
  engine: SimEngine | null,
  settings: Pick<SimSettings, 'timeStep' | 'iterCount'>,
): string[] {
  const hovered = hoveredId !== null ? elements.find((e) => e.id === hoveredId) : undefined;
  return hovered
    ? infoLines(hovered.kind, hovered, readElementReadout(engine, hovered.id))
    : simStatsLines(engine?.time ?? 0, settings.timeStep, settings.iterCount);
}
