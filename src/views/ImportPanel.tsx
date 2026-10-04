import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { filesFromDrop, filesFromInput } from '../fs/import';
import type { ImportSource } from '../fs/import';
import { useWorkspace } from '../store/workspace';

export default function ImportPanel() {
  const importing = useWorkspace((s) => s.importing);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [over, setOver] = useState(false);

  const isBusy = (): boolean => useWorkspace.getState().importing !== null;

  const run = async (source: ImportSource): Promise<void> => {
    if (isBusy()) return;
    if (source.total === 0) {
      window.alert('所选内容里没有可导入的 .md 文件。');
      return;
    }
    await useWorkspace.getState().importFiles(source.rootName, source.files, source.total);
  };

  /** Full overwrite import (decision Q6-A): confirm first when there are unexported edits. */
  const confirmOverwrite = (): boolean => {
    const n = useWorkspace.getState().dirty.size;
    return n === 0 || window.confirm(`有 ${n} 个文件未导出，导入将覆盖它们。继续？`);
  };

  const onPick = (): void => {
    const input = inputRef.current;
    const list = input?.files;
    if (!input || !list || list.length === 0) return;
    const proceed = !isBusy() && confirmOverwrite();
    const source = proceed ? filesFromInput(list) : null;
    // Allow picking the same folder again.
    input.value = '';
    if (source) void run(source);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setOver(false);
    if (isBusy()) return;
    // Entries are only readable synchronously inside the drop event.
    const pending = filesFromDrop(e.dataTransfer.items);
    void pending.then((source) => (!isBusy() && confirmOverwrite() ? run(source) : undefined));
  };

  const busy = importing !== null;
  return (
    <div className="import-panel">
      <input
        ref={(el) => {
          inputRef.current = el;
          el?.setAttribute('webkitdirectory', '');
        }}
        type="file"
        multiple
        hidden
        data-testid="import-input"
        onChange={onPick}
      />
      <button type="button" disabled={busy} onClick={() => inputRef.current?.click()}>
        导入文件夹
      </button>
      <div
        className={over ? 'drop-zone drop-zone-over' : 'drop-zone'}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        {importing ? `导入中 ${importing.done}/${importing.total}` : '或将文件夹拖到这里'}
      </div>
    </div>
  );
}
