import { toKey } from '../index/pageName';
import type { WorkspaceStore } from '../store/workspace';
import type { InlineContext } from './inline';

/**
 * InlineContext backed by a workspace store. Shared by the editor (Outline)
 * and the read-only renderers (ReadOnlyBlocks / Backlinks via BlockText) so
 * `[[page]]`, `#tag` and `((uuid))` behave identically everywhere.
 */
export function makeInlineContext(store: WorkspaceStore): InlineContext {
  return {
    resolveBlock: (uuid) => {
      const first = store.getState().index.state.blocks.get(uuid)?.block.content.split('\n', 1)[0];
      return first === undefined ? undefined : first;
    },
    onOpenPage: (name) => store.getState().openPage(name),
    onOpenBlock: (uuid) => {
      const s = store.getState();
      const loc = s.index.state.blocks.get(uuid);
      if (!loc) return;
      for (const p of s.index.state.pages.values()) {
        if (p.path === loc.path) {
          s.openPage(p.key || toKey(p.name));
          break;
        }
      }
      setTimeout(() => document.getElementById(uuid)?.scrollIntoView?.({ block: 'center' }), 0);
    },
  };
}
