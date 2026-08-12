import { describe, expect, it } from 'vitest';
import {
  clearSampleCache,
  getAudioSamples,
  getDataSamples,
  modelJsonFor,
  nextFileNum,
  setAudioSamples,
  setDataSamples,
} from './sampleCache';
import type { CircuitElement } from './types';

const el = (kind: string, fileNum: number): CircuitElement =>
  ({ id: 1, kind, x1: 0, y1: 0, x2: 32, y2: 0, flags: 0, params: { fileNum } }) as CircuitElement;

describe('sample cache', () => {
  it('assigns monotonic file numbers starting at 1', () => {
    clearSampleCache();
    expect(nextFileNum()).toBe(1);
    expect(nextFileNum()).toBe(2);
    // 0 is reserved for "no file loaded", so a fresh part never collides.
    expect(nextFileNum()).toBeGreaterThan(0);
  });

  it('round-trips audio and data entries by file number', () => {
    clearSampleCache();
    setAudioSamples(7, [0.5, 1.0], 8000);
    expect(getAudioSamples(7)).toEqual({ samples: [0.5, 1.0], samplingRate: 8000 });
    setDataSamples(9, [2.0, 4.0]);
    expect(getDataSamples(9)).toEqual({ samples: [2.0, 4.0] });
  });

  it('clearSampleCache empties every entry', () => {
    clearSampleCache();
    setAudioSamples(1, [0.5], 8000);
    setDataSamples(2, [2.0]);
    clearSampleCache();
    expect(getAudioSamples(1)).toBeUndefined();
    expect(getDataSamples(2)).toBeUndefined();
  });

  it('modelJsonFor resolves the payload for the two sample kinds by fileNum', () => {
    clearSampleCache();
    setAudioSamples(3, [0.5, 1.0], 8000);
    expect(modelJsonFor(el('audioInput', 3))).toBe(
      JSON.stringify({ samples: [0.5, 1.0], samplingRate: 8000 }),
    );
    setDataSamples(4, [2.0]);
    expect(modelJsonFor(el('dataInput', 4))).toBe(JSON.stringify({ samples: [2.0] }));
  });

  it('modelJsonFor returns null for other kinds and unknown file numbers', () => {
    clearSampleCache();
    expect(modelJsonFor(el('resistor', 3))).toBeNull();
    expect(modelJsonFor(el('audioInput', 99))).toBeNull();
    expect(modelJsonFor(el('dataInput', 99))).toBeNull();
  });
});
