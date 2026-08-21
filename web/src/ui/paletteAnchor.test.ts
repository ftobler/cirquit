import { beforeEach, describe, expect, it } from 'vitest';
import { clearPaletteAnchor, paletteAnchor, setPaletteAnchor } from './paletteAnchor';

describe('palette anchor', () => {
  beforeEach(clearPaletteAnchor);

  it('falls back to the caller-supplied point before the pointer has moved', () => {
    expect(paletteAnchor({ x: 400, y: 300 })).toEqual({
      client: { x: 400, y: 300 },
      circuit: { x: 0, y: 0 },
    });
  });

  it('reports the last recorded pointer, viewport pixels and circuit point', () => {
    setPaletteAnchor({ x: 120, y: 80 }, { x: 32, y: 16 });
    expect(paletteAnchor({ x: 400, y: 300 })).toEqual({
      client: { x: 120, y: 80 },
      circuit: { x: 32, y: 16 },
    });
  });

  it('forgets the pointer once it leaves the canvas', () => {
    setPaletteAnchor({ x: 120, y: 80 }, { x: 32, y: 16 });
    clearPaletteAnchor();
    expect(paletteAnchor({ x: 400, y: 300 }).client).toEqual({ x: 400, y: 300 });
  });
});
