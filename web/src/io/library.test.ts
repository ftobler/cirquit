import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  defaultLibraryEntry,
  filterLibrary,
  parseSetupList,
  type LibraryGroup,
} from './library';

const groups: LibraryGroup[] = [
  {
    title: 'Basics',
    entries: [
      { file: 'ohms.txt', title: "Ohm's Law" },
      { file: 'lrc.txt', title: 'LRC Circuit' },
    ],
    groups: [],
  },
  {
    title: 'Transistors',
    entries: [
      { file: 'npn.txt', title: 'NPN Transistor' },
      { file: 'pnp.txt', title: 'PNP Transistor' },
    ],
    groups: [
      {
        title: 'Multivibrators',
        entries: [{ file: 'astable.txt', title: 'Astable Multivibrator' }],
        groups: [],
      },
    ],
  },
];

const CIRCUITS_DIR = fileURLToPath(new URL('../../public/circuits', import.meta.url));

describe('parseSetupList', () => {
  const list = [
    '### a comment line',
    '+Basics',
    "ohms.txt Ohm's Law",
    '>lrc.txt LRC Circuit',
    '-',
    '+Transistors',
    '>npn.txt NPN Transistor',
    '-',
  ].join('\n');

  it('reads groups and entries', () => {
    expect(parseSetupList(list)).toEqual([
      {
        title: 'Basics',
        entries: [
          { file: 'ohms.txt', title: "Ohm's Law" },
          { file: 'lrc.txt', title: 'LRC Circuit', isDefault: true },
        ],
        groups: [],
      },
      {
        title: 'Transistors',
        entries: [{ file: 'npn.txt', title: 'NPN Transistor' }],
        groups: [],
      },
    ]);
  });

  it('nests a group opened inside another, three deep like upstream', () => {
    // Upstream's own list nests this far: Other Passive Circuits holds
    // Transformers, which holds Saturable Core. A parent keeps both its own
    // circuits and its subgroups.
    const nested = [
      '+Other Passive',
      'series.txt Series',
      '+Transformers',
      'xfmr.txt Transformer',
      '+Saturable Core',
      'satcore.txt Saturable Core',
      '-',
      '-',
      '-',
    ].join('\n');
    expect(parseSetupList(nested)).toEqual([
      {
        title: 'Other Passive',
        entries: [{ file: 'series.txt', title: 'Series' }],
        groups: [
          {
            title: 'Transformers',
            entries: [{ file: 'xfmr.txt', title: 'Transformer' }],
            groups: [
              {
                title: 'Saturable Core',
                entries: [{ file: 'satcore.txt', title: 'Saturable Core' }],
                groups: [],
              },
            ],
          },
        ],
      },
    ]);
  });

  it('drops a group that is empty all the way down', () => {
    expect(parseSetupList('+Outer\n+Inner\n-\n-')).toEqual([]);
  });

  it('finds the default marker inside a subgroup', () => {
    const nested = ['+Outer', '+Inner', '>deep.txt Deep', '-', '-'].join('\n');
    expect(defaultLibraryEntry(parseSetupList(nested))?.file).toBe('deep.txt');
  });

  it('marks only the first > entry as the default, like upstream', () => {
    expect(defaultLibraryEntry(parseSetupList(list))).toEqual({
      file: 'lrc.txt',
      title: 'LRC Circuit',
      isDefault: true,
    });
  });

  it('reports no default when the list marks none', () => {
    expect(defaultLibraryEntry(parseSetupList('+Basics\nohms.txt Ohm\n-'))).toBeNull();
  });
});

describe('the bundled setup list', () => {
  // Guards `just import-cirquits-upstream`: startup falls back to the plain
  // starter circuit if the marker or its file ever goes missing.
  it('names a default circuit that is bundled', () => {
    const groups = parseSetupList(readFileSync(join(CIRCUITS_DIR, 'setuplist.txt'), 'utf8'));
    const entry = defaultLibraryEntry(groups);
    expect(entry?.file).toBe('lrc.txt');
    expect(existsSync(join(CIRCUITS_DIR, entry!.file))).toBe(true);
  });

  it('is three levels deep, as upstream ships it', () => {
    const parsed = parseSetupList(readFileSync(join(CIRCUITS_DIR, 'setuplist.txt'), 'utf8'));
    const depth = (gs: LibraryGroup[]): number =>
      gs.length === 0 ? 0 : 1 + Math.max(...gs.map((g) => depth(g.groups)));
    expect(depth(parsed)).toBe(3);
    // The nesting the flat parser used to lose: a subgroup under a subgroup.
    const passive = parsed.find((g) => g.title === 'Other Passive Circuits');
    const transformers = passive?.groups.find((g) => g.title === 'Transformers');
    expect(transformers?.groups.map((g) => g.title)).toEqual(['Saturable Core']);
  });
});

describe('filterLibrary', () => {
  it('returns the groups unchanged for an empty query', () => {
    expect(filterLibrary(groups, '')).toBe(groups);
    expect(filterLibrary(groups, '   ')).toBe(groups);
  });

  it('keeps only the entries whose title matches', () => {
    const hits = filterLibrary(groups, 'circuit');
    expect(hits).toEqual([
      { title: 'Basics', entries: [{ file: 'lrc.txt', title: 'LRC Circuit' }], groups: [] },
    ]);
  });

  it('searches subgroups and keeps the path down to a hit', () => {
    const hits = filterLibrary(groups, 'astable');
    expect(hits).toEqual([
      {
        title: 'Transistors',
        entries: [],
        groups: [
          {
            title: 'Multivibrators',
            entries: [{ file: 'astable.txt', title: 'Astable Multivibrator' }],
            groups: [],
          },
        ],
      },
    ]);
  });

  it('a matching subgroup title keeps everything under it', () => {
    expect(filterLibrary(groups, 'multivibrator')).toEqual([
      { title: 'Transistors', entries: [], groups: groups[1].groups },
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
