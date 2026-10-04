/**
 * Line-level and inline syntax helpers shared by parse / ops.
 * Pure functions only; no I/O, no globals except the temp-id counter.
 */
import type { Property, TaskState } from './types';

// ---------------------------------------------------------------------------
// ids

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

let tmpCounter = 0;

/** Runtime-only block id. A module-wide counter keeps ids unique across Documents. */
export function newTmpId(): string {
  tmpCounter += 1;
  return 'tmp-' + tmpCounter;
}

// ---------------------------------------------------------------------------
// properties and tasks

// `[^]` instead of `.` so a stray "\r" (mixed EOL file) never defeats a match.
const PROPERTY_RE = /^\s*([^\s:]+):: ?([^]*)$/;

export function parseProperty(line: string): Property | null {
  const m = PROPERTY_RE.exec(line);
  return m ? { key: m[1], value: m[2] } : null;
}

const TASK_RE = /^(TODO|DOING|DONE)(?: |$)/;

export function parseTask(firstLine: string): TaskState {
  const nl = firstLine.indexOf('\n');
  const m = TASK_RE.exec(nl < 0 ? firstLine : firstLine.slice(0, nl));
  return m ? (m[1] as TaskState) : null;
}

// ---------------------------------------------------------------------------
// fences

/** Backtick count when `line` opens a ``` fence, else null. */
export function fenceOpen(line: string): number | null {
  const m = /^\s*(`{3,})[^`]*$/.exec(line);
  return m ? m[1].length : null;
}

/** True when `line` closes a fence opened with `openLen` backticks. */
export function fenceClose(line: string, openLen: number): boolean {
  const m = /^\s*(`{3,})\s*$/.exec(line);
  return m !== null && m[1].length >= openLen;
}

// ---------------------------------------------------------------------------
// inline extraction

type InlineKind = 'link' | 'tag' | 'ref';
interface InlineItem {
  kind: InlineKind;
  value: string;
  /** true for the `#[[multi word]]` form of a tag */
  bracketed?: boolean;
}

// Masked spans (inline code, link destinations, bare URLs) are overwritten with
// a same-length run of NUL: it is not whitespace, so masking can neither create
// a `#`/`[[` boundary nor join two tokens, and the patterns below never match it.
const MASK = '\u0000';
const CODE_RE = /`[^`]*`/g;
const MD_LINK_URL_RE = /(?<=\])\([^)\s]*\)/g;
const BARE_URL_RE = /https?:\/\/\S+/g;
const mask = (m: string): string => MASK.repeat(m.length);

// Alternatives, in priority order at a given position:
//   1 #[[multi word]]   2 [[Page]] (innermost)   3 #tag   4 ((uuid))
const INLINE_RE =
  // oxlint-disable-next-line no-control-regex -- NUL is the mask character, see MASK
  /(?<=^|\s)#\[\[([^[\]\u0000]+)\]\]|\[\[([^[\]\u0000]+)\]\]|(?<=^|\s)#(?![[#\u0000])([^\s#\u0000]*[^\s#,.;:!?)\]\u0000])|\(\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)\)/gi;

function scanInline(text: string): InlineItem[] {
  const items: InlineItem[] = [];
  let fence: number | null = null;
  for (const line of text.split('\n')) {
    if (fence !== null) {
      if (fenceClose(line, fence)) fence = null;
      continue;
    }
    const open = fenceOpen(line);
    if (open !== null) {
      fence = open;
      continue;
    }
    const stripped = line.replace(CODE_RE, mask).replace(MD_LINK_URL_RE, mask).replace(BARE_URL_RE, mask);
    for (const m of stripped.matchAll(INLINE_RE)) {
      if (m[1] !== undefined) {
        if (m[1].trim()) items.push({ kind: 'tag', value: m[1], bracketed: true });
      } else if (m[2] !== undefined) {
        if (m[2].trim()) items.push({ kind: 'link', value: m[2] });
      } else if (m[3] !== undefined) {
        items.push({ kind: 'tag', value: m[3] });
      } else if (m[4] !== undefined) {
        items.push({ kind: 'ref', value: m[4] });
      }
    }
  }
  return items;
}

function pushUnique(list: string[], seen: Set<string>, value: string): void {
  if (!seen.has(value)) {
    seen.add(value);
    list.push(value);
  }
}

class Collector {
  links: string[] = [];
  tags: string[] = [];
  refs: string[] = [];
  private seenLinks = new Set<string>();
  private seenTags = new Set<string>();
  private seenRefs = new Set<string>();
  link(v: string): void {
    pushUnique(this.links, this.seenLinks, v);
  }
  tag(v: string): void {
    pushUnique(this.tags, this.seenTags, v);
    this.link(v);
  }
  ref(v: string): void {
    pushUnique(this.refs, this.seenRefs, v);
  }
}

/** Extract [[links]], #tags (also links) and ((uuid)) refs, skipping code. */
export function extractInline(text: string): { links: string[]; tags: string[]; refs: string[] } {
  const c = new Collector();
  for (const item of scanInline(text)) {
    if (item.kind === 'link') c.link(item.value);
    else if (item.kind === 'tag') c.tag(item.value);
    else c.ref(item.value);
  }
  return { links: c.links, tags: c.tags, refs: c.refs };
}

/** Split a `tags::` value on commas that are not inside [[ ]]. */
function splitTagsValue(rawValue: string): string[] {
  const value = rawValue.replace(CODE_RE, '');
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < value.length; i++) {
    const two = value.slice(i, i + 2);
    if (two === '[[') {
      depth++;
      cur += two;
      i++;
    } else if (two === ']]' && depth > 0) {
      depth--;
      cur += two;
      i++;
    } else if (value[i] === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += value[i];
    }
  }
  parts.push(cur);
  return parts
    .map((p) => p.trim())
    .map((p) => (p.startsWith('[[') && p.endsWith(']]') && p.length > 4 ? p.slice(2, -2).trim() : p))
    .map((p) => (p.startsWith('#') ? p.slice(1) : p))
    .filter((p) => p !== '');
}

export interface DerivedFields {
  task: TaskState;
  links: string[];
  tags: string[];
  refs: string[];
}

/** Everything about a block that is computed from content + properties. */
export function deriveFields(kind: 'bullet' | 'raw', content: string, properties: Property[]): DerivedFields {
  const c = new Collector();
  for (const item of scanInline(content)) {
    if (item.kind === 'link') c.link(item.value);
    else if (item.kind === 'tag') c.tag(item.value);
    else c.ref(item.value);
  }
  for (const p of properties) {
    if (p.key.toLowerCase() === 'tags') {
      for (const t of splitTagsValue(p.value)) c.tag(t);
    } else {
      for (const item of scanInline(p.value)) {
        if (item.kind === 'link') c.link(item.value);
        else if (item.kind === 'tag' && item.bracketed) c.tag(item.value);
      }
    }
  }
  return {
    task: kind === 'bullet' ? parseTask(content) : null,
    links: c.links,
    tags: c.tags,
    refs: c.refs,
  };
}

// ---------------------------------------------------------------------------
// body splitting (shared by parse and ops.setBlockText)

/**
 * Split a bullet's text into content + properties.
 * `head` is the text after the marker; `rest` are the following lines
 * (continuation lines of the block, indentation not yet removed).
 * `strip` removes the block's continuation prefix from a content line.
 */
export function splitBulletBody(
  head: string,
  rest: string[],
  strip: (line: string) => string,
): { content: string; properties: Property[] } {
  const properties: Property[] = [];
  const opensFence = fenceOpen(head) !== null;
  const headProp = opensFence ? null : parseProperty(head);
  const contentLines: string[] = [headProp ? '' : head];
  if (headProp) properties.push(headProp);
  let i = 0;
  if (!opensFence) {
    for (; i < rest.length; i++) {
      const p = parseProperty(rest[i]);
      if (!p) break;
      properties.push(p);
    }
  }
  for (; i < rest.length; i++) contentLines.push(strip(rest[i]));
  return { content: contentLines.join('\n'), properties };
}

/** Split a raw run's lines into leading property lines + remaining content. */
export function splitRawBody(lines: string[]): { content: string; properties: Property[] } {
  const properties: Property[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const p = parseProperty(lines[i]);
    if (!p) break;
    properties.push(p);
  }
  return { content: lines.slice(i).join('\n'), properties };
}
