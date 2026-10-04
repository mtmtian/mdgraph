import { useMemo } from 'react';
import { renderInline } from '../editor/inline';
import { makeInlineContext } from '../editor/inlineContext';
import { useWorkspace } from '../store/workspace';
import type { WorkspaceStore } from '../store/workspace';

/**
 * Read-only block text used by ReadOnlyBlocks and the Backlinks panel.
 * Delegates to the editor's `renderInline` so `[[Page]]`, `#tag`, `((uuid))`,
 * inline code, bold and italic look and behave exactly as in the editor.
 */
export default function BlockText({ text, task = true, store }: { text: string; task?: boolean; store?: WorkspaceStore }) {
  const useStore = store ?? useWorkspace;
  const ctx = useMemo(() => makeInlineContext(useStore), [useStore]);
  // Links rendered by renderInline stop propagation themselves, so a click on
  // plain text still bubbles to the surrounding backlink item.
  return <span className="block-text">{text === '' ? ' ' : renderInline(text, ctx, { task })}</span>;
}
