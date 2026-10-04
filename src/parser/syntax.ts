/**
 * Line-level and inline syntax shared by parse / ops / the editor renderer.
 * Pure functions only; no I/O, no globals except the temp-id counter.
 *
 * Inline syntax has exactly one implementation: `tokenize`. `extractInline` /
 * `deriveFields` (the index data) and `renderInline` (the screen) both consume
 * its tokens, so what is clickable on screen is by construction what the index
 * records as a link, tag or ref.
 */
import type { Block, BulletMarker, Property, TaskState } from './types';

// ---------------------------------------------------------------------------
// whitespace

/**
 * The only characters that count as indentation / blank (PLAN 3.1): space and
 * tab. Everything else (full-width space, lone "\r", ...) is content.
 */
export const INDENT_WS = '[ \\t]';

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
const PROPERTY_RE = new RegExp(`^${INDENT_WS}*([^\\s:]+):: ?([^]*)$`);

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

const FENCE_OPEN_RE = new RegExp(`^${INDENT_WS}*(\`{3,})[^\`]*$`);
const FENCE_CLOSE_RE = new RegExp(`^${INDENT_WS}*(\`{3,})${INDENT_WS}*$`);

/** Backtick count when `line` opens a ``` fence, else null. */
export function fenceOpen(line: string): number | null {
  const m = FENCE_OPEN_RE.exec(line);
  return m ? m[1].length : null;
}

/** True when `line` closes a fence opened with `openLen` backticks. */
export function fenceClose(line: string, openLen: number): boolean {
  const m = FENCE_CLOSE_RE.exec(line);
  return m !== null && m[1].length >= openLen;
}

// ---------------------------------------------------------------------------
// tokenizer

export type TokenKind =
  | 'text' //      anything that is not one of the kinds below
  | 'code' //      `inline code`; value = inner text
  | 'fence' //     whole fenced block, open line through close line; value = source
  | 'url' //       bare http(s) URL
  | 'mdlink' //    the `(destination)` of [text](destination)
  | 'pageLink' //  [[Page]]; value = page name
  | 'tag' //       #tag, or one item of a `tags::` value; value = page name
  | 'tagLink' //   #[[multi word]]; value = page name
  | 'blockRef' //  ((uuid)); value = uuid
  | 'bold' //      **x**; children = inner tokens
  | 'italic' //    *x*; children = inner tokens
  | 'property' //  a `key:: value` line; value = key, children cover [valueStart, end)
  | 'task'; //     leading TODO / DOING / DONE keyword; value = keyword

export interface Token {
  kind: TokenKind;
  /** Offsets into the tokenized text; the tokens of one call tile it exactly. */
  start: number;
  end: number;
  value: string;
  children?: Token[];
  /** 'property' only: offset where the value starts. */
  valueStart?: number;
}

export interface TokenizeOptions {
  /** Recognise a task keyword at the start of the first line. Default true; false for raw blocks. */
  task?: boolean;
}

// Masked spans (inline code, link destinations, bare URLs) are overwritten with
// a same-length run of NUL: it is not whitespace, so masking can neither create
// a `#`/`[[` boundary nor join two tokens, and the patterns below never match it.
const MASK = '\u0000';
const CODE_RE = /`[^`]*`/g;
const MD_LINK_URL_RE = /(?<=\])\([^)\s]*\)/g;
const BARE_URL_RE = /https?:\/\/\S+/g;
const ATOMS: readonly [RegExp, TokenKind][] = [
  [CODE_RE, 'code'],
  [MD_LINK_URL_RE, 'mdlink'],
  [BARE_URL_RE, 'url'],
];

// Alternatives, in priority order at a given position:
//   1 #[[multi word]]   2 [[Page]] (innermost)   3 #tag   4 ((uuid))
// A tag ends before `*` so `**a #tag**` is a tag inside bold.
const INLINE_RE =
  // oxlint-disable-next-line no-control-regex -- NUL is the mask character, see MASK
  /(?<=^|\s)#\[\[([^[\]\u0000]+)\]\]|\[\[([^[\]\u0000]+)\]\]|(?<=^|\s)#(?![[#\u0000])([^\s#\u0000]*[^\s#,.;:!?)\]*\u0000])|\(\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)\)/gi;

const EMPHASIS_RE = /\*\*([^*\s](?:[^*]*[^*\s])?)\*\*|\*([^*\s](?:[^*]*[^*\s])?)\*/g;

type Slice = (start: number, end: number) => string;

/** Cover [lo, hi) with `items` (sorted, disjoint, inside the range); gaps become 'text'. */
function fill(items: Token[], lo: number, hi: number, slice: Slice): Token[] {
  const out: Token[] = [];
  let at = lo;
  const gap = (to: number): void => {
    if (to > at) out.push({ kind: 'text', start: at, end: to, value: slice(at, to) });
  };
  for (const t of items) {
    gap(t.start);
    out.push(t);
    at = t.end;
  }
  gap(hi);
  return out;
}

/**
 * Special tokens (everything except 'text') of one stretch of inline text, in
 * order. `base` is the offset of `text` inside the whole tokenized string.
 * `valueMode` is for property values: only [[x]] and #[[x]] are recognised.
 */
function inlineTokens(text: string, base: number, valueMode: boolean): Token[] {
  const slice: Slice = (a, b) => text.slice(a - base, b - base);

  // 1. code spans, link destinations and bare URLs win over everything else.
  let masked = text;
  const atoms: Token[] = [];
  for (const [re, kind] of ATOMS) {
    let out = '';
    let last = 0;
    for (const m of masked.matchAll(re)) {
      const at = m.index;
      const raw = text.slice(at, at + m[0].length);
      atoms.push({
        kind,
        start: base + at,
        end: base + at + m[0].length,
        value: kind === 'code' ? raw.slice(1, -1) : raw,
      });
      out += masked.slice(last, at) + MASK.repeat(m[0].length);
      last = at + m[0].length;
    }
    masked = out + masked.slice(last);
  }
  // A later (wider) span swallows earlier ones it contains, e.g. code inside a URL.
  atoms.sort((a, b) => a.start - b.start || b.end - a.end);
  const specials: Token[] = [];
  let reach = base;
  for (const a of atoms) {
    if (a.start >= reach) {
      specials.push(a);
      reach = a.end;
    }
  }

  // 2. links, tags and refs in what is left.
  for (const m of masked.matchAll(INLINE_RE)) {
    const start = base + m.index;
    const end = start + m[0].length;
    if (m[1] !== undefined) {
      if (m[1].trim()) specials.push({ kind: 'tagLink', start, end, value: m[1] });
    } else if (m[2] !== undefined) {
      if (m[2].trim()) specials.push({ kind: 'pageLink', start, end, value: m[2] });
    } else if (m[3] !== undefined) {
      if (!valueMode) specials.push({ kind: 'tag', start, end, value: m[3] });
    } else if (m[4] !== undefined) {
      if (!valueMode) specials.push({ kind: 'blockRef', start, end, value: m[4] });
    }
  }
  specials.sort((a, b) => a.start - b.start);
  if (!text.includes('*')) return specials;

  // 3. emphasis wraps whole tokens; its markers are looked up with every token masked.
  let plain = '';
  let at = 0;
  for (const t of specials) {
    plain += text.slice(at, t.start - base) + MASK.repeat(t.end - t.start);
    at = t.end - base;
  }
  plain += text.slice(at);
  const out: Token[] = [];
  let i = 0;
  for (const m of plain.matchAll(EMPHASIS_RE)) {
    const bold = m[1] !== undefined;
    const start = base + m.index;
    const end = start + m[0].length;
    while (i < specials.length && specials[i].end <= start) out.push(specials[i++]);
    const inner: Token[] = [];
    while (i < specials.length && specials[i].start < end) inner.push(specials[i++]);
    const from = start + (bold ? 2 : 1);
    const to = end - (bold ? 2 : 1);
    out.push({
      kind: bold ? 'bold' : 'italic',
      start,
      end,
      value: slice(from, to),
      children: fill(inner, from, to, slice),
    });
  }
  while (i < specials.length) out.push(specials[i++]);
  return out;
}

/** Split a `tags::` value on commas that are not inside [[ ]] (code spans are ignored). */
function tagsValueTokens(value: string, base: number): Token[] {
  const masked = value.replace(CODE_RE, (m) => MASK.repeat(m.length));
  const out: Token[] = [];
  const item = (from: number, to: number): void => {
    const seg = masked.slice(from, to);
    const lead = seg.length - seg.trimStart().length;
    const part = seg.slice(lead).trimEnd();
    let name = part.replaceAll(MASK, '').trim();
    if (name.startsWith('#[[') && name.endsWith(']]') && name.length > 5) name = name.slice(1);
    if (name.startsWith('[[') && name.endsWith(']]') && name.length > 4) name = name.slice(2, -2).trim();
    if (name.startsWith('#')) name = name.slice(1);
    if (name === '') return;
    const start = base + from + lead;
    out.push({ kind: 'tag', start, end: start + part.length, value: name });
  };
  let depth = 0;
  let from = 0;
  for (let i = 0; i < masked.length; i++) {
    const two = masked.slice(i, i + 2);
    if (two === '[[') {
      depth++;
      i++;
    } else if (two === ']]' && depth > 0) {
      depth--;
      i++;
    } else if (masked[i] === ',' && depth === 0) {
      item(from, i);
      from = i + 1;
    }
  }
  item(from, masked.length);
  return out;
}

function valueTokens(key: string, value: string, base: number): Token[] {
  return key.toLowerCase() === 'tags' ? tagsValueTokens(value, base) : inlineTokens(value, base, true);
}

/**
 * Tokenize block text. Rules (PLAN 3.4), applied per line in this order:
 *  - a fence opens on a line that starts with ``` and has no further backtick
 *    and closes on a line of only backticks; everything between is one 'fence'
 *    token (an unclosed fence runs to the end);
 *  - a `key:: value` line is one 'property' token: only [[x]] / #[[x]] in its
 *    value are links; a `tags::` value lists tags separated by commas;
 *  - otherwise inline syntax, plus a task keyword on the very first line.
 * The tokens of one call tile the whole text, newlines included.
 */
export function tokenize(text: string, opts: TokenizeOptions = {}): Token[] {
  const slice: Slice = (a, b) => text.slice(a, b);
  const items: Token[] = [];
  let fence: { len: number; start: number } | null = null;
  let offset = 0;
  const lines = text.split('\n');
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const lineStart = offset;
    const lineEnd = lineStart + line.length;
    offset = lineEnd + 1;
    if (fence) {
      if (fenceClose(line, fence.len)) {
        items.push({ kind: 'fence', start: fence.start, end: lineEnd, value: slice(fence.start, lineEnd) });
        fence = null;
      }
      continue;
    }
    const open = fenceOpen(line);
    if (open !== null) {
      fence = { len: open, start: lineStart };
      continue;
    }
    const prop = PROPERTY_RE.exec(line);
    if (prop) {
      const valueStart = lineEnd - prop[2].length;
      items.push({
        kind: 'property',
        start: lineStart,
        end: lineEnd,
        value: prop[1],
        valueStart,
        children: fill(valueTokens(prop[1], prop[2], valueStart), valueStart, lineEnd, slice),
      });
      continue;
    }
    if (n === 0 && opts.task !== false) {
      const task = TASK_RE.exec(line);
      if (task) items.push({ kind: 'task', start: 0, end: task[1].length, value: task[1] });
    }
    for (const t of inlineTokens(line, lineStart, false)) items.push(t);
  }
  if (fence) items.push({ kind: 'fence', start: fence.start, end: text.length, value: slice(fence.start, text.length) });
  return fill(items, 0, text.length, slice);
}

// ---------------------------------------------------------------------------
// inline extraction

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

  /** Take every link / tag / ref token, in document order. */
  add(tokens: Token[]): void {
    for (const t of tokens) {
      if (t.kind === 'pageLink') pushUnique(this.links, this.seenLinks, t.value);
      else if (t.kind === 'tag' || t.kind === 'tagLink') {
        pushUnique(this.tags, this.seenTags, t.value);
        pushUnique(this.links, this.seenLinks, t.value);
      } else if (t.kind === 'blockRef') pushUnique(this.refs, this.seenRefs, t.value);
      else if (t.children) this.add(t.children);
    }
  }
}

/** Extract [[links]], #tags (also links) and ((uuid)) refs, skipping code and fences. */
export function extractInline(text: string): { links: string[]; tags: string[]; refs: string[] } {
  const c = new Collector();
  c.add(tokenize(text, { task: false }));
  return { links: c.links, tags: c.tags, refs: c.refs };
}

export interface DerivedFields {
  task: TaskState;
  links: string[];
  tags: string[];
  refs: string[];
}

/**
 * The text of a block outside its `properties`: a bullet's content, or a raw
 * block's content without the leading property lines it already contains.
 */
export function bodyOf(block: Pick<Block, 'kind' | 'content' | 'properties'>): string {
  return block.kind === 'raw' ? block.content.split('\n').slice(block.properties.length).join('\n') : block.content;
}

/**
 * Everything about a block that is computed from content + properties: body
 * first, then property values.
 */
export function deriveFields(kind: 'bullet' | 'raw', content: string, properties: Property[]): DerivedFields {
  const c = new Collector();
  c.add(tokenize(bodyOf({ kind, content, properties }), { task: false }));
  for (const p of properties) c.add(valueTokens(p.key, p.value, 0));
  return {
    task: kind === 'bullet' ? parseTask(content) : null,
    links: c.links,
    tags: c.tags,
    refs: c.refs,
  };
}

// ---------------------------------------------------------------------------
// body splitting (shared by parse and ops.setBlockText)

/** The consecutive property lines of `lines` starting at index `from`. */
export function takeProperties(lines: string[], from: number): Property[] {
  const properties: Property[] = [];
  for (let i = from; i < lines.length; i++) {
    const p = parseProperty(lines[i]);
    if (!p) break;
    properties.push(p);
  }
  return properties;
}

/**
 * Split a bullet's lines (head = text after the marker, then continuation
 * lines, indentation not yet removed) into head text, properties and the
 * remaining content lines. A head line that is itself a property (not one that
 * opens a fence) becomes a property and leaves the head empty.
 */
export function splitBullet(lines: string[]): { head: string; properties: Property[]; rest: string[] } {
  const opensFence = fenceOpen(lines[0]) !== null;
  const headProp = opensFence ? null : parseProperty(lines[0]);
  const following = opensFence ? [] : takeProperties(lines, 1);
  return {
    head: headProp ? '' : lines[0],
    properties: headProp ? [headProp, ...following] : following,
    rest: lines.slice(1 + following.length),
  };
}

// ---------------------------------------------------------------------------
// block construction

export interface BlockInit {
  kind: 'bullet' | 'raw';
  marker: BulletMarker;
  depth: number;
  content: string;
  properties: Property[];
  rawLines: string[] | null;
}

/** A childless block; its id is the `id::` uuid in `properties` when there is one, else a fresh runtime id. */
export function makeBlock(init: BlockInit): Block {
  const idProp = init.properties.find((p) => p.key === 'id' && isUuid(p.value.trim()));
  return {
    id: idProp ? idProp.value.trim() : newTmpId(),
    persistentId: idProp !== undefined,
    ...init,
    ...deriveFields(init.kind, init.content, init.properties),
    children: [],
  };
}

/**
 * `block` with a new body: fields re-derived, `rawLines` cleared, `id` kept.
 * `persistentId` survives only while an `id::` property still carries that id.
 */
export function withBody(block: Block, content: string, properties: Property[]): Block {
  return {
    ...block,
    content,
    properties,
    persistentId: properties.some((p) => p.key === 'id' && p.value.trim() === block.id),
    ...deriveFields(block.kind, content, properties),
    rawLines: null,
  };
}
