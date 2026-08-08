/** The netlist: six two-input gates, an inverter, a tri-state and the two
 *  Schmitt triggers, each with its inputs driven by rails and its output read
 *  across a 1k load to ground. Input 0 of every gate is high, input 1 low, so
 *  AND/NOR/XNOR read low and NAND/OR/XOR read high. Every rail spells its
 *  waveform, frequency and maxVoltage out, since maxVoltage defaults to 5. */
import { beforeAll, describe, expect, it } from 'vitest';
import { SimEngine } from '../../engine/simulator';
import { parseCircuit } from './index';
import { DEFAULT_SETTINGS } from '../../model/types';

let engine: SimEngine;

beforeAll(async () => {
  engine = await SimEngine.create();
});

export const NETLIST = [
  '$ 1 5.0E-6 10 50 5.0 50 5.0E-11',
  // AND: in0=5, in1=0 -> 0
  'R 0 16 0 16 0 0 40 5',
  'R 0 -16 0 -16 0 0 40 0',
  '150 0 0 96 0 0 2 0 5',
  'r 96 0 96 100 0 1000',
  'g 96 100 96 116 0',
  // NAND: in0=5, in1=0 -> 5
  'R 112 16 112 16 0 0 40 5',
  'R 112 -16 112 -16 0 0 40 0',
  '151 112 0 208 0 0 2 0 5',
  'r 208 0 208 100 0 1000',
  'g 208 100 208 116 0',
  // OR: in0=5, in1=0 -> 5
  'R 224 16 224 16 0 0 40 5',
  'R 224 -16 224 -16 0 0 40 0',
  '152 224 0 320 0 0 2 0 5',
  'r 320 0 320 100 0 1000',
  'g 320 100 320 116 0',
  // NOR: in0=5, in1=0 -> 0
  'R 336 16 336 16 0 0 40 5',
  'R 336 -16 336 -16 0 0 40 0',
  '153 336 0 432 0 0 2 0 5',
  'r 432 0 432 100 0 1000',
  'g 432 100 432 116 0',
  // XOR: in0=5, in1=0 -> 5
  'R 448 16 448 16 0 0 40 5',
  'R 448 -16 448 -16 0 0 40 0',
  '154 448 0 544 0 0 2 0 5',
  'r 544 0 544 100 0 1000',
  'g 544 100 544 116 0',
  // XNOR: in0=5, in1=0 -> 0
  'R 560 16 560 16 0 0 40 5',
  'R 560 -16 560 -16 0 0 40 0',
  '431 560 0 656 0 0 2 0 5',
  'r 656 0 656 100 0 1000',
  'g 656 100 656 116 0',
  // Inverter: input 0 -> 5
  'R 672 0 672 0 0 0 40 0',
  'I 672 0 768 0 0 0.5 5',
  'r 768 0 768 100 0 1000',
  'g 768 100 768 116 0',
  // Tri-state: enabled by a 5 V control, input 5 -> 5
  'R 784 0 784 0 0 0 40 5',
  'R 832 16 832 16 0 0 40 5',
  '180 784 0 880 0 0 0.1 10000000000 0 5',
  'r 880 0 880 100 0 1000',
  'g 880 100 880 116 0',
  // Schmitt (non-inverting): input 5 -> 5
  'R 896 0 896 0 0 0 40 5',
  '182 896 0 992 0 0 0.5 1.66 3.33 5 0',
  'r 992 0 992 100 0 1000',
  'g 992 100 992 116 0',
  // Inverting Schmitt: input 0 -> 5
  'R 1008 0 1008 0 0 0 40 0',
  '183 1008 0 1104 0 0 0.5 1.66 3.33 5 0',
  'r 1104 0 1104 100 0 1000',
  'g 1104 100 1104 116 0',
].join('\n');

/** The voltage at the top of a load resistor, i.e. an output node level. */
function loadVoltage(id: number): number {
  const nodes = engine.elementNodes();
  const offset = engine.postOffset(id);
  const node = offset !== undefined ? nodes[offset] : 0;
  return engine.nodeVoltages()[node] ?? 0;
}

// Load resistor ids, in netlist order: every element (rails and grounds
// included) takes a sequential id from parseCircuit.
const LOAD_IDS = [4, 9, 14, 19, 24, 29, 33, 38, 42, 46];

describe('logic kinds through the engine boundary', () => {
  it('all ten kinds load, run and produce the right logic levels', () => {
    const parsed = parseCircuit(NETLIST);
    const err = engine.setCircuit(parsed.elements, { ...DEFAULT_SETTINGS, ...parsed.settings }, []);
    expect(err).toBeNull();

    const stats = engine.run(20);
    expect(stats.error).toBeUndefined();
    expect(stats.converged).toBe(true);

    // AND 0, NAND 5, OR 5, NOR 0, XOR 5, XNOR 0, inverter 5, tri-state 5,
    // schmitt 5, inverting schmitt 5.
    const expected = [0, 5, 5, 0, 5, 0, 5, 5, 5, 5];
    LOAD_IDS.forEach((id, i) => {
      expect(Math.abs(loadVoltage(id) - expected[i])).toBeLessThan(0.01);
    });
  });
});
