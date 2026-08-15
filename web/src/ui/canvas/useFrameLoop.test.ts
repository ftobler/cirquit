import { describe, expect, it } from 'vitest';
import { buildReport, frameSafely } from './useFrameLoop';

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
