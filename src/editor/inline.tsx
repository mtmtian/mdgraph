import type { ReactNode } from 'react';
import { tokenize, type Token } from '../parser/syntax';

export interface InlineContext {
  /** First line of the referenced block's content, or undefined when the uuid is unknown. */
  resolveBlock(uuid: string): string | undefined;
  onOpenPage(name: string): void;
  onOpenBlock(uuid: string): void;
}

export interface InlineOptions {
  /** Show a task badge for a leading TODO / DOING / DONE. Default true; pass false for raw blocks. */
  task?: boolean;
}

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

/** Token -> React node. All syntax decisions were made by `tokenize`; this only picks the markup. */
function renderTokens(tokens: Token[], text: string, ctx: InlineContext, prefix: string): ReactNode[] {
  return tokens.map((t, i): ReactNode => {
    const key = `${prefix}.${i}`;
    const src = text.slice(t.start, t.end);
    switch (t.kind) {
      case 'text':
        return src;
      case 'code':
        return t.value === '' ? src : <code key={key} className="inline-code">{t.value}</code>;
      case 'fence':
        return <span key={key} className="inline-fence">{src}</span>;
      case 'url':
      case 'mdlink':
        return <span key={key} className="inline-url">{src}</span>;
      case 'pageLink':
        return (
          <span key={key} className="inline-link inline-page" {...activate(() => ctx.onOpenPage(t.value))}>
            <span className="inline-bracket">[[</span>{t.value}<span className="inline-bracket">]]</span>
          </span>
        );
      case 'tag':
      case 'tagLink':
        return (
          <span key={key} className="inline-link inline-tag" {...activate(() => ctx.onOpenPage(t.value))}>
            {src}
          </span>
        );
      case 'blockRef': {
        const target = ctx.resolveBlock(t.value);
        return (
          <span
            key={key}
            className={target === undefined ? 'inline-link inline-ref inline-ref-missing' : 'inline-link inline-ref'}
            {...activate(() => ctx.onOpenBlock(t.value))}
          >
            {target || src}
          </span>
        );
      }
      case 'bold':
        return <strong key={key}>{renderTokens(t.children ?? [], text, ctx, key)}</strong>;
      case 'italic':
        return <em key={key}>{renderTokens(t.children ?? [], text, ctx, key)}</em>;
      case 'property':
        return (
          <span key={key} className="inline-prop">
            <span className="inline-prop-key">{text.slice(t.start, t.valueStart)}</span>
            {renderTokens(t.children ?? [], text, ctx, key)}
          </span>
        );
      case 'task':
        return <span key={key} className={`inline-task inline-task-${t.value.toLowerCase()}`}>{t.value}</span>;
    }
  });
}

/**
 * Minimal inline Markdown/Logseq renderer (PLAN M4). The text is exactly the
 * input (the container uses `white-space: pre-wrap`); URLs are shown as text only.
 */
export function renderInline(text: string, ctx: InlineContext, opts: InlineOptions = {}): ReactNode {
  return renderTokens(tokenize(text, { task: opts.task }), text, ctx, 't');
}
