import { beforeEach, describe, expect, it } from 'vitest';
import type { CircuitElement } from '../model/types';
import { convertWires } from './wireConverter';

let nextId = 1;
const wire = (x1: number, y1: number, x2: number, y2: number): CircuitElement => ({
  id: nextId++,
  kind: 'wire',
  x1,
  y1,
  x2,
  y2,
  flags: 0,
  params: {},
});

const resistor = (x1: number, y1: number, x2: number, y2: number): CircuitElement => ({
  id: nextId++,
  kind: 'resistor',
  x1,
  y1,
  x2,
  y2,
  flags: 0,
  params: { resistance: 1000 },
});

describe('convertWires', () => {
  beforeEach(() => {
    nextId = 1;
  });

  it('merges a chain of four end-to-end wires into one routed wire', () => {
    const wires = [
      wire(0, 0, 80, 0),
      wire(80, 0, 160, 0),
      wire(160, 0, 160, 80),
      wire(160, 80, 240, 80),
    ];
    const out = convertWires(wires);

    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('wire');
    // The ordered polyline runs from one chain endpoint to the other, through
    // every degree-2 interior point.
    expect(out[0].route).toEqual([
      [0, 0],
      [80, 0],
      [160, 0],
      [160, 80],
      [240, 80],
    ]);
    // The merged wire's posts are the chain endpoints, so the engine merges it
    // into the same nodes as the four wires did.
    expect([out[0].x1, out[0].y1, out[0].x2, out[0].y2]).toEqual([0, 0, 240, 80]);
  });

  it('keeps wires meeting at a four-way junction as separate wires', () => {
    const wires = [
      wire(0, 0, 80, 0),
      wire(80, 0, 160, 0),
      wire(80, 0, 80, 80),
      wire(80, 0, 80, -80),
    ];
    const out = convertWires(wires);

    expect(out).toHaveLength(4);
    // None of them merged: each is its own two-point routed wire.
    for (const w of out) {
      expect(w.route).toHaveLength(2);
    }
  });

  it('does not merge a chain across a coordinate a resistor post occupies', () => {
    const a = wire(0, 0, 80, 0);
    const b = wire(80, 0, 160, 0);
    const r = resistor(80, 0, 160, 16);
    const out = convertWires([a, b, r]);

    // (80,0) is degree 4 (two wire ends plus the forced +2 from the resistor
    // post), so the two wires stay separate chains.
    const wires = out.filter((e) => e.kind === 'wire');
    expect(wires).toHaveLength(2);
    expect(out).toContain(r);
  });

  it('leaves a closed loop of wires alone', () => {
    const wires = [
      wire(0, 0, 80, 0),
      wire(80, 0, 80, 80),
      wire(80, 80, 0, 80),
      wire(0, 80, 0, 0),
    ];
    const out = convertWires(wires);

    // Every point has degree 2, so there is no chain endpoint to order from;
    // the ring is skipped untouched (WireConverter.java:170-171).
    expect(out).toHaveLength(4);
    expect(out.every((w) => !w.route)).toBe(true);
  });

  it('converts only the selected wires when any plain wire is selected', () => {
    const a = wire(0, 0, 80, 0);
    const b = wire(80, 0, 160, 0);
    const c = wire(0, 80, 80, 80);
    const out = convertWires([a, b, c], [b.id]);

    // Only b's chain converts; c stays a plain wire.
    const routed = out.filter((w) => w.route);
    expect(routed).toHaveLength(1);
    expect(routed[0].route).toEqual([
      [80, 0],
      [160, 0],
    ]);
    const plain = out.find((w) => w.id === c.id);
    expect(plain?.route).toBeUndefined();
  });

  it('converts everything when the selection holds no plain wire', () => {
    const a = wire(0, 0, 80, 0);
    const b = wire(80, 0, 160, 0);
    const r = resistor(0, 80, 80, 80);
    const out = convertWires([a, b, r], [r.id]);

    // The selection contains no plain wire, so hasSelection is false and the
    // whole circuit's wires convert, matching upstream (WireConverter.java:15-21).
    expect(out.filter((w) => w.route)).toHaveLength(1);
  });

  it('is a no-op when there is nothing to convert and keeps element identity', () => {
    const r = resistor(0, 0, 160, 0);
    const out = convertWires([r]);
    expect(out).toHaveLength(1);
    // The resistor is returned by reference, so the store can diff cheaply.
    expect(out[0]).toBe(r);
  });
});
