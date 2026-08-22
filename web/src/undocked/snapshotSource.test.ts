import { describe, expect, it } from 'vitest';
import { UNDOCKED_FRAME_TYPE, type UndockedFrameMessage } from './protocol';
import { SnapshotScopeSource, deliverToSource } from './snapshotSource';

function frameMessage(overrides: Partial<UndockedFrameMessage> = {}): UndockedFrameMessage {
  return {
    type: UNDOCKED_FRAME_TYPE,
    time: 0.01,
    scope: {} as UndockedFrameMessage['scope'],
    dark: true,
    decimalDigits: 3,
    timeStep: 5e-6,
    colors: {
      positiveColor: null,
      negativeColor: null,
      neutralColor: null,
      selectionColor: null,
      currentColor: null,
    },
    kinds: {},
    title: 'Undocked Scope - Circuit Simulator',
    traces: [
      {
        plotId: 7,
        data: new Float32Array([0.5, -0.5, 1, -1]).buffer,
        diverged: false,
        trigger: null,
        xy: null,
      },
      {
        plotId: 8,
        data: new Float32Array([2, 2, 2, 2]).buffer,
        diverged: true,
        trigger: {
          columns: 256,
          snapshot_start: 4,
          start_index: 9,
          state: 2,
          time: 0.008,
          triggered: true,
          valid_count: 64,
          waiting: false,
          written: 128,
        },
        xy: new Float32Array([3, 4]).buffer,
      },
    ],
    ...overrides,
  };
}

describe('SnapshotScopeSource', () => {
  it('answers the draw queries from the last applied frame', () => {
    const source = new SnapshotScopeSource();
    expect(source.time).toBe(0);
    expect(source.scopeIndexOf(7)).toBeUndefined();
    source.applyFrame(frameMessage());
    expect(source.time).toBeCloseTo(0.01);
    // The index space is frame order, matching how the engine numbers traces.
    expect(source.scopeIndexOf(7)).toBe(0);
    expect(source.scopeIndexOf(8)).toBe(1);
    expect(source.scopeIndexOf(999)).toBeUndefined();
    expect(Array.from(source.scopeData(0))).toEqual([0.5, -0.5, 1, -1]);
    // The engine's own arrays are views over its ring; the child's are plain
    // copies it owns outright.
    expect(() => source.scopeData(0).set([9], 0)).not.toThrow();
    expect(Array.from(source.scopeData(0))).toEqual([9, -0.5, 1, -1]);
  });

  it('reports the diverged flag and the X-Y samples per trace', () => {
    const source = new SnapshotScopeSource();
    source.applyFrame(frameMessage());
    expect(source.scopeDiverged(0)).toBe(false);
    expect(source.scopeDiverged(1)).toBe(true);
    expect(Array.from(source.recentSamples(1))).toEqual([3, 4]);
    expect(source.recentSamples(0).length).toBe(0);
  });

  it('wraps the trigger snapshot with a no-op free, like the dock reads it', () => {
    const source = new SnapshotScopeSource();
    source.applyFrame(frameMessage());
    const info = source.triggerInfo(1, 300);
    expect(info.valid_count).toBe(64);
    expect(info.triggered).toBe(true);
    // drawScope releases the wasm object after reading; a snapshot copy has
    // nothing to release and must not throw when freed.
    expect(() => info.free()).not.toThrow();
    // A trace with no trigger (free-run) reports an idle one defensively.
    expect(source.triggerInfo(0, 300).waiting).toBe(true);
  });

  it('a replaced frame fully replaces the previous one', () => {
    const source = new SnapshotScopeSource();
    source.applyFrame(frameMessage());
    source.applyFrame(
      frameMessage({
        time: 0.02,
        traces: [
          {
            plotId: 42,
            data: new Float32Array([1, 1]).buffer,
            diverged: false,
            trigger: null,
            xy: null,
          },
        ],
      }),
    );
    expect(source.scopeIndexOf(7)).toBeUndefined();
    expect(source.scopeIndexOf(42)).toBe(0);
    expect(source.time).toBeCloseTo(0.02);
  });

  it('deliverToSource applies well-formed frames and rejects everything else', () => {
    const source = new SnapshotScopeSource();
    expect(deliverToSource(source, frameMessage())).toBe(true);
    expect(source.time).toBeCloseTo(0.01);
    for (const junk of [null, undefined, 42, {}, { type: 'undocked-frame' }, { type: 'other' }]) {
      expect(deliverToSource(source, junk)).toBe(false);
    }
    // The rejected messages changed nothing.
    expect(source.time).toBeCloseTo(0.01);
  });

  it('a frame whose trace payload is malformed is refused whole', () => {
    const good = frameMessage().traces;
    const cases: unknown[] = [
      // A trace item that is not an object at all.
      { type: 'undocked-frame', time: 0.01, scope: {}, traces: [7] },
      // Missing or mistyped buffer: applyFrame would build a view from it.
      { traces: [{ ...good[0], data: undefined }] },
      { traces: [{ ...good[0], data: new Float32Array([1]) }] },
      // A detached buffer throws on view construction; the guard refuses it
      // before applyFrame ever sees it.
      (() => {
        const victim = new Float32Array([1]).buffer;
        structuredClone(victim, { transfer: [victim] });
        return { traces: [{ ...good[0], data: victim }] };
      })(),
      // The X-Y samples get the same treatment.
      { traces: [{ ...good[0], xy: 5 }] },
      // And every field of the trigger snapshot copy.
      {
        traces: [{ ...good[1], trigger: { ...good[1].trigger, valid_count: 'many' } }],
      },
    ];
    for (const message of cases) {
      const source = new SnapshotScopeSource();
      // Seed a known-good frame so "refused whole" is observable as "the
      // previous frame survived".
      source.applyFrame(frameMessage());
      expect(deliverToSource(source, message), JSON.stringify(message)).toBe(false);
      expect(source.scopeIndexOf(7)).toBe(0);
      expect(Array.from(source.scopeData(0))).toEqual([0.5, -0.5, 1, -1]);
      expect(source.time).toBeCloseTo(0.01);
    }
  });
});
