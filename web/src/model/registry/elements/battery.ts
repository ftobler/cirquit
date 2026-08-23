/**
 * The battery (BatteryElm.java, port dump 438): a state-of-charge voltage
 * source with a configurable SOC-to-voltage table, ohmic and polarization
 * resistance and a polarization capacitor. The source value comes from the
 * table interpolated by SOC percent; below 0% it extrapolates linearly at
 * three times the 0..10% slope, and the SOC is tracked by coulomb counting
 * the terminal current.
 *
 * Upstream saves this class only in the XML format (its text dump type is 0),
 * so the port assigns dump code 438, free upstream and beside the other
 * port-assigned XML-era codes (the bus logic input's 435, the bus
 * transceiver's 437). The raw `\n`-joined table rides `e.model`, the string
 * carrier the custom-logic blob uses, and the file carries it as one escaped
 * token after the scalar fields.
 */

import { calcLeads, currentDots, drawLeads, endpoints, formatValueShort, interp2, label, line, voltageColor } from '../../../render/draw';
import { boxOfPoints, twoPosts } from '../shared';
import { BATTERY_SHOW_SOC, BATTERY_SHOW_VOLTAGE } from '../flags';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** The five preset chemistries (BatteryElm.java:39-44). BT_CUSTOM (-1) is a
 *  hand-edited table, deliberately not an index so presets can be appended
 *  without renumbering it. */
export const BT_CUSTOM = -1;
export const BATTERY_TYPE_NAMES = ['Alkaline 1.5V', 'Lithium-Ion', 'NiMH 1.2V', 'NiCd 1.2V', 'Lead-Acid'];
export const batteryTypeTables = [
  '0=0.8\n10=0.95\n20=1.05\n40=1.18\n60=1.28\n80=1.38\n90=1.43\n100=1.55\n',           // alkaline
  '0=3.00\n5=3.30\n10=3.45\n20=3.55\n30=3.62\n40=3.68\n50=3.73\n60=3.79\n70=3.87\n80=3.97\n90=4.08\n95=4.15\n100=4.20\n', // lithium-ion
  '0=1.00\n10=1.15\n20=1.20\n50=1.25\n80=1.30\n90=1.33\n100=1.40\n',                   // NiMH
  '0=1.00\n10=1.15\n20=1.20\n50=1.22\n80=1.25\n90=1.28\n100=1.35\n',                   // NiCd
  '0=1.75\n10=1.90\n20=1.95\n50=2.05\n80=2.10\n90=2.12\n100=2.15\n',                   // lead-acid
];
/** Default capacity (Ah), R0, R1, C1 per preset, applied when the user
 *  switches to that type in the edit dialog (BatteryElm.java:56-62). */
export const batteryTypeDefaults: [number, number, number, number][] = [
  [2.5, 0.15, 0.25, 1500],   // alkaline (AA)
  [3.0, 0.025, 0.02, 2000],  // lithium-ion (18650)
  [2.0, 0.03, 0.04, 1800],   // NiMH (AA)
  [1.0, 0.02, 0.025, 1200],  // NiCd (AA)
  [10, 0.008, 0.012, 5000],  // lead-acid (2V)
];

/** The table an element draws and saves with: its custom table when it has
 *  one, else the preset table its batteryType names, falling back to the
 *  lithium default. Mirrors upstream, which only carries a table text for a
 *  custom battery and always keeps the preset's in memory (BatteryElm.java:
 *  127-138). */
export function batteryTableOf(e: CircuitElement): string {
  if (typeof e.model === 'string') return e.model;
  const t = e.params.batteryType ?? 1;
  return batteryTypeTables[t >= 0 && t < batteryTypeTables.length ? t : 1];
}

/** The clamped battery type index: presets 0..4, custom -1 kept verbatim. */
export function batteryTypeOf(e: CircuitElement): number {
  const t = Number(e.params.batteryType ?? 1);
  if (t === BT_CUSTOM) return BT_CUSTOM;
  if (Number.isFinite(t) && t >= 0 && t < batteryTypeTables.length) return Math.trunc(t);
  return 1;
}

/** Splits the table into `(pct, volt)` pairs, skipping blank and malformed
 *  lines, then sorts them ascending by SOC percent, stable so equal percents
 *  keep their parse order like upstream's insertion sort (BatteryElm.java:
 *  186-189). The engine sorts its own copy at construction too, so the caption
 *  here must interpolate the same segment it stamps. */
export function parseSocTable(text: string): { pct: number; volt: number }[] {
  const pairs: { pct: number; volt: number }[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const pct = Number(line.slice(0, eq).trim());
    const volt = Number(line.slice(eq + 1).trim());
    if (Number.isFinite(pct) && Number.isFinite(volt)) pairs.push({ pct, volt });
  }
  pairs.sort((a, b) => a.pct - b.pct);
  return pairs;
}

/** The saved form of a table: every valid `pct=volt` line re-slotted ascending
 *  by SOC percent while each line keeps its original text and every blank or
 *  malformed line stays pinned in place. An already-ordered table therefore
 *  comes back byte-for-byte, and only a genuinely out-of-order one normalizes
 *  on save, matching what the engine reads after its construction sort. */
export function normalizeSocTable(text: string): string {
  const lines = text.split('\n');
  const slots: number[] = [];
  const keyed: { line: string; pct: number }[] = [];
  lines.forEach((line, i) => {
    const eq = line.indexOf('=');
    const pct = eq < 0 ? NaN : Number(line.slice(0, eq).trim());
    const volt = eq < 0 ? NaN : Number(line.slice(eq + 1).trim());
    if (Number.isFinite(pct) && Number.isFinite(volt)) {
      slots.push(i);
      keyed.push({ line, pct });
    }
  });
  keyed.sort((a, b) => a.pct - b.pct);
  keyed.forEach((entry, k) => {
    lines[slots[k]] = entry.line;
  });
  return lines.join('\n');
}

/** Piecewise-linear interpolation of the table by percent, with the empty
 *  and single-entry cases and the out-of-range clamps, the port of upstream's
 *  `interpSocTable` (BatteryElm.java:204-225). */
export function interpSocTable(table: string, socPct: number): number {
  const pairs = parseSocTable(table);
  if (pairs.length === 0) return 3.7;
  if (pairs.length === 1) return pairs[0].volt;
  if (socPct <= pairs[0].pct) return pairs[0].volt;
  const last = pairs[pairs.length - 1];
  if (socPct >= last.pct) return last.volt;
  for (let i = 0; i < pairs.length - 1; i++) {
    const a = pairs[i];
    const b = pairs[i + 1];
    if (socPct >= a.pct && socPct <= b.pct) {
      if (b.pct === a.pct) return a.volt;
      const frac = (socPct - a.pct) / (b.pct - a.pct);
      return a.volt + frac * (b.volt - a.volt);
    }
  }
  return last.volt;
}

/** The source value for a SOC fraction, upstream's `getVoltageForSoc`
 *  (BatteryElm.java:192-202): below 0% it extrapolates linearly at three
 *  times the 0..10% slope. */
export function getVoltageForSoc(table: string, soc: number): number {
  const socPct = soc * 100;
  if (socPct < 0) {
    const v0 = interpSocTable(table, 0);
    const v10 = interpSocTable(table, 10);
    const slope = (v10 - v0) / 10;
    return v0 + slope * 3 * socPct;
  }
  return interpSocTable(table, socPct);
}

/** SOC always draws as a whole percentage; metric prefixes or decimal places
 *  make no sense for a percentage (BatteryElm.java:324). */
function socText(soc: number): string {
  return `${Math.round(soc * 100)}%`;
}

function drawBattery(g: DrawContext, e: CircuitElement): void {
  // The two-plate battery symbol, drawn exactly like the DC voltage source's
  // battery plates (voltage.ts:111-132, VoltageElm.java:281-291): a short
  // plate at lead1 and a long one at lead2, each in its post's voltage colour,
  // with the current dots running the whole path through the plate gap.
  const [p1, p2] = endpoints(e);
  const [lead1, lead2] = calcLeads(e, 8);
  drawLeads(g, e, lead1, lead2);
  const [s1, s2] = interp2(lead1, lead2, 0, 10);
  line(g, s1, s2, voltageColor(g, g.voltages[0]));
  const [l1, l2] = interp2(lead1, lead2, 1, 16);
  line(g, l1, l2, voltageColor(g, g.voltages[1]));
  currentDots(g, p1, p2, g.current);

  // The caption combines the live terminal voltage and the whole-percent SOC
  // per the two flags (BatteryElm.java:298-310). `g.state` is the engine's
  // live SOC fraction (the battery's display_state).
  const soc = g.state;
  const showV = (e.flags & BATTERY_SHOW_VOLTAGE) !== 0;
  const showSoc = (e.flags & BATTERY_SHOW_SOC) !== 0;
  let s: string | null = null;
  if (showV && showSoc) {
    s = `${formatValueShort(getVoltageForSoc(batteryTableOf(e), soc), 'V', g.valueDigits)} ${socText(soc)}`;
  } else if (showV) {
    s = formatValueShort(getVoltageForSoc(batteryTableOf(e), soc), 'V', g.valueDigits);
  } else if (showSoc) {
    s = socText(soc);
  }
  // hs = 16, the long plate's reach (BatteryElm.java:309).
  if (s !== null) label(g, e, s, 16);
}

export const BATTERY_DEF: ElementDef = {
  kind: 'battery',
  label: 'Battery',
  category: 'Sources',
  dumpCode: '438',
  // Port-assigned: upstream gives the battery no placement char in the text
  // era, and 'B' collides with nothing in the placement map.
  shortcut: 'B',
  postCount: 2,
  posts: twoPosts,
  vertical: true,  // BatteryElm.java:93
  defaultLength: 4,
  defaultFlags: BATTERY_SHOW_VOLTAGE | BATTERY_SHOW_SOC,
  // A fresh battery is a lithium-ion with the constructor's values
  // (BatteryElm.java:77-88).
  defaultModel: batteryTypeTables[1],
  defaults: {
    r0: 0.01,
    r1: 0.02,
    c1: 2000,
    capacityAh: 2,
    initialSoc: 1,
    batteryType: 1,
  },
  parse: (t, e) => {
    // The port's own stream: r0, r1, c1, capacityAh, initialSocPercent,
    // batteryType, then the table as one escaped token.
    const num = (i: number): number | undefined => {
      const v = Number(t[i]);
      return t[i] !== undefined && Number.isFinite(v) ? v : undefined;
    };
    const r0 = num(0);
    if (r0 !== undefined) e.params.r0 = r0;
    const r1 = num(1);
    if (r1 !== undefined) e.params.r1 = r1;
    const c1 = num(2);
    if (c1 !== undefined) e.params.c1 = c1;
    const cap = num(3);
    if (cap !== undefined) e.params.capacityAh = cap;
    const pct = num(4);
    if (pct !== undefined) {
      // The file stores percent; the engine and the SOC fraction live in 0..1.
      e.params.initialSoc = Math.min(100, Math.max(0, pct)) / 100;
    }
    const bt = num(5);
    if (bt !== undefined) e.params.batteryType = bt;
    if (t[6] !== undefined) e.model = normalizeSocTable(t[6]);
  },
  dump: (e) => [
    e.params.r0 ?? 0.01,
    e.params.r1 ?? 0.02,
    e.params.c1 ?? 2000,
    e.params.capacityAh ?? 2,
    // The live soc token rides params after an overlayLiveState merge at save
    // time, so a mid-discharge save carries the running charge, upstream's
    // config/state split between dumpXml's isoc and dumpXmlState's soc. After
    // a reset the token equals initialSoc again, and before any build the
    // fallback applies. Both fields are 0..1 fractions; the file stores percent.
    (e.params.soc ?? e.params.initialSoc ?? 1) * 100,
    e.params.batteryType ?? 1,
    batteryTableOf(e),
  ],
  fields: [
    {
      name: 'batteryType',
      label: 'Battery Type',
      type: 'choice',
      choices: [
        ...BATTERY_TYPE_NAMES.map((label, i) => ({ value: i, label })),
        { value: BT_CUSTOM, label: 'Custom' },
      ],
    },
    { name: 'capacityAh', label: 'Capacity', unit: 'Ah' },
    // The param is a 0..1 fraction (the engine and the live SOC token work in
    // fractions); the row shows and edits whole percent, upstream's
    // `initialSoc * 100` edit row (BatteryElm.java:353).
    { name: 'initialSoc', label: 'Initial State of Charge', min: 0, max: 100, scale: 100 },
    { name: 'r0', label: 'R0, Ohmic Resistance', unit: 'Ω' },
    { name: 'r1', label: 'R1, Polarization Resistance', unit: 'Ω' },
    { name: 'c1', label: 'C1, Polarization Capacitance', unit: 'F' },
    // Upstream shows the table editor only on a custom battery
    // (BatteryElm.java:370-376).
    { name: 'socTable', label: 'SOC Voltage Table', type: 'text', target: 'model', multiline: true, visible: (e) => batteryTypeOf(e) === BT_CUSTOM },
    { name: 'showVoltage', label: 'Show Voltage', type: 'bool', flag: BATTERY_SHOW_VOLTAGE },
    { name: 'showSoc', label: 'Show State of Charge', type: 'bool', flag: BATTERY_SHOW_SOC },
  ],
  // The two-plate body is a solid pick zone, like the DC source's battery
  // plates (voltage.ts:93-100).
  bodyRect: (e) => {
    const [lead1, lead2] = calcLeads(e, 8);
    const [s1, s2] = interp2(lead1, lead2, 0, 10);
    const [l1, l2] = interp2(lead1, lead2, 1, 16);
    return boxOfPoints([s1, s2, l1, l2]);
  },
  draw: drawBattery,
};