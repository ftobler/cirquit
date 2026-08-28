import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCircuit } from './netlist';
import { defFor } from '../model/registry';
import type { CircuitElement } from '../model/types';

const circuit = (file: string): CircuitElement[] =>
  parseCircuit(
      readFileSync(fileURLToPath(new URL(`../../public/circuits/${file}`, import.meta.url)), 'utf8'),
  ).elements;

const find = (file: string, pred: (e: CircuitElement) => boolean): CircuitElement => {
  const el = circuit(file).find(pred);
  if (!el) throw new Error(`no element matched in ${file}`);
  return el;
};

const postsOf = (e: CircuitElement) => defFor(e.kind)?.posts?.(e);

// C2: the round-trip check (netlist/roundtrip.test.ts) only compares a parse
// against its own re-serialisation, so a token->field mapping that is
// self-consistent but semantically wrong versus upstream round-trips cleanly.
// These assertions pin the *meaning* of specific tokens against real corpus
// files, so a future swap or misread fails even though dump/parse stay
// self-consistent.
describe('corpus golden param mapping', () => {
  it('zenerref.txt z line maps tokens to forward/breakdown voltage (not swapped)', () => {
    const z = find(
      'zenerref.txt',
      (e) => e.kind === 'zener' && e.x1 === 336 && e.y1 === 288 && e.x2 === 336 && e.y2 === 160,
    );
    expect(z.params.forwardVoltage).toBe(0.805904783);
    expect(z.params.breakdownVoltage).toBe(5.6);
  });

  it('555int.txt op-amp line maps maxOut/minOut/gain in OpAmpElm token order', () => {
    const a = find(
      '555int.txt',
      (e) => e.kind === 'opamp' && e.x1 === 288 && e.y1 === 168 && e.x2 === 384 && e.y2 === 168,
    );
    // tokens after flags: 10 0 1000000 0 0 100000 -> maxOut minOut gbw volts0 volts1 gain
    expect(a.params.maxOut).toBe(10);
    expect(a.params.minOut).toBe(0);
    expect(a.params.gain).toBe(100000);
  });

  it('mr-crossbar.txt memristor line maps r_on/r_off/dopeWidth/totalWidth/mobility', () => {
    const m = find(
      'mr-crossbar.txt',
      (e) => e.kind === 'memristor' && e.x1 === 208 && e.y1 === 240 && e.x2 === 256 && e.y2 === 192,
    );
    // tokens after flags: 100.0 250000.0 1.0e-8 1.0E-8 1.0E-10
    // -> r_on r_off dopeWidth totalWidth mobility
    expect(m.params.r_on).toBe(100.0);
    expect(m.params.r_off).toBe(250000.0);
    expect(m.params.dopeWidth).toBe(1.0e-8);
    expect(m.params.totalWidth).toBe(1.0e-8);
    expect(m.params.mobility).toBe(1.0e-10);
  });

  it('trianglevco.txt op-amp maps volts0/volts1 (OPAMP_SMALL flags)', () => {
    const a = find(
      'trianglevco.txt',
      (e) => e.kind === 'opamp' && e.x1 === 104 && e.y1 === 192 && e.x2 === 160 && e.y2 === 192,
    );
    // flags 2 = OPAMP_SMALL; tokens 5 -5 1000000 0.5000.. 0.5000.. -> maxOut minOut gbw volts0 volts1
    expect(a.params.maxOut).toBe(5);
    expect(a.params.minOut).toBe(-5);
    expect(a.params.volts0).toBe(0.5000137308326578);
    expect(a.params.volts1).toBe(0.5000000000000006);
  });
});

// C3: the engine merges nodes on each registry `posts()` output, not on the raw
// file coordinates. The round-trip only checks x1..y2, so a `posts()` that
// places a terminal at the wrong coordinate would silently re-wire the circuit
// while load/sim/converge all stay green. These pin the derived posts for
// representative multi-post elements against the upstream setPoints geometry.
describe('corpus golden posts geometry', () => {
  it('555int.txt op-amp derives inverting/non-inverting/output posts (FLAG_SWAP set)', () => {
    const a = find(
      '555int.txt',
      (e) => e.kind === 'opamp' && e.x1 === 288 && e.y1 === 168 && e.x2 === 384 && e.y2 === 168,
    );
    // flags 9 = GAIN | FLAG_SWAP(1): the swap reflects in the post order, so the
    // inverting input sits below the axis and the non-inverting above.
    expect(postsOf(a)).toEqual([
      { x: 288, y: 184 },
      { x: 288, y: 152 },
      { x: 384, y: 168 },
    ]);
  });

  it('trianglevco.txt small op-amp derives inputs offset by the small height', () => {
    const a = find(
      'trianglevco.txt',
      (e) => e.kind === 'opamp' && e.x1 === 104 && e.y1 === 192 && e.x2 === 160 && e.y2 === 192,
    );
    // flags 2 = OPAMP_SMALL: height is 8, not 16, so the inputs land 8 units off
    // the axis rather than 16.
    expect(postsOf(a)).toEqual([
      { x: 104, y: 184 },
      { x: 104, y: 200 },
      { x: 160, y: 192 },
    ]);
  });

  it('opamp.txt op-amp derives output post at x2/y2 and inputs offset by height', () => {
    const a = find(
      'opamp.txt',
      (e) => e.kind === 'opamp' && e.x1 === 256 && e.y1 === 240 && e.x2 === 384 && e.y2 === 240,
    );
    expect(postsOf(a)).toEqual([
      { x: 256, y: 224 },
      { x: 256, y: 256 },
      { x: 384, y: 240 },
    ]);
  });
});
