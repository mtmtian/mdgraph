import { useWorkspace } from '../store/workspace';

export default function ExportPanel() {
  const fileCount = useWorkspace((s) => s.docs.size);
  const dirtyCount = useWorkspace((s) => s.dirty.size);
  const importing = useWorkspace((s) => s.importing !== null);
  const exportZip = useWorkspace((s) => s.exportZip);

  return (
    <div className="export-panel">
      <button type="button" disabled={importing || fileCount === 0} onClick={() => void exportZip('all')}>
        导出全部 zip
      </button>
      <button type="button" disabled={importing || dirtyCount === 0} onClick={() => void exportZip('changed')}>
        导出仅改动 zip ({dirtyCount})
      </button>
    </div>
  );
}
