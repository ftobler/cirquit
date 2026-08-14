import { describe, expect, it } from 'vitest';
import { overlayLiveState, recordBuildOnSuccess, shouldInjectLiveState } from './liveState';
import { parseCircuit, serializeCircuit } from './netlist';
import { DEFAULT_SETTINGS } from '../model/types';
import type { CircuitElement } from '../model/types';

function elm(id: number, params: Record<string, number>): CircuitElement {
  return {
    id,
    kind: 'capacitor',
    x1: 0,
    y1: 0,
    x2: 32,
    y2: 0,
    flags: 0,
    params,
  };
}

describe('overlayLiveState', () => {
  it('is a pure copy: originals untouched, new element and params objects', () => {
    const source = [elm(1, { capacitance: 1e-6, voltDiff: 5 }), elm(2, { resistance: 1000 })];
    const live = { 1: { voltDiff: 8.16, seriesResistance: 0.1 } };
    const out = overlayLiveState(source, live);

    expect(out).not.toBe(source);
    expect(out[0]).not.toBe(source[0]);
    expect(out[0].params).not.toBe(source[0].params);
    // The input is untouched.
    expect(source[0].params).toEqual({ capacitance: 1e-6, voltDiff: 5 });
    expect(out[1]).not.toBe(source[1]);
    expect(out[1].params).not.toBe(source[1].params);
  });

  it('merges only the tokens live holds for the element, keeping the rest', () => {
    const source = [elm(1, { capacitance: 1e-6, voltDiff: 5, initialVoltage: 0 })];
    const live = { 1: { voltDiff: 8.16 } };
    const out = overlayLiveState(source, live);
    expect(out[0].params).toEqual({
      capacitance: 1e-6,
      voltDiff: 8.16,
      initialVoltage: 0,
    });
  });

  it('passes elements without an entry through with their params copied', () => {
    const source = [elm(7, { resistance: 220 })];
    const out = overlayLiveState(source, { 1: { voltDiff: 1 } });
    expect(out[0].params).toEqual({ resistance: 220 });
    expect(out[0].params).not.toBe(source[0].params);
  });

  it('never mutates the input elements or their params', () => {
    const source = [elm(1, { capacitance: 1e-6, voltDiff: 5 })];
    const live = { 1: { voltDiff: 9, seriesResistance: 0.1 } };
    overlayLiveState(source, live);
    expect(source[0].params).toEqual({ capacitance: 1e-6, voltDiff: 5 });
  });

  it('serializeCircuit writes the overlaid live token, not the stale params', () => {
    // The element-formats pattern: a loaded capacitor holds voltDiff 5, the
    // live overlay reports 8.16 and a 0.1 ohm ESR, so the saved line must
    // carry the live values (the damped member's ESR included), while the
    // element's own params stay untouched.
    const [e] = parseCircuit('c 0 0 32 0 4 0.00001 5 0 0\n').elements;
    const live = { [e.id]: { voltDiff: 8.16, seriesResistance: 0.1 } };
    const out = serializeCircuit(overlayLiveState([e], live), { ...DEFAULT_SETTINGS }).trim();
    expect(out).toContain('c 0 0 32 0 4 0.00001 8.16 0 0.1');
    expect(e.params.voltDiff).toBe(5);
  });
});

describe('shouldInjectLiveState', () => {
  it('injects when the engine still holds this document', () => {
    expect(shouldInjectLiveState(1, 1)).toBe(true);
    expect(shouldInjectLiveState(0, 0)).toBe(true);
  });

  it('refuses after a load or New bumps the document', () => {
    expect(shouldInjectLiveState(1, 2)).toBe(false);
    // The never-built sentinel (an engine holding no document) also refuses.
    expect(shouldInjectLiveState(-1, 1)).toBe(false);
  });

  it('undo and redo keep the document, so the rebuild still injects', () => {
    expect(shouldInjectLiveState(3, 3)).toBe(true);
  });
});

describe('recordBuildOnSuccess', () => {
  it('records the document only when setCircuit succeeded', () => {
    expect(recordBuildOnSuccess(-1, 5, 'boom')).toBe(-1);
    expect(recordBuildOnSuccess(-1, 5, null)).toBe(5);
    expect(recordBuildOnSuccess(3, 5, 'boom')).toBe(3);
    expect(recordBuildOnSuccess(3, 5, null)).toBe(5);
  });

  it('a failed build keeps the live-state gate closed, a later success opens it', () => {
    const document = 7;
    // The never-built sentinel, like the engine before its first stamp.
    let built = -1;

    // First rebuild fails: not recorded, so the next rebuild refuses to inject.
    built = recordBuildOnSuccess(built, document, 'stamp failed');
    expect(built).toBe(-1);
    expect(shouldInjectLiveState(built, document)).toBe(false);

    // A later rebuild of the same document succeeds: recorded, gate opens.
    built = recordBuildOnSuccess(built, document, null);
    expect(built).toBe(document);
    expect(shouldInjectLiveState(built, document)).toBe(true);
  });

  it('a failed rebuild never overlays stale live tokens onto the new document', () => {
    const elements = [elm(1, { capacitance: 1e-6, voltDiff: 5 })];
    // Tokens the engine would report if it still held a stale or partial
    // build from the failed setCircuit.
    const staleLive = { 1: { voltDiff: 3.2 } };
    let built = -1;
    const document = 9;

    built = recordBuildOnSuccess(built, document, 'stamp failed');
    const build = shouldInjectLiveState(built, document)
      ? overlayLiveState(elements, staleLive)
      : elements;
    expect(build[0].params.voltDiff).toBe(5);

    built = recordBuildOnSuccess(built, document, null);
    const build2 = shouldInjectLiveState(built, document)
      ? overlayLiveState(elements, staleLive)
      : elements;
    expect(build2[0].params.voltDiff).toBe(3.2);
  });
});
