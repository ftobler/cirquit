import { canvasFont, elementLength, interp, lead, limbColor, voltageColor } from '../../../render/draw';
import { onePost, readParams, writeParams } from '../shared';
import type { ElementDef } from '../../types';

export const AUDIO_OUTPUT_DEF: ElementDef = {
  kind: 'audioOutput',
  label: 'Audio output',
  category: 'Other',
  // getDumpType() returns the int 211 (AudioOutputElm.java:87).
  dumpCode: '211',
  postCount: 1,
  posts: onePost,
  draggablePosts: 2,  // the free end is a control point, not a terminal
  // AudioOutputElm.java:31-34: one second of audio at the last-used sample
  // rate. The `labelNum` is normally a per-session counter; 0 is the default
  // here because the port has no cross-element scan. The static site has no
  // audio device, so these three numbers only round-trip.
  defaults: { duration: 1, samplingRate: 8000, labelNum: 0 },
  // dump() and the token constructor both go duration, samplingRate, labelNum
  // (AudioOutputElm.java:41-49).
  parse: (t, e) => readParams(t, e, ['duration', 'samplingRate', 'labelNum']),
  dump: writeParams(['duration', 'samplingRate', 'labelNum']),
  fields: [
    { name: 'duration', label: 'Duration', unit: 's', min: 0 },
    { name: 'samplingRate', label: 'Sampling Rate', unit: 'Hz' },
  ],
  draw(g, e) {
    const p1 = { x: e.x1, y: e.y1 };
    const p2 = { x: e.x2, y: e.y2 };
    // Upstream labels the first output "Audio Out" and numbers the rest
    // (AudioOutputElm.java:106-109).
    const labelNum = e.params.labelNum ?? 0;
    const s = labelNum > 1 ? `Audio ${labelNum}` : 'Audio Out';
    g.ctx.font = canvasFont(12);
    const textWidth = g.ctx.measureText(s).width;
    // The thick lead runs from the post to 8 units short of the text box edge
    // (AudioOutputElm.java:115-121), like the logic output's short lead.
    const dn = Math.max(1, elementLength(e));
    const lead1 = interp(p1, p2, 1 - (textWidth / 2 + 8) / dn);
    lead(g, p1, lead1, voltageColor(g, g.voltages[0]));
    g.ctx.fillStyle = limbColor(g, g.theme.text);
    g.ctx.textAlign = 'center';
    g.ctx.textBaseline = 'middle';
    g.ctx.fillText(s, p2.x, p2.y);
  },
};
