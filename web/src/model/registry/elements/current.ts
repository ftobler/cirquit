import { arrowHead, formatValue, interp, label, line } from '../../../render/draw';
import { drawSourceCircle, readParams, twoPosts, writeParams } from '../shared';
import type { ElementDef } from '../../types';

export const CURRENT_DEF: ElementDef = {
  kind: 'current',
  label: 'Current source',
  category: 'Sources',
  dumpCode: 'i',
  postCount: 2,
  posts: twoPosts,
  defaults: { current: 0.01 },
  parse: (t, e) => {
    readParams(t, e, ['current', 'maxVoltage']);
    // Upstream forces a zero file value to 0.01 at load (CurrentElm.java:43-44);
    // the live edit path keeps 0, so this belongs in the parse, not the model.
    if (e.params.current === 0) e.params.current = 0.01;
  },
  dump: writeParams(['current', 'maxVoltage']),
  fields: [
    { name: 'current', label: 'Current', unit: 'A' },
    { name: 'maxVoltage', label: 'Max voltage (0=unlimited)', unit: 'V' },
  ],
  draw(g, e) {
    const [lead1, lead2] = drawSourceCircle(g, e, 12);
    const a = interp(lead1, lead2, 0.5 - 0.28);
    const b = interp(lead1, lead2, 0.5 + 0.28);
    line(g, a, b, g.theme.text, 1.5);
    arrowHead(g, a, b, 7, g.theme.text);
    label(g, e, formatValue(e.params.current ?? 0, 'A'), 20);
  },
};
