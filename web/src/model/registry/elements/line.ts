import { endpoints, line } from '../../../render/draw';
import type { ElementDef } from '../../types';

export const LINE_DEF: ElementDef = {
  kind: 'line',
  label: 'Line',
  category: 'Other',
  dumpCode: '423',
  postCount: 0,
  draggablePosts: 2,  // the endpoints are drawing geometry, not terminals
  posts: () => [],
  defaultLength: 4,  // 64 px, the base getDragLength()
  draw(g, e) {
    const [p1, p2] = endpoints(e);
    // Upstream strokes the whole span in gray at the ambient width 1
    // (LineElm.java:50-55), a drawing annotation, not a schematic body, so it
    // stays thin while real components draw thick. `line` applies selection
    // and hover highlighting.
    line(g, p1, p2, g.theme.text, 1);
  },
};
