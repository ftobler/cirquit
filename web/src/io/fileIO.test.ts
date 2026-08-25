import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveBlob } from './fileIO';

/** Node has no DOM anchor element, so document.createElement is stubbed and
 *  the fake records what the download link was given. */
function fakeAnchor() {
  const clicks = vi.fn();
  return { clicks, el: { href: '', download: '', click: clicks } };
}

describe('saveBlob', () => {
  let anchor: ReturnType<typeof fakeAnchor>;

  beforeEach(() => {
    vi.useFakeTimers();
    anchor = fakeAnchor();
    let nextUrl = 0;
    vi.stubGlobal('document', { createElement: () => anchor.el });
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:url-${nextUrl++}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('downloads through an anchor carrying the filename and the object URL', () => {
    saveBlob('circuit.txt', new Blob(['x']));
    expect(anchor.clicks).toHaveBeenCalledTimes(1);
    expect(anchor.el.download).toBe('circuit.txt');
    expect(anchor.el.href).toMatch(/^blob:/);
  });

  it('revokes the object URL asynchronously, not inside the click block', () => {
    saveBlob('circuit.txt', new Blob(['x']));
    // Safari cancels a download whose URL is revoked before the click's
    // download task consumes it, so the revoke must not have happened yet.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(anchor.el.href);
  });
});
