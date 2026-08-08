import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { SimEngine } from '../engine/simulator';
import { DEFAULT_SETTINGS } from '../model/types';
import { parseCircuit } from './netlist';
import {
  DIAGNOSED_SIM_FAILURES,
  generateReport,
  plainLoad,
  scanCorpus,
  simulate,
  type CorpusEntry,
} from './corpus';

const CIRCUITS_DIR = fileURLToPath(new URL('../../public/circuits', import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL('./__fixtures__', import.meta.url));
const GOLDEN_PATH = fileURLToPath(new URL('./corpus-report.json', import.meta.url));

function loadGolden(): CorpusEntry[] {
  return JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as CorpusEntry[];
}

function goldenByFile(): Map<string, CorpusEntry> {
  return new Map(loadGolden().map((e) => [e.file, e]));
}

describe('corpus stage 1: load', () => {
  it('every plain file loads, and files the golden report marks ok stay ok', () => {
    const golden = goldenByFile();
    const scanned = scanCorpus(CIRCUITS_DIR);
    expect(scanned.length).toBe(golden.size);

    const xml = scanned.filter((e) => e.format === 'xml');
    expect(xml.length).toBeGreaterThan(0);
    for (const entry of xml) {
      expect(golden.get(entry.file)?.format, entry.file).toBe('xml');
    }

    // No regression: a file that passed must keep passing. Files the golden
    // report already marks failing may stay failing until the kinds land.
    for (const entry of scanned) {
      const g = golden.get(entry.file);
      expect(g, `no golden entry for ${entry.file}`).toBeDefined();
      if (g?.format === 'xml') continue;
      if (g?.load !== 'ok') continue;
      expect(entry.load, entry.file).toBe('ok');
    }
  });
});

describe('wasm in vitest', () => {
  it('SimEngine.create resolves and the starter RC runs with finite outputs', async () => {
    const engine = await SimEngine.create();
    const text = readFileSync(join(FIXTURES_DIR, 'rc.txt'), 'utf8');
    const { elements, settings } = parseCircuit(text);
    expect(engine.setCircuit(elements, { ...DEFAULT_SETTINGS, ...settings }, [])).toBeNull();
    const stats = engine.run(1);
    expect(stats.converged).toBe(true);
    const voltages = [...engine.nodeVoltages()];
    expect(voltages.length).toBeGreaterThan(0);
    expect(voltages.every(Number.isFinite)).toBe(true);
  });
});

describe('corpus fixtures', () => {
  it('scans a clean RC as load ok and simulates to finite outputs', async () => {
    const engine = await SimEngine.create();
    const entries = scanCorpus(FIXTURES_DIR);
    const rc = entries.find((e) => e.file === 'rc.txt');
    expect(rc?.load).toBe('ok');
    expect(rc?.missing).toEqual([]);

    const text = readFileSync(join(FIXTURES_DIR, 'rc.txt'), 'utf8');
    const result = simulate(engine, text);
    expect(result.error).toBeUndefined();
    expect(result.finite).toBe(true);
  });

  it('reports an upstream dump code as missing but keeps the slider out of missing', () => {
    const entries = scanCorpus(FIXTURES_DIR);
    const slider = entries.find((e) => e.file === 'slider-unknown.txt');
    expect(slider?.load).toBe('missing');
    expect(slider?.missing).toEqual(['170']);
    expect(slider?.sliderLines).toBe(1);

    const parsed = parseCircuit(readFileSync(join(FIXTURES_DIR, 'slider-unknown.txt'), 'utf8'));
    // The slider parses into state; only the `170` sweep element is missing.
    expect(parsed.unsupported).not.toContain('38');
    expect(parsed.sliders).toHaveLength(1);
    // It points at the unread `170` line, so it binds to nothing but still
    // round-trips.
    expect(parsed.sliders[0].elementId).toBeUndefined();
    const { missing, sliderLines } = plainLoad(parsed);
    expect(missing).toEqual(['170']);
    expect(sliderLines).toBe(1);
  });

  it('classifies the xml fixture by its `<cir ` root', () => {
    const entries = scanCorpus(FIXTURES_DIR);
    const xml = entries.find((e) => e.file === 'xml.txt');
    expect(xml?.format).toBe('xml');
    expect(xml?.load).toBe('empty');
    expect(xml?.sim).toBe('notrun');
  });

  it('classifies xml even when a blank line precedes the root', () => {
    const entries = scanCorpus(FIXTURES_DIR);
    const xml = entries.find((e) => e.file === 'xml-leading-blank.txt');
    expect(xml?.format).toBe('xml');
    expect(xml?.load).toBe('empty');
  });

  it('records an unreadable file as load error instead of crashing the scan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'corpus-load-'));
    try {
      // A directory named like a circuit file makes readFileSync throw.
      mkdirSync(join(dir, 'broken.txt'));
      const [entry] = scanCorpus(dir);
      expect(entry.load).toBe('error');
      expect(entry.sim).toBe('notrun');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('corpus stage 2: simulate, and the golden report', () => {
  let report: CorpusEntry[];

  beforeAll(async () => {
    const engine = await SimEngine.create();
    report = generateReport(CIRCUITS_DIR, engine);
  }, 180_000);

  it('no regression: files the golden report simulates ok still do', () => {
    const golden = goldenByFile();
    for (const entry of report) {
      const g = golden.get(entry.file);
      expect(g, `no golden entry for ${entry.file}`).toBeDefined();
      if (g?.format === 'xml' || g?.sim !== 'ok') continue;
      expect(entry.sim, entry.file).toBe('ok');
    }
  });

  it('regenerates byte-for-byte; run `just corpus` on mismatch', () => {
    const golden = loadGolden();
    expect(report).toEqual(golden);
  });

  // The mirror image of the no-regression guard. That guard cannot see a file
  // the golden already marks failing, so a diagnosed failure would go quiet
  // forever, including on the day it starts working again. Failing here is the
  // good news: delete the entry and let the no-regression guard take over.
  it('every diagnosed sim failure still fails; delete the entry once it does not', () => {
    const byFile = new Map(report.map((e) => [e.file, e]));
    for (const [file, reason] of Object.entries(DIAGNOSED_SIM_FAILURES)) {
      expect(byFile.get(file), `no corpus entry for ${file}`).toBeDefined();
      expect(
        byFile.get(file)?.sim,
        `${file} simulates again. Remove it from DIAGNOSED_SIM_FAILURES: ${reason}`,
      ).toBe('error');
    }
  });
});
