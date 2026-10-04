import type { Block } from '../parser/types';

export type Caret = number | 'start' | 'end';

export interface FocusRequest {
  id: string;
  caret: Caret;
  /** Bumped on every request so the same block can be re-focused. */
  seq: number;
}

export type TriggerKind = 'page' | 'block';

export interface Trigger {
  kind: TriggerKind;
  /** Offset of the opening `[[` / `((`. */
  start: number;
  query: string;
}

/** The unclosed `[[` / `((` right before the caret, if any. */
export function detectTrigger(value: string, caret: number): Trigger | null {
  const before = value.slice(0, caret);
  const page = before.lastIndexOf('[[');
  const block = before.lastIndexOf('((');
  const start = Math.max(page, block);
  if (start < 0) return null;
  const kind: TriggerKind = page > block ? 'page' : 'block';
  const query = before.slice(start + 2);
  if (query.includes('\n') || query.includes(kind === 'page' ? ']]' : '))')) return null;
  return { kind, start, query };
}

export function flatten(blocks: Block[], out: Block[] = []): Block[] {
  for (const b of blocks) {
    out.push(b);
    flatten(b.children, out);
  }
  return out;
}

/**
 * `mergeWithPrevious` reports the caret as an offset into `content`; the
 * textarea shows head line + property lines + remaining lines, so offsets past
 * the first line shift by the property lines inserted after the head line.
 */
export function caretInEditable(block: Block, contentCaret: number): number {
  if (block.kind === 'raw') return contentCaret;
  const onLaterLine = block.content.slice(0, contentCaret).includes('\n');
  if (!onLaterLine) return contentCaret;
  const props = block.properties.filter((p) => p.key !== 'id');
  return contentCaret + props.reduce((n, p) => n + `${p.key}:: ${p.value}`.length + 1, 0);
}
