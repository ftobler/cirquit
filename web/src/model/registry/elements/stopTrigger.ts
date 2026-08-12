import {
  canvasFont,
  elementLength,
  endpoints,
  interp,
  isHighlighted,
  lead,
  voltageColor,
} from '../../../render/draw';
import { labeledNodeText, onePost, readParams, writeParams } from '../shared';
import type { ElementDef } from '../../types';

export const STOP_TRIGGER_DEF: ElementDef = {
  kind: 'stopTrigger',
  label: 'Stop trigger',
  category: 'Other',
  dumpCode: '408',
  postCount: 1,
  posts: onePost,
  draggablePosts: 2,  // the free end is a control point, not a terminal
  defaults: { triggerVoltage: 1, type: 0, delay: 0, count: 1 },  // StopTriggerElm.java:36-37
  parse: (t, e) => readParams(t, e, ['triggerVoltage', 'type', 'delay', 'count']),
  dump: writeParams(['triggerVoltage', 'type', 'delay', 'count']),
  fields: [
    { name: 'triggerVoltage', label: 'Voltage', unit: 'V' },
    {
      name: 'type',
      label: 'Trigger Type',
      type: 'choice',
      choices: [
        { value: 0, label: '>=' },
        { value: 1, label: '<=' },
      ],
    },
    { name: 'delay', label: 'Delay (s)', unit: 's' },
    { name: 'count', label: 'Required Count' },
  ],
  draw(g, e) {
    const [p1, p2] = endpoints(e);
    const dn = elementLength(e);
    // The stem stops 8 units short of the free end, so the lead never runs
    // under the label (StopTriggerElm.java:72). A collapsed element has no
    // direction to stop along, so the stem degrades to the post.
    const lead1 = dn === 0 ? p1 : interp(p1, p2, 1 - 8 / dn);
    // The part draws highlighted while stopped, even without a selection
    // (StopTriggerElm.java:77-78): the engine latches `stopped` and reports it
    // through `display_state`, which reaches the draw as `g.state`.
    const stopped = g.state >= 1;
    const selected = isHighlighted(g) || stopped;
    // Upstream draws the label with a 14 px SansSerif, bold while selected
    // (StopTriggerElm.java:77-80).
    g.ctx.font = selected ? `bold ${canvasFont(14)}` : canvasFont(14);
    labeledNodeText(
      g,
      'trigger',
      p1,
      lead1,
      selected ? g.theme.selection : g.theme.whiteColor,
    );
    // The stem is voltage-coloured, overridden by the stopped/selection colour
    // (StopTriggerElm.java:84-87).
    const stemColor = stopped ? g.theme.selection : voltageColor(g, g.voltages[0]);
    lead(g, p1, lead1, stemColor);
  },
};
