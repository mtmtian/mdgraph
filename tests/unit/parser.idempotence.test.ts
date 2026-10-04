import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parser/parse';
import { serialize } from '../../src/parser/serialize';
import { GRAPH_DIR, listMarkdown, readText } from './helpers/parser';
import { relative, sep } from 'node:path';

describe('parser idempotence: synthetic corpus', () => {
  const files = listMarkdown(GRAPH_DIR);

  it('finds the synthetic fixtures', () => {
    expect(files.length).toBeGreaterThanOrEqual(13);
  });

  for (const file of files) {
    const rel = relative(GRAPH_DIR, file).split(sep).join('/');
    it(`serialize(parse(x)) === x for ${rel}`, () => {
      const text = readText(file);
      expect(serialize(parse(rel, text))).toBe(text);
    });
  }

  it('keeps the BOM of bom.md as U+FEFF and records it on the Document', () => {
    const doc = parse('pages/bom.md', readText(`${GRAPH_DIR}/pages/bom.md`));
    expect(doc.bom).toBe(true);
    expect(doc.blocks[0].content).toBe('with bom [[Basic Page]]');
  });
});

describe('parser idempotence: real corpus', () => {
  const root = process.env.MDGRAPH_REAL_GRAPH;
  if (!root) {
    console.log('MDGRAPH_REAL_GRAPH is not set: skipping the real-corpus idempotence test.');
  }
  (root ? it : it.skip)('serialize(parse(x)) === x for every .md under MDGRAPH_REAL_GRAPH', () => {
    const files = listMarkdown(root!, ['logseq', 'bak', '.recycle']);
    const failures: string[] = [];
    for (const file of files) {
      const rel = relative(root!, file).split(sep).join('/');
      const text = readText(file);
      if (serialize(parse(rel, text)) !== text) failures.push(rel);
    }
    console.log(`real corpus: checked ${files.length} files, ${failures.length} failures`);
    expect(failures).toEqual([]);
  });
});
