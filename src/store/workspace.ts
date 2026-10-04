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
import type { FileRecord, FileStore, ImportedFile, ImportedFileStream, WorkspaceMeta } from '../storage/types';
import type { WorkspaceState } from './types';

const PARSE_BATCH = 50;
const FAILED_SHOWN = 3;

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

/** The zustand hook plus `flush()`: resolves once every queued IndexedDB operation has finished. */
export type WorkspaceStore = UseBoundStore<StoreApi<WorkspaceState>> & { flush(): Promise<void> };

/** Everything the workspace knows about one file. `dirty` <=> `text !== importedText`. */
interface FileState {
  doc: Document;
  /** serialize(doc), cached. */
  text: string;
  /** Text at import / last export. */
  importedText: string;
}

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

  /** The single source of truth for file contents; `docs` and `dirty` in the store are derived from it by `publish`. */
  let files = new Map<string, FileState>();
  /** Bumped whenever `files` is replaced wholesale (boot / import), so stale export bookkeeping can be dropped. */
  let epoch = 0;
  let booting: Promise<void> | null = null;

  /** Every IndexedDB operation goes through this one queue: boot reads, edits, imports, export marks. */
  let tail: Promise<unknown> = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  }
  const flush = (): Promise<void> => tail.then(() => undefined);

  const useStore = create<WorkspaceState>()((set, get) => {
    const notice = (msg: string) => set((s) => ({ notices: [...s.notices, msg] }));

    /**
     * Derive `docs` and `dirty` from `files`, for `paths` only or (null) from scratch,
     * and set them together with `extra`.
     */
    function publish(paths: Iterable<string> | null, extra: Partial<WorkspaceState> = {}): void {
      const docs = paths === null ? new Map<string, Document>() : new Map(get().docs);
      const dirty = paths === null ? new Set<string>() : new Set(get().dirty);
      for (const p of paths ?? files.keys()) {
        const f = files.get(p);
        if (!f) {
          docs.delete(p);
          dirty.delete(p);
          continue;
        }
        docs.set(p, f.doc);
        if (f.text !== f.importedText) dirty.add(p);
        else dirty.delete(p);
      }
      set({ ...extra, docs, dirty });
    }

    /** Edits are frozen while an import is replacing the workspace. */
    const docOf = (path: string): Document | undefined => (get().importing ? undefined : files.get(path)?.doc);

    /** Write path after an op produced `doc`: serialize -> persist (queued) -> index -> publish. */
    function commit(doc: Document): void {
      const path = doc.path;
      const prev = files.get(path);
      if (!prev) return;
      const text = serialize(doc);
      files.set(path, { doc, text, importedText: prev.importedText });
      const stamp = now();
      enqueue(() => fileStore.updateText(path, text, stamp)).catch((e) => notice(`保存失败：${messageOf(e)}`));
      index.upsertDocument(doc);
      publish([path]);
    }

    /** Apply a document-to-document op to one file. */
    function edit(path: string, op: (doc: Document) => Document): void {
      const doc = docOf(path);
      if (!doc) return;
      const next = op(doc);
      if (next !== doc) commit(next);
    }

    /** Locate the document that holds a block, preferring `path`. */
    function locate(path: string, blockId: string): Document | undefined {
      const preferred = docOf(path);
      if (preferred && ops.findBlock(preferred, blockId)) return preferred;
      const owner = index.state.blocks.get(blockId)?.path;
      return owner === undefined ? undefined : docOf(owner);
    }

    function noticeConflicts(): void {
      const dups = index.duplicateIds();
      if (dups.length === 0) return;
      const shown = dups
        .slice(0, FAILED_SHOWN)
        .map((d) => `${d.id}（${d.paths.join('、')}）`)
        .join('；');
      notice(`发现 ${dups.length} 个块 id 在多个文件中重复，仅第一个文件的块可被引用：${shown}${dups.length > FAILED_SHOWN ? ' 等' : ''}`);
    }

    /** Swap in a freshly built file set: index, derived state and conflict notice in one step. */
    function adopt(next: Map<string, FileState>, extra: Partial<WorkspaceState>): void {
      files = next;
      epoch++;
      index.rebuildAll([...next.values()].map((f) => f.doc));
      publish(null, extra);
      noticeConflicts();
    }

    async function bootTask(): Promise<void> {
      const probe = await fileStore.probe();
      set({ probe });
      if (!probe.indexedDb.ok) {
        notice(`浏览器存储不可用（${probe.indexedDb.reason}）：无法保存工作区，刷新后需重新导入。隐私窗口通常会禁用 IndexedDB。`);
        return;
      }
      try {
        const [meta, records] = await Promise.all([fileStore.getMeta(), fileStore.getAll()]);
        const next = new Map<string, FileState>();
        for (let i = 0; i < records.length; i += PARSE_BATCH) {
          for (const r of records.slice(i, i + PARSE_BATCH)) {
            next.set(r.path, { doc: parse(r.path, r.text), text: r.text, importedText: r.importedText });
          }
          if (i + PARSE_BATCH < records.length) await yieldToMain();
        }
        adopt(next, { workspaceName: meta?.name ?? null });
      } catch (e) {
        notice(`读取已保存的工作区失败：${messageOf(e)}`);
      }
    }

    /**
     * Read + parse everything first (progress reported here), then land it in IndexedDB in one
     * transaction, and only then replace the in-memory state. Any failure leaves both untouched.
     */
    async function importTask(workspaceName: string, source: AsyncIterable<ImportedFile> | ImportedFile[], total: number): Promise<void> {
      const stream = source as ImportedFileStream;
      const next = new Map<string, FileState>();
      let received = 0;
      const progress = () => set({ importing: { done: received, total, failed: [...(stream.failed ?? [])] } });
      for await (const f of stream) {
        next.set(f.path, { doc: parse(f.path, f.text), text: f.text, importedText: f.text });
        received++;
        if (received % PARSE_BATCH === 0) {
          progress();
          await yieldToMain();
        }
      }
      if (received % PARSE_BATCH !== 0) progress();

      const stamp = now();
      const records: FileRecord[] = [...next].map(([path, f]) => ({ path, text: f.text, importedText: f.text, updatedAt: stamp }));
      const meta: WorkspaceMeta = { id: 'default', name: workspaceName, importedAt: stamp, fileCount: next.size };
      await fileStore.replaceAll(records, meta);

      adopt(next, { workspaceName, currentPage: null, importing: null });
      if (received < total) {
        const failed = stream.failed ?? [];
        const names = failed.length > 0 ? `：${failed.slice(0, FAILED_SHOWN).join('、')}${failed.length > FAILED_SHOWN ? ' 等' : ''}` : '';
        notice(`${total - received} 个文件读取失败，已跳过${names}。`);
      }
    }

    /** Record that `exported` is now what the user has on disk (unless the workspace was replaced meanwhile). */
    function markExported(exported: ExportFile[], at: number): Promise<void> {
      return enqueue(async () => {
        if (at !== epoch) return;
        await fileStore.markExported(exported);
        for (const f of exported) {
          const cur = files.get(f.path);
          if (cur) files.set(f.path, { ...cur, importedText: f.text });
        }
        publish(exported.map((f) => f.path));
      });
    }

    function snapshot(paths: Iterable<string>): ExportFile[] {
      const out: ExportFile[] = [];
      for (const path of paths) {
        const f = files.get(path);
        if (f) out.push({ path, text: f.text });
      }
      return out;
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
        booting ??= enqueue(bootTask)
          .catch((e) => notice(`启动失败：${messageOf(e)}`))
          .finally(() => {
            booting = null;
          });
        return booting;
      },

      async importFiles(workspaceName, source, total) {
        if (get().importing) {
          notice('正在导入，请等当前导入结束后再试。');
          return;
        }
        set({ importing: { done: 0, total, failed: [] } });
        try {
          await enqueue(() => importTask(workspaceName, source, total));
        } catch (e) {
          notice(`导入失败：${messageOf(e)}`);
        } finally {
          set({ importing: null });
        }
      },

      rebuildAll() {
        index.rebuildAll([...files.values()].map((f) => f.doc));
        // New Map identity so subscribers re-read the (mutable) index.
        publish(null);
      },

      openPage(nameOrKey) {
        set({ currentPage: index.resolvePage(nameOrKey)?.key ?? toKey(nameOrKey) });
      },

      setBlockText(path, blockId, editableText) {
        edit(path, (doc) => ops.setBlockText(doc, blockId, editableText));
      },

      insertAfter(path, blockId) {
        const doc = docOf(path);
        const r = doc ? ops.insertAfter(doc, blockId) : null;
        if (!r) return blockId;
        commit(r.doc);
        return r.id;
      },

      indent(path, blockId) {
        edit(path, (doc) => ops.indent(doc, blockId));
      },

      outdent(path, blockId) {
        edit(path, (doc) => ops.outdent(doc, blockId));
      },

      mergeWithPrevious(path, blockId) {
        const doc = docOf(path);
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
        if (get().importing) return;
        await flush();
        const list = snapshot((mode === 'changed' ? [...get().dirty] : [...files.keys()]).sort());
        if (list.length === 0) return;
        const name = get().workspaceName ?? 'mdgraph';
        const at = epoch;
        try {
          await download.zip(mode === 'changed' ? `${name}-changed.zip` : `${name}.zip`, list);
          await markExported(list, at);
        } catch (e) {
          notice(`导出失败：${messageOf(e)}`);
        }
      },

      async exportFile(path) {
        if (get().importing) return;
        await flush();
        const list = snapshot([path]);
        if (list.length === 0) return;
        const at = epoch;
        try {
          await download.markdown(path, list[0].text);
          await markExported(list, at);
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
