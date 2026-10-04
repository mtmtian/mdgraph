import { describe, expect, test } from 'vitest';
import { createIndex } from '../../src/index/index';
import { nameFromPath, titleOf, toKey } from '../../src/index/pageName';
import { parse } from '../../src/parser/parse';
import { expectMatchesExpected, syntheticDocs } from './index.graphHelpers';

describe('page names', () => {
  test('nameFromPath', () => {
    expect(nameFromPath('pages/ns%2Fchild.md')).toBe('ns/child');
    expect(nameFromPath('pages/other___deep.md')).toBe('other/deep');
    expect(nameFromPath('pages/100%.md')).toBe('100%'); // malformed escape stays as is
    expect(nameFromPath('pages/Foo Bar.md')).toBe('Foo Bar');
    expect(nameFromPath('journals/2022_06_25.md')).toBe('Jun 25th, 2022');
    expect(nameFromPath('journals/2022-01-01.md')).toBe('Jan 1st, 2022');
    expect(nameFromPath('journals/2022_02_02.md')).toBe('Feb 2nd, 2022');
    expect(nameFromPath('journals/2022_03_13.md')).toBe('Mar 13th, 2022');
    expect(nameFromPath('journals/2022_12_23.md')).toBe('Dec 23rd, 2022');
    expect(nameFromPath('journals/notes.md')).toBe('notes');
    expect(nameFromPath('pages/2022_06_25.md')).toBe('2022_06_25');
  });

  test('toKey and titleOf', () => {
    expect(toKey('  Foo Bar ')).toBe('foo bar');
    expect(titleOf(parse('a.md', 'title:: My Title\n- x'))).toBe('My Title');
    expect(titleOf(parse('a.md', '- title:: In Bullet\n- x'))).toBe('In Bullet');
    expect(titleOf(parse('a.md', '- x\n- y\n  title:: nope'))).toBeUndefined();
    expect(titleOf(parse('a.md', ''))).toBeUndefined();
  });
});

describe('index rebuild over the synthetic graph', () => {
  const index = createIndex();
  index.rebuildAll(syntheticDocs());

  test('matches expected/index.json', () => {
    expectMatchesExpected(index);
  });

  test('virtual pages are exactly the referenced-but-fileless ones', () => {
    const virtual = [...index.state.pages.values()].filter((p) => p.path === null).map((p) => p.key).sort();
    expect(virtual).toEqual(['demo', 'link target', 'multi word tag', 'project', 'real link', 'tag']);
  });

  test('rebuildAll twice gives the same result (it clears first)', () => {
    index.rebuildAll(syntheticDocs());
    expectMatchesExpected(index);
    expect(index.state.pages.size).toBe(
      new Set([...index.state.pages.values()].map((p) => p.key)).size,
    );
  });

  test('via is derived from the syntax that produced the reference', () => {
    const idx = createIndex();
    idx.upsertDocument(
      parse('v.md', '- plain [[Alpha]] and #beta\n- prop block\n  k:: [[Gamma]]\n  tags:: delta\n- ref ((22222222-2222-4222-8222-222222222222))'),
    );
    const via = (key: string) => idx.backlinksForPage(key).map((b) => b.via);
    expect(via('alpha')).toEqual(['link']);
    expect(via('beta')).toEqual(['tag']);
    expect(via('gamma')).toEqual(['property']);
    expect(via('delta')).toEqual(['property']);
    expect(idx.backlinksForBlock('22222222-2222-4222-8222-222222222222').map((b) => b.via)).toEqual(['ref']);
    expect(idx.backlinksForBlock('22222222-2222-4222-8222-222222222222'.toUpperCase())).toHaveLength(1);
  });

  test('a block links the same page once even with different casing', () => {
    const hits = index.backlinksForPage('link target').filter((b) => b.source.block.content.startsWith('DOING'));
    expect(hits).toHaveLength(1);
  });

  test('breadcrumb ancestors are recorded', () => {
    const grand = index.backlinksForBlock('11111111-1111-4111-8111-111111111111').find(
      (b) => b.source.path === 'pages/basic.md',
    )!;
    expect(grand.source.ancestors.map((a) => a.content.split('\n')[0])).toEqual([
      'TODO second block',
      'child of second with #[[multi word tag]]',
    ]);
  });
});
