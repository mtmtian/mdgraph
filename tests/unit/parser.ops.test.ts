import { describe, expect, it } from 'vitest';
import {
  ensureId,
  findBlock,
  indent,
  insertAfter,
  mergeWithPrevious,
  outdent,
  setBlockText,
  walk,
} from '../../src/parser/ops';
import { parse } from '../../src/parser/parse';
import { serialize } from '../../src/parser/serialize';
import type { Document } from '../../src/parser/types';
import { GRAPH_DIR, lineDiff, readText, simplifyDoc } from './helpers/parser';

const UUID1 = '11111111-1111-4111-8111-111111111111';
const UUID2 = '22222222-2222-4222-8222-222222222222';

/** The fixture, spelled out so a fixture edit cannot silently change the expectations below. */
const BASIC = [
  'title:: Basic Page',
  'tags:: [[demo]], project',
  '',
  '- First block with a [[Link Target]] and a #tag',
  '- TODO second block',
  '  key:: value',
  `  id:: ${UUID1}`,
  '  continuation line of second block',
  '  - child of second with #[[multi word tag]]',
  `    - grandchild referencing ((${UUID1}))`,
  '- DONE third block',
  '- DOING fourth [[Link Target]] again and [[link target]] lowercase',
];

const lines = (...ls: string[]): string => ls.join('\n') + '\n';

function load(rel = 'pages/basic.md'): Document {
  return parse(rel, readText(`${GRAPH_DIR}/${rel}`));
}

function idOf(doc: Document, contentStart: string): string {
  for (const { block } of walk(doc)) if (block.content.startsWith(contentStart)) return block.id;
  throw new Error('no block starting with ' + contentStart);
}

/** Re-parsing the serialized output must give the same structure (ops produce valid, stable text). */
function expectStable(doc: Document): void {
  expect(simplifyDoc(parse(doc.path, serialize(doc)))).toEqual(simplifyDoc(doc));
}

describe('ops on pages/basic.md', () => {
  it('fixture is what the expectations assume', () => {
    expect(readText(`${GRAPH_DIR}/pages/basic.md`)).toBe(lines(...BASIC));
    expect(serialize(load())).toBe(lines(...BASIC));
  });

  it('setBlockText: new head, a new property and a continuation line', () => {
    const doc = load();
    const id = idOf(doc, 'First block');
    const next = setBlockText(doc, id, 'First block edited [[New Page]]\nextra:: v\nsecond line');
    const out = serialize(next);
    expect(out).toBe(
      lines(
        'title:: Basic Page',
        'tags:: [[demo]], project',
        '',
        '- First block edited [[New Page]]',
        '  extra:: v',
        '  second line',
        ...BASIC.slice(4),
      ),
    );
    expect(lineDiff(BASIC, out.split('\n').slice(0, -1))).toEqual({
      removed: ['- First block with a [[Link Target]] and a #tag'],
      added: ['- First block edited [[New Page]]', '  extra:: v', '  second line'],
    });
    const b = findBlock(next, id)!.block;
    expect(b.rawLines).toBeNull();
    expect(b.links).toEqual(['New Page']);
    expect(b.tags).toEqual([]);
    expect(b.properties).toEqual([{ key: 'extra', value: 'v' }]);
    expect(b.id).toBe(id);
    // original is untouched (pure)
    expect(serialize(doc)).toBe(lines(...BASIC));
    expectStable(next);
  });

  it('setBlockText: keeps the id:: property although the text does not contain it', () => {
    const doc = load();
    const id = idOf(doc, 'TODO second');
    const next = setBlockText(
      doc,
      id,
      'TODO second block changed\nkey:: value2\ncontinuation line of second block',
    );
    const out = serialize(next);
    expect(out).toBe(
      lines(
        ...BASIC.slice(0, 4),
        '- TODO second block changed',
        '  key:: value2',
        `  id:: ${UUID1}`,
        '  continuation line of second block',
        ...BASIC.slice(8),
      ),
    );
    expect(lineDiff(BASIC, out.split('\n').slice(0, -1))).toEqual({
      removed: ['- TODO second block', '  key:: value'],
      added: ['- TODO second block changed', '  key:: value2'],
    });
    const b = findBlock(next, id)!.block;
    expect(b.id).toBe(UUID1);
    expect(b.persistentId).toBe(true);
    expect(b.task).toBe('TODO');
    expect(b.children).toBe(findBlock(doc, id)!.block.children);
    expectStable(next);
  });

  it('setBlockText: raw block takes property lines then content', () => {
    const doc = load();
    const id = doc.blocks[0].id;
    const next = setBlockText(doc, id, 'title:: Renamed\ntags:: [[demo]], project\n');
    const out = serialize(next);
    expect(out).toBe(lines('title:: Renamed', ...BASIC.slice(1)));
    expect(lineDiff(BASIC, out.split('\n').slice(0, -1))).toEqual({
      removed: ['title:: Basic Page'],
      added: ['title:: Renamed'],
    });
    expect(next.blocks[0].kind).toBe('raw');
    expect(next.blocks[0].properties[0]).toEqual({ key: 'title', value: 'Renamed' });
    expectStable(next);
  });

  it('setBlockText: unchanged text returns the very same Document', () => {
    const doc = load();
    const id = idOf(doc, 'TODO second');
    expect(setBlockText(doc, id, 'TODO second block\nkey:: value\ncontinuation line of second block')).toBe(doc);
    expect(setBlockText(doc, 'does-not-exist', 'x')).toBe(doc);
  });

  it('insertAfter: block without children gets a sibling', () => {
    const doc = load();
    const id = idOf(doc, 'First block');
    const res = insertAfter(doc, id)!;
    const out = serialize(res.doc);
    expect(out).toBe(lines(...BASIC.slice(0, 4), '- ', ...BASIC.slice(4)));
    expect(lineDiff(BASIC, out.split('\n').slice(0, -1))).toEqual({ removed: [], added: ['- '] });
    const nb = findBlock(res.doc, res.id)!.block;
    expect([nb.kind, nb.depth, nb.content, nb.persistentId, nb.rawLines]).toEqual(['bullet', 0, '', false, null]);
    expect(res.id.startsWith('tmp-')).toBe(true);
    expectStable(res.doc);
  });

  it('insertAfter: block with children gets a new first child', () => {
    const doc = load();
    const id = idOf(doc, 'TODO second');
    const res = insertAfter(doc, id)!;
    const out = serialize(res.doc);
    expect(out).toBe(lines(...BASIC.slice(0, 8), '  - ', ...BASIC.slice(8)));
    expect(lineDiff(BASIC, out.split('\n').slice(0, -1))).toEqual({ removed: [], added: ['  - '] });
    expect(findBlock(res.doc, res.id)!.parent!.id).toBe(UUID1);
    expectStable(res.doc);
  });

  it('insertAfter: inherits the marker; after a raw block it is a top-level "-" bullet', () => {
    const doc = load('pages/tabs-no-eol.md');
    const star = idOf(doc, 'star bullet');
    expect(serialize(insertAfter(doc, star)!.doc)).toBe(
      ['- top', '\t- child one', '\t\t- grandchild', '\t- child two', '* star bullet', '* ', '+ plus bullet'].join('\n'),
    );
    const basic = load();
    const res = insertAfter(basic, basic.blocks[0].id)!;
    expect(serialize(res.doc)).toBe(lines(...BASIC.slice(0, 3), '- ', ...BASIC.slice(3)));
  });

  it('indent: becomes the last child of the previous sibling', () => {
    const doc = load();
    const next = indent(doc, idOf(doc, 'DONE third'));
    const out = serialize(next);
    expect(out).toBe(lines(...BASIC.slice(0, 10), '  - DONE third block', BASIC[11]));
    expect(lineDiff(BASIC, out.split('\n').slice(0, -1))).toEqual({
      removed: ['- DONE third block'],
      added: ['  - DONE third block'],
    });
    expect(findBlock(next, idOf(next, 'DONE third'))!.block.depth).toBe(1);
    expectStable(next);
  });

  it('indent: shifts the raw lines of the whole subtree by one indent unit', () => {
    const doc = load();
    const next = indent(doc, UUID1);
    const out = serialize(next);
    expect(out).toBe(
      lines(
        ...BASIC.slice(0, 4),
        '  - TODO second block',
        '    key:: value',
        `    id:: ${UUID1}`,
        '    continuation line of second block',
        '    - child of second with #[[multi word tag]]',
        `      - grandchild referencing ((${UUID1}))`,
        ...BASIC.slice(10),
      ),
    );
    expect(lineDiff(BASIC, out.split('\n').slice(0, -1)).removed).toEqual(BASIC.slice(4, 10));
    // descendants keep their raw lines (shifted), only the moved block is regenerated
    const moved = findBlock(next, UUID1)!.block;
    expect(moved.rawLines).toBeNull();
    expect(moved.children[0].rawLines).toEqual(['    - child of second with #[[multi word tag]]']);
    expect(moved.children[0].depth).toBe(2);
    expectStable(next);
  });

  it('indent: no previous sibling, or raw block => same Document', () => {
    const doc = load();
    expect(indent(doc, idOf(doc, 'First block'))).toBe(doc); // previous sibling is a raw block
    expect(indent(doc, doc.blocks[0].id)).toBe(doc);
    const tabs = load('pages/tabs-no-eol.md');
    expect(indent(tabs, idOf(tabs, 'top'))).toBe(tabs);
  });

  it('outdent: moves after the parent and re-indents its subtree', () => {
    const doc = load();
    const next = outdent(doc, idOf(doc, 'child of second'));
    const out = serialize(next);
    expect(out).toBe(
      lines(
        ...BASIC.slice(0, 8),
        '- child of second with #[[multi word tag]]',
        `  - grandchild referencing ((${UUID1}))`,
        ...BASIC.slice(10),
      ),
    );
    expect(lineDiff(BASIC, out.split('\n').slice(0, -1))).toEqual({
      removed: ['  - child of second with #[[multi word tag]]', `    - grandchild referencing ((${UUID1}))`],
      added: ['- child of second with #[[multi word tag]]', `  - grandchild referencing ((${UUID1}))`],
    });
    expectStable(next);
  });

  it('outdent: following siblings become children of the moved block (four-space.md)', () => {
    const doc = load('pages/four-space.md');
    expect(serialize(doc)).toBe(lines('- a', '    - b', '        - c', '    - d', '- e'));
    const next = outdent(doc, idOf(doc, 'b'));
    const out = serialize(next);
    expect(out).toBe(lines('- a', '- b', '    - c', '    - d', '- e'));
    expect(lineDiff(serialize(doc).split('\n'), out.split('\n')).removed).toEqual(['    - b', '        - c']);
    const b = findBlock(next, idOf(next, 'b'))!.block;
    expect(b.children.map((c) => [c.content, c.depth])).toEqual([
      ['c', 1],
      ['d', 1],
    ]);
    // `d` was not touched: same object, same raw lines
    expect(b.children[1]).toBe(findBlock(doc, idOf(doc, 'd'))!.block);
    expectStable(next);
  });

  it('outdent: depth 0 => same Document', () => {
    const doc = load();
    expect(outdent(doc, idOf(doc, 'DONE third'))).toBe(doc);
  });

  it('mergeWithPrevious: into the deepest last descendant of the previous sibling', () => {
    const doc = load();
    const res = mergeWithPrevious(doc, idOf(doc, 'DONE third'))!;
    const out = serialize(res.doc);
    const merged = `grandchild referencing ((${UUID1}))`;
    expect(out).toBe(lines(...BASIC.slice(0, 9), `    - ${merged}DONE third block`, BASIC[11]));
    expect(res.caret).toBe(63);
    expect(res.caret).toBe(merged.length);
    expect(res.blockId).toBe(idOf(doc, 'grandchild'));
    expect(lineDiff(BASIC, out.split('\n').slice(0, -1))).toEqual({
      removed: [`    - ${merged}`, '- DONE third block'],
      added: [`    - ${merged}DONE third block`],
    });
    expect(findBlock(res.doc, res.blockId)!.block.refs).toEqual([UUID1]);
    expect(findBlock(res.doc, idOf(doc, 'DONE third'))).toBeNull();
    expectStable(res.doc);
  });

  it('mergeWithPrevious: into the parent when first child; grandchildren move up with it', () => {
    const doc = load();
    const res = mergeWithPrevious(doc, idOf(doc, 'child of second'))!;
    const out = serialize(res.doc);
    expect(out).toBe(
      lines(
        ...BASIC.slice(0, 7),
        '  continuation line of second blockchild of second with #[[multi word tag]]',
        `  - grandchild referencing ((${UUID1}))`,
        ...BASIC.slice(10),
      ),
    );
    expect(res.caret).toBe(51);
    expect(res.blockId).toBe(UUID1);
    const b = findBlock(res.doc, UUID1)!.block;
    expect(b.tags).toEqual(['multi word tag']);
    expect(b.properties.map((p) => p.key)).toEqual(['key', 'id']);
    expect(b.children.map((c) => [c.depth, c.content.slice(0, 10)])).toEqual([[1, 'grandchild']]);
    expectStable(res.doc);
  });

  it('mergeWithPrevious: nothing to merge into => null', () => {
    const doc = load();
    expect(mergeWithPrevious(doc, doc.blocks[0].id)).toBeNull(); // first block
    expect(mergeWithPrevious(doc, idOf(doc, 'First block'))).toBeNull(); // previous is raw
    expect(mergeWithPrevious(doc, 'nope')).toBeNull();
  });

  it('ensureId: appends id:: to the properties of a block without one', () => {
    const doc = load();
    const id = idOf(doc, 'First block');
    const next = ensureId(doc, id, UUID2);
    const out = serialize(next);
    expect(out).toBe(lines(...BASIC.slice(0, 4), `  id:: ${UUID2}`, ...BASIC.slice(4)));
    expect(lineDiff(BASIC, out.split('\n').slice(0, -1))).toEqual({ removed: [], added: [`  id:: ${UUID2}`] });
    const b = findBlock(next, UUID2)!.block;
    expect([b.persistentId, b.rawLines]).toEqual([true, null]);
    expect(findBlock(next, id)).toBeNull();
    expectStable(next);
  });

  it('ensureId: appends after existing properties; no-op when an id already exists', () => {
    const doc = load('pages/ns%2Fchild.md');
    const id = doc.blocks[1].id;
    const out = serialize(ensureId(doc, id, UUID2));
    expect(out).toBe(
      lines('- namespace child page links [[Jun 25th, 2022]]', '- ', '  date:: [[Jun 25th, 2022]]', `  id:: ${UUID2}`),
    );
    const basic = load();
    expect(ensureId(basic, UUID1, UUID2)).toBe(basic);
  });
});

describe('ops: untouched blocks keep identity and bytes', () => {
  it('unrelated blocks are the same objects after every op', () => {
    const doc = load();
    const third = idOf(doc, 'DONE third');
    const fourth = findBlock(doc, idOf(doc, 'DOING fourth'))!.block;
    const first = findBlock(doc, idOf(doc, 'First block'))!.block;
    const results: Document[] = [
      setBlockText(doc, third, 'DONE third block!'),
      insertAfter(doc, third)!.doc,
      indent(doc, third),
      ensureId(doc, third, UUID2),
      mergeWithPrevious(doc, third)!.doc,
    ];
    for (const r of results) {
      expect(findBlock(r, fourth.id)!.block).toBe(fourth);
      expect(findBlock(r, first.id)!.block).toBe(first);
      expect(r.blocks[0]).toBe(doc.blocks[0]);
    }
  });
});
