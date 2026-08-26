import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatReadFailure, openCircuit, readChosenFile, saveBlob } from './fileIO';

/** Node has no DOM anchor element, so document.createElement is stubbed and
 *  the fake records what the download link was given. */
function fakeAnchor() {
  const clicks = vi.fn();
  return { clicks, el: { href: '', download: '', click: clicks } };
}

describe('formatReadFailure', () => {
  it('names the file and the cause', () => {
    expect(formatReadFailure('amp.txt', new Error('disk gone'))).toBe(
      'Could not read "amp.txt": disk gone',
    );
    // A rejection need not carry an Error; a bare string still gets a
    // readable cause instead of "[object Object]".
    expect(formatReadFailure('amp.txt', 'nope')).toBe('Could not read "amp.txt": nope');
  });
});

describe('readChosenFile', () => {
  it('routes a rejected read to onError, not an unhandled rejection', async () => {
    // file.text() can reject (a drive pulled mid-read, a permission change);
    // the promise must be observed here rather than escaping into the window
    // as an unhandled rejection with a silent UI.
    const onLoad = vi.fn();
    const onError = vi.fn();
    await readChosenFile({ name: 'amp.txt', text: () => Promise.reject(new Error('boom')) }, onLoad, onError);
    expect(onLoad).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('Could not read "amp.txt": boom');
  });

  it('hands resolved text and the name to onLoad', async () => {
    const onLoad = vi.fn();
    const onError = vi.fn();
    await readChosenFile({ name: 'amp.txt', text: () => Promise.resolve('r 1 1') }, onLoad, onError);
    expect(onLoad).toHaveBeenCalledWith('r 1 1', 'amp.txt');
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('openCircuit', () => {
  /** A stand-in for the created picker input: openCircuit drives it purely
   *  through its properties, so no DOM is needed. */
  function stubPicker(file: { name: string; text: () => Promise<string> } | undefined) {
    const input = {
      type: '',
      accept: '',
      value: 'previous choice',
      files: file === undefined ? null : [file],
      onchange: null as (() => Promise<void>) | null,
      click: vi.fn(),
    };
    vi.stubGlobal('document', { createElement: () => input });
    return input;
  }

  afterEach(() => vi.unstubAllGlobals());

  it('clears the picker value after a failed read, so choosing the file again retries', async () => {
    const input = stubPicker({ name: 'amp.txt', text: () => Promise.reject(new Error('boom')) });
    const onError = vi.fn();
    openCircuit(vi.fn(), onError);
    await input.onchange?.();
    expect(onError).toHaveBeenCalledOnce();
    expect(input.value).toBe('');
  });

  it('clears the picker value after a successful load too, and passes the notice channel through', async () => {
    const input = stubPicker({ name: 'amp.txt', text: () => Promise.resolve('$ 0\nr 1 1\n') });
    const onLoad = vi.fn();
    openCircuit(onLoad, vi.fn());
    await input.onchange?.();
    expect(onLoad).toHaveBeenCalledWith('$ 0\nr 1 1\n', 'amp.txt');
    expect(input.value).toBe('');
  });

  it('leaves nothing to observe when the picker is cancelled', async () => {
    const input = stubPicker(undefined);
    const onLoad = vi.fn();
    openCircuit(onLoad, vi.fn());
    await input.onchange?.();
    expect(onLoad).not.toHaveBeenCalled();
    expect(input.click).toHaveBeenCalledTimes(1);
  });
});

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
