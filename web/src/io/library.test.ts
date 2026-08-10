import { describe, expect, it } from 'vitest';
import { filterLibrary, type LibraryGroup } from './library';

const groups: LibraryGroup[] = [
  {
    title: 'Basics',
    entries: [
      { file: 'ohms.txt', title: "Ohm's Law" },
      { file: 'lrc.txt', title: 'LRC Circuit' },
    ],
  },
  {
    title: 'Transistors',
    entries: [
      { file: 'npn.txt', title: 'NPN Transistor' },
      { file: 'pnp.txt', title: 'PNP Transistor' },
    ],
  },
];

describe('filterLibrary', () => {
  it('returns the groups unchanged for an empty query', () => {
    expect(filterLibrary(groups, '')).toBe(groups);
    expect(filterLibrary(groups, '   ')).toBe(groups);
  });

  it('keeps only the entries whose title matches', () => {
    const hits = filterLibrary(groups, 'circuit');
    expect(hits).toEqual([
      { title: 'Basics', entries: [{ file: 'lrc.txt', title: 'LRC Circuit' }] },
    ]);
  });

  it('keeps every entry of a group whose own title matches', () => {
    const hits = filterLibrary(groups, 'transistor');
    expect(hits).toEqual([groups[1]]);
  });

  it('is case-insensitive', () => {
    expect(filterLibrary(groups, 'TRANSISTOR')).toEqual(filterLibrary(groups, 'transistor'));
    expect(filterLibrary(groups, 'Ohm')).toHaveLength(1);
  });

  it('drops groups with nothing left', () => {
    const hits = filterLibrary(groups, 'zzzznope');
    expect(hits).toEqual([]);
  });
});
