// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ExportFile } from '../../src/fs/export';
import { serialize } from '../../src/parser/serialize';
import { createFileStore } from '../../src/storage/idb';
import type { FileRecord, FileStore, ImportedFile, ImportedFileStream } from '../../src/storage/types';
import { createWorkspaceStore } from '../../src/store/workspace';
import { editableTextOf } from '../../src/store/types';
import { expectMatchesExpected, expectedIndex, findByContent, importedFiles } from './index.graphHelpers';

const BASIC = 'pages/basic.md';
const JOURNAL = 'journals/2022_06_25.md';

let dbCounter = 0;
function setup(fileStore?: FileStore) {
  const fs = fileStore ?? createFileStore(`mdgraph-store-test-${++dbCounter}`);
  const zip = vi.fn<(name: string, files: ExportFile[]) => Promise<void>>(async () => {});
  const markdown = vi.fn<(path: string, text: string) => void>();
  let n = 0;
  const store = createWorkspaceStore({
    fileStore: fs,
    download: { zip, markdown },
    now: () => 1_000 + ++n,
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  });
  return { fs, store, zip, markdown };
}

async function imported() {
  const ctx = setup();
  const files = importedFiles();
  await ctx.store.getState().importFiles('graph', files, files.length);
  return ctx;
}

describe('workspace store: import', () => {
  test('imports the synthetic graph: docs, no dirty, index, persisted records', async () => {
    const { store, fs } = await imported();
    const s = store.getState();
    expect(s.docs.size).toBe(expectedIndex().importedPaths.length);
    expect([...s.docs.keys()].sort()).toEqual(expectedIndex().importedPaths);
    expect(s.dirty.size).toBe(0);
    expect(s.importing).toBeNull();
    expect(s.workspaceName).toBe('graph');
    expectMatchesExpected(s.index);
    expect(await fs.getMeta()).toMatchObject({ id: 'default', name: 'graph', fileCount: s.docs.size });
    expect((await fs.getAll()).length).toBe(s.docs.size);
  });

  test('reports progress per batch of 50 and ends at done = total', async () => {
    const { store } = setup();
    const files: ImportedFile[] = Array.from({ length: 120 }, (_, i) => ({ path: `pages/p${i}.md`, text: `- block ${i}` }));
    const seen: number[] = [];
    store.subscribe((s) => {
      if (s.importing) seen.push(s.importing.done);
    });
    async function* gen() {
      for (const f of files) yield f;
    }
    await store.getState().importFiles('big', gen(), files.length);
    expect([...new Set(seen)]).toEqual([0, 50, 100, 120]);
    expect(store.getState().docs.size).toBe(120);
    expect(store.getState().importing).toBeNull();
  });

  test('a second import replaces the first (full overwrite) and notes shortfall', async () => {
    const { store, fs } = await imported();
    await store.getState().importFiles('other', [{ path: 'a.md', text: '- a' }], 3);
    const s = store.getState();
    expect([...s.docs.keys()]).toEqual(['a.md']);
    expect(await fs.listPaths()).toEqual(['a.md']);
    expect(s.workspaceName).toBe('other');
    expect(s.notices.some((n) => n.includes('2 个文件读取失败'))).toBe(true);
    expect(s.index.state.pages.has('basic page')).toBe(false);
  });
});

describe('workspace store: editing', () => {
  test('setBlockText marks the path dirty and persists exactly serialize(doc)', async () => {
    const { store, fs } = await imported();
    const first = findByContent(store.getState().docs.get(BASIC)!, 'First block');
    store.getState().setBlockText(BASIC, first.id, 'First block edited with [[Fresh]]');
    await store.flush();

    const s = store.getState();
    expect([...s.dirty]).toEqual([BASIC]);
    const rec = (await fs.get(BASIC))!;
    expect(rec.text).toBe(serialize(s.docs.get(BASIC)!));
    expect(rec.text).toContain('- First block edited with [[Fresh]]');
    expect(rec.importedText).not.toBe(rec.text);
    // index updated in the same step
    expect(s.index.state.pages.get('fresh')).toMatchObject({ name: 'Fresh', path: null });
    expect(s.index.backlinksForPage('link target')).toHaveLength(1);
  });

  test('an edit that restores the imported text clears dirty; a no-op edit never dirties', async () => {
    const { store } = await imported();
    const first = findByContent(store.getState().docs.get(BASIC)!, 'First block');
    const original = editableTextOf(first);
    store.getState().setBlockText(BASIC, first.id, original);
    expect(store.getState().dirty.size).toBe(0);
    store.getState().setBlockText(BASIC, first.id, 'changed');
    expect(store.getState().dirty.has(BASIC)).toBe(true);
    store.getState().setBlockText(BASIC, first.id, original);
    expect(store.getState().dirty.size).toBe(0);
  });

  test('insertAfter / indent / outdent / mergeWithPrevious go through the same write path', async () => {
    const { store, fs } = await imported();
    const get = () => store.getState();
    const third = findByContent(get().docs.get(BASIC)!, 'DONE third');
    const newId = get().insertAfter(BASIC, third.id);
    expect(newId).not.toBe(third.id);
    expect(get().docs.get(BASIC)!.blocks.map((b) => b.id)).toContain(newId);
    get().setBlockText(BASIC, newId, 'added');
    get().indent(BASIC, newId);
    expect(findByContent(get().docs.get(BASIC)!, 'DONE third').children.map((c) => c.id)).toEqual([newId]);
    get().outdent(BASIC, newId);
    expect(findByContent(get().docs.get(BASIC)!, 'DONE third').children).toEqual([]);
    const merged = get().mergeWithPrevious(BASIC, newId);
    expect(merged).toEqual({ blockId: third.id, caret: 'DONE third block'.length });
    await store.flush();
    expect((await fs.get(BASIC))!.text).toBe(serialize(get().docs.get(BASIC)!));
    // unknown ids are harmless
    expect(get().insertAfter(BASIC, 'nope')).toBe('nope');
    expect(get().mergeWithPrevious('missing.md', 'x')).toBeNull();
  });

  test('ensureBlockId on a block in another file dirties both files', async () => {
    const { store, fs } = await imported();
    const get = () => store.getState();
    const target = findByContent(get().docs.get(JOURNAL)!, 'unreferenced block');
    const referrer = findByContent(get().docs.get(BASIC)!, 'DONE third');

    // Editing BASIC, referencing a block that lives in the journal file.
    const id = get().ensureBlockId(BASIC, target.id);
    expect(id).toMatch(/^00000000-0000-4000-8000-/);
    expect([...get().dirty]).toEqual([JOURNAL]);
    get().setBlockText(BASIC, referrer.id, `DONE third ((${id}))`);
    await store.flush();

    expect([...get().dirty].sort()).toEqual([JOURNAL, BASIC].sort());
    expect((await fs.get(JOURNAL))!.text).toContain(`id:: ${id}`);
    expect(get().index.backlinksForBlock(id).map((b) => b.source.path)).toEqual([BASIC]);
    // idempotent: a block that already has a persistent id is returned as is
    expect(get().ensureBlockId(BASIC, id)).toBe(id);
    expect(get().ensureBlockId(BASIC, 'missing')).toBe('missing');
  });
});

describe('workspace store: export', () => {
  test("exportZip('changed') only carries dirty files and clears dirty afterwards", async () => {
    const { store, fs, zip } = await imported();
    const get = () => store.getState();
    const first = findByContent(get().docs.get(BASIC)!, 'First block');
    get().setBlockText(BASIC, first.id, 'First block edited');
    const target = findByContent(get().docs.get(JOURNAL)!, 'unreferenced');
    get().ensureBlockId(BASIC, target.id);

    await get().exportZip('changed');
    expect(zip).toHaveBeenCalledTimes(1);
    const [name, files] = zip.mock.calls[0];
    expect(name).toBe('graph-changed.zip');
    expect(files.map((f) => f.path)).toEqual([JOURNAL, BASIC]);
    expect(files[1].text).toBe(serialize(get().docs.get(BASIC)!));
    expect(get().dirty.size).toBe(0);
    const rec = (await fs.get(BASIC))!;
    expect(rec.importedText).toBe(rec.text);

    await get().exportZip('changed'); // nothing changed any more
    expect(zip).toHaveBeenCalledTimes(1);

    await get().exportZip('all');
    expect(zip.mock.calls[1][1].map((f) => f.path)).toEqual(expectedIndex().importedPaths);
  });

  test('a failing download keeps dirty and reports a notice', async () => {
    const { store, zip } = await imported();
    const first = findByContent(store.getState().docs.get(BASIC)!, 'First block');
    store.getState().setBlockText(BASIC, first.id, 'x');
    zip.mockRejectedValueOnce(new Error('disk full'));
    await store.getState().exportZip('changed');
    expect(store.getState().dirty.has(BASIC)).toBe(true);
    expect(store.getState().notices.at(-1)).toContain('disk full');
  });

  test('exportFile downloads one file and marks it exported', async () => {
    const { store, markdown } = await imported();
    const first = findByContent(store.getState().docs.get(BASIC)!, 'First block');
    store.getState().setBlockText(BASIC, first.id, 'x');
    await store.getState().exportFile(BASIC);
    expect(markdown).toHaveBeenCalledWith(BASIC, serialize(store.getState().docs.get(BASIC)!));
    expect(store.getState().dirty.size).toBe(0);
  });
});

describe('workspace store: boot', () => {
  test('a fresh store on the same IndexedDB restores docs, dirty and the index', async () => {
    const { store, fs } = await imported();
    const first = findByContent(store.getState().docs.get(BASIC)!, 'First block');
    store.getState().setBlockText(BASIC, first.id, 'First block persisted');
    await store.flush();

    const next = setup(fs);
    await next.store.getState().boot();
    const s = next.store.getState();
    expect(s.probe).toEqual({ indexedDb: { ok: true } });
    expect(s.docs.size).toBe(expectedIndex().importedPaths.length);
    expect([...s.dirty]).toEqual([BASIC]);
    expect(s.workspaceName).toBe('graph');
    expect(serialize(s.docs.get(BASIC)!)).toContain('- First block persisted');
    expect(s.index.search('persisted')).toHaveLength(1);
    expect(s.index.backlinksForBlock('11111111-1111-4111-8111-111111111111')).toHaveLength(2);
  });

  test('boot on an empty database yields an empty workspace', async () => {
    const { store } = setup();
    await store.getState().boot();
    expect(store.getState().docs.size).toBe(0);
    expect(store.getState().workspaceName).toBeNull();
    expect(store.getState().notices).toEqual([]);
  });

  test('unavailable storage stops boot with a notice instead of throwing', async () => {
    const fs = createFileStore('unused');
    const probe = vi.spyOn(fs, 'probe').mockResolvedValue({ indexedDb: { ok: false, reason: 'blocked' } });
    const getAll = vi.spyOn(fs, 'getAll');
    const { store } = setup(fs);
    await store.getState().boot();
    expect(probe).toHaveBeenCalled();
    expect(getAll).not.toHaveBeenCalled();
    expect(store.getState().probe).toEqual({ indexedDb: { ok: false, reason: 'blocked' } });
    expect(store.getState().notices[0]).toContain('blocked');
  });
});

describe('workspace store: navigation and rebuild', () => {
  let ctx: Awaited<ReturnType<typeof imported>>;
  beforeEach(async () => {
    ctx = await imported();
  });

  test('openPage resolves aliases and falls back to the key for unknown pages', () => {
    const { store } = ctx;
    store.getState().openPage('Basic');
    expect(store.getState().currentPage).toBe('basic page');
    store.getState().openPage('  Link Target ');
    expect(store.getState().currentPage).toBe('link target');
    store.getState().openPage('No Such Page');
    expect(store.getState().currentPage).toBe('no such page');
  });

  test('rebuildAll recomputes the index from docs and notifies subscribers', () => {
    const { store } = ctx;
    const before = store.getState().docs;
    store.getState().index.state.pages.clear();
    const listener = vi.fn();
    store.subscribe(listener);
    store.getState().rebuildAll();
    expect(listener).toHaveBeenCalled();
    expect(store.getState().docs).not.toBe(before);
    expectMatchesExpected(store.getState().index);
  });
});

/** A stream that yields `first`, then waits for `release()` before yielding the rest. */
function gated(first: ImportedFile, rest: ImportedFile[]) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  async function* gen() {
    yield first;
    await gate;
    yield* rest;
  }
  return { stream: gen(), release };
}

const byPath = (rs: FileRecord[]) => [...rs].sort((a, b) => (a.path < b.path ? -1 : 1));

describe('workspace store: atomic import (B1)', () => {
  test('a failing replaceAll leaves docs, dirty, index and IndexedDB exactly as before', async () => {
    const real = createFileStore(`mdgraph-store-test-${++dbCounter}`);
    // The real replaceAll rolls back when one record cannot be stored.
    const poisoned = { path: 'bad.md', text: (() => {}) as unknown as string, importedText: '', updatedAt: 0 };
    const failing: FileStore = { ...real, replaceAll: (records, meta) => real.replaceAll([...records, poisoned], meta) };
    const { store } = setup(real);
    const files = importedFiles();
    await store.getState().importFiles('graph', files, files.length);
    const first = findByContent(store.getState().docs.get(BASIC)!, 'First block');
    store.getState().setBlockText(BASIC, first.id, 'edited before the failed import');
    await store.flush();

    const before = { db: byPath(await real.getAll()), meta: await real.getMeta() };

    const second = setup(failing);
    await second.store.getState().boot();
    await second.store.getState().importFiles('other', [{ path: 'a.md', text: '- a' }], 1);
    const s = second.store.getState();
    expect([...s.docs.keys()].sort()).toEqual(expectedIndex().importedPaths);
    expect([...s.dirty]).toEqual([BASIC]);
    expect(s.workspaceName).toBe('graph');
    expect(s.importing).toBeNull();
    expect(s.notices.at(-1)).toContain('导入失败');
    expect(s.index.state.pages.has('basic page')).toBe(true);
    expect(s.index.state.pages.has('a')).toBe(false);
    expect(byPath(await real.getAll())).toEqual(before.db);
    expect(await real.getMeta()).toEqual(before.meta);
  });

  test('a replaceAll that throws (injected FileStore) keeps the in-memory workspace', async () => {
    const real = createFileStore(`mdgraph-store-test-${++dbCounter}`);
    const replaceAll = vi.fn<FileStore['replaceAll']>().mockRejectedValue(new Error('quota exceeded'));
    const { store } = setup({ ...real, replaceAll });
    await store.getState().importFiles('graph', [{ path: 'a.md', text: '- a' }], 1);
    const s = store.getState();
    expect(replaceAll).toHaveBeenCalledTimes(1);
    expect(s.docs.size).toBe(0);
    expect(s.workspaceName).toBeNull();
    expect(s.dirty.size).toBe(0);
    expect(s.notices.at(-1)).toContain('quota exceeded');
    expect(await real.getAll()).toEqual([]);
  });

  test('a read error halfway through the stream writes nothing and keeps the old workspace', async () => {
    const { store, fs } = await imported();
    const before = byPath(await fs.getAll());
    async function* broken() {
      yield { path: 'a.md', text: '- a' };
      throw new Error('disk unplugged');
    }
    await store.getState().importFiles('other', broken(), 2);
    const s = store.getState();
    expect([...s.docs.keys()].sort()).toEqual(expectedIndex().importedPaths);
    expect(s.workspaceName).toBe('graph');
    expect(s.notices.at(-1)).toContain('disk unplugged');
    expect(byPath(await fs.getAll())).toEqual(before);
  });

  test('nothing is persisted before the whole stream has been read', async () => {
    const { store, fs } = await imported();
    const g = gated({ path: 'a.md', text: '- a' }, [{ path: 'b.md', text: '- b' }]);
    const run = store.getState().importFiles('other', g.stream, 2);
    await new Promise((r) => setTimeout(r, 20));
    expect((await fs.listPaths()).sort()).toEqual(expectedIndex().importedPaths);
    g.release();
    await run;
    expect((await fs.listPaths()).sort()).toEqual(['a.md', 'b.md']);
  });
});

describe('workspace store: import serialization (B2)', () => {
  test('editing actions are no-ops while an import is running', async () => {
    const { store, fs } = await imported();
    const get = () => store.getState();
    const first = findByContent(get().docs.get(BASIC)!, 'First block');
    const docsBefore = get().docs;
    const g = gated({ path: 'a.md', text: '- a' }, []);
    const run = get().importFiles('other', g.stream, 1);
    expect(get().importing).not.toBeNull();

    get().setBlockText(BASIC, first.id, 'sneaky');
    expect(get().insertAfter(BASIC, first.id)).toBe(first.id);
    get().indent(BASIC, first.id);
    get().outdent(BASIC, first.id);
    expect(get().mergeWithPrevious(BASIC, first.id)).toBeNull();
    expect(get().ensureBlockId(BASIC, first.id)).toBe(first.id);
    await get().exportZip('all');

    expect(get().docs).toBe(docsBefore);
    expect(get().dirty.size).toBe(0);
    g.release();
    await run;
    expect([...get().docs.keys()]).toEqual(['a.md']);
    expect(get().dirty.size).toBe(0);
    expect((await fs.listPaths())).toEqual(['a.md']);
  });

  test('a second importFiles while one is running is rejected with a notice', async () => {
    const { store, fs } = setup();
    const g = gated({ path: 'a.md', text: '- a' }, [{ path: 'b.md', text: '- b' }]);
    const first = store.getState().importFiles('one', g.stream, 2);
    await store.getState().importFiles('two', [{ path: 'z.md', text: '- z' }], 1);
    expect(store.getState().importing).not.toBeNull();
    expect(store.getState().notices.at(-1)).toContain('正在导入');
    g.release();
    await first;
    expect([...store.getState().docs.keys()].sort()).toEqual(['a.md', 'b.md']);
    expect(store.getState().workspaceName).toBe('one');
    expect((await fs.listPaths()).sort()).toEqual(['a.md', 'b.md']);
    expect(store.getState().importing).toBeNull();
  });

  test('boot and import share one queue: whichever is called last wins, consistently with IndexedDB', async () => {
    const { fs } = await imported();
    const other = [{ path: 'z.md', text: '- z' }];

    const a = setup(fs);
    await Promise.all([a.store.getState().boot(), a.store.getState().importFiles('other', other, 1)]);
    expect([...a.store.getState().docs.keys()]).toEqual(['z.md']);
    expect(a.store.getState().workspaceName).toBe('other');
    expect(await fs.listPaths()).toEqual(['z.md']);

    const b = setup(fs);
    await Promise.all([b.store.getState().importFiles('again', [{ path: 'y.md', text: '- y' }], 1), b.store.getState().boot()]);
    expect([...b.store.getState().docs.keys()]).toEqual(['y.md']);
    expect(b.store.getState().workspaceName).toBe('again');
    expect(await fs.listPaths()).toEqual(['y.md']);
  });
});

describe('workspace store: export marking (B3)', () => {
  test('an edit made while the download is pending stays dirty; IndexedDB records the exported text', async () => {
    const { store, fs, zip } = await imported();
    const get = () => store.getState();
    const first = findByContent(get().docs.get(BASIC)!, 'First block');
    get().setBlockText(BASIC, first.id, 'exported version');
    let release!: () => void;
    zip.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));

    const exporting = get().exportZip('changed');
    await vi.waitFor(() => expect(zip).toHaveBeenCalledTimes(1));
    const exportedText = zip.mock.calls[0][1][0].text;
    expect(exportedText).toContain('- exported version');

    get().setBlockText(BASIC, first.id, 'edited during export');
    release();
    await exporting;
    await store.flush();

    expect(get().dirty.has(BASIC)).toBe(true);
    const rec = (await fs.get(BASIC))!;
    expect(rec.importedText).toBe(exportedText);
    expect(rec.text).toBe(serialize(get().docs.get(BASIC)!));
    expect(rec.text).toContain('- edited during export');

    // after reload the file is still dirty relative to what was exported
    const next = setup(fs);
    await next.store.getState().boot();
    expect(next.store.getState().dirty.has(BASIC)).toBe(true);
  });

  test('an export that finishes after the workspace was replaced does not touch the new files', async () => {
    const { store, fs, zip } = await imported();
    const get = () => store.getState();
    const first = findByContent(get().docs.get(BASIC)!, 'First block');
    get().setBlockText(BASIC, first.id, 'old edit');
    let release!: () => void;
    zip.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const exporting = get().exportZip('changed');
    await vi.waitFor(() => expect(zip).toHaveBeenCalledTimes(1));

    await get().importFiles('fresh', [{ path: BASIC, text: '- brand new' }], 1);
    release();
    await exporting;
    await store.flush();
    expect(get().dirty.size).toBe(0);
    expect(await fs.get(BASIC)).toMatchObject({ text: '- brand new', importedText: '- brand new' });
  });
});

describe('workspace store: reporting (S6, S7)', () => {
  test('failed paths carried by the stream end up in progress and in the closing notice', async () => {
    const { store } = setup();
    const failed: string[] = [];
    async function* gen() {
      yield { path: 'ok.md', text: '- ok' };
      failed.push('bad1.md', 'bad2.md', 'bad3.md', 'bad4.md');
    }
    const stream: ImportedFileStream = Object.assign(gen(), { failed });
    const seen: string[][] = [];
    store.subscribe((s) => s.importing && seen.push(s.importing.failed));
    await store.getState().importFiles('w', stream, 5);
    expect(seen.at(-1)).toEqual(failed);
    const note = store.getState().notices.at(-1)!;
    expect(note).toContain('4 个文件读取失败');
    expect(note).toContain('bad1.md、bad2.md、bad3.md 等');
    expect(note).not.toContain('bad4.md');
  });

  test('the same persistent id in two files raises a notice (import and boot)', async () => {
    const id = '33333333-3333-4333-8333-333333333333';
    const dup = [
      { path: 'a.md', text: `- one\n  id:: ${id}` },
      { path: 'b.md', text: `- two\n  id:: ${id}` },
    ];
    const { store, fs } = setup();
    await store.getState().importFiles('dups', dup, 2);
    expect(store.getState().notices.some((n) => n.includes(id) && n.includes('a.md') && n.includes('b.md'))).toBe(true);
    expect(store.getState().index.duplicateIds()).toEqual([{ id, paths: ['a.md', 'b.md'] }]);

    const next = setup(fs);
    await next.store.getState().boot();
    expect(next.store.getState().notices.some((n) => n.includes(id))).toBe(true);
  });
});
