import { describe, expect, it } from 'vitest';
import { AUDIO_DECODE_ERROR, decodeAudioFile, type AudioContextLike } from './audioFile';

const SAMPLES = new Float32Array([0.25, -0.5, 1]);

function okContext(close: () => Promise<void> = () => Promise.resolve()): AudioContextLike {
  return {
    sampleRate: 8000,
    decodeAudioData: async () => ({
      getChannelData: (channel: number) => (channel === 0 ? SAMPLES : new Float32Array(0)),
    }),
    close,
  };
}

/** Runs `fn` with an unhandled-rejection listener attached and returns what it
 *  caught after a macrotask flush, the point at which node reports one. */
async function caughtUnhandledRejections(fn: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', listener);
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    process.off('unhandledRejection', listener);
  }
  return unhandled;
}

describe('decodeAudioFile', () => {
  it('decodes the first channel and reports the context sample rate', async () => {
    const decoded = await decodeAudioFile(new ArrayBuffer(8), () => okContext());
    expect(decoded.error).toBeNull();
    expect(decoded.samples).toEqual([0.25, -0.5, 1]);
    expect(decoded.samplingRate).toBe(8000);
  });

  it('turns a throwing AudioContext constructor into the error state', async () => {
    const decoded = await decodeAudioFile(new ArrayBuffer(8), () => {
      throw new Error('no audio hardware');
    });
    expect(decoded.error).toBe(AUDIO_DECODE_ERROR);
    expect(decoded.samples).toEqual([]);
  });

  it('turns a rejected decode into the error state and still closes the context', async () => {
    let closed = false;
    const ctx: AudioContextLike = {
      sampleRate: 8000,
      decodeAudioData: () => Promise.reject(new Error('bad audio buffer')),
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    };
    const decoded = await decodeAudioFile(new ArrayBuffer(8), () => ctx);
    expect(decoded.error).toBe(AUDIO_DECODE_ERROR);
    expect(closed).toBe(true);
  });

  it('swallows a rejected close() on success without an unhandled rejection', async () => {
    const unhandled = await caughtUnhandledRejections(async () => {
      const decoded = await decodeAudioFile(new ArrayBuffer(8), () =>
        okContext(() => Promise.reject(new Error('close failed'))),
      );
      expect(decoded.error).toBeNull();
      expect(decoded.samples).toEqual([0.25, -0.5, 1]);
      expect(decoded.samplingRate).toBe(8000);
    });
    expect(unhandled).toEqual([]);
  });

  it('swallows a rejected close() on a failed decode without an unhandled rejection', async () => {
    let closed = 0;
    const ctx: AudioContextLike = {
      sampleRate: 8000,
      decodeAudioData: () => Promise.reject(new Error('bad audio buffer')),
      close: () => {
        closed++;
        return Promise.reject(new Error('close failed'));
      },
    };
    const unhandled = await caughtUnhandledRejections(async () => {
      const decoded = await decodeAudioFile(new ArrayBuffer(8), () => ctx);
      expect(decoded.error).toBe(AUDIO_DECODE_ERROR);
    });
    expect(closed).toBe(1);
    expect(unhandled).toEqual([]);
  });

  it('contains a synchronous close() throw', async () => {
    const decoded = await decodeAudioFile(new ArrayBuffer(8), () =>
      okContext(() => {
        throw new Error('close exploded');
      }),
    );
    expect(decoded.error).toBeNull();
    expect(decoded.samples).toEqual([0.25, -0.5, 1]);
  });
});
