import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// printStyle() no longer builds the print stylesheet: the rules moved into
// styles.css, keyed to the overlay id that printCircuit injects. The string
// assertions give way to a source check that the rules survive in the static
// stylesheet, so a print regression is caught here instead of on paper.
// Whitespace is stripped so the assertions survive reformatting.
const STYLES_PATH = fileURLToPath(new URL('../styles.css', import.meta.url));
const css = readFileSync(STYLES_PATH, 'utf8').replace(/\s+/g, ' ');

describe('print stylesheet', () => {
  it('hides everything but the overlay on paper', () => {
    expect(css).toContain('body > *:not(#circuit-print-overlay) { display: none !important; }');
    expect(css).toContain('#circuit-print-overlay { display: block !important;');
  });

  it('keeps the overlay hidden on screen and sets the page margins', () => {
    // On screen the overlay must not flash over the app; the print rule keeps
    // the image inside the page and pins the margins like upstream's @page.
    expect(css).toContain('#circuit-print-overlay { display: none; }');
    expect(css).toContain('@page { size: auto; margin: 10mm; }');
    expect(css).toContain('max-width: 100%');
  });
});
