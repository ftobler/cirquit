import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type SimSettings } from '../model/types';
import {
  APP_PREF_KEYS,
  APP_PREF_STORAGE_KEY,
  loadAppPrefs,
  saveAppPrefs,
  type StorageLike,
} from './appPrefs';

/** A plain-object storage, injected so the module never touches the real DOM
 *  localStorage under the node test environment. */
const fakeStorage = () => {
  const map = new Map<string, string>();
  return {
    storage: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    } as StorageLike,
    raw: () => map.get(APP_PREF_STORAGE_KEY),
  };
};

describe('app prefs', () => {
  it('round-trips exactly the app-pref keys and never the circuit keys', () => {
    const { storage, raw } = fakeStorage();
    const settings: SimSettings = {
      ...DEFAULT_SETTINGS,
      positiveColor: '#123456',
      wheelSensitivity: 2,
      // Circuit keys must not leak into the stored blob.
      autoDC: true,
      timeStep: 1e-6,
    };
    saveAppPrefs(settings, storage);

    const blob = JSON.parse(raw() ?? '{}') as Record<string, unknown>;
    expect(blob.positiveColor).toBe('#123456');
    expect(blob.wheelSensitivity).toBe(2);
    expect('autoDC' in blob).toBe(false);
    expect('timeStep' in blob).toBe(false);
    // Every stored key is one the plan declared a pref.
    for (const key of Object.keys(blob)) {
      expect(APP_PREF_KEYS).toContain(key);
    }

    const back = loadAppPrefs(storage);
    expect(back).toEqual({
      showCrosshair: false,
      euroResistors: true,
      euroGates: true,
      positiveColor: '#123456',
      negativeColor: null,
      neutralColor: null,
      selectionColor: null,
      currentColor: null,
      valueFontSize: 12,
      shortDecimalDigits: 1,
      decimalDigits: 3,
      wheelSensitivity: 2,
    });
    // Every key that comes back is one the plan declared an app pref.
    expect(Object.keys(back).sort()).toEqual([...APP_PREF_KEYS].sort());
  });

  it('round-trips the euroResistors symbol toggle as a boolean', () => {
    const { storage } = fakeStorage();
    saveAppPrefs({ ...DEFAULT_SETTINGS, euroResistors: false }, storage);
    expect(loadAppPrefs(storage).euroResistors).toBe(false);
    // A wrong-typed stored value is dropped like any other invalid pref.
    storage.setItem(APP_PREF_STORAGE_KEY, JSON.stringify({ euroResistors: 'yes' }));
    expect(loadAppPrefs(storage).euroResistors).toBeUndefined();
  });

  it('round-trips the euroGates symbol toggle as a boolean', () => {
    const { storage } = fakeStorage();
    saveAppPrefs({ ...DEFAULT_SETTINGS, euroGates: false }, storage);
    expect(loadAppPrefs(storage).euroGates).toBe(false);
    // A wrong-typed stored value is dropped like any other invalid pref.
    storage.setItem(APP_PREF_STORAGE_KEY, JSON.stringify({ euroGates: 1 }));
    expect(loadAppPrefs(storage).euroGates).toBeUndefined();
  });

  it('a corrupt blob is a fallback, not a crash', () => {
    const { storage } = fakeStorage();
    storage.setItem(APP_PREF_STORAGE_KEY, '{not json');
    expect(() => loadAppPrefs(storage)).not.toThrow();
    expect(loadAppPrefs(storage)).toEqual({});
  });

  it('drops unknown or wrong-shaped stored keys', () => {
    const { storage } = fakeStorage();
    // A stored timestep must not override the default, and a scalar blob is
    // not an object at all.
    storage.setItem(APP_PREF_STORAGE_KEY, JSON.stringify({ timeStep: 999, valueFontSize: 14 }));
    expect(loadAppPrefs(storage)).toEqual({ valueFontSize: 14 });

    storage.setItem(APP_PREF_STORAGE_KEY, JSON.stringify('a string'));
    expect(loadAppPrefs(storage)).toEqual({});
  });

  it('drops parseable-but-invalid values so they can never reach toFixed', () => {
    const { storage } = fakeStorage();
    // A negative digit count would make formatValue's toFixed(-5) throw
    // RangeError; a string digit count and an out-of-range font size are just
    // as unusable. Each must fall back to the default, not merge in.
    storage.setItem(
      APP_PREF_STORAGE_KEY,
      JSON.stringify({
        decimalDigits: -5,
        shortDecimalDigits: 'abc',
        wheelSensitivity: '2', // a numeric string, not a number
        valueFontSize: 999,
        showCrosshair: 'true',
        positiveColor: 12345,
      }),
    );
    expect(loadAppPrefs(storage)).toEqual({});
  });

  it('keeps in-range values and a null colour', () => {
    const { storage } = fakeStorage();
    storage.setItem(
      APP_PREF_STORAGE_KEY,
      JSON.stringify({
        decimalDigits: 4,
        wheelSensitivity: 0.5,
        negativeColor: null, // null means the theme default, and stays
      }),
    );
    expect(loadAppPrefs(storage)).toEqual({ decimalDigits: 4, wheelSensitivity: 0.5, negativeColor: null });
  });

  it('a missing blob and a missing storage both yield the defaults', () => {
    const { storage } = fakeStorage();
    expect(loadAppPrefs(storage)).toEqual({});
    expect(loadAppPrefs(undefined)).toEqual({});
  });

  it('saveAppPrefs is quiet when the storage throws', () => {
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    } as StorageLike;
    expect(() => saveAppPrefs({ ...DEFAULT_SETTINGS }, throwing)).not.toThrow();
    expect(() => saveAppPrefs({ ...DEFAULT_SETTINGS }, undefined)).not.toThrow();
  });
});
