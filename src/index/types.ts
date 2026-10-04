/**
 * Index contract. All indexes live in memory and are derived purely from
 * parsed Documents. They are rebuilt per changed file (incremental) and can be
 * rebuilt from scratch at any time.
 */
import type { Block, Document } from '../parser/types';

/** Lower-cased, trimmed page name. `[[Foo Bar]]`, `#foo bar`, "Foo bar.md" all map to "foo bar". */
export type PageKey = string;

export interface PageEntry {
  key: PageKey;
  /** Display name: `title::` property if the file has one, else name derived from the file name (namespace-decoded, journal-formatted). */
  name: string;
  /** Relative path of the backing file, or null for a virtual page (only referenced, no file). */
  path: string | null;
  /** Alternate keys that resolve to this page (e.g. the raw file-derived name when `title::` overrides it). */
  aliases: PageKey[];
}

export interface BlockLocation {
  path: string;
  block: Block;
  /** Ancestors from the top-level block down to the direct parent; used for breadcrumbs. */
  ancestors: Block[];
}

export interface Backlink {
  /** The referencing block. */
  source: BlockLocation;
  /** Which syntax produced the reference. */
  via: 'link' | 'tag' | 'ref' | 'property';
}

export interface SearchHit {
  path: string;
  blockId: string;
  /** Simple relevance: number of matched tokens; ties broken by path then order. */
  score: number;
}

export interface Indexes {
  /** Every block by its id (persistent uuid or transient id). */
  blocks: Map<string, BlockLocation>;
  /** Every known page, real or virtual. */
  pages: Map<PageKey, PageEntry>;
  /** Blocks that reference a page (by key) via [[link]], #tag or property value. */
  pageBacklinks: Map<PageKey, Backlink[]>;
  /** Blocks that reference a block uuid via ((uuid)). */
  blockBacklinks: Map<string, Backlink[]>;
  /** Token -> block ids containing it. */
  search: Map<string, Set<string>>;
}

export interface IndexApi {
  /** Replace all index entries for `doc.path` with entries derived from `doc`. */
  upsertDocument(doc: Document): void;
  /** Remove all entries derived from a path (file deleted or re-imported). */
  removeDocument(path: string): void;
  /** Drop everything and index all docs. The "全量重建" fallback. */
  rebuildAll(docs: Iterable<Document>): void;
  resolvePage(nameOrKey: string): PageEntry | undefined;
  backlinksForPage(key: PageKey): Backlink[];
  backlinksForBlock(blockId: string): Backlink[];
  search(query: string, limit?: number): SearchHit[];
  readonly state: Indexes;
}

/** Page-name helpers shared by index and views (implemented in index/pageName.ts). */
export interface PageNameApi {
  /** "pages/a%2Fb.md" -> "a/b"; "pages/a___b.md" -> "a/b"; "journals/2022_06_25.md" -> "Jun 25th, 2022". */
  nameFromPath(path: string): string;
  toKey(name: string): PageKey;
}
