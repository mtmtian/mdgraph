import { useMemo, useState } from 'react';
import { nameFromPath } from '../index/pageName';
import type { Backlink } from '../index/types';
import type { Block } from '../parser/types';
import { editableTextOf } from '../store/types';
import { useWorkspace } from '../store/workspace';
import type { WorkspaceStore } from '../store/workspace';
import BlockText from './BlockText';
import { BlockTree } from './ReadOnlyBlocks';

const FLASH_MS = 1500;
const BREADCRUMB_MAX = 40;

function persistentBlocks(blocks: Block[], out: Block[] = []): Block[] {
  for (const b of blocks) {
    if (b.persistentId) out.push(b);
    persistentBlocks(b.children, out);
  }
  return out;
}

function countDescendants(b: Block): number {
  return b.children.reduce((n, c) => n + 1 + countDescendants(c), 0);
}

/** First content line, or the first non-id property line when the content is empty. */
function labelOf(b: Block): string {
  let text = (b.content.split('\n', 1)[0] ?? '').trim();
  if (text === '') {
    const prop = b.properties.find((p) => p.key !== 'id');
    if (prop) text = `${prop.key}:: ${prop.value}`.trim();
  }
  return text.length > BREADCRUMB_MAX ? `${text.slice(0, BREADCRUMB_MAX)}…` : text;
}

function flash(blockId: string, tries = 5): void {
  requestAnimationFrame(() => {
    const el = document.getElementById(blockId);
    if (!el) {
      if (tries > 1) flash(blockId, tries - 1);
      return;
    }
    el.scrollIntoView({ block: 'center' });
    el.classList.add('block-flash');
    setTimeout(() => el.classList.remove('block-flash'), FLASH_MS);
  });
}

interface Group {
  path: string;
  name: string;
  pageKey: string;
  items: Backlink[];
}

export default function Backlinks({
  pageKey,
  path,
  store,
}: {
  pageKey: string;
  path: string | null;
  store?: WorkspaceStore;
}) {
  const useStore = store ?? useWorkspace;
  const docs = useStore((s) => s.docs);
  const index = useStore((s) => s.index);
  const openPage = useStore((s) => s.openPage);

  const groups = useMemo<Group[]>(() => {
    // The index is mutable; `docs` changes identity on every write and is the recompute trigger.
    const all = [...index.backlinksForPage(pageKey)];
    const doc = path === null ? undefined : docs.get(path);
    if (doc) for (const b of persistentBlocks(doc.blocks)) all.push(...index.backlinksForBlock(b.id));

    const seen = new Set<string>();
    const map = new Map<string, Group>();
    for (const bl of all) {
      const src = bl.source.path;
      if (src === path) continue;
      const id = `${src}\u0000${bl.source.block.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const entry = index.pageOfPath(src);
      const group = map.get(src) ?? { path: src, name: entry?.name ?? nameFromPath(src), pageKey: entry?.key ?? nameFromPath(src), items: [] };
      group.items.push(bl);
      map.set(src, group);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [index, docs, pageKey, path]);

  const total = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <section className="backlinks" aria-label="反向链接">
      <h3 className="backlinks-title">
        反向链接 <span className="backlinks-count">{total}</span>
      </h3>
      {groups.length === 0 && <p className="view-empty">没有反向链接</p>}
      {groups.map((g) => (
        <section key={g.path} className="bl-group" aria-label={`来自 ${g.name}`}>
          <h4 className="bl-group-title">
            {g.name} <span className="backlinks-count">{g.items.length}</span>
          </h4>
          <ul className="bl-items">
            {g.items.map((bl) => (
              <BacklinkItem
                key={bl.source.block.id}
                bl={bl}
                pageName={g.name}
                store={store}
                onJump={() => {
                  openPage(g.pageKey);
                  flash(bl.source.block.id);
                }}
              />
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}

function BacklinkItem({
  bl,
  pageName,
  store,
  onJump,
}: {
  bl: Backlink;
  pageName: string;
  store?: WorkspaceStore;
  onJump: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { block, ancestors } = bl.source;
  const childCount = countDescendants(block);
  const crumbs = [pageName, ...ancestors.map(labelOf)];
  return (
    <li className="bl-item">
      <button type="button" className="bl-crumbs" onClick={onJump}>
        {crumbs.map((c, i) => (
          <span key={i} className="bl-crumb">
            {i > 0 && <span className="bl-sep"> › </span>}
            {c}
          </span>
        ))}
      </button>
      <span className="bl-via">{bl.via}</span>
      {/* Mouse convenience only; the breadcrumb button is the keyboard-accessible jump. */}
      <div className="bl-text" onClick={onJump}>
        <BlockText text={editableTextOf(block)} store={store} />
      </div>
      {childCount > 0 && (
        <div className="bl-children">
          <button type="button" className="bl-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? '▾' : '▸'} {childCount} 个子块
          </button>
          {open && <BlockTree blocks={block.children} baseDepth={block.depth + 1} store={store} />}
        </div>
      )}
    </li>
  );
}
