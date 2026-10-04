/**
 * Store contract (zustand). The ONLY write path for views and the editor.
 * Views never touch storage or the parser directly; they read from `docs`
 * and `index`, and call actions.
 *
 * Write path for every edit: mutate the Document via parser/ops ->
 * serialize that one file -> storage.updateText -> index.upsertDocument(doc).
 */
import type { Block, Document } from '../parser/types';
import type { IndexApi } from '../index/types';
import type { ImportProgress, ImportedFile, StorageProbe } from '../storage/types';

export type ExportMode = 'all' | 'changed';

export interface WorkspaceState {
  /** null until storage probe finished. */
  probe: StorageProbe | null;
  workspaceName: string | null;
  /** Parsed documents by path. Source of truth for views together with `index`. */
  docs: Map<string, Document>;
  /** Paths whose text differs from importedText. */
  dirty: Set<string>;
  index: IndexApi;
  importing: ImportProgress | null;
  /** Page key currently shown; null = page list / empty state. */
  currentPage: string | null;
  /** Non-fatal messages for the UI banner (storage unavailable, import failures, conflicts). */
  notices: string[];

  // ---- lifecycle ----
  /** Probe storage, load FileRecords, parse all, rebuild index. Called once at startup. */
  boot(): Promise<void>;
  /**
   * Replace the workspace with these files (decision Q6-A: full overwrite).
   * Caller must have confirmed if `dirty.size > 0`. Parses in batches and
   * reports progress through `importing`.
   */
  importFiles(workspaceName: string, files: AsyncIterable<ImportedFile> | ImportedFile[], total: number): Promise<void>;
  rebuildAll(): void;

  // ---- navigation ----
  openPage(nameOrKey: string): void;

  // ---- editing (all take a path + blockId, return the affected block id) ----
  /** Replace a block's editable text (content + non-id property lines, see Q15-A). */
  setBlockText(path: string, blockId: string, editableText: string): void;
  /** Enter: new empty sibling after this block (or first child when the block has children and is expanded). */
  insertAfter(path: string, blockId: string): string;
  /** Tab: become last child of previous sibling. No-op when there is no previous sibling. */
  indent(path: string, blockId: string): void;
  /** Shift+Tab: move after parent as parent's sibling. No-op at depth 0. */
  outdent(path: string, blockId: string): void;
  /** Backspace at offset 0: append content to previous visible block and delete this one. Returns the surviving block id and the caret offset. */
  mergeWithPrevious(path: string, blockId: string): { blockId: string; caret: number } | null;
  /**
   * Make sure the block has a persistent `id::` (decision Q3-A: only when
   * referenced). Writes the property into its file if needed and returns the uuid.
   */
  ensureBlockId(path: string, blockId: string): string;

  // ---- export ----
  /** Build a zip (fflate) of all or changed-only files, trigger download, then mark exported. */
  exportZip(mode: ExportMode): Promise<void>;
  /** Download a single .md, then mark it exported. */
  exportFile(path: string): Promise<void>;
}

/**
 * Text shown in the editor textarea for a block. Mirrors what
 * parser/ops.setBlockText expects back:
 *  - bullet: head line, property lines except id, remaining content lines
 *  - raw:    the block's content verbatim (it already contains its property lines)
 */
export function editableTextOf(block: Block): string {
  if (block.kind === 'raw') return block.content;
  const props = block.properties.filter((p) => p.key !== 'id').map((p) => `${p.key}:: ${p.value}`);
  const lines = block.content.split('\n');
  return [lines[0] ?? '', ...props, ...lines.slice(1)].join('\n');
}
