import type { ImportedFile, ImportedFileStream, ImportProgress } from '../storage/types.ts';

export interface ImportSource {
  /** Carries the live list of unreadable paths in `failed`. */
  files: ImportedFileStream;
  total: number;
  rootName: string;
  /** Original relative paths that were filtered out (not .md, hidden, logseq/, bak, .recycle). */
  skipped: string[];
}

export interface ImportOptions {
  onProgress?: (p: ImportProgress) => void;
  batchSize?: number;
}

export interface PlannedImport {
  kept: Array<{ path: string; file: File }>;
  skipped: string[];
  rootName: string;
}

const DEFAULT_BATCH = 32;

function normalize(p: string): string[] {
  return p.replace(/\\/g, '/').split('/').filter((s) => s !== '');
}

function isIgnored(segs: string[]): boolean {
  if (segs.length === 0) return true;
  if (!segs[segs.length - 1].toLowerCase().endsWith('.md')) return true;
  if (segs[0] === 'logseq') return true;
  return segs.some((s) => s.startsWith('.') || s === 'bak' || s === '.recycle');
}

/**
 * Generic planner shared by the FileList and drag-and-drop paths so the latter can
 * avoid resolving File handles for skipped entries.
 */
export function planPaths<T>(
  entries: Array<{ relativePath: string; item: T }>,
): { kept: Array<{ path: string; item: T }>; skipped: string[]; rootName: string } {
  const split = entries.map((e) => ({ ...e, segs: normalize(e.relativePath) }));
  let rootName = '';
  if (split.length > 0 && split.every((e) => e.segs.length > 1)) {
    const first = split[0].segs[0];
    if (split.every((e) => e.segs[0] === first)) rootName = first;
  }
  const kept: Array<{ path: string; item: T }> = [];
  const skipped: string[] = [];
  for (const e of split) {
    const segs = rootName ? e.segs.slice(1) : e.segs;
    if (isIgnored(segs)) skipped.push(e.segs.join('/'));
    else kept.push({ path: segs.join('/'), item: e.item });
  }
  return { kept, skipped, rootName };
}

/** Pure: strip the shared root folder and apply the PLAN §4 import filter. */
export function planImport(entries: Array<{ relativePath: string; file: File }>): PlannedImport {
  const r = planPaths(entries.map((e) => ({ relativePath: e.relativePath, item: e.file })));
  return {
    kept: r.kept.map((k) => ({ path: k.path, file: k.item })),
    skipped: r.skipped,
    rootName: r.rootName,
  };
}

// Blob.text() applies the UTF-8 decode algorithm, which silently drops a leading BOM.
// The BOM must survive import (PLAN §3.1), so decode manually with ignoreBOM, and fail
// on invalid UTF-8 rather than corrupting the file with U+FFFD.
async function readText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
}

const yieldToMain = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Read files `batchSize` at a time, yielding to the main thread between batches. Never throws on
 * a single bad file; the stream's `failed` property lists the paths that could not be read.
 */
export function readInBatches(
  kept: Array<{ path: string; file: File }>,
  onProgress?: (p: ImportProgress) => void,
  batchSize = DEFAULT_BATCH,
): ImportedFileStream {
  const failed: string[] = [];
  return Object.assign(readBatches(kept, failed, onProgress, batchSize), { failed });
}

async function* readBatches(
  kept: Array<{ path: string; file: File }>,
  failed: string[],
  onProgress: ((p: ImportProgress) => void) | undefined,
  batchSize: number,
): AsyncGenerator<ImportedFile> {
  const total = kept.length;
  const size = Math.max(1, Math.floor(batchSize));
  for (let i = 0; i < total; i += size) {
    const batch = kept.slice(i, i + size);
    const results = await Promise.all(
      batch.map(async (k): Promise<ImportedFile | null> => {
        try {
          return { path: k.path, text: await readText(k.file) };
        } catch {
          failed.push(k.path);
          return null;
        }
      }),
    );
    onProgress?.({ done: i + batch.length, total, failed: [...failed] });
    for (const r of results) if (r) yield r;
    if (i + size < total) await yieldToMain();
  }
  if (total === 0) onProgress?.({ done: 0, total: 0, failed: [] });
}

/** `<input type="file" webkitdirectory>` entry point. */
export function filesFromInput(list: FileList | File[], opts: ImportOptions = {}): ImportSource {
  const arr = Array.from(list);
  const plan = planImport(
    arr.map((file) => ({ relativePath: file.webkitRelativePath || file.name, file })),
  );
  return {
    files: readInBatches(plan.kept, opts.onProgress, opts.batchSize),
    total: plan.kept.length,
    rootName: plan.rootName,
    skipped: plan.skipped,
  };
}

function readAllEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const out: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    const next = () =>
      reader.readEntries((batch) => {
        // readEntries returns a limited chunk per call; an empty array signals the end.
        if (batch.length === 0) resolve(out);
        else {
          out.push(...batch);
          next();
        }
      }, reject);
    next();
  });
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walk(
  entry: FileSystemEntry,
  prefix: string,
  out: Array<{ relativePath: string; item: FileSystemFileEntry }>,
): Promise<void> {
  const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    out.push({ relativePath: rel, item: entry as FileSystemFileEntry });
  } else if (entry.isDirectory) {
    for (const child of await readAllEntries(entry as FileSystemDirectoryEntry)) {
      await walk(child, rel, out);
    }
  }
}

/** Drag-and-drop entry point (`DataTransferItemList`). */
export async function filesFromDrop(
  items: DataTransferItemList | DataTransferItem[],
  opts: ImportOptions = {},
): Promise<ImportSource> {
  // DataTransfer items are only valid synchronously inside the drop event, so grab all entries first.
  const roots: FileSystemEntry[] = [];
  for (const it of Array.from(items)) {
    if (it.kind && it.kind !== 'file') continue;
    const e = it.webkitGetAsEntry?.();
    if (e) roots.push(e);
  }
  const found: Array<{ relativePath: string; item: FileSystemFileEntry }> = [];
  for (const r of roots) await walk(r, '', found);
  const plan = planPaths(found);
  const size = Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_BATCH));
  const kept: Array<{ path: string; file: File }> = [];
  for (let i = 0; i < plan.kept.length; i += size) {
    const batch = plan.kept.slice(i, i + size);
    const files = await Promise.all(batch.map((k) => fileOf(k.item)));
    batch.forEach((k, j) => kept.push({ path: k.path, file: files[j] }));
  }
  return {
    files: readInBatches(kept, opts.onProgress, opts.batchSize),
    total: kept.length,
    rootName: plan.rootName,
    skipped: plan.skipped,
  };
}
