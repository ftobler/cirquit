/**
 * The Create Test command (TestCreator.java): builds a test harness around a
 * selected chip by placing an element on every non-duplicate pin, extending
 * `gridSize * 4` outward from the pin's post along its side. Narrow pins get
 * plain logic inputs and outputs; a pin wider than one bit collapses to a
 * single bus logic input (inputs) or a single show-bus-value wire (outputs),
 * the four-way branch of TestCreator.java:60-93.
 *
 * Everything here is pure geometry: given the pins, their posts and the chip's
 * flip flags it returns the elements to add. No canvas and no DOM, so the
 * placement and the single-chip guard are testable headlessly. The store action
 * and the menubar row just wire this up and bump the engine revision.
 */

import { CHIP_FLIP_X, CHIP_FLIP_Y, CHIP_FLIP_XY } from './registry/elements/dFlipFlop';
import { WIRE_SHOW_BUS_VALUE } from './registry/flags';
import { chipPinsOf } from './registry/chips';
import type { CircuitElement, Point } from './types';

/** One chip pin as the harness sees it: the side the post points along, whether
 *  it is an output, and where the post sits. `busZ`/`busWidth` come from the
 *  chip's pin table (ChipElm.Pin); bus-mode chips like the wide adder or the
 *  counter2 collapse each bank onto one row and tag every bit with them. */
export interface HarnessPin {
  side: 'W' | 'E' | 'N' | 'S';
  output: boolean;
  post: Point;
  busWidth?: number;
  busZ?: number;
}

/** One element to add: a single-post part whose terminal sits on the chip's
 *  post and whose free end is `gridSize * 4` outward along the pin's side, so
 *  the harness element and the chip merge into one node. */
export interface HarnessPlacement {
  kind: 'logicInput' | 'logicOutput' | 'busLogicInput' | 'wire';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** The pin width carried by a bus placement: upstream seeds it straight
   *  into the new BusLogicInputElm (TestCreator.java:81). Absent elsewhere;
   *  the wire takes its width from the surrounding topology like any other. */
  busWidth?: number;
  /** Element flags beyond the kind defaults: the wide-output wire carries
   *  WIRE_SHOW_BUS_VALUE so its word stays visible (TestCreator.java:68). */
  flags?: number;
}

/** The outward unit direction of a pin, from its side after the chip's flip
 *  flags, mirroring the flip handling in `chipPinPoints` (ChipElm.Pin.setPoint,
 *  ChipElm.java:688-700): FLAG_FLIP_XY remaps the side letter first, then
 *  FLAG_FLIP_X and FLAG_FLIP_Y negate the axis they mirror. */
function pinOutward(side: HarnessPin['side'], flags: number): { x: number; y: number } {
  let s = side;
  if ((flags & CHIP_FLIP_XY) !== 0) {
    s = ({ W: 'N', E: 'S', N: 'W', S: 'E' } as const)[side];
  }
  let dx = 0;
  let dy = 0;
  switch (s) {
    case 'W':
      dx = -1;
      break;
    case 'E':
      dx = 1;
      break;
    case 'N':
      dy = -1;
      break;
    case 'S':
      dy = 1;
      break;
  }
  if ((flags & CHIP_FLIP_X) !== 0) dx = -dx;
  if ((flags & CHIP_FLIP_Y) !== 0) dy = -dy;
  return { x: dx, y: dy };
}

/** The placements for a chip's pins: one element per non-duplicate pin,
 *  `gridSize * 4` outward from its post. Upstream splits each pin four ways
 *  (TestCreator.java:60-93): a wide input collapses to a single
 *  BusLogicInputElm seeded with the pin width (79-86), a wide output to a
 *  single wire showing the bus value (62-69), and narrow pins keep their
 *  plain logic input or output. Bus duplicate pins (`busZ > 0`) are skipped
 *  either way, so a bus contributes exactly one element (TestCreator.java:
 *  36-38).
 *
 *  The lead direction is the pin's side letter run through the flip flags
 *  (pinOutward). That matches an unrotated chip; a quarter turn (chips rotate
 *  like any two-point part) rotates the posts with the frame while the side
 *  letters stay put, so the lead then points along the raw screen axis instead
 *  of the rotated side. Deliberate: the terminal still lands exactly on the
 *  post, so the harness connects and drives correctly and only the lead/glyph
 *  direction is off. A rotation-aware version would push the side letter
 *  through the chip's frame axis the way chipPosts does. */
export function createTestHarness(
  pins: readonly HarnessPin[],
  gridSize: number,
  flags = 0,
): HarnessPlacement[] {
  const len = gridSize * 4;
  const placements: HarnessPlacement[] = [];
  for (const pin of pins) {
    if ((pin.busZ ?? 0) > 0) continue;
    const d = pinOutward(pin.side, flags);
    const lead = {
      x1: pin.post.x,
      y1: pin.post.y,
      x2: pin.post.x + d.x * len,
      y2: pin.post.y + d.y * len,
    };
    const wide = (pin.busWidth ?? 1) > 1;
    if (!pin.output && wide) {
      placements.push({ kind: 'busLogicInput', ...lead, busWidth: pin.busWidth });
    } else if (wide) {
      placements.push({ kind: 'wire', ...lead, flags: WIRE_SHOW_BUS_VALUE });
    } else {
      placements.push({ kind: pin.output ? 'logicOutput' : 'logicInput', ...lead });
    }
  }
  return placements;
}

/** The single selected chip element, or null when nothing is selected, more
 *  than one element is selected, or the selected element is not a chip. The
 *  command aborts (with an alert) when this returns null. */
export function selectHarnessChip(
  elements: readonly CircuitElement[],
  selectedIds: readonly number[],
): CircuitElement | null {
  if (selectedIds.length !== 1) return null;
  const selected = elements.find((e) => e.id === selectedIds[0]);
  return selected !== undefined && chipPinsOf(selected) !== undefined ? selected : null;
}
