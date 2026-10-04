import { deriveFields, fenceClose, fenceOpen, isUuid, newTmpId, splitBulletBody, splitRawBody } from './syntax';
import type { Block, BulletMarker, Document, Property } from './types';

// `[^]` instead of `.` so a stray "\r" never defeats a match.
const BULLET_RE = /^(\s*)([-*+])(?: ([^]*))?$/;
const BLANK_RE = /^\s*$/;

interface Group {
  kind: 'bullet' | 'raw';
  lines: string[];
  // bullet only
  indentWs: string;
  marker: BulletMarker;
  head: string;
}

/** Pass 1: split lines into bullet / raw groups (3.2), tracking ``` fences. */
function groupLines(lines: string[]): Group[] {
  const groups: Group[] = [];
  let fence: number | null = null;
  for (const line of lines) {
    const cur = groups.length > 0 ? groups[groups.length - 1] : null;
    if (fence !== null && cur) {
      cur.lines.push(line);
      if (fenceClose(line, fence)) fence = null;
      continue;
    }
    const m = BULLET_RE.exec(line);
    if (m) {
      const head = m[3] ?? '';
      groups.push({ kind: 'bullet', lines: [line], indentWs: m[1], marker: m[2] as BulletMarker, head });
      fence = fenceOpen(head);
      continue;
    }
    if (cur && cur.kind === 'bullet' && (BLANK_RE.test(line) || /^\s/.test(line))) {
      cur.lines.push(line);
    } else if (cur && cur.kind === 'raw') {
      cur.lines.push(line);
    } else {
      groups.push({ kind: 'raw', lines: [line], indentWs: '', marker: '-', head: '' });
    }
    fence = fenceOpen(line);
  }
  return groups;
}

function detectIndentUnit(groups: Group[]): string {
  for (const g of groups) {
    if (g.kind === 'bullet' && g.indentWs.length > 0) {
      return g.indentWs.includes('\t') ? '\t' : g.indentWs;
    }
  }
  return '  ';
}

function detectContinuationIndent(groups: Group[]): string {
  for (const g of groups) {
    if (g.kind !== 'bullet') continue;
    for (let i = 1; i < g.lines.length; i++) {
      const line = g.lines[i];
      if (BLANK_RE.test(line) || !line.startsWith(g.indentWs)) continue;
      const lead = /^\s*/.exec(line.slice(g.indentWs.length))![0];
      if (lead.length > 0) return lead;
    }
  }
  return '  ';
}

function depthOf(ws: string, unit: string): number {
  if (unit === '\t') {
    let n = 0;
    for (const ch of ws) if (ch === '\t') n++;
    return n;
  }
  return Math.floor(ws.length / unit.length);
}

/** Remove `prefix` from a line; if the line is indented less, remove its leading whitespace. */
function stripPrefix(line: string, prefix: string): string {
  if (line.startsWith(prefix)) return line.slice(prefix.length);
  let k = 0;
  while (k < prefix.length && k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
  return line.slice(k);
}

function buildBlock(
  kind: 'bullet' | 'raw',
  marker: BulletMarker,
  depth: number,
  content: string,
  properties: Property[],
  rawLines: string[],
): Block {
  const idProp = properties.find((p) => p.key === 'id' && isUuid(p.value.trim()));
  return {
    id: idProp ? idProp.value.trim() : newTmpId(),
    persistentId: idProp !== undefined,
    kind,
    marker,
    depth,
    content,
    properties,
    ...deriveFields(kind, content, properties),
    rawLines,
    children: [],
  };
}

export function parse(path: string, text: string): Document {
  const bom = text.charCodeAt(0) === 0xfeff;
  const body = bom ? text.slice(1) : text;
  const nl = body.indexOf('\n');
  const eol: '\n' | '\r\n' = nl > 0 && body[nl - 1] === '\r' ? '\r\n' : '\n';
  const trailingNewline = body.endsWith(eol);
  let lines: string[];
  if (body === '') {
    lines = [];
  } else {
    lines = body.split(eol);
    if (trailingNewline) lines.pop();
  }

  const groups = groupLines(lines);
  const indentUnit = detectIndentUnit(groups);
  const continuationIndent = detectContinuationIndent(groups);

  const doc: Document = { path, bom, eol, trailingNewline, indentUnit, continuationIndent, blocks: [] };
  const stack: Block[] = [];
  for (const g of groups) {
    if (g.kind === 'raw') {
      const { content, properties } = splitRawBody(g.lines);
      doc.blocks.push(buildBlock('raw', '-', 0, content, properties, g.lines));
      stack.length = 0;
      continue;
    }
    const depth = depthOf(g.indentWs, indentUnit);
    const prefix = g.indentWs + continuationIndent;
    const { content, properties } = splitBulletBody(g.head, g.lines.slice(1), (l) => stripPrefix(l, prefix));
    const block = buildBlock('bullet', g.marker, depth, content, properties, g.lines);
    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack.length > 0 ? stack[stack.length - 1] : null;
    (parent ? parent.children : doc.blocks).push(block);
    stack.push(block);
  }
  return doc;
}
