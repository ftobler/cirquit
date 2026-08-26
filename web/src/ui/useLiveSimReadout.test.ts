import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SimEngine } from '../engine/simulator';
import {
  readElementReadout,
  readoutEquals,
  tickReadout,
  type ElementReadout,
} from './useLiveSimReadout';

/** A stub engine standing in for the wasm-backed SimEngine under the node test
 *  environment. The operating-point arrays are returned live so a test can
 *  rewrite them between frames. */
function makeEngine(
  currents: number[],
  voltages: number[],
  powers: number[],
  indexOf: (id: number) => number | undefined = (id) => (id === 7 ? 2 : undefined),
): SimEngine {
  return {
    indexOf,
    elementCurrents: () => new Float64Array(currents),
    elementVoltages: () => new Float64Array(voltages),
    elementPowers: () => new Float64Array(powers),
  } as unknown as SimEngine;
}

/** A manual animation-frame scheduler: every rAF the code requests is queued
 *  until `runNext` fires it, the same shape the browser drives. */
function stubFrames() {
  const callbacks: Array<() => void> = [];
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    callbacks.push(cb);
    return callbacks.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    callbacks.length = 0;
  });
  return {
    runNext: () => {
      const cb = callbacks.shift();
      if (cb) cb();
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('readElementReadout', () => {
  it('maps the three engine arrays at the element index', () => {
    const engine = makeEngine([0, 0, 5], [0, 0, 1.5], [0, 0, 7.5]);
    expect(readElementReadout(engine, 7)).toEqual({ current: 5, voltage: 1.5, power: 7.5 });
  });

  it('reads an empty readout for an id the engine skipped', () => {
    const engine = makeEngine([5], [1.5], [7.5], () => undefined);
    expect(readElementReadout(engine, 99)).toEqual({});
  });

  it('reads an empty readout with no engine or no selection', () => {
    const engine = makeEngine([5], [1.5], [7.5]);
    expect(readElementReadout(null, 7)).toEqual({});
    expect(readElementReadout(null, undefined)).toEqual({});
    expect(readElementReadout(engine, undefined)).toEqual({});
  });
});

describe('readoutEquals', () => {
  it('treats absent and present fields as different', () => {
    expect(readoutEquals({}, {})).toBe(true);
    expect(readoutEquals({ current: 1, voltage: 2, power: 3 }, { current: 1, voltage: 2, power: 3 })).toBe(
      true,
    );
    expect(readoutEquals({ current: 1 }, {})).toBe(false);
    expect(readoutEquals({}, { current: 1 })).toBe(false);
    expect(readoutEquals({ power: 1 }, { power: 1 })).toBe(true);
    expect(readoutEquals({ power: 1 }, { power: 2 })).toBe(false);
  });

  it('distinguishes negative zero', () => {
    // The engine can flip the sign of a near-zero reading between frames;
    // Object.is keeps that visible instead of collapsing both to zero.
    expect(readoutEquals({ current: 0 }, { current: -0 })).toBe(false);
    expect(readoutEquals({ current: -0 }, { current: 0 })).toBe(false);
    expect(readoutEquals({ current: -0 }, { current: -0 })).toBe(true);
  });
});

describe('tickReadout', () => {
  it('emits one readout per animation frame', () => {
    const frames = stubFrames();
    const emitted: ElementReadout[] = [];
    const stop = tickReadout(
      () => ({ current: 1 }),
      (r) => emitted.push(r),
    );
    frames.runNext();
    frames.runNext();
    expect(emitted).toEqual([{ current: 1 }, { current: 1 }]);
    stop();
  });

  it('re-reads the engine arrays so a changed value shows after one frame', () => {
    const frames = stubFrames();
    const currents = [0, 0, 5];
    const voltages = [0, 0, 1.5];
    const powers = [0, 0, 7.5];
    const engine = makeEngine(currents, voltages, powers);
    const emitted: ElementReadout[] = [];
    const stop = tickReadout(
      () => readElementReadout(engine, 7),
      (r) => emitted.push(r),
    );
    frames.runNext();
    voltages[2] = 2;
    powers[2] = 10;
    frames.runNext();
    expect(emitted[emitted.length - 1]).toEqual({ current: 5, voltage: 2, power: 10 });
    stop();
  });

  it('stops emitting after the unsubscribe runs', () => {
    const frames = stubFrames();
    const emitted: ElementReadout[] = [];
    const stop = tickReadout(
      () => ({ current: 1 }),
      (r) => emitted.push(r),
    );
    frames.runNext();
    stop();
    frames.runNext();
    expect(emitted).toEqual([{ current: 1 }]);
  });
});
