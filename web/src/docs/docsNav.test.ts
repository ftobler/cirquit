import { describe, expect, it } from 'vitest';
import { docsNavGroups } from './docsNav';
import { DOC_PAGES } from './pages';

describe('docsNavGroups', () => {
  it('lists every page except the index, exactly once', () => {
    const listed = docsNavGroups().flatMap((g) => g.pages.map((p) => p.id));
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual(
      DOC_PAGES.filter((p) => p.id !== 'docs')
        .map((p) => p.id)
        .sort(),
    );
  });

  it('keeps the sections in their fixed order', () => {
    expect(docsNavGroups().map((g) => g.key)).toEqual(['Reference', 'Calculators', 'Elements']);
    expect(docsNavGroups().map((g) => g.title)).toEqual([
      'Reference',
      'Calculators',
      'Element Guides',
    ]);
  });

  it('keeps registry order inside a group', () => {
    const reference = docsNavGroups().find((g) => g.key === 'Reference');
    expect(reference?.pages.map((p) => p.id)).toEqual(
      DOC_PAGES.filter((p) => p.id !== 'docs' && p.group === 'Reference').map((p) => p.id),
    );
  });

  it('drops a section with no pages', () => {
    const onlyReference = DOC_PAGES.filter((p) => p.group === 'Reference');
    expect(docsNavGroups(onlyReference).map((g) => g.key)).toEqual(['Reference']);
  });
});
