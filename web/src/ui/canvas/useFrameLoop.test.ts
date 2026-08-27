import { describe, expect, it } from 'vitest';
import type { SimEngine } from '../../engine/simulator';
import { DEFAULT_SETTINGS, type Point } from '../../model/types';
import type { Drag } from './useCanvasInteractions';
import { backingStoreSize } from './backingStoreSize';
import {
  buildReport,
  frameSafely,
  paintedSelection,
  paintedSet,
  scopeDrawPayload,
} from './useFrameLoop';

describe('backingStoreSize', () => {
  it('rounds once so a fractional dpr settles against an odd CSS width', () => {
    // 967 x 1.5 is 1450.5: comparing the stored integer attribute against the
    // raw product never agrees, so the bitmap was reallocated and cleared
    // every frame of the session. The rounded value is exactly what the
    // attribute holds after assignment, so the next frame's compare settles.
    const first = backingStoreSize(967, 553, 1.5);
    expect(first.width).toBe(Math.round(967 * 1.5));
    expect(Number.isInteger(first.width)).toBe(true);
    expect(Number.isInteger(first.height)).toBe(true);
    // The compare-and-assign cycle is stable: recomputing for the same CSS
    // size and dpr returns what is already stored.
    expect(backingStoreSize(967, 553, 1.5)).toEqual(first);
  });

  it('is stable across the common scaling factors and browser zoom steps', () => {
    // 1.25 and 1.5 are the common Windows/Linux scalings; ~1.1 is a typical
    // browser zoom product. None may leave a fractional target behind.
    const cases: [number, number, number][] = [
      [1281, 721, 1.1],
      [1921, 1081, 1.25],
      [1441, 901, 1.5],
      [1000, 500, 1],
      [800, 600, 2],
    ];
    for (const [w, h, dpr] of cases) {
      const s = backingStoreSize(w, h, dpr);
      expect(Number.isInteger(s.width)).toBe(true);
      expect(Number.isInteger(s.height)).toBe(true);
      expect(backingStoreSize(w, h, dpr)).toEqual(s);
    }
  });

  it('keeps the exact doubling at integral dpr', () => {
    expect(backingStoreSize(800, 600, 2)).toEqual({ width: 1600, height: 1200 });
    expect(backingStoreSize(800, 600, 1)).toEqual({ width: 800, height: 600 });
  });
});

describe('frameSafely', () => {
  it('reports a throw instead of letting it escape the loop', () => {
    const reported: string[] = [];
    expect(() =>
      frameSafely(
        () => {
          throw new Error('draw bug');
        },
        (message) => reported.push(message),
      ),
    ).not.toThrow();
    expect(reported).toEqual(['draw bug']);
  });

  it('converts a non-Error throw into a string report', () => {
    const reported: string[] = [];
    frameSafely(
      () => {
        throw 'string boom';
      },
      (message) => reported.push(message),
    );
    expect(reported).toEqual(['string boom']);
  });

  it('runs the body to completion when it does not throw', () => {
    const calls: string[] = [];
    frameSafely(
      () => calls.push('body'),
      () => calls.push('report'),
    );
    expect(calls).toEqual(['body']);
  });
});

describe('buildReport', () => {
  // The two the engine can raise on its own, both of which it has already
  // handled by the time it says so (circuit.rs:601, circuit.rs:989).
  const NO_GROUND = 'No ground symbol: the first node was used as the voltage reference.';
  const FLOATING =
    '1 floating node(s) have no path to ground; they were pinned with a 100 MΩ resistance.';

  it('sends the engine warnings to the notice, leaving the banner empty', () => {
    expect(buildReport(null, [NO_GROUND, FLOATING], null)).toEqual({
      problem: null,
      notice: `${NO_GROUND} ${FLOATING}`,
    });
  });

  it('keeps the load-time message on the banner, beside the flashed warnings', () => {
    expect(buildReport(null, [NO_GROUND], 'missing')).toEqual({
      problem: 'missing',
      notice: NO_GROUND,
    });
  });

  it('a build error goes to the banner, and its warnings are dropped', () => {
    // The warnings would describe a circuit that never came up.
    expect(buildReport('matrix is singular', [NO_GROUND], null)).toEqual({
      problem: 'matrix is singular',
      notice: null,
    });
  });

  it('reports nothing on either channel for a clean build', () => {
    expect(buildReport(null, [], null)).toEqual({ problem: null, notice: null });
  });
});

describe('scopeDrawPayload', () => {
  it('reads the engine clock exactly once per payload build', () => {
    // `time` is a wasm crossing, so the getter here counts accesses: one
    // build must mean one read, which is what lets the frame loop hoist the
    // payload above the element loop and share it by reference.
    let reads = 0;
    const engine = {
      get time() {
        reads += 1;
        return 0.0025;
      },
    } as unknown as SimEngine;
    const payload = scopeDrawPayload(engine, DEFAULT_SETTINGS, true);
    expect(reads).toBe(1);
    expect(payload).toMatchObject({
      source: engine,
      simTime: 0.0025,
      timeStep: DEFAULT_SETTINGS.timeStep,
      dark: true,
      decimalDigits: DEFAULT_SETTINGS.decimalDigits,
    });
    expect(payload?.themeColors).toBe(DEFAULT_SETTINGS);
  });

  it('builds nothing without an engine, touching no clock', () => {
    expect(scopeDrawPayload(null, DEFAULT_SETTINGS, false)).toBeUndefined();
  });
});

describe('paintedSelection', () => {
  const at = (x: number, y: number): Point => ({ x, y });

  it('a move drag paints its frozen ids even when the live selection moved on', () => {
    // stepMoveDrag translates the group frozen at pointer-down, so a select
    // landing mid-gesture must not pull the highlight or the move handles
    // onto elements the drag is not carrying.
    const drag: Drag = { mode: 'move', ids: [1, 2], last: at(0, 0), moved: true };
    expect(paintedSelection(drag, [3])).toEqual([1, 2]);
  });

  it('with no move armed the frame paints the live selection', () => {
    expect(paintedSelection({ mode: 'none' }, [3])).toEqual([3]);
    expect(
      paintedSelection(
        { mode: 'rowcol', axis: 'col', captured: [], last: at(0, 0) },
        [3],
      ),
    ).toEqual([3]);
  });
});

describe('paintedSet', () => {
  // The draw loop tests selection through a Set so each element's membership
  // is O(1); the Set must agree with paintedSelection exactly, or the
  // highlight and move handles would split from the painted list.
  it('a move drag paints its frozen ids as a set', () => {
    const drag: Drag = { mode: 'move', ids: [1, 2], last: { x: 0, y: 0 }, moved: true };
    expect(paintedSet(drag, [3])).toEqual(new Set([1, 2]));
    expect(paintedSet(drag, [3]).has(1)).toBe(true);
    expect(paintedSet(drag, [3]).has(3)).toBe(false);
  });

  it('with no move armed the set holds the live selection', () => {
    expect(paintedSet({ mode: 'none' }, [3, 7])).toEqual(new Set([3, 7]));
    expect(paintedSet({ mode: 'none' }, [3, 7]).has(7)).toBe(true);
    expect(paintedSet({ mode: 'none' }, [3, 7]).size).toBe(2);
  });
});
