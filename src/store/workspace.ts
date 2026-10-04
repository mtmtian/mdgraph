import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import { downloadMarkdown, downloadZip } from '../fs/export';
import type { ExportFile } from '../fs/export';
import { createIndex } from '../index/index';
import { toKey } from '../index/pageName';
import type { IndexApi } from '../index/types';
import * as ops from '../parser/ops';
import { parse } from '../parser/parse';
import { serialize } from '../parser/serialize';
import type { Document } from '../parser/types';
import { createFileStore } from '../storage/idb';
import type { FileRecord, FileStore, ImportedFile } from '../storage/types';
import type { WorkspaceState } from './types';

const PARSE_BATCH = 50;

export interface WorkspaceDeps {
  fileStore: FileStore;
  index?: IndexApi;
  now?: () => number;
  uuid?: () => string;
  download?: {
    zip(filename: string, files: ExportFile[]): Promise<void>;
    markdown(path: string, text: string): void | Promise<void>;
  };
}

/** The zustand hook plus `flush()`: resolves once every queued IndexedDB write has landed. */
export type WorkspaceStore = UseBoundStore<StoreApi<WorkspaceState>> & { flush(): Promise<void> };

const yieldToMain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function messageOf(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e);
}

export function createWorkspaceStore(deps: WorkspaceDeps): WorkspaceStore {
  const { fileStore } = deps;
  const index = deps.index ?? createIndex();
  const now = deps.now ?? (() => Date.now());
  const uuid = deps.uuid ?? (() => crypto.randomUUID());
  const download = deps.download ?? { zip: downloadZip, markdown: downloadMarkdown };

  /** Current serialized text and the text at import/last export, per path. `dirty` = they differ. */
  const texts = new Map<string, string>();
  const imported = new Map<string, string>();
  /** Serial queue of IndexedDB writes, so edits to one file land in order. */
  let pending: Promise<void> = Promise.resolve();
  let booting: Promise<void> | null = null;
  const flush = () => pending;

  const useStore = create<WorkspaceState>()((set, get) => {
    const notice = (msg: string) => set((s) => ({ notices: [...s.notices, msg] }));

    function enqueue(task: () => Promise<void>, what: string): void {
      pending = pending.then(task).catch((e) => notice(`${what}失败：${messageOf(e)}`));
    }

    function dirtyWith(paths: Iterable<string>): Set<string> {
      const dirty = new Set(get().dirty);
      for (const p of paths) {
        if (texts.get(p) !== imported.get(p) && texts.has(p)) dirty.add(p);
        else dirty.delete(p);
      }
      return dirty;
    }

    /** Write path after an op produced `doc`: serialize -> persist (queued) -> index -> publish. */
    function commit(doc: Document): void {
      const path = doc.path;
      const text = serialize(doc);
      texts.set(path, text);
      const stamp = now();
      enqueue(() => fileStore.updateText(path, text, stamp), '保存');
      index.upsertDocument(doc);
      set({ docs: new Map(get().docs).set(path, doc), dirty: dirtyWith([path]) });
    }

    /** Locate the document that holds a block, preferring `path`. */
    function locate(path: string, blockId: string): Document | undefined {
      const preferred = get().docs.get(path);
      if (preferred && ops.findBlock(preferred, blockId)) return preferred;
      const owner = index.state.blocks.get(blockId)?.path;
      return owner === undefined ? undefined : get().docs.get(owner);
    }

    async function parseRecords(records: FileRecord[]): Promise<Map<string, Document>> {
      const docs = new Map<string, Document>();
      for (let i = 0; i < records.length; i += PARSE_BATCH) {
        for (const r of records.slice(i, i + PARSE_BATCH)) docs.set(r.path, parse(r.path, r.text));
        if (i + PARSE_BATCH < records.length) await yieldToMain();
      }
      return docs;
    }

    async function markExported(files: ExportFile[]): Promise<void> {
      const paths = files.map((f) => f.path);
      await fileStore.markExported(paths);
      for (const f of files) imported.set(f.path, f.text);
      set({ dirty: dirtyWith(paths) });
    }

    async function bootOnce(): Promise<void> {
      const probe = await fileStore.probe();
      set({ probe });
      if (!probe.indexedDb.ok) {
        notice(`浏览器存储不可用（${probe.indexedDb.reason}）：无法保存工作区，刷新后需重新导入。隐私窗口通常会禁用 IndexedDB。`);
        return;
      }
      try {
        const [meta, records] = await Promise.all([fileStore.getMeta(), fileStore.getAll()]);
        texts.clear();
        imported.clear();
        for (const r of records) {
          texts.set(r.path, r.text);
          imported.set(r.path, r.importedText);
        }
        const docs = await parseRecords(records);
        index.rebuildAll(docs.values());
        set({ workspaceName: meta?.name ?? null, docs, dirty: dirtyWith(docs.keys()) });
      } catch (e) {
        notice(`读取已保存的工作区失败：${messageOf(e)}`);
      }
    }

    return {
      probe: null,
      workspaceName: null,
      docs: new Map(),
      dirty: new Set(),
      index,
      importing: null,
      currentPage: null,
      notices: [],

      boot() {
        booting ??= bootOnce().finally(() => {
          booting = null;
        });
        return booting;
      },

      async importFiles(workspaceName, files, total) {
        set({ importing: { done: 0, total, failed: [] } });
        try {
          await flush();
          await fileStore.clear();
          texts.clear();
          imported.clear();
          const docs = new Map<string, Document>();
          let batch: ImportedFile[] = [];
          const stamp = now();
          const drain = async (): Promise<void> => {
            if (batch.length === 0) return;
            const records: FileRecord[] = batch.map((f) => ({
              path: f.path,
              text: f.text,
              importedText: f.text,
              updatedAt: stamp,
            }));
            for (const f of batch) {
              docs.set(f.path, parse(f.path, f.text));
              texts.set(f.path, f.text);
              imported.set(f.path, f.text);
            }
            batch = [];
            await fileStore.putMany(records);
            set({ importing: { done: docs.size, total, failed: [] } });
            await yieldToMain();
          };
          for await (const f of files) {
            batch.push(f);
            if (batch.length >= PARSE_BATCH) await drain();
          }
          await drain();
          await fileStore.putMeta({ id: 'default', name: workspaceName, importedAt: stamp, fileCount: docs.size });
          index.rebuildAll(docs.values());
          set({ workspaceName, docs, dirty: new Set(), currentPage: null });
          if (docs.size < total) notice(`${total - docs.size} 个文件读取失败，已跳过。`);
        } catch (e) {
          notice(`导入失败：${messageOf(e)}`);
        } finally {
          set({ importing: null });
        }
      },

      rebuildAll() {
        const docs = get().docs;
        index.rebuildAll(docs.values());
        // New Map identity so subscribers re-read the (mutable) index.
        set({ docs: new Map(docs) });
      },

      openPage(nameOrKey) {
        set({ currentPage: index.resolvePage(nameOrKey)?.key ?? toKey(nameOrKey) });
      },

      setBlockText(path, blockId, editableText) {
        const doc = get().docs.get(path);
        if (!doc) return;
        const next = ops.setBlockText(doc, blockId, editableText);
        if (next !== doc) commit(next);
      },

      insertAfter(path, blockId) {
        const doc = get().docs.get(path);
        const r = doc ? ops.insertAfter(doc, blockId) : null;
        if (!r) return blockId;
        commit(r.doc);
        return r.id;
      },

      indent(path, blockId) {
        const doc = get().docs.get(path);
        if (!doc) return;
        const next = ops.indent(doc, blockId);
        if (next !== doc) commit(next);
      },

      outdent(path, blockId) {
        const doc = get().docs.get(path);
        if (!doc) return;
        const next = ops.outdent(doc, blockId);
        if (next !== doc) commit(next);
      },

      mergeWithPrevious(path, blockId) {
        const doc = get().docs.get(path);
        const r = doc ? ops.mergeWithPrevious(doc, blockId) : null;
        if (!r) return null;
        commit(r.doc);
        return { blockId: r.blockId, caret: r.caret };
      },

      ensureBlockId(path, blockId) {
        // The referenced block may live in a different file than the one being edited.
        const doc = locate(path, blockId);
        if (!doc) return blockId;
        const found = ops.findBlock(doc, blockId);
        if (!found || found.block.persistentId) return blockId;
        const id = uuid();
        const next = ops.ensureId(doc, blockId, id);
        if (next === doc) return blockId;
        commit(next);
        return id;
      },

      async exportZip(mode) {
        await flush();
        const paths = (mode === 'changed' ? [...get().dirty] : [...texts.keys()]).sort();
        if (paths.length === 0) return;
        const files = paths.map((p) => ({ path: p, text: texts.get(p)! }));
        const name = get().workspaceName ?? 'mdgraph';
        try {
          await download.zip(mode === 'changed' ? `${name}-changed.zip` : `${name}.zip`, files);
          await markExported(files);
        } catch (e) {
          notice(`导出失败：${messageOf(e)}`);
        }
      },

      async exportFile(path) {
        await flush();
        const text = texts.get(path);
        if (text === undefined) return;
        try {
          await download.markdown(path, text);
          await markExported([{ path, text }]);
        } catch (e) {
          notice(`导出失败：${messageOf(e)}`);
        }
      },
    };
  });

  return Object.assign(useStore, { flush });
}

/** Application-wide store backed by the real IndexedDB file store (opened lazily). */
export const useWorkspace = createWorkspaceStore({ fileStore: createFileStore() });
