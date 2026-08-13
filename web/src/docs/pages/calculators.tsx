/** The three interactive calculators: crystal resonance, diode/LED model and
 *  MOSFET beta. Thin forms over the pure math in `calculators.ts`, sharing the
 *  app's unit parser (`parseUnits`). */

import { useState } from 'react';
import { circuitToUrl } from '../../io/urlShare';
import { parseUnits } from '../../model/units';
import {
  crystalFrequencies,
  crystalNetlist,
  diodeEmissionCoefficient,
  diodeNetlist,
  mosfetBeta,
} from '../calculators';
import { simulatorBase } from '../components';

function SimLink({ href, children }: { href: string | null; children: string }) {
  if (href === null) return null;
  return (
    <p>
      <a href={href} target="_blank" rel="noopener">
        {children}
      </a>
    </p>
  );
}

/** A text field helper: label plus an input bound to a string state slot. */
function UnitField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label>
      {label}:{' '}
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
    </label>
  );
}

export function CrystalCalcPage() {
  const [cp, setCp] = useState('29p');
  const [cs, setCs] = useState('0.1p');
  const [l, setL] = useState('2.5m');
  const [r, setR] = useState('6.4');

  const cpV = parseUnits(cp);
  const csV = parseUnits(cs);
  const lV = parseUnits(l);
  const rV = parseUnits(r);
  const valid = cpV > 0 && csV > 0 && lV > 0 && rV > 0;
  const values = valid ? crystalFrequencies(cpV, csV, lV, rV) : null;
  const href = valid
    ? circuitToUrl(crystalNetlist(cpV, csV, lV, rV), simulatorBase())
    : null;

  return (
    <>
      <p>
        In this simulator, crystals are modeled using an equivalent circuit: a
        series motional branch (series capacitor, inductor and resistor) in
        parallel with the holder (parallel) capacitor. To change the crystal
        parameters, you need to know the values of all these components. You
        can use the values below as a starting point to get a crystal with a
        desired frequency.
      </p>
      <div className="docs-form">
        <UnitField label="Parallel Capacitor, F" value={cp} onChange={setCp} />
        <UnitField label="Series Capacitor, F" value={cs} onChange={setCs} />
        <UnitField label="Inductor, H" value={l} onChange={setL} />
        <UnitField label="Resistor, Ω" value={r} onChange={setR} />
      </div>
      {values && (
        <div className="docs-result">
          <p>Series resonant frequency = {Math.round(values.fs)} Hz</p>
          <p>Parallel resonant frequency = {Math.round(values.fp)} Hz</p>
          <p>Q = {Math.round(values.q)}</p>
        </div>
      )}
      <SimLink href={href}>crystal with these parameters</SimLink>
    </>
  );
}

export function DiodeCalcPage() {
  const [fwd, setFwd] = useState('.6');
  const [cur, setCur] = useState('18m');
  const [rev, setRev] = useState('171n');
  const [model, setModel] = useState('model');

  const fwdV = parseUnits(fwd);
  const curV = parseUnits(cur);
  const revV = parseUnits(rev);
  const valid = fwdV > 0 && curV > 0 && revV > 0;
  const ecoef = valid ? diodeEmissionCoefficient(fwdV, curV, revV) : null;
  const href = valid
    ? circuitToUrl(diodeNetlist(fwdV, curV, revV, model), simulatorBase())
    : null;

  return (
    <>
      <div className="docs-form">
        <UnitField label="Forward voltage" value={fwd} onChange={setFwd} />
        <UnitField label="Current at above voltage" value={cur} onChange={setCur} />
        <UnitField label="Saturation current (reverse current)" value={rev} onChange={setRev} />
        <UnitField label="Model name" value={model} onChange={setModel} />
      </div>
      <div className="docs-result">
        {ecoef !== null && <p>Emission coefficient: {ecoef}</p>}
        <p>Series resistance: 0</p>
      </div>
      <SimLink href={href}>link to example circuit</SimLink>
    </>
  );
}

export function MosfetBetaPage() {
  const [rds, setRds] = useState('0.1');
  const [vgs, setVgs] = useState('10');
  const [vt, setVt] = useState('2');

  const rdsV = parseUnits(rds);
  const vgsV = parseUnits(vgs);
  const vtV = parseUnits(vt);
  const valid = rdsV > 0 && vgsV - vtV !== 0;
  const beta = valid ? mosfetBeta(rdsV, vgsV, vtV) : null;

  return (
    <>
      <p>
        We use a parameter called "beta" to describe the behavior of a MOSFET.
        The default value is small (20m), which is appropriate for a signal
        MOSFET. To simulate a power MOSFET, use a larger value like 80.
      </p>
      <p>
        In the saturation region, I<sub>ds</sub> = beta * (V<sub>gs</sub> - V
        <sub>t</sub>)<sup>2</sup>/2.
      </p>
      <p>
        This worksheet will calculate the value of beta for a particular
        MOSFET, given Rds(on).
      </p>
      <div className="docs-form">
        <UnitField label="RDS(on) (Ω) (use typical value)" value={rds} onChange={setRds} />
        <UnitField label="VGS where measured (V)" value={vgs} onChange={setVgs} />
        <UnitField label="Threshold (V) (use typical value)" value={vt} onChange={setVt} />
      </div>
      {beta !== null && (
        <div className="docs-result">
          <p>beta = {beta}</p>
        </div>
      )}
    </>
  );
}
