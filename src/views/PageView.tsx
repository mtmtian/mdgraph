import type { Block } from '../parser/types';
import { useWorkspace } from '../store/workspace';

function flatten(blocks: Block[], out: Block[] = []): Block[] {
  for (const b of blocks) {
    out.push(b);
    flatten(b.children, out);
  }
  return out;
}

/** Read-only placeholder; M4 (Outline) and M5 (PageView/Backlinks) replace it. */
export default function PageView() {
  const currentPage = useWorkspace((s) => s.currentPage);
  const docs = useWorkspace((s) => s.docs);
  const dirty = useWorkspace((s) => s.dirty);
  const index = useWorkspace((s) => s.index);

  const entry = currentPage === null ? undefined : index.resolvePage(currentPage);
  const doc = entry?.path ? docs.get(entry.path) : undefined;
  const blocks = doc ? flatten(doc.blocks) : [];

  if (currentPage === null) return <p className="view-empty">从左侧选择一个页面。</p>;

  const title = entry?.name ?? currentPage;
  return (
    <article className="page-view">
      <h2 className="page-title">
        {title}
        {!doc && <span className="tag tag-virtual">虚拟页</span>}
        {entry?.path && dirty.has(entry.path) && <span className="tag tag-dirty">已改</span>}
      </h2>
      {entry?.path && <div className="page-path">{entry.path}</div>}
      <ul className="block-list">
        {blocks.map((b) => (
          <li key={b.id} id={b.id} style={{ paddingLeft: `${b.depth * 1.25}rem` }}>
            {b.content.split('\n', 1)[0] || ' '}
          </li>
        ))}
      </ul>
      <section className="backlinks-placeholder">反链面板由 M5 提供</section>
    </article>
  );
}
