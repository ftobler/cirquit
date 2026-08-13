import { describe, expect, it } from 'vitest';
import { parseCircuit } from '../io/netlist';
import { compressCircuit, decompressCircuit } from '../io/urlShare';
import { EXAMPLES } from './examples';

describe('inline example circuits', () => {
  it('every example parses as a valid circuit with no unsupported lines', () => {
    for (const [name, netlist] of Object.entries(EXAMPLES)) {
      const parsed = parseCircuit(netlist);
      expect(parsed.elements.length, name).toBeGreaterThan(0);
      expect(parsed.unsupported, name).toEqual([]);
    }
  });

  it('every example round-trips through the compressed URL form byte-for-byte', () => {
    for (const [name, netlist] of Object.entries(EXAMPLES)) {
      expect(decompressCircuit(compressCircuit(netlist)), name).toBe(netlist);
    }
  });

  it('bridge rectifier has 4 diodes, 4 labeled nodes and wires', () => {
    const parsed = parseCircuit(EXAMPLES.subcircuitBridgeRectifier);
    const count = (kind: string) => parsed.elements.filter((e) => e.kind === kind).length;
    expect(count('diode')).toBe(4);
    expect(count('labeledNode')).toBe(4);
    expect(count('wire')).toBeGreaterThan(0);
  });

  it('555 pins example has one timer and one labeled node per pin', () => {
    const parsed = parseCircuit(EXAMPLES.subcircuitTimer555Pins);
    const count = (kind: string) => parsed.elements.filter((e) => e.kind === kind).length;
    expect(count('timer')).toBe(1);
    // Vin, dis, tr, th, ctl, gnd, out, rst: one per 555 pin.
    expect(count('labeledNode')).toBe(8);
  });

  it('555 usage example carries a . model line and a 410 instance', () => {
    const parsed = parseCircuit(EXAMPLES.subcircuitTimer555Usage);
    expect(parsed.compositeModels).toHaveLength(1);
    expect(parsed.compositeModels[0].name).toBe('555');
    const composite = parsed.elements.find((e) => e.kind === 'customComposite');
    expect(composite?.text).toBe('555');
    // The second pass resolves the instance against the file's `.` line.
    expect(composite?.model).toBeDefined();
  });

  it('crystal equivalent is the discrete motional-branch circuit', () => {
    const parsed = parseCircuit(EXAMPLES.crystalEquivalent);
    const count = (kind: string) => parsed.elements.filter((e) => e.kind === kind).length;
    expect(count('capacitor')).toBe(2);
    expect(count('inductor')).toBe(1);
    expect(count('resistor')).toBe(1);
    expect(count('wire')).toBeGreaterThan(0);
  });
});
