/** The drill-in bridge (feature/subcircuit-drill-in.md): reconstructing an
 *  editable document from a model and extracting an edited document back into
 *  a model. The round-trip guarantee is the core: entering and immediately
 *  leaving must reproduce the model byte-for-byte except for pin-label
 *  positions, which are new by construction. */

import { describe, expect, it } from 'vitest';
import { parseCircuit } from './netlist';
import { parseCompositeModelLine } from './subcircuits';
import {
  compositeFromDocument,
  describeMissingComponents,
  documentFromComposite,
  modelHasNestedSubcircuit,
} from './compositeDocument';

/** The two-1k-resistor divider model the store tests share: `in` on node 1
 *  (north), `out` on node 3 (south). */
const MODEL_LINE =
  '. myCirc 0 2 2 2 in 1 0 0 out 3 0 1 ' +
  'ResistorElm\\s1\\s2\\rResistorElm\\s2\\s3 ' +
  '0\\\\s1000\\s0\\\\s1000';

const model = () => parseCompositeModelLine(MODEL_LINE)!;

describe('documentFromComposite', () => {
  it("produces parseable text whose elements carry the dumps' kinds and state", () => {
    const text = documentFromComposite(model());
    const parsed = parseCircuit(text);
    expect(parsed.unsupported).toEqual([]);
    // Two resistor children, one per nodeList line, in order (the document
    // also carries the pin labels and the net-chain wires).
    const resistors = parsed.elements.filter((e) => e.kind === 'resistor');
    expect(resistors).toHaveLength(2);
    for (const r of resistors) {
      expect(r.params.resistance).toBe(1000);
      // Coordinates are finite and grid-aligned, so the drawn circuit is real.
      expect(Number.isInteger(r.x1)).toBe(true);
      expect(Number.isInteger(r.y1)).toBe(true);
      expect(Number.isInteger(r.x2)).toBe(true);
      expect(Number.isInteger(r.y2)).toBe(true);
    }
  });

  it('places one labeled node per external pin, named after it, below the body', () => {
    const text = documentFromComposite(model());
    const labels = parseCircuit(text).elements.filter((e) => e.kind === 'labeledNode');
    expect(labels.map((l) => l.text)).toEqual(['in', 'out']);
    // The labels sit on a fresh row below every child row.
    const maxChildY = Math.max(
      ...parseCircuit(text)
        .elements.filter((e) => e.kind === 'resistor')
        .map((e) => Math.max(e.y1, e.y2)),
    );
    for (const l of labels) {
      expect(l.y1).toBeGreaterThan(maxChildY);
    }
  });

  it('wires the posts that share a model node into one net', () => {
    const text = documentFromComposite(model());
    const parsed = parseCircuit(text);
    const wires = parsed.elements.filter((e) => e.kind === 'wire');
    // Node 2 (shared by both resistors) and the two pin nets each need a
    // chain, so at least one wire exists and it joins two coordinates.
    expect(wires.length).toBeGreaterThanOrEqual(3);
  });

  it('reproduces the model byte-for-byte on immediate exit', () => {
    const original = model();
    const text = documentFromComposite(original);
    const { model: back, error } = compositeFromDocument(original.name, text, original);
    expect(error).toBeNull();
    expect(back).not.toBeNull();
    // The ext list, node list and every dumped token come back identical; only
    // the pin-label positions are new by construction.
    expect(back!.extList).toEqual(original.extList);
    expect(back!.nodeList).toBe(original.nodeList);
    expect(back!.elmDump).toBe(original.elmDump);
    expect(back!.flags).toBe(original.flags);
    expect(back!.sizeX).toBe(original.sizeX);
    expect(back!.sizeY).toBe(original.sizeY);
  });

  it("keeps a child's edited parameter in the re-extracted dump", () => {
    const original = model();
    const text = documentFromComposite(original);
    // Edit the first resistor's value in the reconstructed document.
    const edited = text.replace('r 0 0 32 0 0 1000', 'r 0 0 32 0 0 4700');
    const { model: back } = compositeFromDocument(original.name, edited, original);
    expect(back!.elmDump.split(' ')[0]).toBe('0\\s4700');
    expect(back!.elmDump.split(' ')[1]).toBe('0\\s1000');
  });

  it('a child dump count that does not match the node list degrades, never throws', () => {
    const original = model();
    // One dump token for two children: the second child parses to defaults.
    const text = documentFromComposite({ ...original, elmDump: '0\\s1000' });
    expect(typeof text).toBe('string');
    const { model: back, error } = compositeFromDocument(original.name, text, original);
    // The missing child is not a refusal: the reconstruction simply rebuilt it
    // from defaults, so the model comes back with two children again.
    expect(error).toBeNull();
    expect(back!.nodeList).toBe(original.nodeList);
  });

  it('a grounded child keeps model node 0 through the round trip', () => {
    const model = parseCompositeModelLine(
      '. gndtest 0 2 1 1 in 1 0 2 ' + 'ResistorElm\\s1\\s0 ' + '0\\\\s1000',
    )!;
    const text = documentFromComposite(model);
    // The reconstruction grounds the node-0 net, so re-extraction restores it.
    expect(parseCircuit(text).elements.some((e) => e.kind === 'ground')).toBe(true);
    const { model: back, error } = compositeFromDocument(model.name, text, model);
    expect(error).toBeNull();
    expect(back!.nodeList).toBe('ResistorElm 1 0');
    expect(back!.extList).toEqual([{ name: 'in', node: 1, pos: 0, side: 2 }]);
    expect(back!.elmDump).toBe('0\\s1000');
  });

  it('a corrupted elmDump yields a clear error instead of a throw', () => {
    const original = model();
    // A child class the port cannot build (with no dump token to match it):
    // the reconstruction emits a placeholder element line, the parse reports
    // it unsupported, and extraction refuses with the banner rather than
    // throwing or half-loading.
    const bad = {
      ...original,
      nodeList: 'ResistorElm 1 2\rOpAmpElm 2 3',
      elmDump: '0\\s1000',
    };
    const text = documentFromComposite(bad);
    expect(typeof text).toBe('string');
    expect(describeMissingComponents(parseCircuit(text).unsupported)).toMatch(/not implemented/);
    const { model: back, error } = compositeFromDocument(bad.name, text, original);
    expect(back).toBeNull();
    expect(error).toMatch(/not implemented/);
  });

  it('modelHasNestedSubcircuit detects a 410 child', () => {
    const flat = parseCompositeModelLine(MODEL_LINE)!;
    expect(modelHasNestedSubcircuit(flat)).toBe(false);
    const nested = parseCompositeModelLine(
      '. nested 0 2 2 2 in 1 0 0 out 2 0 1 ' +
        'CustomCompositeElm\\s1\\s2 ' +
        '1\\sinner',
    )!;
    expect(modelHasNestedSubcircuit(nested)).toBe(true);
  });
});