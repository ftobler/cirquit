import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCircuit, serializeCircuit, type NetlistLine } from './index';
import type { CircuitElement } from '../../model/types';
import { defFor } from '../../model/registry';
import { CIRCUITS_DIR, SAMPLE } from './fixtures';
import { xmlToText } from '../xmlToText';
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

  /**
   * Decodes both netlists and compares the meaningful payload of every element
   * line: kind, terminal coordinates, the flags word, the model name, the free
   * text, and each decoded param. The dump re-renders numbers, applies each
   * kind's `dumpFlags` normalisation (e.g. a capacitor always gains
   * CAP_RESISTANCE, a valueless diode always gains the forward-voltage bit) and
   * emits default-valued tail tokens (`writeParams` writes `?? 0`) or re-reads
   * model-derived params from a sibling `32`/`34` line, so the re-parsed flags
   * and a few params differ on a faithful round trip. What must hold is that no
   * field the parser read is lost or changed: a `def.dump` that drops or
   * mis-encodes a token would change a re-parsed param or the coordinates, which
   * the line-count check could never see.
   */
  const elementPayloadAnomalies = (
    file: string,
    before: CircuitElement[],
    after: CircuitElement[],
  ): string[] => {
    const anomalies: string[] = [];
    if (before.length !== after.length) {
      return [`${file}: ${before.length} elements in, ${after.length} out`];
    }
    const num = (x: number, y: number) => Number(x) === Number(y);
    before.forEach((a, i) => {
      const b = after[i];
      const where = `${file}:element#${i + 1} (${a.kind})`;
      const def = defFor(a.kind);
      if (a.kind !== b.kind) {
        anomalies.push(`${where}: kind ${a.kind} -> ${b.kind}`);
        return;
      }
      // Coordinates and the model name travel verbatim; any change is a real loss.
      if (!num(a.x1, b.x1)) anomalies.push(`${where}: x1 ${a.x1} -> ${b.x1}`);
      if (!num(a.y1, b.y1)) anomalies.push(`${where}: y1 ${a.y1} -> ${b.y1}`);
      if (!num(a.x2, b.x2)) anomalies.push(`${where}: x2 ${a.x2} -> ${b.x2}`);
      if (!num(a.y2, b.y2)) anomalies.push(`${where}: y2 ${a.y2} -> ${b.y2}`);
      if (a.text !== b.text) anomalies.push(`${where}: text ${JSON.stringify(a.text)} -> ${JSON.stringify(b.text)}`);
      if (a.modelName !== b.modelName) {
        anomalies.push(`${where}: modelName ${JSON.stringify(a.modelName)} -> ${JSON.stringify(b.modelName)}`);
      }
      // The flags word is rewritten through `dumpFlags`; the re-dumped value
      // must equal that canonical form, not the original (which omits bits the
      // dump always sets). A deviation here is a real flag corruption.
      const canonFlags = def?.dumpFlags ? def.dumpFlags(a) : a.flags;
      if (!num(canonFlags, b.flags)) anomalies.push(`${where}: flags ${a.flags} -> ${b.flags} (canonical ${canonFlags})`);
      // Params: every field the parser read must survive. A field the re-parse
      // gains but the load never had (a `writeParams` default or a model-derived
      // param re-read from its `32`/`34` line) is benign, not a loss.
      const keys = new Set([...Object.keys(a.params), ...Object.keys(b.params)]);
      for (const k of keys) {
        const av = a.params[k];
        const bv = b.params[k];
        if (av === undefined) {
          if (bv !== undefined) continue; // benign default/model-derived addition
        } else if (bv === undefined) {
          anomalies.push(`${where}: param ${k} ${av} dropped`);
        } else if (!num(av, bv)) {
          anomalies.push(`${where}: param ${k} ${av} -> ${bv}`);
        }
      }
    });
    return anomalies;
  };

  it('reproduces the line arrangement of every file, verbatim for the lines it cannot read', () => {
    const anomalies: string[] = [];
    let headers = 0;
    for (const file of files) {
      const text = read(file);
      // XML `<cir>` files are migrated to text before parsing; the converted
      // text is what the app saves from then on.
      const input = isXml(text) ? xmlToText(text) : text;
      const parsed = parseCircuit(input);
      const out = serializeCircuit(
        parsed.elements,
        { ...DEFAULT_SETTINGS, ...parsed.settings },
        parsed.scopes,
        parsed.passthrough,
        parsed.order,
        parsed.sliders,
      );
      headers += parsed.order.filter((l) => l.kind === 'header').length;
      anomalies.push(...compare(file, input, out, parsed.order));
      anomalies.push(...elementPayloadAnomalies(file, parsed.elements, parseCircuit(out).elements));
    }
    expect(anomalies).toEqual([]);
    // Every file, blank.txt included, has exactly one `$` line now that the
    // XML files are migrated; `compare` byte-checks each of them, so without
    // this the header claim would rest on one sample.
    expect(headers).toBe(files.length);
  });

  it('round-trips every file through the store, which is how the app saves', () => {
    // `serializeCircuit` alone bypasses the scope mapping and the settings
    // merge, which is exactly where a save loses data.
    const anomalies: string[] = [];
    for (const file of files) {
      const text = read(file);
      const input = isXml(text) ? xmlToText(text) : text;
      useStore.getState().loadNetlist(text);
      const s = useStore.getState();
      anomalies.push(...compare(file, input, s.toNetlist(), s.order));
      const loaded = parseCircuit(input);
      anomalies.push(...elementPayloadAnomalies(file, loaded.elements, parseCircuit(s.toNetlist()).elements));
    }
    expect(anomalies).toEqual([]);
  });

  it('migrates the XML-format files to text on load', () => {
    // Loading an XML `<cir>` file converts it: the save that follows writes
    // the text format, and the converted document saves stably (a second
    // load-then-save is byte-identical). The 38 bundled XML circuits are the
    // migration target. A converted file is not expected to match its first
    // conversion byte-for-byte when a token hit the clamp-on-load policy
    // (brentkung's decimal display carries `bc 9`, clamped to the engine's
    // 1..8 ceiling with a warning); the stable fixpoint is the contract.
    const xml = files.filter((f) => isXml(read(f)));
    expect(xml).toHaveLength(38);
    for (const file of xml) {
      useStore.getState().loadNetlist(read(file));
      const out = useStore.getState().toNetlist();
      expect(out.split('\n')[0], file).toMatch(/^\$ /);
      useStore.getState().loadNetlist(out);
      expect(useStore.getState().toNetlist(), file).toBe(out);
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
      // The `>` marks the startup default; see library.test.ts.
      { file: 'lrc.txt', title: 'LRC Circuit', isDefault: true },
    ]);
  });
});
