/**
 * Shared parser contract. Every layer (parser, index, store, editor, views)
 * imports these types; do not fork them.
 *
 * Invariants that make `parse -> serialize` byte-identical:
 *  - A Document remembers file-level formatting (BOM, EOL, trailing newline,
 *    indent unit, continuation indent).
 *  - Every Block keeps `rawLines` = the exact source lines (without EOL) that
 *    belong to this block only (not its children). `rawLines === null` means
 *    the block was created or edited and must be regenerated on serialize.
 *  - Serializing an unmodified block MUST emit `rawLines` verbatim.
 */

export type TaskState = 'TODO' | 'DOING' | 'DONE' | null;

export type BulletMarker = '-' | '*' | '+';

export interface Property {
  key: string;
  value: string;
}

export interface Block {
  /**
   * Persistent id from an `id:: <uuid>` property line when present, otherwise a
   * transient runtime id prefixed with `tmp-`. Transient ids are never written
   * to disk and are not stable across reloads.
   */
  id: string;
  /** true iff `id` came from an `id::` property line in the source. */
  persistentId: boolean;
  /**
   * 'bullet' = an outliner block (`- `, `* ` or `+ ` line plus its continuation
   * lines). 'raw' = a run of top-level non-bullet lines (headings, paragraphs,
   * blank lines, front matter). Raw blocks have depth 0 and no children, and
   * are edited as one opaque text unit.
   */
  kind: 'bullet' | 'raw';
  /** Bullet marker used in source; '-' for new blocks. Ignored for raw blocks. */
  marker: BulletMarker;
  /** 0 for top-level. Depth is derived from indentation / Document.indentUnit. */
  depth: number;
  /**
   * Block body WITHOUT property lines, lines joined by '\n'. For bullet blocks
   * the first line is the head line (text after the marker). Task keyword is
   * kept inside content (e.g. "TODO buy milk"); `task` is derived from it.
   */
  content: string;
  /** Ordered `key:: value` lines belonging to this block, including `id`. */
  properties: Property[];
  task: TaskState;
  /** Page names referenced via [[Page]] or #tag / #[[tag]] (tags are also pages), de-duplicated, original casing. */
  links: string[];
  /** Subset of links that came from #tag syntax. */
  tags: string[];
  /** Block uuids referenced via ((uuid)). */
  refs: string[];
  /** Exact source lines for this block only; null => regenerate on serialize. */
  rawLines: string[] | null;
  children: Block[];
}

export interface Document {
  /** Relative path inside the imported folder, '/'-separated, e.g. "pages/foo.md". */
  path: string;
  bom: boolean;
  eol: '\n' | '\r\n';
  /** Whether the source ended with an EOL. */
  trailingNewline: boolean;
  /**
   * One level of indentation as it appears in this file: '\t', '  ' or '    '.
   * Detected from the first indented bullet line; default '  ' when the file
   * has no indented bullets.
   */
  indentUnit: string;
  /**
   * Prefix added (after the block's indentation) to continuation and property
   * lines of a bullet block. Detected from existing continuation lines; default
   * '  ' (aligns with text after "- ").
   */
  continuationIndent: string;
  /** Top-level blocks in source order. */
  blocks: Block[];
}

/** Flattened pre-order walk helper result. */
export interface BlockRef {
  path: string;
  block: Block;
  parent: Block | null;
}
