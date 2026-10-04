import type { FileRecord, FileStore, StorageProbe, WorkspaceMeta } from './types.ts';

const FILES = 'files';
const META = 'meta';
const DB_VERSION = 1;

function reasonOf(e: unknown): string {
  if (typeof e === 'string' && e) return e;
  // Duck-typed: DOMException is not always `instanceof Error` across realms.
  const msg = (e as { message?: unknown } | null)?.message;
  if (typeof msg === 'string' && msg) return msg;
  return 'IndexedDB 打开失败';
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB 请求失败'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'));
  });
}

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof globalThis.indexedDB === 'undefined' || globalThis.indexedDB === null) {
      reject(new Error('IndexedDB 不可用'));
      return;
    }
    let r: IDBOpenDBRequest;
    try {
      r = globalThis.indexedDB.open(name, DB_VERSION);
    } catch (e) {
      reject(new Error(reasonOf(e)));
      return;
    }
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: 'path' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB 打开失败'));
    r.onblocked = () => reject(new Error('IndexedDB 被其他标签页占用'));
  });
}

export function createFileStore(dbName = 'mdgraph'): FileStore {
  let dbPromise: Promise<IDBDatabase> | null = null;

  function db(): Promise<IDBDatabase> {
    if (!dbPromise) {
      const p = openDb(dbName).then((d) => {
        d.onversionchange = () => {
          d.close();
          if (dbPromise === p) dbPromise = null;
        };
        return d;
      });
      p.catch(() => {
        if (dbPromise === p) dbPromise = null;
      });
      dbPromise = p;
    }
    return dbPromise;
  }

  return {
    async probe(): Promise<StorageProbe> {
      if (typeof globalThis.indexedDB === 'undefined' || globalThis.indexedDB === null) {
        return { indexedDb: { ok: false, reason: 'IndexedDB 不可用' } };
      }
      try {
        await db();
        return { indexedDb: { ok: true } };
      } catch (e) {
        return { indexedDb: { ok: false, reason: reasonOf(e) } };
      }
    },

    async getMeta() {
      const d = await db();
      const r = await req<WorkspaceMeta | undefined>(d.transaction(META, 'readonly').objectStore(META).get('default'));
      return r ?? null;
    },

    async putMeta(meta) {
      const d = await db();
      const tx = d.transaction(META, 'readwrite');
      tx.objectStore(META).put(meta);
      await done(tx);
    },

    async listPaths() {
      const d = await db();
      const keys = await req(d.transaction(FILES, 'readonly').objectStore(FILES).getAllKeys());
      return keys.map(String);
    },

    async getAll() {
      const d = await db();
      return req<FileRecord[]>(d.transaction(FILES, 'readonly').objectStore(FILES).getAll());
    },

    async get(path) {
      const d = await db();
      const r = await req<FileRecord | undefined>(d.transaction(FILES, 'readonly').objectStore(FILES).get(path));
      return r ?? null;
    },

    async putMany(records) {
      const d = await db();
      const tx = d.transaction(FILES, 'readwrite');
      const s = tx.objectStore(FILES);
      for (const r of records) s.put(r);
      await done(tx);
    },

    async updateText(path, text, updatedAt) {
      const d = await db();
      const tx = d.transaction(FILES, 'readwrite');
      const s = tx.objectStore(FILES);
      const finished = done(tx);
      const rec = await req<FileRecord | undefined>(s.get(path));
      if (!rec) {
        tx.abort();
        await finished.catch(() => undefined);
        throw new Error(`文件不存在: ${path}`);
      }
      s.put({ ...rec, text, updatedAt });
      await finished;
    },

    async markExported(paths) {
      const d = await db();
      const tx = d.transaction(FILES, 'readwrite');
      const s = tx.objectStore(FILES);
      const finished = done(tx);
      for (const p of paths) {
        const rec = await req<FileRecord | undefined>(s.get(p));
        if (rec) s.put({ ...rec, importedText: rec.text });
      }
      await finished;
    },

    async clear() {
      const d = await db();
      const tx = d.transaction([FILES, META], 'readwrite');
      tx.objectStore(FILES).clear();
      tx.objectStore(META).clear();
      await done(tx);
    },
  };
}
