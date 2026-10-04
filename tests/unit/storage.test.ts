// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFileStore } from '../../src/storage/idb.ts';
import type { FileRecord, WorkspaceMeta } from '../../src/storage/types.ts';

let n = 0;
const fresh = () => createFileStore(`mdgraph-test-${n++}`);
const rec = (path: string, text = 'x', importedText = text): FileRecord => ({
  path,
  text,
  importedText,
  updatedAt: 1,
});

afterEach(() => vi.unstubAllGlobals());

describe('FileStore (IndexedDB)', () => {
  it('probe ok with fake-indexeddb', async () => {
    expect(await fresh().probe()).toEqual({ indexedDb: { ok: true } });
  });

  it('probe reports unavailable when indexedDB is missing', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const p = await fresh().probe();
    expect(p.indexedDb.ok).toBe(false);
    if (!p.indexedDb.ok) expect(p.indexedDb.reason).toBeTruthy();
  });

  it('probe reports open failure without throwing', async () => {
    vi.stubGlobal('indexedDB', {
      open() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    const p = await fresh().probe();
    expect(p.indexedDb).toEqual({ ok: false, reason: 'denied' });
  });

  it('meta round-trips and is null when empty', async () => {
    const s = fresh();
    expect(await s.getMeta()).toBeNull();
    const meta: WorkspaceMeta = { id: 'default', name: 'graph', importedAt: 5, fileCount: 2 };
    await s.putMeta(meta);
    expect(await s.getMeta()).toEqual(meta);
    await s.putMeta({ ...meta, fileCount: 3 });
    expect((await s.getMeta())?.fileCount).toBe(3);
  });

  it('putMany / get / getAll / listPaths', async () => {
    const s = fresh();
    expect(await s.getAll()).toEqual([]);
    expect(await s.get('nope.md')).toBeNull();
    await s.putMany([rec('a.md', 'A'), rec('pages/b.md', 'B')]);
    expect((await s.listPaths()).sort()).toEqual(['a.md', 'pages/b.md']);
    expect(await s.get('a.md')).toEqual(rec('a.md', 'A'));
    expect((await s.getAll()).map((r) => r.path).sort()).toEqual(['a.md', 'pages/b.md']);
    await s.putMany([rec('a.md', 'A2')]);
    expect((await s.get('a.md'))?.text).toBe('A2');
  });

  it('preserves BOM / CRLF text exactly', async () => {
    const s = fresh();
    const text = '﻿- a\r\n- b\r\n';
    await s.putMany([rec('bom.md', text)]);
    expect((await s.get('bom.md'))?.text).toBe(text);
  });

  it('updateText overwrites text only', async () => {
    const s = fresh();
    await s.putMany([rec('a.md', 'old')]);
    await s.updateText('a.md', 'new', 99);
    expect(await s.get('a.md')).toEqual({ path: 'a.md', text: 'new', importedText: 'old', updatedAt: 99 });
  });

  it('updateText on a missing path rejects and writes nothing', async () => {
    const s = fresh();
    await expect(s.updateText('missing.md', 't', 1)).rejects.toThrow(/missing\.md/);
    expect(await s.listPaths()).toEqual([]);
  });

  it('markExported sets importedText to the exported text for given paths only', async () => {
    const s = fresh();
    await s.putMany([rec('a.md', 'a2', 'a0'), rec('b.md', 'b1', 'b0')]);
    // The file was edited again (a2) after the text that was exported (a1) was taken.
    await s.markExported([
      { path: 'a.md', text: 'a1' },
      { path: 'ghost.md', text: 'g' },
    ]);
    expect(await s.get('a.md')).toMatchObject({ text: 'a2', importedText: 'a1' });
    expect((await s.get('b.md'))?.importedText).toBe('b0');
    expect(await s.get('ghost.md')).toBeNull();
  });

  it('replaceAll swaps files and meta for the new set', async () => {
    const s = fresh();
    await s.putMany([rec('old.md'), rec('keep.md', 'old')]);
    await s.putMeta({ id: 'default', name: 'old', importedAt: 1, fileCount: 2 });
    const meta: WorkspaceMeta = { id: 'default', name: 'new', importedAt: 2, fileCount: 2 };
    await s.replaceAll([rec('keep.md', 'new'), rec('x/y.md')], meta);
    expect((await s.listPaths()).sort()).toEqual(['keep.md', 'x/y.md']);
    expect((await s.get('keep.md'))?.text).toBe('new');
    expect(await s.getMeta()).toEqual(meta);
  });

  it('replaceAll is atomic: a record that cannot be stored leaves the previous workspace intact', async () => {
    const s = fresh();
    const oldMeta: WorkspaceMeta = { id: 'default', name: 'old', importedAt: 1, fileCount: 1 };
    await s.putMany([rec('old.md', 'precious')]);
    await s.putMeta(oldMeta);
    // Functions cannot be structured-cloned: put() throws after clear() was already issued.
    const poisoned = { ...rec('bad.md'), text: (() => {}) as unknown as string };
    await expect(
      s.replaceAll([rec('good.md'), poisoned], { id: 'default', name: 'new', importedAt: 2, fileCount: 2 }),
    ).rejects.toThrow();
    expect(await s.listPaths()).toEqual(['old.md']);
    expect((await s.get('old.md'))?.text).toBe('precious');
    expect(await s.getMeta()).toEqual(oldMeta);
  });

  it('data persists across store instances on the same database', async () => {
    const name = `mdgraph-persist-${n++}`;
    await createFileStore(name).putMany([rec('a.md', 'kept')]);
    expect((await createFileStore(name).get('a.md'))?.text).toBe('kept');
  });
});
