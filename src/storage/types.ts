/**
 * Storage contract. Only IndexedDB is used (decision Q4-A). Indexes are NOT
 * persisted; they are rebuilt in memory from FileRecords at startup.
 */

export interface FileRecord {
  /** Relative path inside the imported folder, '/'-separated. Primary key. */
  path: string;
  /** Current text (may contain local edits). Exact bytes as string; BOM/EOL preserved. */
  text: string;
  /** Text as it was at import time. `dirty` <=> text !== importedText. */
  importedText: string;
  /** Epoch ms of last local modification (or import). */
  updatedAt: number;
}

export interface WorkspaceMeta {
  /** Always 'default' (single workspace, decision Q6-A). */
  id: 'default';
  /** Top-level folder name chosen by the user at import (display only). */
  name: string;
  importedAt: number;
  fileCount: number;
}

export interface StorageProbe {
  indexedDb: { ok: true } | { ok: false; reason: string };
}

export interface FileStore {
  probe(): Promise<StorageProbe>;
  getMeta(): Promise<WorkspaceMeta | null>;
  putMeta(meta: WorkspaceMeta): Promise<void>;
  listPaths(): Promise<string[]>;
  getAll(): Promise<FileRecord[]>;
  get(path: string): Promise<FileRecord | null>;
  /** Upsert many records in one transaction. */
  putMany(records: FileRecord[]): Promise<void>;
  /** Overwrite `text` only; leaves importedText untouched. */
  updateText(path: string, text: string, updatedAt: number): Promise<void>;
  /** After a successful export: importedText = text for the given paths. */
  markExported(paths: string[]): Promise<void>;
  /** Drop every record and meta (used before a fresh import). */
  clear(): Promise<void>;
}

/** Output of the fs/import layer, independent of DOM File objects so it is unit-testable. */
export interface ImportedFile {
  /** Relative path with the chosen root folder stripped, '/'-separated, e.g. "pages/a.md". */
  path: string;
  text: string;
}

export interface ImportProgress {
  done: number;
  total: number;
  /** Paths that could not be read/decoded; import continues past them. */
  failed: string[];
}
