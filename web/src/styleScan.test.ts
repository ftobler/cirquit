import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));

// The three popup/menu positioners set left/top from the store; that is
// dynamic data per open, exactly what an inline style is for, and moving it to
// CSS would mean a custom property per element for no benefit. ScopeProperties
// sets the channel-selector dot's colour from the trace-colour map, which the
// theme and the user's Other Options colours decide at run time: no CSS class
// can track those. Every other inline style must be a class in a real
// stylesheet, so this scan keeps the `style={{` rule enforced in CI.
const DYNAMIC_STYLE_FILES = [
  'ui/ContextMenu.tsx',
  'ui/ScopeMenu.tsx',
  'ui/canvas/ScrollValuePopup.tsx',
  'ui/ScopeProperties.tsx',
];

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else if (path.endsWith('.tsx')) found.push(path);
  }
  return found;
}

describe('inline style scan', () => {
  it('keeps style={{ out of tsx files except the dynamic-data files', () => {
    const offenders = walk(SRC_DIR).filter((path) => {
      const relative = path.slice(SRC_DIR.length);
      if (DYNAMIC_STYLE_FILES.includes(relative)) return false;
      return readFileSync(path, 'utf8').includes('style={{');
    });
    expect(offenders).toEqual([]);
  });
});
