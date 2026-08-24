import { describe, expect, it } from 'vitest';
import { runFullScreenToggle, toggleFullScreen, type FullScreenDocument } from './fullscreen';

/** A stand-in for `document`: jsdom/node implements none of the Fullscreen
 *  API, so the tests inject this, watch the calls and dispatch the transition
 *  events by hand. */
const fakeDoc = (fullscreenElement: Element | null = null) => {
  const calls: string[] = [];
  const listeners = new Map<string, Set<() => void>>();
  const doc: FullScreenDocument = {
    fullscreenElement,
    documentElement: { requestFullscreen: () => void calls.push('request') },
    exitFullscreen: () => void calls.push('exit'),
    addEventListener: (type, fn) => {
      const set = listeners.get(type) ?? new Set<() => void>();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener: (type, fn) => void listeners.get(type)?.delete(fn),
  };
  return {
    doc,
    calls,
    /** Simulate the browser dispatching a fullscreen lifecycle event. */
    fire: (type: string) => void [...(listeners.get(type) ?? [])].forEach((fn) => fn()),
    listenerCount: (type: string) => (listeners.get(type) ?? new Set()).size,
  };
};

describe('toggleFullScreen', () => {
  it('a windowed document enters full screen through the document element', () => {
    const { doc, calls } = fakeDoc(null);
    expect(toggleFullScreen(doc)).toBe(true);
    expect(calls).toEqual(['request']);
  });

  it('a full-screen document leaves it, without requesting again', () => {
    const { doc, calls } = fakeDoc({} as Element);
    expect(toggleFullScreen(doc)).toBe(false);
    expect(calls).toEqual(['exit']);
  });

  it('the state is read per call, never cached', () => {
    // Upstream mirrors a static flag around the request calls; reading
    // document.fullscreenElement instead means repeated toggles flip honestly
    // even if something else changed the state behind our back.
    let el: Element | null = null;
    const doc: FullScreenDocument = {
      get fullscreenElement() {
        return el;
      },
      documentElement: { requestFullscreen: () => void (el = {} as Element) },
      exitFullscreen: () => void (el = null),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    expect(toggleFullScreen(doc)).toBe(true);
    expect(toggleFullScreen(doc)).toBe(false);
    expect(toggleFullScreen(doc)).toBe(true);
  });

  it('an engine without the unprefixed APIs degrades to a no-op, not a throw', () => {
    const windowed: FullScreenDocument = {
      fullscreenElement: null,
      documentElement: {},
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    // The intent is still reported honestly, but nothing throws and no call
    // happens; the same holds for leaving from a document stuck full screen.
    expect(toggleFullScreen(windowed)).toBe(true);
    const fullscreen: FullScreenDocument = { ...windowed, fullscreenElement: {} as Element };
    expect(toggleFullScreen(fullscreen)).toBe(false);
  });

  it('a rejected request is swallowed, never an unhandled rejection', async () => {
    const doc: FullScreenDocument = {
      fullscreenElement: null,
      documentElement: { requestFullscreen: () => Promise.reject(new Error('denied')) },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    expect(toggleFullScreen(doc)).toBe(true);
    // Let the rejected promise settle; vitest fails the suite on an unhandled
    // rejection, so reaching this line with a quiet console is the assertion.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('runFullScreenToggle', () => {
  it('centers now and refits once when the entering transition lands', () => {
    // The immediate fit runs against the windowed viewport, so the transition
    // itself must trigger a second one; a third dispatch finds no listener.
    const { doc, calls, fire } = fakeDoc(null);
    expect(runFullScreenToggle(doc, () => void calls.push('center'))).toBe(true);
    expect(calls).toEqual(['request', 'center']);
    fire('fullscreenchange');
    expect(calls).toEqual(['request', 'center', 'center']);
    fire('fullscreenchange');
    expect(calls).toEqual(['request', 'center', 'center']);
  });

  it('refits after leaving too, upstream CommandManager.java:305-311 order', () => {
    const { doc, calls, fire } = fakeDoc({} as Element);
    expect(runFullScreenToggle(doc, () => void calls.push('center'))).toBe(false);
    expect(calls).toEqual(['exit', 'center']);
    fire('fullscreenchange');
    expect(calls).toEqual(['exit', 'center', 'center']);
  });

  it('a denied request cleans up through fullscreenerror and leaves no stray refit', () => {
    // Otherwise the one-shot listener would sit waiting and fire a spurious
    // center on some later manual F11.
    const { doc, calls, fire, listenerCount } = fakeDoc(null);
    runFullScreenToggle(doc, () => void calls.push('center'));
    fire('fullscreenerror');
    expect(calls).toEqual(['request', 'center', 'center']);
    expect(listenerCount('fullscreenchange')).toBe(0);
    expect(listenerCount('fullscreenerror')).toBe(0);
    fire('fullscreenchange');
    expect(calls).toEqual(['request', 'center', 'center']);
  });

  it('no browser call means no listener and a single fit', () => {
    const doc: FullScreenDocument = {
      fullscreenElement: null,
      documentElement: {},
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    const calls: string[] = [];
    expect(runFullScreenToggle(doc, () => void calls.push('center'))).toBe(true);
    expect(calls).toEqual(['center']);
  });
});
