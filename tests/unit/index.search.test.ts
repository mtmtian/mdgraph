import { describe, expect, test } from 'vitest';
import { createIndex } from '../../src/index/index';
import { tokenize } from '../../src/index/searchIndex';
import { parse } from '../../src/parser/parse';

function indexOf(files: Record<string, string>) {
  const index = createIndex();
  for (const [path, text] of Object.entries(files)) index.upsertDocument(parse(path, text));
  const text = (id: string) => index.state.blocks.get(id)!.block.content;
  return { index, texts: (q: string, limit?: number) => index.search(q, limit).map((h) => [text(h.blockId), h.score] as const) };
}

describe('tokenize', () => {
  test('latin words are lower-cased and split on punctuation', () => {
    expect(tokenize('Hello, World-wide Web_2!')).toEqual(['hello', 'world', 'wide', 'web', '2']);
  });
  test('CJK runs become single characters plus adjacent pairs', () => {
    expect(tokenize('图数据库')).toEqual(['图', '图数', '数', '数据', '据', '据库', '库']);
    expect(tokenize('abc中文def')).toEqual(['abc', '中', '中文', '文', 'def']);
  });
});

describe('search', () => {
  test('Chinese: intersection of single characters and pairs', () => {
    const { texts } = indexOf({
      'a.md': '- 今天学习了图数据库\n- 数据结构笔记\n- 完全无关',
    });
    expect(texts('数据库')).toEqual([['今天学习了图数据库', 5]]);
    expect(texts('数据结构')).toEqual([['数据结构笔记', 7]]);
    expect(texts('不存在')).toEqual([]);
  });

  test('English: intersection beats union', () => {
    const { texts } = indexOf({
      'a.md': '- Graph Database design\n- database backup\n- graph theory',
    });
    expect(texts('graph DATABASE')).toEqual([['Graph Database design', 2]]);
  });

  test('falls back to the union ordered by matched tokens, then path, then position', () => {
    const { texts } = indexOf({
      'b.md': '- graph in b\n- backup in b',
      'a.md': '- graph database\n- backup in a\n- graph in a',
    });
    // No block contains all of graph/database/backup.
    expect(texts('graph database backup')).toEqual([
      ['graph database', 2],
      ['backup in a', 1],
      ['graph in a', 1],
      ['graph in b', 1],
      ['backup in b', 1],
    ]);
  });

  test('empty queries and limits', () => {
    const { index, texts } = indexOf({ 'a.md': '- one\n- one two\n- one three' });
    expect(index.search('   ')).toEqual([]);
    expect(index.search('!!!')).toEqual([]);
    expect(texts('one', 2)).toHaveLength(2);
  });

  test('property values are searchable, ids are not', () => {
    const { index } = indexOf({
      'a.md': '- block\n  status:: waiting\n  id:: 33333333-3333-4333-8333-333333333333',
    });
    expect(index.search('waiting')).toHaveLength(1);
    expect(index.search('33333333')).toEqual([]);
  });
});
