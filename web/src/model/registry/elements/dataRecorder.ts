import {
  canvasFont,
  elementLength,
  endpoints,
  interp,
  isHighlighted,
  lead,
  limbColor,
  voltageColor,
} from '../../../render/draw';
import { labeledNodeText, onePost, readParams, writeParams, endpointBox } from '../shared';
import type { ElementDef } from '../../types';

export const DATA_RECORDER_DEF: ElementDef = {
  kind: 'dataRecorder',
  label: 'Data recorder',
  category: 'Other',
  dumpCode: '210',
  postCount: 1,
  posts: onePost,
  draggablePosts: 2,  // the free end is a control point, not a terminal
  defaults: { dataCount: 10240 },  // DataRecorderElm.java:19
  parse: (t, e) => readParams(t, e, ['dataCount']),
  dump: writeParams(['dataCount']),
  fields: [
    { name: 'dataCount', label: '# of Data Points', min: 1, integer: true },
    // A button, not a value: the panel renders the download and the samples
    // come from the engine on demand (DataRecorderElm.java:99-125).
    { name: 'download', label: 'Download data', type: 'download' },
  ],
  // The "export" label at the free end is a solid pick zone (DataRecorderElm.java).
  bodyRect: (e) => endpointBox(e, 12),
  draw(g, e) {
    const [p1, p2] = endpoints(e);
    const dn = elementLength(e);
    // The stem stops 8 units short of the free end, so the lead never runs
    // under the label (DataRecorderElm.java:43). A collapsed element has no
    // direction to stop along, so the stem degrades to the post.
    const lead1 = dn === 0 ? p1 : interp(p1, p2, 1 - 8 / dn);
    const selected = isHighlighted(g);
    // Upstream draws the label with a 14 px SansSerif, bold while selected
    // (DataRecorderElm.java:47-53).
    g.ctx.font = selected ? `bold ${canvasFont(14)}` : canvasFont(14);
    labeledNodeText(
      g,
      'export',
      p1,
      lead1,
      selected ? g.theme.selection : g.theme.whiteColor,
    );
    lead(g, p1, lead1, limbColor(g, voltageColor(g, g.voltages[0])));
  },
};
