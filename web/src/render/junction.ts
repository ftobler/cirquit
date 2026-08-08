/** Junction-dot policy, kept headless so it can be unit tested: upstream draws
 *  a post dot only where the post count at a coordinate is not exactly 2, so a
 *  plain two-element pass-through connection hides while dead ends and real
 *  junctions keep theirs (makePostDrawList, SimulationManager.java:1056-1108). */

import type { CircuitElement } from '../model/types';
import { postsOf } from '../model/registry';

/** Count of element posts per `x,y` coordinate, keyed `"x,y"`. A routed wire's
 *  bend vertices are not posts and contribute nothing; only the two endpoints
 *  count. */
export function postDotPoints(elements: readonly CircuitElement[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of elements) {
    for (const p of postsOf(e)) {
      const key = `${p.x},${p.y}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/** A dot belongs at a coordinate when the post count is not exactly 2: a dead
 *  end (1) or a junction (3+), never a pass-through. */
export function shouldDrawDot(count: number): boolean {
  return count !== 2;
}
