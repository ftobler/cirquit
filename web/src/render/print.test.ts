import { describe, expect, it } from 'vitest';
import { printStyle } from './print';

describe('printStyle', () => {
  it('hides everything but the overlay on paper', () => {
    const css = printStyle();
    expect(css).toContain('body > *:not(#circuit-print-overlay) { display: none !important; }');
    expect(css).toContain('#circuit-print-overlay { display: block !important;');
  });

  it('keeps the overlay hidden on screen and sets the page margins', () => {
    const css = printStyle();
    // On screen the overlay must not flash over the app; the print rule keeps
    // the image inside the page and pins the margins like upstream's @page.
    expect(css).toContain('#circuit-print-overlay { display: none; }');
    expect(css).toMatch(/@page \{ size: auto; margin: 10mm; \}/);
    expect(css).toContain('max-width: 100%');
  });
});
