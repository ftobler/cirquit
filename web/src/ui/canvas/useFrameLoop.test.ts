import { describe, expect, it } from 'vitest';
import { frameSafely } from './useFrameLoop';

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
