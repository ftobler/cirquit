import { describe, expect, it, beforeEach } from 'vitest';
import { useStore } from './store';
import { fresh } from './store.test-helpers';
import {
  clearSampleCache,
  getAudioSamples,
  getDataSamples,
  modelJsonFor,
} from '../model/sampleCache';

const audioInput = {
  kind: 'audioInput' as const,
  x1: 0,
  y1: 0,
  x2: 64,
  y2: 0,
  flags: 16,
  params: {
    waveform: 1,
    frequency: 60,
    maxVoltage: 5,
    bias: 0,
    phaseShift: 0,
    dutyCycle: 0.5,
    startPosition: 0,
    fileNum: 0,
  },
};

const dataInput = {
  kind: 'dataInput' as const,
  x1: 0,
  y1: 0,
  x2: 64,
  y2: 0,
  flags: 16,
  params: {
    waveform: 1,
    frequency: 60,
    maxVoltage: 5,
    bias: 0,
    phaseShift: 0,
    dutyCycle: 0.5,
    sampleLength: 1e-3,
    scaleFactor: 1,
    fileNum: 0,
  },
};

describe('audio and data file loads', () => {
  beforeEach(() => {
    useStore.setState(fresh());
    clearSampleCache();
  });

  it('loadAudioFile caches the samples and records the filename on the element', () => {
    const id = useStore.getState().addElement(audioInput);
    const before = useStore.getState();

    useStore.getState().loadAudioFile(id, [0.5, 1.0], 8000, 'mysong');

    const after = useStore.getState();
    const el = after.elements.find((e) => e.id === id)!;
    expect(el.params.fileNum).toBeGreaterThan(0);
    expect(el.text).toBe('mysong');
    expect(getAudioSamples(el.params.fileNum)).toEqual({
      samples: [0.5, 1.0],
      samplingRate: 8000,
    });
    // The load is a topology edit, so the engine reloads.
    expect(after.revision).toBe(before.revision + 1);
    // The payload the engine would receive on setCircuit carries the samples.
    expect(modelJsonFor(el)).toBe(JSON.stringify({ samples: [0.5, 1.0], samplingRate: 8000 }));
  });

  it('a fresh fileNum is assigned on every load, so undo restores the old samples', () => {
    const id = useStore.getState().addElement(audioInput);
    useStore.getState().loadAudioFile(id, [1.0], 8000, 'first');
    const fileNum1 = useStore.getState().elements.find((e) => e.id === id)!.params.fileNum;
    useStore.getState().commit();

    useStore.getState().loadAudioFile(id, [2.0], 8000, 'second');
    const fileNum2 = useStore.getState().elements.find((e) => e.id === id)!.params.fileNum;
    // Never reused, and the first entry survives the second load.
    expect(fileNum2).not.toBe(fileNum1);
    expect(getAudioSamples(fileNum1)).toEqual({ samples: [1.0], samplingRate: 8000 });
    expect(getAudioSamples(fileNum2)).toEqual({ samples: [2.0], samplingRate: 8000 });

    useStore.getState().undo();
    const el = useStore.getState().elements.find((e) => e.id === id)!;
    expect(el.params.fileNum).toBe(fileNum1);
    expect(el.text).toBe('first');
  });

  it('loadDataFile caches parsed values without a sampling rate', () => {
    const id = useStore.getState().addElement(dataInput);

    useStore.getState().loadDataFile(id, [2.0, 4.0], 'data');

    const el = useStore.getState().elements.find((e) => e.id === id)!;
    expect(el.text).toBe('data');
    expect(getDataSamples(el.params.fileNum)).toEqual({ samples: [2.0, 4.0] });
    expect(modelJsonFor(el)).toBe(JSON.stringify({ samples: [2.0, 4.0] }));
  });

  it('a circuit load clears the cache, so the new file resolves to no file', () => {
    const id = useStore.getState().addElement(audioInput);
    useStore.getState().loadAudioFile(id, [1.0], 8000, 'first');

    // Loading a new netlist is a fresh document: the previous file's buffers
    // go with it, so the audio element's fileNum resolves to nothing.
    useStore.getState().loadNetlist(
      '$ 0 5e-6 10 50 5 50 5e-11\n411 0 0 64 0 16 1 60 5 0 0 0.5 5 0 0\n',
    );
    const el = useStore.getState().elements[0];
    expect(el.kind).toBe('audioInput');
    expect(modelJsonFor(el)).toBeNull();
  });
});
