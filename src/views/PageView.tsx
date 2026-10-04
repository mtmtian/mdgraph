import { useWorkspace } from '../store/workspace';
import type { WorkspaceStore } from '../store/workspace';
import Outline from '../editor/Outline';
import Backlinks from './Backlinks';
import './PageView.css';

export default function PageView({ store }: { store?: WorkspaceStore }) {
  const useStore = store ?? useWorkspace;
  const currentPage = useStore((s) => s.currentPage);
  const docs = useStore((s) => s.docs);
  const dirty = useStore((s) => s.dirty);
  const index = useStore((s) => s.index);
  const exportFile = useStore((s) => s.exportFile);

  if (currentPage === null) return <p className="view-empty">从左侧选择一个页面。</p>;

  const entry = index.resolvePage(currentPage);
  const key = entry?.key ?? currentPage;
  const path = entry?.path && docs.has(entry.path) ? entry.path : null;
  const name = entry?.name ?? currentPage;

  return (
    <article className="page-view">
      <header className="page-head">
        <h2 className="page-title">
          {name}
          {path === null && <span className="tag tag-virtual">虚拟页（无文件）</span>}
          {path !== null && dirty.has(path) && <span className="tag tag-dirty">未导出</span>}
        </h2>
        {path !== null && (
          <div className="page-meta">
            <span className="page-path">{path}</span>
            <button type="button" onClick={() => void exportFile(path)}>
              导出此文件
            </button>
          </div>
        )}
      </header>
      {path !== null ? (
        <Outline path={path} store={store} />
      ) : (
        <p className="view-empty">此页面只被引用，尚无内容。</p>
      )}
      <Backlinks pageKey={key} path={path} store={store} />
    </article>
  );
}
