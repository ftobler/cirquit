/**
 * Quartz crystal (CrystalElm.java, dump 412): the motional LCR branch in
 * parallel with the holder capacitance. The frontend draws the plate and
 * sandwich symbol and labels the series-resonance frequency under
 * FLAG_SHOW_FREQ (bit 2, CrystalElm.java:27).
 *
 * Token layout after the common fields is one `_`-joined dump token per
 * composite child, the four motional-branch parts in model order: the
 * parallel capacitor, the series capacitor, the inductor and the resistor.
 * The engine applies the four motional values from its params, so this def
 * always writes the child dumps derived from the current params: a set value
 * survives a save exactly like upstream, whose children hold the values. The
 * child dumps' saved charge/current state tokens are dropped, the same
 * live-state gap the capacitor's `voltDiff` has.
 */

import {
  endpoints,
  formatValueShort,
  interp,
  interp2,
  label,
  lead,
  line,
  voltageColor,
} from '../../../render/draw';
import { CRYSTAL_SHOW_FREQ } from '../flags';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

const DEF_PARALLEL_CAP = 28.7e-12;
const DEF_SERIES_CAP = 0.1e-12;
const DEF_INDUCTANCE = 2.5e-3;
const DEF_RESISTANCE = 6.4;

function drawCrystal(g: DrawContext, e: CircuitElement): void {
  const [p1, p2] = endpoints(e);
  const dn = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const f = (dn / 2 - 10) / dn;
  const lead1 = interp(p1, p2, f);
  const lead2 = interp(p1, p2, 1 - f);

  // The two lead-and-plate pairs, voltage-coloured (CrystalElm.java:118-129).
  lead(g, p1, lead1, voltageColor(g, g.voltages[0]));
  lead(g, p2, lead2, voltageColor(g, g.voltages[1]));
  const [pl1a, pl1b] = interp2(p1, p2, f, 8);
  const [pl2a, pl2b] = interp2(p1, p2, 1 - f, 8);
  line(g, pl1a, pl1b, g.theme.wire);
  line(g, pl2a, pl2b, g.theme.wire);

  // The central sandwich quad at the average plate voltage
  // (CrystalElm.java:131-134).
  const f2 = (dn / 2 - 5) / dn;
  const s0 = interp(p1, p2, f2, 10);
  const s1 = interp(p1, p2, f2, -10);
  const s3 = interp(p1, p2, 1 - f2, 10);
  const s2 = interp(p1, p2, 1 - f2, -10);
  const sandwich = [s0, s1, s2, s3, s0];
  const mid = voltageColor(g, (g.voltages[0] + g.voltages[1]) / 2);
  for (let i = 0; i < 4; i++) line(g, sandwich[i], sandwich[i + 1], mid);

  // The series-resonance frequency caption, 1/(2π√(L·Cs)) (CrystalElm.java:
  // 142-146), under FLAG_SHOW_FREQ.
  if ((e.flags & CRYSTAL_SHOW_FREQ) !== 0) {
    const l = e.params.inductance ?? DEF_INDUCTANCE;
    const cs = e.params.seriesCapacitance ?? DEF_SERIES_CAP;
    if (l > 0 && cs > 0) {
      const fs = 1 / (2 * Math.PI * Math.sqrt(l * cs));
      label(g, e, formatValueShort(fs, 'Hz'), 12);
    }
  }
}

/** One derived child-dump token, the `_`-joined form a saved 412 line
 *  carries. The capacitor children get FLAG_RESISTANCE and the four-token
 *  capacitor dump, the inductor and resistor their plain dumps, all exactly
 *  as the upstream children would dump themselves. */
function crystalTokens(e: CircuitElement): string[] {
  const cap = (c: number) => `4_${c}_0_0.001_0`;
  return [
    cap(e.params.parallelCapacitance ?? DEF_PARALLEL_CAP),
    cap(e.params.seriesCapacitance ?? DEF_SERIES_CAP),
    `0_${e.params.inductance ?? DEF_INDUCTANCE}_0_0_0`,
    `0_${e.params.resistance ?? DEF_RESISTANCE}`,
  ];
}

export const CRYSTAL_DEF: ElementDef = {
  kind: 'crystal',
  label: 'Crystal',
  category: 'Basics',
  dumpCode: '412',
  postCount: 2,
  posts: (e) => endpoints(e),
  defaultFlags: CRYSTAL_SHOW_FREQ,  // CrystalElm.java:36
  defaults: {
    parallelCapacitance: DEF_PARALLEL_CAP,
    seriesCapacitance: DEF_SERIES_CAP,
    inductance: DEF_INDUCTANCE,
    resistance: DEF_RESISTANCE,
  },
  // The motional values ride inside the child dump tokens; each token's
  // second `_`-field is the value (flags first).
  parse: (t, e) => {
    const field = (i: number, d: number) => {
      const v = Number((t[i] ?? '').split('_')[1]);
      return Number.isFinite(v) ? v : d;
    };
    e.params.parallelCapacitance = field(0, DEF_PARALLEL_CAP);
    e.params.seriesCapacitance = field(1, DEF_SERIES_CAP);
    e.params.inductance = field(2, DEF_INDUCTANCE);
    e.params.resistance = field(3, DEF_RESISTANCE);
  },
  dump: crystalTokens,
  fields: [
    { name: 'parallelCapacitance', label: 'Parallel Capacitance', unit: 'F' },
    { name: 'seriesCapacitance', label: 'Series Capacitance', unit: 'F' },
    { name: 'inductance', label: 'Inductance', unit: 'H' },
    { name: 'resistance', label: 'Resistance', unit: 'Ω' },
    { name: 'showFreq', label: 'Show Frequency', type: 'bool', flag: CRYSTAL_SHOW_FREQ },
  ],
  draw: drawCrystal,
};
