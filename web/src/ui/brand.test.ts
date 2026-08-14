import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BRAND_GRADIENT } from './brand';

const FAVICON_PATH = fileURLToPath(new URL('../../public/favicon.svg', import.meta.url));

describe('BRAND_GRADIENT', () => {
  it('is a fixed 90deg golden-to-magenta sweep', () => {
    expect(BRAND_GRADIENT).toBe('linear-gradient(90deg, rgb(226 212 25), rgb(223 27 126))');
  });
});

describe('favicon.svg', () => {
  it('exists and parses as a well-formed SVG with the op-amp mark', () => {
    const svg = readFileSync(FAVICON_PATH, 'utf8');
    expect(svg).toContain('<svg');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    // The favicon's own tag count must balance: opening and closing svg tags.
    const opens = svg.match(/<svg/g)?.length ?? 0;
    const closes = svg.match(/<\/svg>/g)?.length ?? 0;
    expect(opens).toBe(closes);
    expect(closes).toBe(1);
    // The op-amp body is a triangle (three-segment closed path) plus the two
    // input leads and the output lead.
    expect(svg).toMatch(/<path[^>]*M10 6\.5 L25 16 L10 25\.5 Z/);
    expect(svg.match(/<path/g)?.length).toBe(4);
  });

  it('draws yellow on the dark disc so it reads in both chrome themes', () => {
    const svg = readFileSync(FAVICON_PATH, 'utf8');
    expect(svg).toContain('stroke="#ffff00"');
    expect(svg).toContain('fill="#161b22"');
    expect(svg).toContain('<circle');
  });
});
