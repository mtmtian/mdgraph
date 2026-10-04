import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { parse } from '../../src/parser/parse';
import type { Block, Document } from '../../src/parser/types';
import type { Backlink, IndexApi } from '../../src/index/types';
import type { ImportedFile } from '../../src/storage/types';
import { FIXTURE_ROOT, GRAPH_DIR } from './helpers/fsFixtures';

/** Keep a BOM as U+FEFF, like the import layer. (Not shared with helpers/parser.ts, which breaks under jsdom.) */
const decode = (buf: Uint8Array): string => new TextDecoder('utf-8', { ignoreBOM: true }).decode(buf);

export interface ExpectedIndex {
  importedPaths: string[];
  pages: Record<string, { name?: string; path?: string | null; resolvesTo?: string }>;
  pageBacklinks: Record<string, Array<[string, string]>>;
  blockBacklinks: Record<string, Array<[string, string]>>;
}

export function expectedIndex(): ExpectedIndex {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, 'expected/index.json'), 'utf8')) as ExpectedIndex;
}

/** The files `importedPaths` lists, as the import layer would deliver them. */
export function importedFiles(): ImportedFile[] {
  return expectedIndex().importedPaths.map((path) => ({
    path,
    text: decode(readFileSync(join(GRAPH_DIR, path))),
  }));
}

export function syntheticDocs(): Document[] {
  return importedFiles().map((f) => parse(f.path, f.text));
}

/**
 * "First content line" of a block as expected/index.json writes it. For a
 * bullet whose head line is itself a property (`- date:: [[x]]`, content '')
 * that is the property line.
 */
export function labelOf(block: Block): string {
  const first = block.content.split('\n', 1)[0] ?? '';
  if (first === '' && block.kind === 'bullet') {
    const p = block.properties.find((x) => x.key !== 'id');
    if (p) return `${p.key}:: ${p.value}`;
  }
  return first;
}

export function labels(backlinks: Backlink[]): Array<[string, string]> {
  return backlinks.map((b): [string, string] => [b.source.path, labelOf(b.source.block)]).sort(compare);
}

export function compare(a: [string, string], b: [string, string]): number {
  return a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]);
}

export function sorted(pairs: Array<[string, string]>): Array<[string, string]> {
  return [...pairs].sort(compare);
}

export function findByContent(doc: Document, prefix: string): Block {
  const stack = [...doc.blocks];
  while (stack.length > 0) {
    const b = stack.shift()!;
    if (b.content.startsWith(prefix)) return b;
    stack.unshift(...b.children);
  }
  throw new Error(`no block starting with ${prefix}`);
}

/** Assert an index built from the synthetic graph agrees with expected/index.json. */
export function expectMatchesExpected(index: IndexApi): void {
  for (const [key, want] of Object.entries(expectedIndex().pages)) {
    if (want.resolvesTo !== undefined) {
      expect(index.resolvePage(key)?.key, `resolvePage(${key})`).toBe(want.resolvesTo);
      // An alias resolves, but is not a second page in the list.
      expect(index.state.pages.has(key), `${key} must not be its own page`).toBe(false);
    } else {
      const page = index.state.pages.get(key);
      expect(page, `page ${key}`).toBeDefined();
      expect(page?.name).toBe(want.name);
      expect(page?.path).toBe(want.path);
    }
  }
  for (const [key, want] of Object.entries(expectedIndex().pageBacklinks)) {
    expect(labels(index.backlinksForPage(key)), `pageBacklinks ${key}`).toEqual(sorted(want));
  }
  for (const [id, want] of Object.entries(expectedIndex().blockBacklinks)) {
    expect(labels(index.backlinksForBlock(id)), `blockBacklinks ${id}`).toEqual(sorted(want));
  }
}

