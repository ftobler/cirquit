import {
  calcLeads,
  circle,
  currentDotsFrom,
  dotPhaseAfter,
  drawLeads,
  elementLength,
  endpoints,
  gradientPolyline,
  interp,
  isHighlighted,
  lead,
  powerColor,
  tempColor,
  voltageColor,
} from '../../../render/draw';
import { readParams, twoPosts, writeParams } from '../shared';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** Lead gap, filament diagonal offset and bulb radius for the non-IEC lamp
 *  symbol (LampElm.java's `setPoints`: `llen` at :88, `filament_len` at :85,
 *  `bulbR` at :92). Upstream's `bulbLead` (:93-95) is not ported: it computes
 *  `filament_len - sqrt(bulbR² - llen²)` in setPoints and no draw call reads
 *  it, so it is dead upstream and its absence here is faithful. */
const LAMP_LEAD_GAP = 16;
const LAMP_FILAMENT_OFFSET = 24;
const LAMP_BULB_RADIUS = 20;

/**
 * Two lead-to-filament diagonals crossing inside a circular bulb outline
 * (LampElm.java:123-155). The bulb fill is the filament temperature in
 * `g.state` mapped through `tempColor`, upstream's getTempColor keyed off the
 * same `temp` state `startIteration` evolves: black when cold, through orange
 * and yellow to white when hot (LampElm.java:101-121, :132-133).
 */
function drawLampBody(g: DrawContext, e: CircuitElement): void {
  const [lead1, lead2] = calcLeads(e, LAMP_LEAD_GAP);
  drawLeads(g, e, lead1, lead2);
  const filament0 = interp(lead1, lead2, 0, LAMP_FILAMENT_OFFSET);
  const filament1 = interp(lead1, lead2, 1, LAMP_FILAMENT_OFFSET);
  const bulb = interp(filament0, filament1, 0.5);
  // The bulb fill is a single colour, not a gradient: it is a filled disc,
  // which the per-segment stroke mechanism cannot shade, and the envelope is
  // not the conducting path anyway. The filament is the conductor, so it
  // shades along the drop from lead1's post to lead2's. Under Show Power the
  // disc takes the power colour like every other dissipating body, the
  // intended reading of upstream's setPowerColor(g, true) before the fill
  // (LampElm.java:131); upstream's next line overwrites it with getTempColor,
  // which makes that call dead there, but the port keeps the participation.
  const fill = g.showPowerColor ? powerColor(g, g.power) : tempColor(g.state);
  // The disc fill is the idle body; a picked lamp would otherwise read as a
  // solid block of the selection or hover colour, so the highlight keeps the
  // white outline below and drops the fill.
  if (!isHighlighted(g)) circle(g, bulb, LAMP_BULB_RADIUS, fill, true);
  // The bulb outline and filament are drawThickCircle/drawThickLine upstream
  // (LampElm.java:135-141), the 3-unit body weight. The outline is upstream's
  // whiteColor (LampElm.java:134): white in the normal theme, black in the
  // printable one (UIManager.java:578-583), which is how a print stays legible
  // on the white page.
  circle(g, bulb, LAMP_BULB_RADIUS, g.theme.whiteColor, false);
  lead(g, lead1, filament0, voltageColor(g, g.voltages[0]));
  lead(g, lead2, filament1, voltageColor(g, g.voltages[1]));
  gradientPolyline(g, [filament0, filament1]);
  const [p1, p2] = endpoints(e);
  // The five dot runs mirror LampElm.java:143-152, which chain the phase
  // through the body and then restart the last lead at the base curcount. The
  // restart is deliberate: a continuous chain across all six points would
  // carry the whole body offset into lead2's run. That offset is
  // (3/2)(dn-16), which wraps to zero modulo the 16-unit dot spacing only
  // when the lead length (dn-16)/2 is a multiple of 16, so nearly every lamp
  // drifts its last-run dots off the pattern on lead1.
  currentDotsFrom(g, p1, lead1, g.current, g.dotPhase);
  let cc = dotPhaseAfter(g.dotPhase, (elementLength(e) - LAMP_LEAD_GAP) / 2);
  currentDotsFrom(g, lead1, filament0, g.current, cc);
  cc = dotPhaseAfter(cc, LAMP_FILAMENT_OFFSET);
  currentDotsFrom(g, filament0, filament1, g.current, cc);
  cc = dotPhaseAfter(cc, LAMP_LEAD_GAP);
  currentDotsFrom(g, filament1, lead2, g.current, cc);
  currentDotsFrom(g, lead2, p2, g.current, g.dotPhase);
}

export const LAMP_DEF: ElementDef = {
  kind: 'lamp',
  label: 'Lamp',
  category: 'Basics',
  // getDumpType() returns the int 181, not a char (LampElm.java:74).
  dumpCode: '181',
  postCount: 2,
  posts: twoPosts,
  // LampElm.java's no-args constructor: room temperature, a 100 W bulb
  // rated at 120 V, with 0.4 s warm-up and cool-down time constants
  // (LampElm.java:31-39).
  defaults: { temp: 300, nomPower: 100, nomVoltage: 120, warmTime: 0.4, coolTime: 0.4 },
  // dump()/the token constructor both go temp, nom_pow, nom_v, warmTime,
  // coolTime, in that order (LampElm.java:43-54).
  parse: (t, e) =>
    readParams(t, e, ['temp', 'nomPower', 'nomVoltage', 'warmTime', 'coolTime']),
  dump: writeParams(['temp', 'nomPower', 'nomVoltage', 'warmTime', 'coolTime']),
  // getEditInfo's four fields, in order (LampElm.java:195-206); `temp` is
  // simulation state like the fuse's `heat`, not something to edit.
  fields: [
    { name: 'nomPower', label: 'Nominal Power', unit: 'W', min: 0 },
    { name: 'nomVoltage', label: 'Nominal Voltage', unit: 'V', min: 0 },
    { name: 'warmTime', label: 'Warmup Time', unit: 's', min: 0 },
    { name: 'coolTime', label: 'Cooldown Time', unit: 's', min: 0 },
  ],
  draw: drawLampBody,
};
