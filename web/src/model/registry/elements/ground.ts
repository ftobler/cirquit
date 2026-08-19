import { currentDots, line } from '../../../render/draw';
import { elementColor, groundBars, onePost, readParams, writeParams, boxOfPoints } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

function drawGroundSymbol(g: DrawContext, e: CircuitElement): void {
  const p1 = { x: e.x1, y: e.y1 };
  const p2 = { x: e.x2, y: e.y2 };
  const color = elementColor(g, 0, g.power);
  // The stem is the whole dragged span; the symbol hangs off the far end,
  // the end opposite the post (GroundElm.java:65). The stem is the symbol
  // body, not a terminal lead, so it strokes at the port's crisp butt cap,
  // the same policy as the bars and every other symbol body; upstream draws
  // both round. The base bar covers the far end either way.
  line(g, p1, p2, color);
  for (const [a, b] of groundBars(p1, p2, e.params.symbolType ?? 0)) {
    line(g, a, b, color);
  }
  // One dot run down the whole stem, post to symbol end (GroundElm.java:
  // 93-94). The ground's `current` is positive flowing from the node down
  // the stem into earth, so a positive current animates from the post into
  // the symbol.
  currentDots(g, p1, p2, g.current);
}

export const GROUND_DEF: ElementDef = {
  kind: 'ground',
  label: 'Ground',
  category: 'Basics',
  dumpCode: 'g',
  shortcut: 'g',  // GroundElm.java
  postCount: 1,
  posts: onePost,
  draggablePosts: 2,  // the free end is a control point, not a terminal
  vertical: true,   // GroundElm.java:36, always placed vertically
  defaultLength: 2, // 32 px, GroundElm.java:140
  parse: (t, e) => readParams(t, e, ['symbolType']),
  dump: writeParams(['symbolType']),
  // The symbol choice upstream exposes as its only edit item
  // (GroundElm.java:142-159); the lastSymbolType persistence is a static that
  // has no file representation, so it is not modelled.
  fields: [
    {
      name: 'symbolType',
      label: 'Symbol',
      type: 'choice',
      choices: [
        { value: 0, label: 'Earth' },
        { value: 1, label: 'Chassis' },
        { value: 2, label: 'Signal' },
        { value: 3, label: 'Common' },
      ],
    },
  ],
  // The stem and the bars hanging off its free end are a solid pick zone: the
  // symbol that a click has to reach to grab the ground (GroundElm.java:95).
  bodyRect: (e) => {
    const p1 = { x: e.x1, y: e.y1 };
    const p2 = { x: e.x2, y: e.y2 };
    const pts: Point[] = [p1];
    for (const [a, b] of groundBars(p1, p2, e.params.symbolType ?? 0)) pts.push(a, b);
    return boxOfPoints(pts);
  },
  draw: drawGroundSymbol,
};
