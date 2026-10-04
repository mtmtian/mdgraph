/**
 * Pure editing operations (PLAN 3.6). Each returns a new Document; blocks that
 * were not touched are reused by reference. A touched block gets
 * `rawLines = null`; descendants that are only re-indented get their raw lines
 * prefix-shifted instead (so their bytes stay as close to the source as possible).
 */
import { makeBlock, splitBullet, takeProperties, withBody } from './syntax';
import type { Block, BlockRef, Document, Property } from './types';

// ---------------------------------------------------------------------------
// lookup

// All tree traversals below use explicit stacks: outline depth is unbounded
// (PLAN 3.5 round-trips any input), the call stack is not.

export function* walk(doc: Document): Iterable<BlockRef> {
  const stack: { block: Block; parent: Block | null }[] = [];
  for (let i = doc.blocks.length - 1; i >= 0; i--) stack.push({ block: doc.blocks[i], parent: null });
  while (stack.length > 0) {
    const { block, parent } = stack.pop()!;
    yield { path: doc.path, block, parent };
    for (let i = block.children.length - 1; i >= 0; i--) stack.push({ block: block.children[i], parent: block });
  }
}

export function findBlock(doc: Document, id: string): BlockRef | null {
  for (const ref of walk(doc)) if (ref.block.id === id) return ref;
  return null;
}

/** Index path from doc.blocks down to the block, or null. */
function pathOf(blocks: Block[], id: string): number[] | null {
  const lists: Block[][] = [blocks];
  const idx: number[] = [0];
  while (lists.length > 0) {
    const top = lists.length - 1;
    const list = lists[top];
    const k = idx[top];
    if (k >= list.length) {
      lists.pop();
      idx.pop();
      if (idx.length > 0) idx[idx.length - 1]++;
      continue;
    }
    const b = list[k];
    if (b.id === id) return idx.slice();
    if (b.children.length > 0) {
      lists.push(b.children);
      idx.push(0);
    } else {
      idx[top] = k + 1;
    }
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
  const levels: Block[][] = [blocks];
  for (let j = 0; j < path.length - 1; j++) levels.push(levels[j][path[j]].children);
  const last = path.length - 1;
  let list = fn(levels[last], path[last]);
  for (let j = last - 1; j >= 0; j--) {
    const sibs = levels[j];
    const b = sibs[path[j]];
    list = [...sibs.slice(0, path[j]), { ...b, children: list }, ...sibs.slice(path[j] + 1)];
  }
  return list;
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
 * Move a subtree by `delta` levels, prefix-shifting every block's raw lines.
 * Callers that edit the root clear its `rawLines` themselves.
 */
function shiftBlock(block: Block, delta: number, unit: string): Block {
  if (delta === 0) return block;
  const shiftSelf = (b: Block, children: Block[]): Block => ({
    ...b,
    depth: b.kind === 'bullet' ? b.depth + delta : b.depth,
    rawLines: b.rawLines !== null && b.kind === 'bullet' ? shiftLines(b.rawLines, delta, unit) : b.rawLines,
    children,
  });

  interface Frame {
    block: Block;
    done: Block[];
  }
  const stack: Frame[] = [{ block, done: [] }];
  let result = block;
  while (stack.length > 0) {
    const f = stack[stack.length - 1];
    if (f.done.length < f.block.children.length) {
      stack.push({ block: f.block.children[f.done.length], done: [] });
      continue;
    }
    stack.pop();
    const out = shiftSelf(f.block, f.done);
    if (stack.length > 0) stack[stack.length - 1].done.push(out);
    else result = out;
  }
  return result;
}

// ---------------------------------------------------------------------------
// setBlockText

function propsEqual(a: Property[], b: Property[]): boolean {
  return a.length === b.length && a.every((p, i) => p.key === b[i].key && p.value === b[i].value);
}

/**
 * Replace a block's text from textarea content (see `editableTextOf` in
 * store/types.ts). A raw block's text is its whole content; a bullet's text is
 * head line, non-id property lines, remaining lines, and keeps its original
 * `id::` property. The runtime id never changes. When nothing actually changes
 * the same Document is returned, so an unedited blur never rewrites a block.
 */
export function setBlockText(doc: Document, id: string, editableText: string): Document {
  const path = pathOf(doc.blocks, id);
  if (!path) return doc;
  const block = blockAt(doc, path);
  const lines = editableText.replace(/\r\n/g, '\n').split('\n');
  let content: string;
  let properties: Property[];
  if (block.kind === 'raw') {
    content = lines.join('\n');
    properties = takeProperties(lines, 0);
  } else {
    const split = splitBullet(lines);
    content = [split.head, ...split.rest].join('\n');
    properties = split.properties;
    const oldIdIndex = block.properties.findIndex((p) => p.key === 'id');
    if (oldIdIndex >= 0) {
      properties = properties.filter((p) => p.key !== 'id');
      properties.splice(Math.min(oldIdIndex, properties.length), 0, block.properties[oldIdIndex]);
    }
  }
  if (content === block.content && propsEqual(properties, block.properties)) return doc;
  return replaceBlock(doc, path, withBody(block, content, properties));
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
  const fresh = makeBlock({
    kind: 'bullet',
    marker: target.kind === 'bullet' ? target.marker : '-',
    depth: target.kind === 'raw' ? 0 : asChild ? target.depth + 1 : target.depth,
    content: '',
    properties: [],
    rawLines: null,
  });
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
  const moved: Block = { ...shiftBlock(block, prev.depth + 1 - block.depth, doc.indentUnit), rawLines: null };
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
      const base: Block = { ...shiftBlock(block, delta, doc.indentUnit), rawLines: null };
      const later = parent.children
        .slice(idx + 1)
        .map((c) => shiftBlock(c, base.depth + 1 - c.depth, doc.indentUnit));
      const moved: Block = { ...base, children: [...base.children, ...later] };
      const trimmed: Block = { ...parent, children: parent.children.slice(0, idx) };
      return [...sibs.slice(0, pi), trimmed, moved, ...sibs.slice(pi + 1)];
    }),
  );
}

// ---------------------------------------------------------------------------
// mergeWithPrevious

/**
 * The previous visible block: the previous sibling's deepest last descendant,
 * or the parent when `path` is a first child. null for the very first block.
 */
function previousVisiblePath(doc: Document, path: number[]): number[] | null {
  const last = path[path.length - 1];
  if (last === 0) return path.length > 1 ? path.slice(0, -1) : null;
  const prevPath = [...path.slice(0, -1), last - 1];
  let b = blockAt(doc, prevPath);
  while (b.children.length > 0) {
    prevPath.push(b.children.length - 1);
    b = b.children[b.children.length - 1];
  }
  return prevPath;
}

/**
 * Append this block's content to the previous visible block and delete it; its
 * children move under the merged block, keeping their place in the outline.
 * `caret` = length of the merged block's content before the append. null when
 * there is nothing to merge into (first block, or either side is a raw block).
 */
export function mergeWithPrevious(
  doc: Document,
  id: string,
): { doc: Document; blockId: string; caret: number } | null {
  const path = pathOf(doc.blocks, id);
  if (!path) return null;
  const prevPath = previousVisiblePath(doc, path);
  if (!prevPath) return null;
  const target = blockAt(doc, path);
  const prev = blockAt(doc, prevPath);
  if (target.kind === 'raw' || prev.kind === 'raw') return null;

  // The previous block is either a childless leaf (adopted children go after
  // its none) or the parent, whose first child is the target (adopted children
  // take its place at the front).
  const prevIsParent = prevPath.length < path.length;
  const adopted = target.children.map((c) => shiftBlock(c, prev.depth + 1 - c.depth, doc.indentUnit));
  const without = modifySiblings(doc.blocks, path, (sibs, i) => [...sibs.slice(0, i), ...sibs.slice(i + 1)]);
  const current = blockAt({ ...doc, blocks: without }, prevPath);
  const merged: Block = {
    ...withBody(current, prev.content + target.content, [
      ...prev.properties,
      ...target.properties.filter((p) => p.key !== 'id'),
    ]),
    children: prevIsParent ? [...adopted, ...current.children] : [...current.children, ...adopted],
  };
  return { doc: replaceBlock({ ...doc, blocks: without }, prevPath, merged), blockId: prev.id, caret: prev.content.length };
}

// ---------------------------------------------------------------------------
// ensureId

/**
 * Give the block a persistent `id::` property (uuid supplied by the caller): at
 * the end of a bullet's properties, after the leading property lines of a raw
 * block's content. A non-uuid `id::` is overwritten. Returns the same Document
 * when the block already has a persistent id. The block's runtime id becomes
 * the uuid.
 */
export function ensureId(doc: Document, id: string, uuid: string): Document {
  const path = pathOf(doc.blocks, id);
  if (!path) return doc;
  const block = blockAt(doc, path);
  if (block.persistentId) return doc;
  const idProp: Property = { key: 'id', value: uuid };
  const existing = block.properties.findIndex((p) => p.key === 'id');
  let next: Block;
  if (block.kind === 'raw') {
    const lines = block.content.split('\n');
    lines.splice(existing >= 0 ? existing : block.properties.length, existing >= 0 ? 1 : 0, 'id:: ' + uuid);
    next = withBody(block, lines.join('\n'), takeProperties(lines, 0));
  } else {
    const properties =
      existing >= 0 ? block.properties.map((p, i) => (i === existing ? idProp : p)) : [...block.properties, idProp];
    next = withBody(block, block.content, properties);
  }
  return replaceBlock(doc, path, { ...next, id: uuid, persistentId: true });
}
