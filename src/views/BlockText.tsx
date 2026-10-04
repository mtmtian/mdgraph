import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { useWorkspace } from '../store/workspace';
import type { WorkspaceStore } from '../store/workspace';

/**
 * Plain-text block rendering with clickable `[[Page]]`, `#tag` and `#[[tag]]`.
 * Inline code spans are left alone. No bold/italic: the editor's `renderInline`
 * replaces this once M4 is merged.
 */
const TOKEN = /`[^`\n]*`|#\[\[([^[\]]+)\]\]|\[\[([^[\]]+)\]\]|#([^\s#]*[^\s#,.;:!?)\]])/g;

type Part = { text: string; page?: string };

function split(text: string): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index;
    const bare = m[3] !== undefined;
    // `#tag` only counts at the start of the text or after whitespace.
    if (bare && at > 0 && !/\s/.test(text[at - 1] ?? '')) continue;
    const page = m[1] ?? m[2] ?? m[3];
    if (page === undefined) continue; // inline code
    if (at > last) parts.push({ text: text.slice(last, at) });
    parts.push({ text: m[0], page });
    last = at + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

export default function BlockText({ text, store }: { text: string; store?: WorkspaceStore }) {
  const useStore = store ?? useWorkspace;
  const openPage = useStore((s) => s.openPage);
  const nodes: ReactNode[] = split(text).map((p, i) =>
    p.page === undefined ? (
      <Fragment key={i}>{p.text}</Fragment>
    ) : (
      <button
        key={i}
        type="button"
        className="inline-link"
        onClick={(e) => {
          e.stopPropagation();
          openPage(p.page!);
        }}
      >
        {p.text}
      </button>
    ),
  );
  return <span className="block-text">{nodes}</span>;
}
