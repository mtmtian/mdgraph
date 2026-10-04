// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { filesFromDrop, filesFromInput, planImport, readInBatches } from '../../src/fs/import.ts';
import type { ImportedFile, ImportProgress } from '../../src/storage/types.ts';
import { expectedImportedPaths, graphEntries, walkGraph } from './helpers/fsFixtures.ts';

const file = (name: string, text = 'x') => new File([text], name);

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('planImport', () => {
  it('keeps exactly the expected synthetic paths and skips bak / non-md', () => {
    const plan = planImport(graphEntries());
    expect(plan.rootName).toBe('graph');
    expect(plan.kept.map((k) => k.path).sort()).toEqual([...expectedImportedPaths()].sort());
    expect(plan.skipped).toContain('graph/logseq/bak/pages/basic.md');
    expect(plan.skipped).toContain('graph/pages/notes.txt');
    expect(plan.skipped).toHaveLength(2);
  });

  it('leaves rootName empty when there is no shared first segment', () => {
    const plan = planImport([
      { relativePath: 'a/x.md', file: file('x.md') },
      { relativePath: 'b/y.md', file: file('y.md') },
      { relativePath: 'z.md', file: file('z.md') },
    ]);
    expect(plan.rootName).toBe('');
    expect(plan.kept.map((k) => k.path)).toEqual(['a/x.md', 'b/y.md', 'z.md']);
  });

  it('does not strip a lone top-level file name', () => {
    const plan = planImport([{ relativePath: 'only.md', file: file('only.md') }]);
    expect(plan.rootName).toBe('');
    expect(plan.kept.map((k) => k.path)).toEqual(['only.md']);
  });

  it('applies each filter rule', () => {
    const rel = [
      'g/pages/ok.md',
      'g/pages/readme.txt',
      'g/pages/.hidden.md',
      'g/.git/x.md',
      'g/pages/.sub/y.md',
      'g/logseq/config.md',
      'g/logseq/custom.md',
      'g/pages/bak/z.md',
      'g/.recycle/w.md',
      'g/pages/.recycle/w2.md',
      'g/pages/logseq-notes.md',
      'g/pages/sub/logseq/ok2.md',
    ];
    const plan = planImport(rel.map((relativePath) => ({ relativePath, file: file('f') })));
    expect(plan.kept.map((k) => k.path)).toEqual(['pages/ok.md', 'pages/logseq-notes.md', 'pages/sub/logseq/ok2.md']);
    expect(plan.skipped).toHaveLength(rel.length - 3);
  });

  it('only a dot-prefixed root folder is stripped before the hidden-segment check', () => {
    const plan = planImport([{ relativePath: '.graph/pages/a.md', file: file('a.md') }, { relativePath: '.graph/b.md', file: file('b.md') }]);
    expect(plan.rootName).toBe('.graph');
    expect(plan.kept.map((k) => k.path)).toEqual(['pages/a.md', 'b.md']);
  });

  it('normalizes backslashes', () => {
    const plan = planImport([
      { relativePath: 'graph\\pages\\a.md', file: file('a.md') },
      { relativePath: 'graph\\logseq\\bak\\pages\\a.md', file: file('a.md') },
    ]);
    expect(plan.kept.map((k) => k.path)).toEqual(['pages/a.md']);
    expect(plan.skipped).toEqual(['graph/logseq/bak/pages/a.md']);
  });

  it('handles empty input', () => {
    expect(planImport([])).toEqual({ kept: [], skipped: [], rootName: '' });
  });
});

describe('readInBatches', () => {
  const make = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ path: `p/${i}.md`, file: file(`${i}.md`, `t${i}`) }));

  it('reports progress per batch of 32 and yields every file', async () => {
    const progress: ImportProgress[] = [];
    const got = await collect(readInBatches(make(40), (p) => progress.push(p)));
    expect(progress.map((p) => [p.done, p.total])).toEqual([
      [32, 40],
      [40, 40],
    ]);
    expect(got).toHaveLength(40);
    expect(got[0]).toEqual({ path: 'p/0.md', text: 't0' });
    expect(got[39]).toEqual({ path: 'p/39.md', text: 't39' });
  });

  it('records unreadable files in failed and keeps going', async () => {
    const kept = make(5);
    const bad = file('bad.md');
    Object.defineProperty(bad, 'arrayBuffer', { value: () => Promise.reject(new Error('boom')) });
    kept[2] = { path: 'p/bad.md', file: bad };
    const progress: ImportProgress[] = [];
    const got = await collect(readInBatches(kept, (p) => progress.push(p)));
    expect(got.map((g) => g.path)).toEqual(['p/0.md', 'p/1.md', 'p/3.md', 'p/4.md']);
    expect(progress.at(-1)).toEqual({ done: 5, total: 5, failed: ['p/bad.md'] });
  });

  it('treats invalid UTF-8 as a failure instead of corrupting text', async () => {
    const f = new File([new Uint8Array([0x2d, 0x20, 0xff, 0xfe, 0x0a])], 'bin.md');
    const progress: ImportProgress[] = [];
    const got = await collect(readInBatches([{ path: 'bin.md', file: f }], (p) => progress.push(p)));
    expect(got).toEqual([]);
    expect(progress[0].failed).toEqual(['bin.md']);
  });

  it('preserves BOM and CRLF bytes in text', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x2d, 0x20, 0x61, 0x0d, 0x0a]);
    const [r] = await collect(readInBatches([{ path: 'a.md', file: new File([bytes], 'a.md') }]));
    expect(r.text).toBe('﻿- a\r\n');
  });

  it('yields to the main thread between batches', async () => {
    vi.useFakeTimers();
    try {
      const it = readInBatches(make(40))[Symbol.asyncIterator]();
      const seen: ImportedFile[] = [];
      for (let i = 0; i < 32; i++) seen.push((await it.next()).value as ImportedFile);
      const pending = it.next();
      let resolved = false;
      void pending.then(() => (resolved = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('handles an empty list', async () => {
    const progress: ImportProgress[] = [];
    expect(await collect(readInBatches([], (p) => progress.push(p)))).toEqual([]);
    expect(progress).toEqual([{ done: 0, total: 0, failed: [] }]);
  });

  it('imports the synthetic graph byte-for-byte via filesFromInput', async () => {
    const files = graphEntries().map((e) => {
      Object.defineProperty(e.file, 'webkitRelativePath', { value: e.relativePath });
      return e.file;
    });
    const src = filesFromInput(files);
    expect(src.rootName).toBe('graph');
    expect(src.total).toBe(expectedImportedPaths().length);
    expect(src.skipped).toHaveLength(2);
    const got = await collect(src.files);
    const byPath = new Map(walkGraph().map((f) => [f.rel, f.bytes]));
    for (const g of got) {
      const want = new TextDecoder('utf-8', { ignoreBOM: true }).decode(byPath.get(g.path)!);
      expect(g.text).toBe(want);
    }
    expect(got.map((g) => g.path).sort()).toEqual([...expectedImportedPaths()].sort());
  });
});

// Minimal FileSystemEntry fakes. readEntries returns at most `chunk` entries per call, then [].
type FakeEntry = FileSystemFileEntry | FileSystemDirectoryEntry;
function fileEntry(name: string, text: string): FileSystemFileEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (ok: (f: File) => void) => ok(new File([text], name)),
  } as unknown as FileSystemFileEntry;
}
function dirEntry(name: string, children: FakeEntry[], chunk = 2): FileSystemDirectoryEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let pos = 0;
      return {
        readEntries: (ok: (e: FakeEntry[]) => void) => {
          const out = children.slice(pos, pos + chunk);
          pos += chunk;
          queueMicrotask(() => ok(out));
        },
      };
    },
  } as unknown as FileSystemDirectoryEntry;
}
const item = (e: FakeEntry | null) =>
  ({ kind: 'file', webkitGetAsEntry: () => e }) as unknown as DataTransferItem;

describe('filesFromDrop', () => {
  it('walks directories, loops readEntries until empty, strips the root and filters', async () => {
    const pages = dirEntry('pages', [
      fileEntry('a.md', 'A'),
      fileEntry('b.md', 'B'),
      fileEntry('c.md', 'C'),
      fileEntry('notes.txt', 'n'),
      fileEntry('d.md', 'D'),
    ]);
    const bak = dirEntry('bak', [fileEntry('old.md', 'o')]);
    const logseq = dirEntry('logseq', [bak, fileEntry('config.md', 'c')]);
    const root = dirEntry('graph', [pages, logseq, fileEntry('.hidden.md', 'h')]);
    const src = await filesFromDrop([item(root)]);
    expect(src.rootName).toBe('graph');
    expect(src.total).toBe(4);
    expect(src.skipped.sort()).toEqual([
      'graph/.hidden.md',
      'graph/logseq/bak/old.md',
      'graph/logseq/config.md',
      'graph/pages/notes.txt',
    ]);
    const got = await collect(src.files);
    expect(got.map((g) => g.path).sort()).toEqual(['pages/a.md', 'pages/b.md', 'pages/c.md', 'pages/d.md']);
    expect(got.find((g) => g.path === 'pages/c.md')?.text).toBe('C');
  });

  it('ignores items without an entry and non-file items', async () => {
    const src = await filesFromDrop([
      item(null),
      { kind: 'string', webkitGetAsEntry: () => null } as unknown as DataTransferItem,
      item(fileEntry('solo.md', 'S')),
    ]);
    expect(src.rootName).toBe('');
    expect(await collect(src.files)).toEqual([{ path: 'solo.md', text: 'S' }]);
  });
});
