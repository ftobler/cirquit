import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCircuit, serializeCircuit, type NetlistLine } from './index';
import { CIRCUITS_DIR, SAMPLE } from './fixtures';
import { useStore } from '../../state/store';
import { DEFAULT_SETTINGS } from '../../model/types';
import { parseSetupList } from '../library';
import { compressCircuit, decompressCircuit, isLongUrl } from '../urlShare';

describe('transistor corpus parity', () => {
  it('every bundled t line parses to +1 or -1 and survives a round trip', () => {
    const files = readdirSync(CIRCUITS_DIR).filter((f) => f.endsWith('.txt'));
    let lines = 0;
    let npn = 0;
    let pnp = 0;
    let withModel = 0;
    const anomalies: string[] = [];
    for (const file of files) {
      const parsed = parseCircuit(readFileSync(join(CIRCUITS_DIR, file), 'utf8'));
      for (const e of parsed.elements) {
        if (e.kind !== 'transistor') continue;
        lines += 1;
        if (e.params.pnp === -1) pnp += 1;
        else if (e.params.pnp === 1) npn += 1;
        else anomalies.push(`${file}: pnp=${e.params.pnp}`);
        if (e.modelName !== undefined) withModel += 1;
        const [again] = parseCircuit(
          serializeCircuit([e], { ...DEFAULT_SETTINGS, ...parsed.settings }),
        ).elements;
        if (again.params.pnp !== e.params.pnp) {
          anomalies.push(`${file}: pnp changed on round trip`);
        }
        if (again.modelName !== e.modelName) {
          anomalies.push(`${file}: model name changed on round trip`);
        }
      }
    }
    console.log(`t lines ${lines}: npn ${npn}, pnp ${pnp}, model names ${withModel}`);
    expect(anomalies).toEqual([]);
    expect(lines).toBeGreaterThan(0);
  });
});

describe('bundled circuit round trips', () => {
  const files = readdirSync(CIRCUITS_DIR).filter(
    (f) => f.endsWith('.txt') && f !== 'setuplist.txt',
  );
  const read = (file: string) => readFileSync(join(CIRCUITS_DIR, file), 'utf8');

  /** Same classification as `corpus.ts`: the root can follow a BOM or a blank
   *  line, so it is the first non-blank line that decides. */
  const isXml = (text: string) =>
    (text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '').trimStart().startsWith('<cir ');

  /**
   * The `$` line is rebuilt from numbers, so a Java-written `5.0E-6` comes
   * back as `0.000005` and an old six-token header gains its seventh. What
   * must hold is that no field changes value and none is dropped, which is
   * what catches a field being replaced by a default.
   */
  const headerAnomaly = (before: string, after: string): string | null => {
    const a = before.split(/\s+/);
    const b = after.split(/\s+/);
    if (b.length !== 8) return `header has ${b.length - 1} fields, expected 7`;
    for (let i = 1; i < Math.min(a.length, 8); i++) {
      if (Number(a[i]) !== Number(b[i])) return `field ${i}: ${a[i]} -> ${b[i]}`;
    }
    return null;
  };

  /**
   * Compares a file with its own re-serialisation. Element lines re-render
   * their numbers too, so only their count is checked. Everything else,
   * comments, blank lines, scope lines and every line this build cannot read,
   * must come back byte-for-byte.
   */
  const compare = (file: string, text: string, out: string, order: NetlistLine[]) => {
    const anomalies: string[] = [];
    const before = text.split('\n');
    const after = out.split('\n');
    if (before.length !== after.length) {
      return [`${file}: ${before.length} lines in, ${after.length} out`];
    }
    order.forEach((entry, i) => {
      if (entry.kind === 'element') return;
      if (entry.kind === 'header') {
        const bad = headerAnomaly(before[i], after[i]);
        if (bad) anomalies.push(`${file}:${i + 1}: ${bad}`);
        return;
      }
      if (before[i] === after[i]) return;
      anomalies.push(
        `${file}:${i + 1}: ${JSON.stringify(before[i])} -> ${JSON.stringify(after[i])}`,
      );
    });
    return anomalies;
  };

  it('reproduces the line arrangement of every file, verbatim for the lines it cannot read', () => {
    const anomalies: string[] = [];
    let headers = 0;
    for (const file of files) {
      const text = read(file);
      const parsed = parseCircuit(text);
      const out = serializeCircuit(
        parsed.elements,
        { ...DEFAULT_SETTINGS, ...parsed.settings },
        parsed.scopes,
        parsed.passthrough,
        parsed.order,
        parsed.sliders,
      );
      headers += parsed.order.filter((l) => l.kind === 'header').length;
      anomalies.push(...compare(file, text, out, parsed.order));
    }
    expect(anomalies).toEqual([]);
    // Every non-XML file has exactly one `$` line, and `compare` byte-checks
    // each of them; without this the header claim would rest on one sample.
    expect(headers).toBe(files.length - files.filter((f) => isXml(read(f))).length);
  });

  it('round-trips every file through the store, which is how the app saves', () => {
    // `serializeCircuit` alone bypasses the scope mapping and the settings
    // merge, which is exactly where a save loses data.
    const anomalies: string[] = [];
    for (const file of files) {
      const text = read(file);
      useStore.getState().loadNetlist(text);
      const s = useStore.getState();
      anomalies.push(...compare(file, text, s.toNetlist(), s.order));
    }
    expect(anomalies).toEqual([]);
  });

  it('leaves the XML-format files exactly as they were', () => {
    // 38 of the bundled circuits are upstream's `<cir>` XML, which this build
    // does not import. Passing them through unchanged is the whole promise
    // until it does: a `$` line in front would stop upstream reading them.
    const xml = files.filter((f) => isXml(read(f)));
    expect(xml).toHaveLength(38);
    for (const file of xml) {
      useStore.getState().loadNetlist(read(file));
      expect(useStore.getState().toNetlist(), file).toBe(read(file));
    }
  });
});

describe('url sharing', () => {
  it('round-trips a circuit through the compressed form', () => {
    expect(decompressCircuit(compressCircuit(SAMPLE))).toBe(SAMPLE);
  });

  it('produces URI-safe output', () => {
    const token = compressCircuit(SAMPLE);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it('warns only past 2000 characters, matching ExportAsUrlDialog.java:111-114', () => {
    expect(isLongUrl('a'.repeat(2000))).toBe(false);
    expect(isLongUrl('a'.repeat(2001))).toBe(true);
  });
});

describe('circuit library index', () => {
  it('groups entries under their headings', () => {
    const groups = parseSetupList(
      ['### comment', '+Basics', "ohms.txt Ohm's Law", '>lrc.txt LRC Circuit', '-'].join('\n'),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe('Basics');
    expect(groups[0].entries).toEqual([
      { file: 'ohms.txt', title: "Ohm's Law" },
      { file: 'lrc.txt', title: 'LRC Circuit' },
    ]);
  });
});
