/**
 * Regression guard for the stricter composite child-build rule (commit
 * 7939b52). `Composite::from_model` used to swallow a failed child build with
 * `continue`, which dropped the child silently; it now returns an error that
 * names the child, aborting the whole load. That is correct, but it must not
 * refuse a bundled composite circuit that loaded under the old, lenient rule.
 *
 * This smoke-loads every circuit in the bundled library that contains a
 * composite element (op-amp, OTA, comparator, custom subcircuit) and asserts the
 * stricter rule's refusal never reaches `setCircuit`. The build path is the same
 * one the store uses, so a child-build refusal here is exactly the regression a
 * real load would hit.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { SimEngine } from '../engine/simulator';
import { DEFAULT_SETTINGS } from '../model/types';
import { parseCircuit } from './netlist';
import { clearSessionModels, registerSessionModel } from './subcircuits';

const CIRCUITS_DIR = fileURLToPath(new URL('../../public/circuits', import.meta.url));

// The element kinds the engine builds as composites
// (engine/core/src/elements/composite.rs). Each routes through `from_model`, so
// each is in scope for the stricter child-build refusal.
const COMPOSITE_KINDS = new Set(['opamp', 'ota', 'comparator', 'customComposite']);

// The exact text `Composite::from_model` returns for a rejected child
// (engine/core/src/elements/composite.rs:456). A bundled file whose load ends
// with this string is the regression under test: a previously-loading circuit
// the stricter rule now refuses.
const CHILD_BUILD_ERROR = /composite child \d+ \([^)]*\) failed to build/;

/** Every bundled circuit whose element list contains a composite kind. */
function compositeFiles(): string[] {
  const out: string[] = [];
  for (const file of readdirSync(CIRCUITS_DIR).sort()) {
    if (!file.endsWith('.txt')) continue;
    let parsed;
    try {
      parsed = parseCircuit(readFileSync(join(CIRCUITS_DIR, file), 'utf8'));
    } catch {
      // A parse failure is a different regression, guarded by the corpus load
      // test; it is not the child-build refusal this guard targets.
      continue;
    }
    if (parsed.elements.some((e) => COMPOSITE_KINDS.has(e.kind))) out.push(file);
  }
  return out;
}

describe('bundled composite circuits survive the stricter child-build rule', () => {
  let engine: SimEngine;
  const files = compositeFiles();

  beforeAll(async () => {
    engine = await SimEngine.create();
  }, 30_000);

  it('covers the bundled op-amp and OTA circuits', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain('ota-gain.txt');
  });

  for (const file of files) {
    it(`loads ${file} without a child-build refusal`, async () => {
      const text = readFileSync(join(CIRCUITS_DIR, file), 'utf8');
      const parsed = parseCircuit(text);
      // The file's own `.` subcircuit models join the session library so a
      // custom-composite child's geometry resolves the way the store resolves
      // it. Cleared first because the engine and session map are shared across
      // every file in this suite.
      clearSessionModels();
      for (const model of parsed.compositeModels) registerSessionModel(model);
      const err = engine.setCircuit(
        parsed.elements,
        { ...DEFAULT_SETTINGS, ...parsed.settings },
        [],
      );
      if (err) {
        // The only load refusal this guard forbids. Any other error (a
        // convergence refusal, a singular matrix) is an unrelated, pre-existing
        // condition, not the stricter child-build regression.
        expect(err, `${file}: ${err}`).not.toMatch(CHILD_BUILD_ERROR);
      }
    });
  }
});
