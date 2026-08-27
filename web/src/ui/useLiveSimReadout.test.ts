import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SimEngine } from '../engine/simulator';
import {
  beginReadoutFrame,
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
 *  until `runNext` fires it, the same shape the browser drives. Each fired
 *  callback receives a monotonically increasing frame timestamp, matching how
 *  all of a browser's rAF callbacks in one frame see the same stamp. */
function stubFrames() {
  const callbacks: Array<(t: number) => void> = [];
  let stamp = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    callbacks.push(cb);
    return callbacks.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    callbacks.length = 0;
  });
  return {
    runNext: () => {
      const cb = callbacks.shift();
      if (cb) cb(++stamp);
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('readElementReadout', () => {
  it('maps the three engine arrays at the element index', () => {
    const engine = makeEngine([0, 0, 5], [0, 0, 1.5], [0, 0, 7.5]);
    expect(readElementReadout(engine, 7)).toEqual({ current: 5, voltage: 1.5, power: 7.5 });
  });

  it('crosses each operating-point array exactly once per read', () => {
    // The three getters each copy a full array across the wasm boundary, so a
    // read must fetch each once and index the same copies for all three values.
    const currents = [0, 0, 5];
    const voltages = [0, 0, 1.5];
    const powers = [0, 0, 7.5];
    const engine = makeEngine(currents, voltages, powers);
    const spy = engine as unknown as {
      elementCurrents: ReturnType<typeof vi.fn>;
      elementVoltages: ReturnType<typeof vi.fn>;
      elementPowers: ReturnType<typeof vi.fn>;
    };
    spy.elementCurrents = vi.fn(engine.elementCurrents);
    spy.elementVoltages = vi.fn(engine.elementVoltages);
    spy.elementPowers = vi.fn(engine.elementPowers);
    expect(readElementReadout(engine, 7)).toEqual({ current: 5, voltage: 1.5, power: 7.5 });
    expect(spy.elementCurrents).toHaveBeenCalledTimes(1);
    expect(spy.elementVoltages).toHaveBeenCalledTimes(1);
    expect(spy.elementPowers).toHaveBeenCalledTimes(1);
  });

  it('shares one triple fetch across reads in the same frame', () => {
    // The canvas info box (hovered) and the LiveReadout pump (selected) read in
    // the same animation frame; opening one frame and reading two ids must hit
    // the wasm boundary once for each array, not once per id. This is the
    // genuine dedup: the three crossings drop from N per frame (N consumers) to
    // exactly one.
    const engine = makeEngine(
      [0, 0, 5, 9],
      [0, 0, 1.5, 3],
      [0, 0, 7.5, 27],
      (id) => (id === 7 ? 2 : id === 8 ? 3 : undefined),
    );
    const spy = engine as unknown as {
      elementCurrents: ReturnType<typeof vi.fn>;
      elementVoltages: ReturnType<typeof vi.fn>;
      elementPowers: ReturnType<typeof vi.fn>;
    };
    spy.elementCurrents = vi.fn(engine.elementCurrents);
    spy.elementVoltages = vi.fn(engine.elementVoltages);
    spy.elementPowers = vi.fn(engine.elementPowers);
    beginReadoutFrame(1);
    expect(readElementReadout(engine, 7)).toEqual({ current: 5, voltage: 1.5, power: 7.5 });
    expect(readElementReadout(engine, 8)).toEqual({ current: 9, voltage: 3, power: 27 });
    expect(spy.elementCurrents).toHaveBeenCalledTimes(1);
    expect(spy.elementVoltages).toHaveBeenCalledTimes(1);
    expect(spy.elementPowers).toHaveBeenCalledTimes(1);
    // A new frame opens a fresh fetch, so the next read crosses again.
    beginReadoutFrame(2);
    readElementReadout(engine, 7);
    expect(spy.elementCurrents).toHaveBeenCalledTimes(2);
  });

  it('skips the shared fetch when the caller passes its own arrays', () => {
    // The frame loop fetches the triple once and threads it into each read,
    // so a read given arrays must not cross the wasm boundary at all.
    const engine = makeEngine([0, 0, 5], [0, 0, 1.5], [0, 0, 7.5]);
    const spy = engine as unknown as {
      elementCurrents: ReturnType<typeof vi.fn>;
      elementVoltages: ReturnType<typeof vi.fn>;
      elementPowers: ReturnType<typeof vi.fn>;
    };
    spy.elementCurrents = vi.fn(engine.elementCurrents);
    spy.elementVoltages = vi.fn(engine.elementVoltages);
    spy.elementPowers = vi.fn(engine.elementPowers);
    expect(
      readElementReadout(engine, 7, {
        currents: new Float64Array([0, 0, 5]),
        voltages: new Float64Array([0, 0, 1.5]),
        powers: new Float64Array([0, 0, 7.5]),
      }),
    ).toEqual({ current: 5, voltage: 1.5, power: 7.5 });
    expect(spy.elementCurrents).toHaveBeenCalledTimes(0);
    expect(spy.elementVoltages).toHaveBeenCalledTimes(0);
    expect(spy.elementPowers).toHaveBeenCalledTimes(0);
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

  it('fetches the triple once per frame when the read serves hovered and selected', () => {
    // The hook's pump opens a frame per rAF and reads the selected element;
    // a frame that also reads the hovered element (what the canvas info box
    // does) must share the pump's single fetch. Two reads, one crossing each.
    const frames = stubFrames();
    const currents = [0, 0, 5, 9];
    const voltages = [0, 0, 1.5, 3];
    const powers = [0, 0, 7.5, 27];
    const engine = makeEngine(
      currents,
      voltages,
      powers,
      (id) => (id === 7 ? 2 : id === 8 ? 3 : undefined),
    );
    const spy = engine as unknown as {
      elementCurrents: ReturnType<typeof vi.fn>;
      elementVoltages: ReturnType<typeof vi.fn>;
      elementPowers: ReturnType<typeof vi.fn>;
    };
    spy.elementCurrents = vi.fn(engine.elementCurrents);
    spy.elementVoltages = vi.fn(engine.elementVoltages);
    spy.elementPowers = vi.fn(engine.elementPowers);
    let last: ElementReadout = {};
    const stop = tickReadout(
      () => {
        readElementReadout(engine, 7);
        last = readElementReadout(engine, 8);
        return last;
      },
      () => {},
    );
    frames.runNext();
    expect(last).toEqual({ current: 9, voltage: 3, power: 27 });
    expect(spy.elementCurrents).toHaveBeenCalledTimes(1);
    expect(spy.elementVoltages).toHaveBeenCalledTimes(1);
    expect(spy.elementPowers).toHaveBeenCalledTimes(1);
    stop();
  });
});
