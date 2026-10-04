import type { ReactNode } from 'react';

export interface InlineContext {
  /** First line of the referenced block's content, or undefined when the uuid is unknown. */
  resolveBlock(uuid: string): string | undefined;
  onOpenPage(name: string): void;
  onOpenBlock(uuid: string): void;
}

const PROPERTY_RE = /^\s*([^\s:]+):: ?([^]*)$/;
const TASK_RE = /^(TODO|DOING|DONE)(?: |$)/;
const FENCE_RE = /^\s*```/;

// One alternation, leftmost match wins. URLs come first so a `#` inside a URL is never a tag.
const TOKEN_RE = new RegExp(
  [
    '(?<url>https?://[^\\s<>"\']*[^\\s<>"\'.,;:!?)\\]])',
    '`(?<code>[^`]+)`',
    '\\*\\*(?<bold>[^*\\s](?:[^*]*[^*\\s])?)\\*\\*',
    '\\*(?<italic>[^*\\s](?:[^*]*[^*\\s])?)\\*',
    '(?<=^|\\s)#\\[\\[(?<tagLong>[^\\[\\]]+)\\]\\]',
    '\\[\\[(?<page>[^\\[\\]]+)\\]\\]',
    '(?<=^|\\s)#(?![\\[#])(?<tag>[^\\s#]*[^\\s#,.;:!?)\\]])',
    '\\(\\((?<ref>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\)\\)',
  ].join('|'),
  'gi',
);

function activate(fn: () => void) {
  return {
    role: 'link' as const,
    tabIndex: 0,
    onClick: (e: { stopPropagation(): void }) => {
      e.stopPropagation();
      fn();
    },
    onKeyDown: (e: { key: string; stopPropagation(): void; preventDefault(): void }) => {
      if (e.key === 'Enter') {
        e.stopPropagation();
        e.preventDefault();
        fn();
      }
    },
  };
}

function renderSpans(text: string, ctx: InlineContext, keyPrefix: string, nested: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  const key = () => `${keyPrefix}.${n++}`;
  for (const m of text.matchAll(TOKEN_RE)) {
    const at = m.index;
    if (at > last) out.push(text.slice(last, at));
    last = at + m[0].length;
    const g = m.groups ?? {};
    if (g.url !== undefined) {
      out.push(<span key={key()} className="inline-url">{m[0]}</span>);
    } else if (g.code !== undefined) {
      out.push(<code key={key()} className="inline-code">{g.code}</code>);
    } else if (g.bold !== undefined) {
      out.push(<strong key={key()}>{nested ? g.bold : renderSpans(g.bold, ctx, key(), true)}</strong>);
    } else if (g.italic !== undefined) {
      out.push(<em key={key()}>{nested ? g.italic : renderSpans(g.italic, ctx, key(), true)}</em>);
    } else if (g.page !== undefined) {
      const name = g.page;
      out.push(
        <span key={key()} className="inline-link inline-page" {...activate(() => ctx.onOpenPage(name))}>
          <span className="inline-bracket">[[</span>{name}<span className="inline-bracket">]]</span>
        </span>,
      );
    } else if (g.tagLong !== undefined || g.tag !== undefined) {
      const name = (g.tagLong ?? g.tag) as string;
      out.push(
        <span key={key()} className="inline-link inline-tag" {...activate(() => ctx.onOpenPage(name))}>
          #{g.tagLong !== undefined ? `[[${name}]]` : name}
        </span>,
      );
    } else if (g.ref !== undefined) {
      const uuid = g.ref;
      const target = ctx.resolveBlock(uuid);
      out.push(
        target === undefined ? (
          <span key={key()} className="inline-link inline-ref inline-ref-missing" {...activate(() => ctx.onOpenBlock(uuid))}>
            {m[0]}
          </span>
        ) : (
          <span key={key()} className="inline-link inline-ref" {...activate(() => ctx.onOpenBlock(uuid))}>
            {target || m[0]}
          </span>
        ),
      );
    }
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Minimal inline Markdown/Logseq renderer (PLAN M4). Newlines are preserved
 * (the container uses `white-space: pre-wrap`); URLs are shown as text only.
 */
export function renderInline(text: string, ctx: InlineContext): ReactNode {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  let fence: string[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sep = i < lines.length - 1 ? '\n' : '';
    if (fence) {
      if (FENCE_RE.test(line)) {
        out.push(<span key={i} className="inline-fence">{[...fence, line].join('\n')}</span>);
        fence = null;
      } else fence.push(line);
      continue;
    }
    if (FENCE_RE.test(line)) {
      fence = [line];
      continue;
    }
    const prop = PROPERTY_RE.exec(line);
    if (prop) {
      out.push(
        <span key={i} className="inline-prop">
          <span className="inline-prop-key">{prop[1]}::</span> {renderSpans(prop[2], ctx, `p${i}`, false)}
        </span>,
      );
      continue;
    }
    const task = i === 0 ? TASK_RE.exec(line) : null;
    if (task) {
      out.push(
        <span key={i}>
          <span className={`inline-task inline-task-${task[1].toLowerCase()}`}>{task[1]}</span>
          {renderSpans(line.slice(task[1].length), ctx, `t${i}`, false)}
          {sep}
        </span>,
      );
      continue;
    }
    out.push(<span key={i}>{renderSpans(line, ctx, `l${i}`, false)}{sep}</span>);
  }
  // Unterminated fence: show what we collected as code-ish text.
  if (fence) out.push(<span key="fence-open" className="inline-fence">{fence.join('\n')}</span>);
  return out;
}
