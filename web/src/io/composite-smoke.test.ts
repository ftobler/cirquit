/**
 * Regression guard for the stricter composite child-build rule (commit
 * 7939b52). `Composite::from_model` used to swallow a failed child build with
 * `continue`, which dropped the child silently; it now returns an error that
 * names the child, aborting the whole load. That is correct, but it must not
 * refuse a bundled composite circuit that loaded under the old, lenient rule.
 *
 * This smoke-loads every circuit in the bundled library that contains a
 * composite-built element and asserts the stricter rule's refusal never reaches
 * `setCircuit`. The build path is the same one the store uses, so a child-build
 * refusal here is exactly the regression a real load would hit.
 *
 * The covered kinds are the ones the engine actually routes through
 * `Composite::from_model`: `ota`, `comparator`, `customComposite`, `opampReal`,
 * `crystal` and `optocoupler`. The plain op-amp (`opamp`) is NOT composite-built,
 * so it can never trigger the regression and must stay out of the set.
 *
 * A refused bundle surfaces through one of two strings, depending on which
 * builder aborts. The custom subcircuit builder (`Composite::from_spec`) returns
 * the specific `composite child N (...) failed to build` message; the built-in
 * composite builders (`ota`/`comparator`/`opampReal`/`optocoupler`/`crystal`)
 * fold the child failure into their `Option` contract and surface the generic
 * `element '...' has a missing or malformed model definition` message. The
 * matcher catches both, so a refusal via either path lands on a failing
 * assertion.
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

// The element kinds the engine actually builds as composites
// (engine/core/src/elements/mod.rs: the `ota`/`comparator`/`opampReal`/`optocoupler`/
// `crystal` arms route through `Composite::from_model`; `composite` is the custom
// subcircuit). Each routes through `from_model`, so each is in scope for the
// stricter child-build refusal. `opamp` is deliberately absent: it is a
// standalone element that never goes through `from_model` and therefore cannot
// trigger the regression.
const COMPOSITE_KINDS = new Set([
  'ota',
  'comparator',
  'customComposite',
  'opampReal',
  'crystal',
  'optocoupler',
]);

// The only composite-built kind the bundled corpus actually contains. These
// bundles get the strongest guard: they must load with no error at all, so a
// future refusal is an immediate failing assertion.
const STRONG_KINDS = new Set(['ota']);

// Either string the engine emits when a composite child build is refused. The
// custom subcircuit builder returns the specific text (engine/core/src/elements/
// composite.rs:456); the built-in composite builders swallow the detailed error
// behind `.ok()` and surface the generic text via `model_composite`
// (engine/core/src/elements/mod.rs:454). Catching both closes the false-pass the
// narrow match left open for the built-in kinds.
const CHILD_BUILD_ERROR =
  /(composite child|failed to build|missing or malformed model definition)/;

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

  it('covers the bundled OTA circuits', () => {
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
      if (parsed.elements.some((e) => STRONG_KINDS.has(e.kind))) {
        // Strongest guard: an OTA bundle (the one composite-built kind the
        // corpus actually ships) must load with no error at all. A future
        // child-build refusal therefore fails immediately instead of being
        // excused as an "unrelated" error.
        expect(err, `${file}: ${err}`).toBe(null);
      } else if (err) {
        // For the other composite-built kinds, the only load refusal this guard
        // forbids is the child-build one, surfaced by either builder. Any other
        // error (a convergence refusal, a singular matrix) is an unrelated,
        // pre-existing condition, not the stricter child-build regression.
        expect(err, `${file}: ${err}`).not.toMatch(CHILD_BUILD_ERROR);
      }
    });
  }
});
