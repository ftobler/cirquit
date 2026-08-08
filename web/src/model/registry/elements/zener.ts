import { readParams, twoPosts } from '../shared';
import { drawDiodeBody } from './diode';
import type { ElementDef } from '../../types';

export const ZENER_DEF: ElementDef = {
  kind: 'zener',
  label: 'Zener diode',
  category: 'Semiconductors',
  dumpCode: 'z',
  postCount: 2,
  posts: twoPosts,
  // The defaults are upstream's "default-zener" model (DiodeModel.java:84),
  // so a preserved `default-zener` name happens to simulate exactly.
  defaults: {
    forwardVoltage: 0.805904783,
    breakdownVoltage: 5.6,
    seriesResistance: 0,
    emissionCoefficient: 2,
  },
  // ZenerElm inherits DiodeElm's dump, then appends its own token, so the
  // trailing fields depend on the flags (ZenerElm.java:32-42): FLAG_MODEL
  // (bit 2) is an escaped model name on its own; otherwise FLAG_FWDROP
  // (bit 1) contributes a forward drop and the zener voltage always follows.
  parse: (t, e) => {
    if ((e.flags & 2) !== 0) {
      e.modelName = t[0];
      return;
    }
    // The zener voltage is last either way, so the field list is just the
    // fwdrop token prepended when its flag is set. Going through readParams
    // keeps the "skip non-finite tokens" guard, so a truncated line falls
    // back to the default-zener values instead of stamping NaN.
    const names =
      (e.flags & 1) !== 0 ? ['forwardVoltage', 'breakdownVoltage'] : ['breakdownVoltage'];
    readParams(t, e, names);
  },
  // The value form always writes both tokens: a bare zvoltage line would
  // lose the forward drop, and upstream throws on a `z` line that carries a
  // fwdrop with no zvoltage after it, dropping the element on load.
  dump: (e) =>
    e.modelName != null
      ? [e.modelName]
      : [e.params.forwardVoltage ?? 0.805904783, e.params.breakdownVoltage ?? 5.6],
  // The value form must carry exactly FLAG_FWDROP: with bit 2 (FLAG_MODEL)
  // left over from a loaded name, a reload would read the fwdrop token as a
  // bogus model name and silently lose the zener voltage.
  dumpFlags: (e) => (e.modelName != null ? e.flags | 2 : (e.flags & ~2) | 1),
  // ZenerElm inherits DiodeElm's editing surface upstream (ZenerElm extends
  // DiodeElm), so the zener exposes the diode's three model fields plus its
  // own breakdown voltage. The FieldDefs are copied from the diode so both
  // elements read and write identically.
  fields: [
    { name: 'forwardVoltage', label: 'Forward drop', unit: 'V' },
    { name: 'seriesResistance', label: 'Series resistance', unit: 'Ω' },
    { name: 'emissionCoefficient', label: 'Emission coefficient' },
    { name: 'breakdownVoltage', label: 'Zener voltage', unit: 'V' },
  ],
  draw: (g, e) => drawDiodeBody(g, e, true),
};
