import {
  bodyRect,
  calcLeads,
  currentDotsPath,
  drawLeads,
  endpoints,
  formatValue,
  label,
  voltageColor,
} from '../../../render/draw';
import { readParams, twoPosts, writeParams } from '../shared';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

function drawResistorBody(g: DrawContext, e: CircuitElement): void {
  const [lead1, lead2] = calcLeads(e, 32);
  drawLeads(g, e, lead1, lead2);
  const color = voltageColor(g, (g.voltages[0] + g.voltages[1]) / 2);
  bodyRect(g, lead1, lead2, 6, color);  // IEC rectangle, 32 x 12 as upstream
  const [p1, p2] = endpoints(e);
  currentDotsPath(g, [p1, lead1, lead2, p2], g.current);
  label(g, e, formatValue(e.params.resistance ?? 0, 'Ω'));
}

export const RESISTOR_DEF: ElementDef = {
  kind: 'resistor',
  label: 'Resistor',
  category: 'Basics',
  dumpCode: 'r',
  postCount: 2,
  posts: twoPosts,
  defaults: { resistance: 1000 },
  parse: (t, e) => readParams(t, e, ['resistance']),
  dump: writeParams(['resistance']),
  fields: [{ name: 'resistance', label: 'Resistance', unit: 'Ω' }],
  draw: drawResistorBody,
};
