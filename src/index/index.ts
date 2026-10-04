import { extractInline } from '../parser/syntax';
import type { Block, Document } from '../parser/types';
import { nameFromPath, titleOf, toKey } from './pageName';
import { searchTextOf, tokenize } from './searchIndex';
import type { Backlink, BlockLocation, IndexApi, Indexes, PageEntry, PageKey, SearchHit } from './types';

/** Everything one document put into the shared maps, so it can be undone exactly. */
interface Contribution {
  blockIds: string[];
  /** Page keys this document references (keys of `pageBacklinks` / `refNames` it touched). */
  linkKeys: string[];
  /** Block uuids (lower-cased) this document references. */
  refIds: string[];
  /** The real page this file backs. */
  entry: PageEntry;
}

/**
 * One file's claim on a block id. Persistent ids can repeat across files; the
 * first holder is the owner shown in `state.blocks` / `state.search`, and when
 * it goes away the next holder takes over.
 */
interface Holder {
  path: string;
  loc: BlockLocation;
  /** Position inside its document, for stable search ordering. */
  seq: number;
  tokens: string[];
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function removeFrom<K, V>(map: Map<K, V[]>, key: K, drop: (v: V) => boolean): void {
  const list = map.get(key);
  if (!list) return;
  const kept = list.filter((v) => !drop(v));
  if (kept.length === 0) map.delete(key);
  else if (kept.length !== list.length) map.set(key, kept);
}


export function createIndex(): IndexApi {
  const state: Indexes = {
    blocks: new Map(),
    pages: new Map(),
    pageBacklinks: new Map(),
    blockBacklinks: new Map(),
    search: new Map(),
  };
  const holders = new Map<string, Holder[]>();
  const contributions = new Map<string, Contribution>();
  const keyToPaths = new Map<PageKey, string[]>();
  const aliasToPaths = new Map<PageKey, string[]>();
  /** Original spellings of referenced page names, in first-seen order, with the referencing path. */
  const refNames = new Map<PageKey, Array<{ path: string; name: string }>>();

  const entryOf = (path: string): PageEntry | undefined => contributions.get(path)?.entry;

  function activate(id: string, h: Holder): void {
    state.blocks.set(id, h.loc);
    for (const token of h.tokens) {
      let ids = state.search.get(token);
      if (!ids) state.search.set(token, (ids = new Set()));
      ids.add(id);
    }
  }

  function deactivate(id: string, h: Holder): void {
    state.blocks.delete(id);
    for (const token of h.tokens) {
      const ids = state.search.get(token);
      if (!ids) continue;
      ids.delete(id);
      if (ids.size === 0) state.search.delete(token);
    }
  }

  function recomputePage(key: PageKey): void {
    const owner = keyToPaths.get(key)?.[0];
    const entry = owner === undefined ? undefined : entryOf(owner);
    if (entry) {
      state.pages.set(key, entry);
      return;
    }
    if (aliasToPaths.has(key)) {
      state.pages.delete(key);
      return;
    }
    const names = refNames.get(key);
    if (names && names.length > 0) {
      const old = state.pages.get(key);
      if (!old || old.path !== null || old.name !== names[0].name) {
        state.pages.set(key, { key, name: names[0].name, path: null, aliases: [] });
      }
      return;
    }
    state.pages.delete(key);
  }

  function removeDocument(path: string): void {
    const c = contributions.get(path);
    if (!c) return;
    contributions.delete(path);
    for (const id of c.blockIds) {
      const list = holders.get(id);
      const at = list ? list.findIndex((h) => h.path === path) : -1;
      if (!list || at < 0) continue;
      const [gone] = list.splice(at, 1);
      if (at === 0) {
        deactivate(id, gone);
        if (list.length > 0) activate(id, list[0]);
      }
      if (list.length === 0) holders.delete(id);
    }
    const fromPath = (b: Backlink) => b.source.path === path;
    for (const key of c.linkKeys) {
      removeFrom(state.pageBacklinks, key, fromPath);
      removeFrom(refNames, key, (r) => r.path === path);
    }
    for (const id of c.refIds) removeFrom(state.blockBacklinks, id, fromPath);

    removeFrom(keyToPaths, c.entry.key, (p) => p === path);
    for (const a of c.entry.aliases) removeFrom(aliasToPaths, a, (p) => p === path);

    for (const key of new Set([...c.linkKeys, c.entry.key, ...c.entry.aliases])) recomputePage(key);
  }

  function addDocument(doc: Document): void {
    const path = doc.path;
    const derived = nameFromPath(path);
    const title = titleOf(doc);
    const name = title ?? derived;
    const key = toKey(name);
    const aliases = toKey(derived) !== key ? [toKey(derived)] : [];
    const entry: PageEntry = { key, name, path, aliases };
    pushTo(keyToPaths, key, path);
    for (const a of aliases) pushTo(aliasToPaths, a, path);

    const c: Contribution = { blockIds: [], linkKeys: [], refIds: [], entry };
    contributions.set(path, c);
    const linkKeys = new Set<string>();
    const refIds = new Set<string>();
    let seq = 0;

    const visit = (blocks: Block[], ancestors: Block[]): void => {
      for (const block of blocks) {
        const loc: BlockLocation = { path, block, ancestors };
        const holder: Holder = { path, loc, seq: seq++, tokens: [...new Set(tokenize(searchTextOf(block)))] };
        const list = holders.get(block.id);
        if (list) list.push(holder);
        else {
          holders.set(block.id, [holder]);
          activate(block.id, holder);
        }
        c.blockIds.push(block.id);

        // page references
        if (block.links.length > 0) {
          // Without property lines every link comes from the content; otherwise re-extract
          // from the content alone so links found only in properties are told apart.
          const src = block.properties.some((p) => p.key !== 'id') ? extractInline(block.content) : block;
          const contentLinks = new Set(src.links);
          const contentTags = new Set(src.tags);
          const seen = new Set<string>();
          for (const link of block.links) {
            const target = toKey(link);
            if (!target || seen.has(target)) continue;
            seen.add(target);
            const via = !contentLinks.has(link) ? 'property' : contentTags.has(link) ? 'tag' : 'link';
            pushTo(state.pageBacklinks, target, { source: loc, via });
            pushTo(refNames, target, { path, name: link.trim() });
            linkKeys.add(target);
          }
        }

        // block references
        for (const ref of block.refs) {
          const id = ref.toLowerCase();
          pushTo(state.blockBacklinks, id, { source: loc, via: 'ref' });
          refIds.add(id);
        }

        visit(block.children, [...ancestors, block]);
      }
    };
    visit(doc.blocks, []);
    c.linkKeys = [...linkKeys];
    c.refIds = [...refIds];

    for (const k of new Set([...c.linkKeys, key, ...aliases])) recomputePage(k);
  }

  function upsertDocument(doc: Document): void {
    removeDocument(doc.path);
    addDocument(doc);
  }

  function resolvePage(nameOrKey: string): PageEntry | undefined {
    const key = toKey(nameOrKey);
    const direct = state.pages.get(key);
    if (direct) return direct;
    const owner = aliasToPaths.get(key)?.[0];
    return owner === undefined ? undefined : entryOf(owner);
  }

  function duplicateIds(): Array<{ id: string; paths: string[] }> {
    const out: Array<{ id: string; paths: string[] }> = [];
    for (const [id, list] of holders) {
      if (list.length > 1) out.push({ id, paths: [...new Set(list.map((h) => h.path))] });
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  function backlinksForPage(nameOrKey: string): Backlink[] {
    const key = toKey(nameOrKey);
    const entry = resolvePage(key);
    const keys = new Set<PageKey>([key]);
    if (entry) {
      keys.add(entry.key);
      for (const a of entry.aliases) keys.add(a);
    }
    const seen = new Set<string>();
    const out: Backlink[] = [];
    for (const k of keys) {
      for (const b of state.pageBacklinks.get(k) ?? []) {
        const id = `${b.source.path}\u0000${b.source.block.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(b);
      }
    }
    return out;
  }

  function search(query: string, limit = 50): SearchHit[] {
    const tokens = [...new Set(tokenize(query))];
    if (tokens.length === 0) return [];
    const counts = new Map<string, number>();
    for (const t of tokens) {
      for (const id of state.search.get(t) ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const located: SearchHit[] = [];
    for (const [blockId, score] of counts) {
      const loc = state.blocks.get(blockId);
      if (loc) located.push({ path: loc.path, blockId, score });
    }
    const full = located.filter((h) => h.score === tokens.length);
    // Intersection first; with no block containing every token, fall back to the union.
    const hits = full.length > 0 ? full : located;
    hits.sort(
      (a, b) =>
        b.score - a.score ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
        (holders.get(a.blockId)?.[0].seq ?? 0) - (holders.get(b.blockId)?.[0].seq ?? 0),
    );
    return hits.slice(0, limit);
  }

  return {
    upsertDocument,
    removeDocument,
    rebuildAll(docs) {
      state.blocks.clear();
      state.pages.clear();
      state.pageBacklinks.clear();
      state.blockBacklinks.clear();
      state.search.clear();
      holders.clear();
      keyToPaths.clear();
      aliasToPaths.clear();
      refNames.clear();
      contributions.clear();
      for (const doc of docs) upsertDocument(doc);
    },
    resolvePage,
    pageOfPath: entryOf,
    duplicateIds,
    backlinksForPage,
    backlinksForBlock: (blockId) => state.blockBacklinks.get(blockId.toLowerCase()) ?? [],
    search,
    state,
  };
}
