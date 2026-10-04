import { useState } from 'react';
import { useWorkspace } from '../store/workspace';

export default function StorageBanner() {
  const probe = useWorkspace((s) => s.probe);
  const notices = useWorkspace((s) => s.notices);
  const [seen, setSeen] = useState(0);
  const visible = notices.slice(seen);

  const storage = probe?.indexedDb;
  return (
    <div className="banner-area">
      {storage && !storage.ok && (
        <div className="banner banner-warn" role="alert">
          存储不可用：{storage.reason}。仍可浏览已导入的内容，但刷新后不会保留。
        </div>
      )}
      {storage?.ok && (
        <div className="banner banner-ok" role="status">
          存储可用（IndexedDB）
        </div>
      )}
      {visible.length > 0 && (
        <div className="banner banner-warn" role="alert">
          <ul>
            {visible.map((n, i) => (
              <li key={seen + i}>{n}</li>
            ))}
          </ul>
          <button type="button" onClick={() => setSeen(notices.length)}>
            关闭
          </button>
        </div>
      )}
    </div>
  );
}
