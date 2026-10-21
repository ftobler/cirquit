import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = fileURLToPath(new URL('..', import.meta.url));

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else if (/\.tsx?$/.test(path)) found.push(path);
  }
  return found;
}

/** Source files a history grep may look at: everything runtime, never a test
 *  (tests may legitimately inspect the History shape) and never history.ts
 *  itself, which owns the only writes. */
const runtimeSources = () =>
  walk(SRC_DIR).filter((path) => {
    const relative = path.slice(SRC_DIR.length);
    if (relative === 'state/history.ts') return false;
    if (/\.test\.tsx?$/.test(relative)) return false;
    return true;
  });

describe('history writing is confined to history.ts', () => {
  it('no runtime source assigns undoStack or redoStack as an object key', () => {
    const offenders = runtimeSources().filter((path) =>
      /\b(undoStack|redoStack)\s*:/.test(readFileSync(path, 'utf8')),
    );
    // The stacks live on the History value and are only written by the pure
    // transitions in state/history.ts. A new hand-written push outside it is
    // how the old store grew four different undo-boundary tricks.
    expect(offenders).toEqual([]);
  });

  it('no runtime source still carries the retired scopeGesture flag', () => {
    const offenders = runtimeSources().filter((path) =>
      /\bscopeGesture\b/.test(readFileSync(path, 'utf8')),
    );
    // Gestures are transactions now, so the flag has no job left; a
    // reintroduced flag would mean a second boundary mechanism.
    expect(offenders).toEqual([]);
  });
});
