import { describe, expect, it } from 'vitest';
import { runFullScreenToggle, toggleFullScreen, type FullScreenDocument } from './fullscreen';

/** A stand-in for `document`: jsdom/node implements none of the Fullscreen
 *  API, so the tests inject this and watch the calls. */
const fakeDoc = (fullscreenElement: Element | null = null) => {
  const calls: string[] = [];
  const doc = {
    fullscreenElement,
    documentElement: {
      requestFullscreen: () => void calls.push('request'),
    },
    exitFullscreen: () => void calls.push('exit'),
  };
  return { doc: doc as FullScreenDocument, calls };
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
    const doc = {
      get fullscreenElement() {
        return el;
      },
      documentElement: { requestFullscreen: () => void (el = {} as Element) },
      exitFullscreen: () => void (el = null),
    } as FullScreenDocument;
    expect(toggleFullScreen(doc)).toBe(true);
    expect(toggleFullScreen(doc)).toBe(false);
    expect(toggleFullScreen(doc)).toBe(true);
  });
});

describe('runFullScreenToggle', () => {
  it('re-centres the circuit after entering full screen', () => {
    const { doc, calls } = fakeDoc(null);
    expect(runFullScreenToggle(doc, () => void calls.push('center'))).toBe(true);
    expect(calls).toEqual(['request', 'center']);
  });

  it('re-centres after exiting too, upstream CommandManager.java:305-311 order', () => {
    const { doc, calls } = fakeDoc({} as Element);
    expect(runFullScreenToggle(doc, () => void calls.push('center'))).toBe(false);
    expect(calls).toEqual(['exit', 'center']);
  });
});
