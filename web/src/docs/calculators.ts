/**
 * The headless math behind the three docs calculators: crystal resonance, the
 * diode/LED model and the MOSFET beta worksheet. Each function is pure and
 * node-tested (`calculators.test.ts`); the React forms are thin shells over
 * these and over the shared `parseUnits`.
 *
 * The generated netlists use this port's own file formats so `parseCircuit`
 * reads them back: the `412` line carries the four `_`-joined child-dump
 * tokens `crystalTokens` writes (`web/src/model/registry/elements/crystal.ts`),
 * and the diode circuit uses the `34` model line plus a `d` element naming it.
 * Upstream's calculators emit different byte layouts; re-pointing them at the
 *  port's writer is the whole point, so the generated link loads here.
 */

/** Thermal voltage at room temperature, the diode model's VT
 *  (DiodeModel.java:32, shared with `deviceModels.ts`). */
const VT = 0.025865;

/** Series resonance fs, parallel resonance fp and quality factor q of the
 *  motional-branch model, from the crystal calculator (crystal.html). */
export function crystalFrequencies(
  parallelCapacitance: number,
  seriesCapacitance: number,
  inductance: number,
  resistance: number,
): { fs: number; fp: number; q: number } {
  const fs = 1 / (2 * Math.PI * Math.sqrt(inductance * seriesCapacitance));
  const fp =
    1 /
    (2 *
      Math.PI *
      Math.sqrt((inductance * seriesCapacitance * parallelCapacitance) / (seriesCapacitance + parallelCapacitance)));
  const q = (2 * Math.PI * fp * inductance) / resistance;
  return { fs, fp, q };
}

/** The crystal element line for the four motional values, in the port's own
 *  `412` format (see crystal.ts `crystalTokens`). */
function crystalTokens(cp: number, cs: number, l: number, r: number): string[] {
  const cap = (c: number) => `4_${c}_0_0.001_0`;
  return [cap(cp), cap(cs), `0_${l}_0_0_0`, `0_${r}`];
}

/** A whole circuit holding one crystal with the given motional parameters. */
export function crystalNetlist(cp: number, cs: number, l: number, r: number): string {
  return `$ 1 0.000005 10.20027730826997 50 5 50 5e-11
412 112 144 192 144 1 ${crystalTokens(cp, cs, l, r).join(' ')}
`;
}

/** The diode emission coefficient from a forward-drop data point, upstream's
 *  `ecoef = (fwd / ln(cur / rev + 1)) / vt` (diodecalc.html). */
export function diodeEmissionCoefficient(fwd: number, cur: number, rev: number): number {
  return fwd / Math.log(cur / rev + 1) / VT;
}

/** A circuit demonstrating a diode model: the `34` model line the load turns
 *  into `saturationCurrent`/`emissionCoefficient`, a `d` element naming it,
 *  a rail and a ground. Whitespace is stripped from the model name, which the
 *  netlist format cannot represent anyway (upstream's `replace(" ", "")`). */
export function diodeNetlist(fwd: number, cur: number, rev: number, modelName: string): string {
  const name = modelName.replace(/\s+/g, '');
  const ecoef = diodeEmissionCoefficient(fwd, cur, rev);
  return [
    '$ 1 0.000005 10.20027730826997 50 5 50 5e-11',
    `34 ${name} 0 ${rev} 0 ${ecoef} 0`,
    `d 352 112 352 224 2 ${name}`,
    `R 352 112 352 64 0 0 40 ${fwd} 0 0 0.5`,
    `g 352 224 352 272 0`,
    '',
  ].join('\n');
}

/** MOSFET beta from an Rds(on) data point, `|1/(Rds*(Vgs-Vt))|`
 *  (mosfet-beta.html). Display only, no generated circuit. */
export function mosfetBeta(rds: number, vgs: number, vt: number): number {
  return Math.abs(1 / (rds * (vgs - vt)));
}
