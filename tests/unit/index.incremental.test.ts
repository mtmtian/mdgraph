import { describe, expect, test } from 'vitest';
import { createIndex } from '../../src/index/index';
import type { Backlink } from '../../src/index/types';
import { setBlockText } from '../../src/parser/ops';
import { parse } from '../../src/parser/parse';
import type { Document } from '../../src/parser/types';
import { expectMatchesExpected, findByContent, labels, syntheticDocs } from './index.graphHelpers';

const BASIC = 'pages/basic.md';
const UUID = '11111111-1111-4111-8111-111111111111';

function build() {
  const docs = syntheticDocs();
  const index = createIndex();
  index.rebuildAll(docs);
  return { docs, index, basic: docs.find((d) => d.path === BASIC)! };
}

function allBacklinks(index: ReturnType<typeof createIndex>): Backlink[] {
  return [...index.state.pageBacklinks.values(), ...index.state.blockBacklinks.values()].flat();
}

describe('incremental upsert', () => {
  test('editing one block touches only entries derived from that file', () => {
    const { index, basic } = build();
    const others = allBacklinks(index).filter((b) => b.source.path !== BASIC);
    const otherBlocks = new Map(
      [...index.state.blocks].filter(([, loc]) => loc.path !== BASIC),
    );
    const otherTokens = new Map([...index.state.search].map(([t, ids]) => [t, new Set(ids)]));

    const first = findByContent(basic, 'First block');
    const edited = setBlockText(basic, first.id, 'First block now links [[New Target]] only');
    expect(edited).not.toBe(basic);
    index.upsertDocument(edited);

    // Entries owned by other files are the very same objects.
    const after = new Set(allBacklinks(index));
    for (const b of others) expect(after.has(b), `${b.source.path} backlink kept`).toBe(true);
    for (const [id, loc] of otherBlocks) expect(index.state.blocks.get(id)).toBe(loc);

    // Entries derived from basic.md reflect the edit.
    expect(labels(index.backlinksForPage('link target'))).toEqual([
      [BASIC, 'DOING fourth [[Link Target]] again and [[link target]] lowercase'],
    ]);
    expect(labels(index.backlinksForPage('new target'))).toEqual([[BASIC, 'First block now links [[New Target]] only']]);
    expect(index.state.pages.get('new target')).toMatchObject({ name: 'New Target', path: null });
    expect(index.search('now links').map((h) => h.blockId)).toEqual([first.id]);
    expect(index.search('with a').filter((h) => h.blockId === first.id)).toHaveLength(0);
    // Unrelated search entries are unchanged.
    expect(index.state.search.get('journal')).toEqual(otherTokens.get('journal'));
  });

  test('an edit leaves no stale entries behind (upsert = remove + add)', () => {
    const { index, basic } = build();
    const first = findByContent(basic, 'First block');
    index.upsertDocument(setBlockText(basic, first.id, 'plain xyzzy text'));
    expect(index.backlinksForPage('tag')).toEqual([]);
    expect(index.state.pages.has('tag')).toBe(false); // virtual page dropped with its last reference
    expect(index.search('xyzzy').map((h) => h.blockId)).toEqual([first.id]);
    expect(index.search('first').filter((h) => h.blockId === first.id)).toEqual([]);
    const count = (blocks: Document['blocks']): number => blocks.reduce((n, b) => n + 1 + count(b.children), 0);
    expect([...index.state.blocks.values()].filter((l) => l.path === BASIC)).toHaveLength(count(basic.blocks));
  });

  test('re-upserting an unchanged document is a no-op in observable terms', () => {
    const { index, docs } = build();
    for (const d of docs) index.upsertDocument(d);
    expectMatchesExpected(index);
  });
});

describe('removeDocument', () => {
  test('drops the file page, its references and their virtual pages; real page degrades to virtual', () => {
    const { index } = build();
    index.removeDocument(BASIC);

    expect(index.backlinksForPage('link target')).toEqual([]);
    expect(index.state.pages.has('link target')).toBe(false);
    expect(index.state.pages.has('demo')).toBe(false);
    expect(index.state.pages.has('project')).toBe(false);
    expect(index.state.pages.has('multi word tag')).toBe(false);
    // 'basic page' is still referenced by other files, so it lives on as a virtual page.
    expect(index.state.pages.get('basic page')).toMatchObject({ name: 'Basic Page', path: null, aliases: [] });
    expect(index.resolvePage('basic')).toBeUndefined();
    expect(labels(index.backlinksForPage('basic page'))).toHaveLength(4);
    // Only the journal still references the block.
    expect(labels(index.backlinksForBlock(UUID))).toEqual([
      ['journals/2022_06_25.md', 'journal entry referencing [[Basic Page]] and ((11111111-1111-4111-8111-111111111111))'],
    ]);
    expect([...index.state.blocks.values()].some((l) => l.path === BASIC)).toBe(false);
    expect(index.search('grandchild').filter((h) => h.path === BASIC)).toEqual([]);
  });

  test('re-adding the file upgrades the virtual page back to a real one and restores everything', () => {
    const { index, basic } = build();
    index.removeDocument(BASIC);
    index.upsertDocument(basic);
    expect(index.state.pages.get('basic page')).toMatchObject({ path: BASIC, aliases: ['basic'] });
    expect(index.resolvePage('basic')?.key).toBe('basic page');
    expectMatchesExpected(index);
  });

  test('removing an unknown path does nothing', () => {
    const { index } = build();
    index.removeDocument('nope.md');
    expectMatchesExpected(index);
  });
});

describe('virtual page upgrade', () => {
  test('a file named like a referenced page replaces the virtual page and keeps its backlinks', () => {
    const index = createIndex();
    index.upsertDocument(parse('pages/a.md', '- see [[Target Page]]'));
    expect(index.state.pages.get('target page')).toMatchObject({ name: 'Target Page', path: null });
    index.upsertDocument(parse('pages/Target Page.md', '- hello'));
    expect(index.state.pages.get('target page')).toMatchObject({ name: 'Target Page', path: 'pages/Target Page.md' });
    expect(labels(index.backlinksForPage('target page'))).toEqual([['pages/a.md', 'see [[Target Page]]']]);
    index.removeDocument('pages/Target Page.md');
    expect(index.state.pages.get('target page')).toMatchObject({ path: null });
  });

  test('virtual page keeps the first-seen spelling', () => {
    const index = createIndex();
    index.upsertDocument(parse('a.md', '- [[Some Name]]'));
    index.upsertDocument(parse('b.md', '- [[some name]]'));
    expect(index.state.pages.get('some name')?.name).toBe('Some Name');
  });

  test('title:: page is reachable through its file-derived alias and merges backlinks', () => {
    const index = createIndex();
    index.upsertDocument(parse('pages/orig.md', 'title:: Pretty\n- body'));
    index.upsertDocument(parse('pages/x.md', '- via title [[Pretty]]\n- via file name [[orig]]'));
    expect(index.resolvePage('ORIG')?.name).toBe('Pretty');
    expect(index.state.pages.has('orig')).toBe(false);
    expect(labels(index.backlinksForPage('pretty'))).toHaveLength(2);
    expect(labels(index.backlinksForPage('orig'))).toHaveLength(2);
  });
});
