import type { Block } from '../parser/types';
import { useWorkspace } from '../store/workspace';
import type { WorkspaceStore } from '../store/workspace';
import { editableTextOf } from '../store/types';
import BlockText from './BlockText';

interface TreeProps {
  blocks: Block[];
  /** Depth that renders with zero indent (the first level shown). */
  baseDepth?: number;
  /** Put each block's id on its container so it can be scrolled to. Off for embedded subtrees. */
  withIds?: boolean;
  store?: WorkspaceStore;
}

/** Read-only render of a block tree (pre-order, indented by depth). */
export function BlockTree({ blocks, baseDepth = 0, withIds = false, store }: TreeProps) {
  return (
    <>
      {blocks.map((b) => (
        <div key={b.id} className="ro-node">
          <div
            id={withIds ? b.id : undefined}
            className={b.kind === 'raw' ? 'ro-block ro-raw' : 'ro-block'}
            style={{ paddingLeft: `${Math.max(0, b.depth - baseDepth) * 1.25}rem` }}
          >
            {b.kind === 'bullet' && <span className="ro-bullet" aria-hidden="true">•</span>}
            <BlockText text={editableTextOf(b)} store={store} />
          </div>
          {b.children.length > 0 && <BlockTree blocks={b.children} baseDepth={baseDepth} withIds={withIds} store={store} />}
        </div>
      ))}
    </>
  );
}

/** Read-only page body: the document at `path` as an indented block tree. */
export default function ReadOnlyBlocks({ path, store }: { path: string; store?: WorkspaceStore }) {
  const useStore = store ?? useWorkspace;
  const doc = useStore((s) => s.docs.get(path));
  if (!doc) return null;
  return (
    <div className="ro-blocks">
      <BlockTree blocks={doc.blocks} withIds store={store} />
    </div>
  );
}
