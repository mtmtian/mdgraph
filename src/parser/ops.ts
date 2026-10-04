/**
 * Pure editing operations (PLAN 3.6). Each returns a new Document; blocks that
 * were not touched are reused by reference. A touched block gets
 * `rawLines = null`; descendants that are only re-indented get their raw lines
 * prefix-shifted instead (so their bytes stay as close to the source as possible).
 */
import {
  deriveFields,
  isUuid,
  newTmpId,
  splitBulletBody,
  splitRawBody,
} from './syntax';
import type { Block, BlockRef, Document, Property } from './types';

// ---------------------------------------------------------------------------
// lookup

export function* walk(doc: Document): Iterable<BlockRef> {
  function* visit(blocks: Block[], parent: Block | null): Iterable<BlockRef> {
    for (const block of blocks) {
      yield { path: doc.path, block, parent };
      yield* visit(block.children, block);
    }
  }
  yield* visit(doc.blocks, null);
}

export function findBlock(doc: Document, id: string): BlockRef | null {
  for (const ref of walk(doc)) if (ref.block.id === id) return ref;
  return null;
}

/** Index path from doc.blocks down to the block, or null. */
function pathOf(blocks: Block[], id: string): number[] | null {
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].id === id) return [i];
    const sub = pathOf(blocks[i].children, id);
    if (sub) return [i, ...sub];
  }
  return null;
}

function blockAt(doc: Document, path: number[]): Block {
  let list = doc.blocks;
  let block = list[path[0]];
  for (let i = 1; i < path.length; i++) {
    list = block.children;
    block = list[path[i]];
  }
  return block;
}

/** Rebuild the tree with `fn` applied to the sibling list that holds path's last index. */
function modifySiblings(
  blocks: Block[],
  path: number[],
  fn: (siblings: Block[], index: number) => Block[],
): Block[] {
  if (path.length === 1) return fn(blocks, path[0]);
  const [i, ...rest] = path;
  const b = blocks[i];
  const children = modifySiblings(b.children, rest, fn);
  return [...blocks.slice(0, i), { ...b, children }, ...blocks.slice(i + 1)];
}

function withBlocks(doc: Document, blocks: Block[]): Document {
  return { ...doc, blocks };
}

function replaceBlock(doc: Document, path: number[], next: Block): Document {
  return withBlocks(
    doc,
    modifySiblings(doc.blocks, path, (sibs, i) => [...sibs.slice(0, i), next, ...sibs.slice(i + 1)]),
  );
}

// ---------------------------------------------------------------------------
// re-indentation

function shiftLines(lines: string[], delta: number, unit: string): string[] | null {
  if (delta > 0) {
    const pad = unit.repeat(delta);
    return lines.map((l) => (l === '' ? l : pad + l));
  }
  const prefix = unit.repeat(-delta);
  const out: string[] = [];
  for (const l of lines) {
    if (l === '') out.push(l);
    else if (l.startsWith(prefix)) out.push(l.slice(prefix.length));
    else return null;
  }
  return out;
}

/**
 * Move a subtree by `delta` levels. `regenerate` marks the root as edited
 * (rawLines = null); descendants keep their raw lines, prefix-shifted.
 */
function shiftBlock(block: Block, delta: number, unit: string, regenerate: boolean): Block {
  if (delta === 0 && !regenerate) return block;
  let rawLines = block.rawLines;
  if (regenerate) rawLines = null;
  else if (rawLines !== null && block.kind === 'bullet') rawLines = shiftLines(rawLines, delta, unit);
  return {
    ...block,
    depth: block.kind === 'bullet' ? block.depth + delta : block.depth,
    rawLines,
    children: block.children.map((c) => shiftBlock(c, delta, unit, false)),
  };
}

// ---------------------------------------------------------------------------
// setBlockText

function propsEqual(a: Property[], b: Property[]): boolean {
  return a.length === b.length && a.every((p, i) => p.key === b[i].key && p.value === b[i].value);
}

/**
 * Replace a block's text from textarea content (see `editableTextOf` in
 * store/types.ts: head line, non-id property lines, remaining lines). The
 * block's original `id::` property is kept. When nothing actually changes the
 * same Document is returned, so an unedited blur never rewrites a block.
 */
export function setBlockText(doc: Document, id: string, editableText: string): Document {
  const path = pathOf(doc.blocks, id);
  if (!path) return doc;
  const block = blockAt(doc, path);
  const lines = editableText.replace(/\r\n?/g, '\n').split('\n');
  const parsed =
    block.kind === 'raw'
      ? splitRawBody(lines)
      : splitBulletBody(lines[0], lines.slice(1), (l) => l);

  let properties = parsed.properties;
  const oldIdIndex = block.properties.findIndex((p) => p.key === 'id');
  if (oldIdIndex >= 0) {
    properties = properties.filter((p) => p.key !== 'id');
    properties.splice(Math.min(oldIdIndex, properties.length), 0, block.properties[oldIdIndex]);
  }
  if (parsed.content === block.content && propsEqual(properties, block.properties)) return doc;

  const idProp = properties.find((p) => p.key === 'id' && isUuid(p.value.trim()));
  const next: Block = {
    ...block,
    id: block.persistentId ? block.id : idProp ? idProp.value.trim() : block.id,
    persistentId: block.persistentId || idProp !== undefined,
    content: parsed.content,
    properties,
    ...deriveFields(block.kind, parsed.content, properties),
    rawLines: null,
  };
  return replaceBlock(doc, path, next);
}

// ---------------------------------------------------------------------------
// insertAfter

/**
 * New empty bullet after `id` (first child when the block has children).
 * Returns the new Document and the new block's id; null when `id` is unknown.
 */
export function insertAfter(doc: Document, id: string): { doc: Document; id: string } | null {
  const path = pathOf(doc.blocks, id);
  if (!path) return null;
  const target = blockAt(doc, path);
  const asChild = target.kind === 'bullet' && target.children.length > 0;
  const fresh: Block = {
    id: newTmpId(),
    persistentId: false,
    kind: 'bullet',
    marker: target.kind === 'bullet' ? target.marker : '-',
    depth: target.kind === 'raw' ? 0 : asChild ? target.depth + 1 : target.depth,
    content: '',
    properties: [],
    task: null,
    links: [],
    tags: [],
    refs: [],
    rawLines: null,
    children: [],
  };
  if (asChild) {
    return {
      doc: replaceBlock(doc, path, { ...target, children: [fresh, ...target.children] }),
      id: fresh.id,
    };
  }
  return {
    doc: withBlocks(
      doc,
      modifySiblings(doc.blocks, path, (sibs, i) => [...sibs.slice(0, i + 1), fresh, ...sibs.slice(i + 1)]),
    ),
    id: fresh.id,
  };
}

// ---------------------------------------------------------------------------
// indent / outdent

/** Become the last child of the previous sibling. No-op (same Document) without one. */
export function indent(doc: Document, id: string): Document {
  const path = pathOf(doc.blocks, id);
  if (!path) return doc;
  const idx = path[path.length - 1];
  const block = blockAt(doc, path);
  if (idx === 0 || block.kind === 'raw') return doc;
  const siblings = path.length === 1 ? doc.blocks : blockAt(doc, path.slice(0, -1)).children;
  const prev = siblings[idx - 1];
  if (prev.kind === 'raw') return doc;
  const moved = shiftBlock(block, prev.depth + 1 - block.depth, doc.indentUnit, true);
  return withBlocks(
    doc,
    modifySiblings(doc.blocks, path, (sibs, i) => [
      ...sibs.slice(0, i - 1),
      { ...prev, children: [...prev.children, moved] },
      ...sibs.slice(i + 1),
    ]),
  );
}

/**
 * Move after the parent as its sibling; following siblings become this block's
 * children (Logseq behaviour). No-op at depth 0.
 */
export function outdent(doc: Document, id: string): Document {
  const path = pathOf(doc.blocks, id);
  if (!path || path.length < 2) return doc;
  const block = blockAt(doc, path);
  const idx = path[path.length - 1];
  const parentPath = path.slice(0, -1);
  return withBlocks(
    doc,
    modifySiblings(doc.blocks, parentPath, (sibs, pi) => {
      const parent = sibs[pi];
      const delta = parent.depth - block.depth;
      const base = shiftBlock(block, delta, doc.indentUnit, true);
      const later = parent.children
        .slice(idx + 1)
        .map((c) => shiftBlock(c, base.depth + 1 - c.depth, doc.indentUnit, false));
      const moved: Block = { ...base, children: [...base.children, ...later] };
      const trimmed: Block = { ...parent, children: parent.children.slice(0, idx) };
      return [...sibs.slice(0, pi), trimmed, moved, ...sibs.slice(pi + 1)];
    }),
  );
}

// ---------------------------------------------------------------------------
// mergeWithPrevious

function flatten(blocks: Block[], prefix: number[], out: { path: number[]; block: Block }[]): void {
  blocks.forEach((block, i) => {
    const path = [...prefix, i];
    out.push({ path, block });
    flatten(block.children, path, out);
  });
}

/**
 * Append this block's content to the previous visible block and delete it; its
 * children move under the merged block. `caret` = length of the merged block's
 * content before the append. null when there is nothing to merge into (first
 * block, or either side is a raw block).
 */
export function mergeWithPrevious(
  doc: Document,
  id: string,
): { doc: Document; blockId: string; caret: number } | null {
  const flat: { path: number[]; block: Block }[] = [];
  flatten(doc.blocks, [], flat);
  const at = flat.findIndex((e) => e.block.id === id);
  if (at <= 0) return null;
  const target = flat[at];
  const prev = flat[at - 1];
  if (target.block.kind === 'raw' || prev.block.kind === 'raw') return null;

  const t = target.block;
  const m = prev.block;
  const caret = m.content.length;
  const content = m.content + t.content;
  const properties = [...m.properties, ...t.properties.filter((p) => p.key !== 'id')];
  const adopted = t.children.map((c) => shiftBlock(c, m.depth + 1 - c.depth, doc.indentUnit, false));
  const mergedBase: Block = {
    ...m,
    content,
    properties,
    ...deriveFields('bullet', content, properties),
    rawLines: null,
  };

  const targetParentPath = target.path.slice(0, -1);
  const isParent =
    prev.path.length === targetParentPath.length && prev.path.every((v, i) => v === targetParentPath[i]);

  let blocks: Block[];
  if (isParent) {
    // target is the first child of the merged block: its children take its place.
    const merged: Block = { ...mergedBase, children: [...adopted, ...m.children.slice(1)] };
    blocks = modifySiblings(doc.blocks, prev.path, (sibs, i) => [
      ...sibs.slice(0, i),
      merged,
      ...sibs.slice(i + 1),
    ]);
  } else {
    // merged block is the deepest last descendant of the previous sibling (no children).
    const merged: Block = { ...mergedBase, children: adopted };
    blocks = modifySiblings(doc.blocks, prev.path, (sibs, i) => [
      ...sibs.slice(0, i),
      merged,
      ...sibs.slice(i + 1),
    ]);
    blocks = modifySiblings(blocks, target.path, (sibs, i) => [...sibs.slice(0, i), ...sibs.slice(i + 1)]);
  }
  return { doc: withBlocks(doc, blocks), blockId: m.id, caret };
}

// ---------------------------------------------------------------------------
// ensureId

/**
 * Give the block a persistent `id::` property (uuid supplied by the caller),
 * appended at the end of its properties. Returns the same Document when the
 * block already has a persistent id. The block's runtime id becomes the uuid.
 */
export function ensureId(doc: Document, id: string, uuid: string): Document {
  const path = pathOf(doc.blocks, id);
  if (!path) return doc;
  const block = blockAt(doc, path);
  if (block.persistentId) return doc;
  const existing = block.properties.findIndex((p) => p.key === 'id');
  const properties =
    existing >= 0
      ? block.properties.map((p, i) => (i === existing ? { key: 'id', value: uuid } : p))
      : [...block.properties, { key: 'id', value: uuid }];
  return replaceBlock(doc, path, { ...block, id: uuid, persistentId: true, properties, rawLines: null });
}

