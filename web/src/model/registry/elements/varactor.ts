import { calcLeads, interp2Precise, line } from '../../../render/draw';
import { elementColor, readParams, twoPosts } from '../shared';
import { drawDiodeBody } from './diode';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/**
 * The diode body plus a second capacitor plate: a thick bar just short of
 * the cathode bar, coloured by the anode's voltage. Upstream draws its own
 * cathode bar a second time at the same spot as `plate2`
 * (VaractorElm.java:57-68/78-90); that duplicate is skipped here since it
 * paints nothing a plain diode body has not already drawn. The plate is an
 * anode-side sub-shape, so it samples post 0's colour through `elementColor`
 * like the diode body it rides on, keeping the whole symbol on the flat
 * power colour under Show Power.
 */
function drawVaractorBody(g: DrawContext, e: CircuitElement): void {
  drawDiodeBody(g, e, false);
  const [lead1, lead2] = calcLeads(e, 16);
  // Body geometry, drawn without grid rounding so the plate stays square to
  // the body on a diagonal (VaractorElm.java:57-68).
  const [p1, p2] = interp2Precise(lead1, lead2, 0.6, 7);
  // The extra plate is a drawThickLine stroke upstream (VaractorElm.java:87),
  // the 3-unit body weight.
  line(g, p1, p2, elementColor(g, g.voltages[0], g.power));
}

export const VARACTOR_DEF: ElementDef = {
  kind: 'varactor',
  label: 'Varactor',
  category: 'Semiconductors',
  // getDumpType() returns the int 176, not a char (VaractorElm.java:19).
  dumpCode: '176',
  postCount: 2,
  posts: twoPosts,
  // VaractorElm extends DiodeElm and simulates the same "default" model
  // (forwardVoltage 0.805904783, series resistance 0, n = 2), plus its own
  // capacitance at 0 V (VaractorElm.java:9-12).
  defaults: {
    forwardVoltage: 0.805904783,
    seriesResistance: 0,
    emissionCoefficient: 2,
    baseCapacitance: 4e-12,
  },
  // VaractorElm's own constructor calls DiodeElm's token constructor first
  // (so the leading tokens are the diode's: an escaped model name under
  // FLAG_MODEL, else a forward drop under FLAG_FWDROP), then
  // unconditionally reads two more tokens of its own: capvoltdiff (the
  // persisted junction voltage) and baseCapacitance
  // (VaractorElm.java:13-18).
  parse: (t, e) => {
    if ((e.flags & 2) !== 0) {
      e.modelName = t[0];
      readParams(t.slice(1), e, ['capVoltDiff', 'baseCapacitance']);
      return;
    }
    const names =
      (e.flags & 1) !== 0
        ? ['forwardVoltage', 'capVoltDiff', 'baseCapacitance']
        : ['capVoltDiff', 'baseCapacitance'];
    readParams(t, e, names);
  },
  // Upstream's own dump() is inherited straight from DiodeElm and never
  // appends capvoltdiff or baseCapacitance at all, even though its own
  // token constructor above always expects them: a save-then-reload loses
  // both in the original app. The bundled corpus (varactor.txt,
  // varactorvco.txt) shows the tokens really are there in practice
  // (`176 x1 y1 x2 y2 1 0.805904783 <capvoltdiff> 4e-12`), so this port
  // writes them too, the same fix already applied to the thermistor and
  // LDR rows for their own real dump() quirks (see OVERVIEW.md section 6).
  dump: (e) => {
    const tail = [e.params.capVoltDiff ?? 0, e.params.baseCapacitance ?? 4e-12];
    return e.modelName != null
      ? [e.modelName, ...tail]
      : [e.params.forwardVoltage ?? 0.805904783, ...tail];
  },
  // The value form must carry exactly FLAG_FWDROP: with bit 2 (FLAG_MODEL)
  // left over from a loaded name, a reload would read the fwdrop token as a
  // bogus model name and misparse everything after it.
  dumpFlags: (e) => (e.modelName != null ? e.flags | 2 : (e.flags & ~2) | 1),
  fields: [
    // The model choice is upstream's edit item 0 (DiodeElm.java:197-210).
    { name: 'modelName', label: 'Model', type: 'modelChoice', target: 'modelName', modelFamily: 'diode' },
    { name: 'baseCapacitance', label: 'Capacitance @ 0V', unit: 'F' },
    { name: 'forwardVoltage', label: 'Forward drop', unit: 'V' },
    { name: 'seriesResistance', label: 'Series resistance', unit: 'Ω' },
    { name: 'emissionCoefficient', label: 'Emission coefficient' },
  ],
  draw: drawVaractorBody,
};
