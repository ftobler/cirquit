/**
 * The audio-input file decode (AudioInputElm.java:181-197): a WebAudio
 * context decodes an ArrayBuffer and the first channel becomes the element's
 * sample buffer. Pure and DOM-free so it is testable headlessly; the caller
 * supplies the context factory, so the suite can substitute a fake and pin the
 * failure paths without an audio stack.
 */

export interface AudioDecoded {
  /** The first channel's samples, in file order, when the decode succeeded. */
  samples: number[];
  /** The decoding context's sample rate, only meaningful on success. */
  samplingRate: number;
  /** The reason loading must fail, or null when `samples` is usable. */
  error: string | null;
}

/** The sliver of the WebAudio API the decode path touches. */
export interface AudioContextLike {
  readonly sampleRate: number;
  decodeAudioData(buffer: ArrayBuffer): Promise<{ getChannelData(channel: number): Float32Array }>;
  close(): Promise<void>;
}

/** The user-facing message on any audio load failure (read, constructor or
 *  decode). The data-file path alerts on its own "Expected format" message;
 *  audio has no equivalent format to describe, so it gets a plain error. */
export const AUDIO_DECODE_ERROR = 'Error decoding audio data.\nPlease choose a valid audio file.';

/**
 * Decodes an audio buffer into the first channel's samples. Never throws and
 * never leaves an unhandled rejection: a throwing constructor or a failed
 * decode resolve to the error state, and the best-effort `close()` is
 * swallowed on both paths, so the FileReader `onload` that calls this cannot
 * escape.
 */
export async function decodeAudioFile(
  buffer: ArrayBuffer,
  createContext: () => AudioContextLike,
): Promise<AudioDecoded> {
  let context: AudioContextLike;
  try {
    context = createContext();
  } catch {
    return { samples: [], samplingRate: 0, error: AUDIO_DECODE_ERROR };
  }
  const decoded = await context.decodeAudioData(buffer).catch(() => null);
  if (decoded === null) {
    closeSafely(context);
    return { samples: [], samplingRate: 0, error: AUDIO_DECODE_ERROR };
  }
  closeSafely(context);
  return {
    samples: Array.from(decoded.getChannelData(0)),
    samplingRate: context.sampleRate,
    error: null,
  };
}

/** Best-effort cleanup: nothing useful to surface, so a rejected close() is
 *  swallowed, and a synchronous throw is contained too. */
function closeSafely(context: AudioContextLike): void {
  try {
    context.close().catch(() => {});
  } catch {
    // ignore
  }
}
