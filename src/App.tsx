import { useEffect } from 'react';
import './App.css';
import { useWorkspace } from './store/workspace';
import ExportPanel from './views/ExportPanel';
import ImportPanel from './views/ImportPanel';
import PageList from './views/PageList';
import PageView from './views/PageView';
import StorageBanner from './views/StorageBanner';

export default function App() {
  const workspaceName = useWorkspace((s) => s.workspaceName);
  const rebuildAll = useWorkspace((s) => s.rebuildAll);

  useEffect(() => {
    void useWorkspace.getState().boot();
  }, []);

  return (
    <div className="app">
      <header className="app-top">
        <h1 className="app-title">mdgraph</h1>
        <span className="app-workspace" title="当前工作区">
          {workspaceName ?? '未导入'}
        </span>
        <ImportPanel />
        <ExportPanel />
        <button type="button" onClick={rebuildAll}>
          全量重建索引
        </button>
      </header>
      <StorageBanner />
      <div className="app-body">
        <aside className="app-side">
          <PageList />
        </aside>
        <main className="app-main">
          <PageView />
        </main>
      </div>
    </div>
  );
}
