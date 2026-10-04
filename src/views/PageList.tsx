import { useMemo, useState } from 'react';
import type { PageEntry } from '../index/types';
import { useWorkspace } from '../store/workspace';

const firstLine = (s: string): string => s.split('\n', 1)[0] ?? '';

export default function PageList() {
  const docs = useWorkspace((s) => s.docs);
  const dirty = useWorkspace((s) => s.dirty);
  const index = useWorkspace((s) => s.index);
  const currentPage = useWorkspace((s) => s.currentPage);
  const openPage = useWorkspace((s) => s.openPage);
  const [query, setQuery] = useState('');

  // The index is mutable; `docs` changes identity whenever it does.
  const pages = useMemo(
    () => [...index.state.pages.values()].sort((a, b) => a.name.localeCompare(b.name)),
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [index, docs],
  );
  const byPath = useMemo(() => {
    const m = new Map<string, PageEntry>();
    for (const p of pages) if (p.path !== null) m.set(p.path, p);
    return m;
  }, [pages]);
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  const hits = useMemo(() => (query.trim() ? index.search(query) : null), [index, docs, query]);

  return (
    <nav className="page-list" aria-label="页面列表">
      <input
        type="search"
        className="page-search"
        placeholder="搜索块内容"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {hits ? (
        <ul className="page-items" aria-label="搜索结果">
          {hits.length === 0 && <li className="page-empty">无结果</li>}
          {hits.map((h) => {
            const page = byPath.get(h.path);
            const block = index.state.blocks.get(h.blockId)?.block;
            return (
              <li key={h.blockId}>
                <button type="button" className="page-item" onClick={() => openPage(page?.key ?? h.path)}>
                  <span className="hit-text">{block ? firstLine(block.content) || '(空块)' : ''}</span>
                  <span className="hit-page">{page?.name ?? h.path}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <ul className="page-items">
          {pages.length === 0 && <li className="page-empty">暂无页面，请先导入文件夹</li>}
          {pages.map((p) => (
            <li key={p.key}>
              <button
                type="button"
                className={p.key === currentPage ? 'page-item page-item-active' : 'page-item'}
                onClick={() => openPage(p.key)}
              >
                <span className="page-name">{p.name}</span>
                {p.path === null && <span className="tag tag-virtual">虚拟</span>}
                {p.path !== null && dirty.has(p.path) && <span className="tag tag-dirty">已改</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
