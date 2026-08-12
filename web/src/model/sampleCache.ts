/**
 * Session cache for the audio/data input sample buffers.
 *
 * The samples an audio or data input plays cannot ride the element: the
 * clipboard holds netlist text, so a copied part can only carry the `fileNum`
 * that keys its samples, exactly like upstream's static `fileNum`-keyed maps
 * (AudioInputElm.java:48-50, DataInputElm.java:46-47). The cache is
 * module-level session state: it never enters the store or the undo Snapshot,
 * and a fresh `fileNum` is assigned on every file load, never reused, so an
 * undo of a load restores the old number whose entry still holds the old
 * samples.
 *
 * Only a circuit load or New clears the cache (upstream clears both maps in
 * CircuitLoader.java:239-240); loading a sample file into an element never
 * deletes the old entry, which is what undo needs.
 */

import type { CircuitElement } from './types';

export interface AudioSamples {
  samples: number[];
  samplingRate: number;
}

export interface DataSamples {
  samples: number[];
}

/** Monotonic, never resets, starts at 1: `0` always means "no file loaded",
 *  exactly as upstream's `fileNum == 0` means no data (AudioInputElm.java:79). */
let fileNumCounter = 1;

const audioCache = new Map<number, AudioSamples>();
const dataCache = new Map<number, DataSamples>();

export function nextFileNum(): number {
  return fileNumCounter++;
}

export function setAudioSamples(fileNum: number, samples: number[], samplingRate: number): void {
  audioCache.set(fileNum, { samples, samplingRate });
}

export function setDataSamples(fileNum: number, samples: number[]): void {
  dataCache.set(fileNum, { samples });
}

export function getAudioSamples(fileNum: number): AudioSamples | undefined {
  return audioCache.get(fileNum);
}

export function getDataSamples(fileNum: number): DataSamples | undefined {
  return dataCache.get(fileNum);
}

/** Drops every entry; called by `loadNetlist` and `newCircuit`. */
export function clearSampleCache(): void {
  audioCache.clear();
  dataCache.clear();
}

/**
 * The `spec.model` payload an audio or data input hands the engine, looked up
 * by the element's `fileNum`. Null when the kind is not one of the two sample
 * sources, or the number has no cache entry (a fresh part, or a loaded file
 * whose samples were never re-imported this session). The engine parses this
 * JSON directly (audio_input.rs / data_input.rs), the same string carrier the
 * custom-logic model uses, so no extra kind check crosses the engine boundary.
 */
export function modelJsonFor(e: CircuitElement): string | null {
  const fileNum = e.params.fileNum;
  if (!Number.isFinite(fileNum)) return null;
  if (e.kind === 'audioInput') {
    const entry = audioCache.get(fileNum);
    if (entry === undefined) return null;
    return JSON.stringify({ samples: entry.samples, samplingRate: entry.samplingRate });
  }
  if (e.kind === 'dataInput') {
    const entry = dataCache.get(fileNum);
    if (entry === undefined) return null;
    return JSON.stringify({ samples: entry.samples });
  }
  return null;
}
