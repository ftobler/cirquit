import { describe, expect, it } from 'vitest';
import type { Scope } from '../engine/simulator';
import { SCOPE_DEFAULTS_STORAGE_KEY, loadScopeDefaults, saveScopeDefaults } from './scopeDefaults';
import type { StorageLike } from './appPrefs';

/** A minimal scope over the given overrides, with the fields `saveScopeDefaults`
 *  reads. */
const scopeOf = (overrides: Partial<Scope> = {}): Scope => ({
  id: 1,
  raw: null,
  plots: [],
  speed: 64,
  position: 0,
  manualScale: false,
  maxScale: false,
  label: '',
  manDivisions: 8,
  showScale: false,
  showMax: true,
  showMin: false,
  showP2P: false,
  showFreq: false,
  showRMS: false,
  showAverage: false,
  showDutyCycle: false,
  fftPlot: false,
  logSpectrum: false,
  plotXY: false,
  showPhaseAngle: false,
  trailPersistence: 0,
  showElmInfo: false,
  showI: true,
  showV: true,
  scaleV: 20,
  scaleA: 0.05,
  trigger: { mode: 'freeRun', edge: 'rising', level: 0 },
  ...overrides,
});

/** A plain-object storage, injected so the module never touches the real DOM
 *  localStorage under the node test environment. */
const fakeStorage = (): StorageLike => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
};

describe('scope defaults persistence', () => {
  it('round-trips the modelled flags, speed and trigger level', () => {
    const storage = fakeStorage();
    const scope = scopeOf({
      showV: true,
      showI: false,
      showMax: false,
      showFreq: true,
      showRMS: true,
      fftPlot: true,
      logSpectrum: true,
      showPhaseAngle: true,
      manualScale: true,
      maxScale: true,
      plotXY: true,
      showAverage: true,
      showDutyCycle: true,
      showScale: true,
      showMin: true,
      showP2P: true,
      showElmInfo: true,
      speed: 32,
      trigger: { mode: 'normal', edge: 'falling', level: 2.5 },
    });
    saveScopeDefaults(scope, storage);
    expect(loadScopeDefaults(storage)).toEqual({
      showI: false,
      showV: true,
      showMax: false,
      showMin: true,
      showScale: true,
      showP2P: true,
      showFreq: true,
      showRMS: true,
      showAverage: true,
      showDutyCycle: true,
      fftPlot: true,
      logSpectrum: true,
      plotXY: true,
      showPhaseAngle: true,
      manualScale: true,
      maxScale: true,
      showElmInfo: true,
      speed: 32,
      trigger: { level: 2.5 },
    });
  });

  it('the stored blob is one JSON entry under the scopeDefaults key', () => {
    const storage = fakeStorage();
    saveScopeDefaults(scopeOf({ showFreq: true, speed: 128 }), storage);
    // The default scope carries showI + showV, so the flag word is
    // 1 + 2 + 8 (showFreq) + FLAG_PLOTS.
    expect(storage.getItem(SCOPE_DEFAULTS_STORAGE_KEY)).toBe(
      JSON.stringify({ flags: 1 + 2 + 8 + 4096, speed: 128, level: 0 }),
    );
  });

  it('clamps an out-of-range speed on load like the load path', () => {
    const storage = fakeStorage();
    storage.setItem(
      SCOPE_DEFAULTS_STORAGE_KEY,
      JSON.stringify({ flags: 4098, speed: 5000, level: 0 }),
    );
    expect(loadScopeDefaults(storage)?.speed).toBe(1024);
  });

  it('a corrupt blob falls back to null, not a crash', () => {
    const storage = fakeStorage();
    storage.setItem(SCOPE_DEFAULTS_STORAGE_KEY, '{not json');
    expect(loadScopeDefaults(storage)).toBeNull();
    storage.setItem(SCOPE_DEFAULTS_STORAGE_KEY, '[]');
    expect(loadScopeDefaults(storage)).toBeNull();
    storage.setItem(SCOPE_DEFAULTS_STORAGE_KEY, 'null');
    expect(loadScopeDefaults(storage)).toBeNull();
    // A wrong-typed entry must not reach the flag decoder.
    storage.setItem(
      SCOPE_DEFAULTS_STORAGE_KEY,
      JSON.stringify({ flags: 'abc', speed: 64, level: 0 }),
    );
    expect(loadScopeDefaults(storage)).toBeNull();
    storage.setItem(
      SCOPE_DEFAULTS_STORAGE_KEY,
      JSON.stringify({ flags: 4098, speed: 64, level: '1.5' }),
    );
    expect(loadScopeDefaults(storage)).toBeNull();
  });

  it('a missing blob and a missing storage both yield null', () => {
    expect(loadScopeDefaults(fakeStorage())).toBeNull();
    expect(loadScopeDefaults(undefined)).toBeNull();
  });

  it('save is quiet when the storage throws', () => {
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    } as StorageLike;
    expect(() => saveScopeDefaults(scopeOf(), throwing)).not.toThrow();
    expect(() => saveScopeDefaults(scopeOf(), undefined)).not.toThrow();
  });
});
