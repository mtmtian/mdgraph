import type { Block, Document } from './types';

function renderBlock(doc: Document, block: Block, out: string[]): void {
  if (block.rawLines !== null) {
    for (const line of block.rawLines) out.push(line);
  } else if (block.kind === 'raw') {
    // A raw block's content already contains its property lines.
    for (const line of block.content.split('\n')) out.push(line);
  } else {
    const indent = doc.indentUnit.repeat(block.depth);
    const cont = indent + doc.continuationIndent;
    const lines = block.content.split('\n');
    out.push(indent + block.marker + ' ' + lines[0]);
    for (const p of block.properties) out.push(cont + p.key + ':: ' + p.value);
    for (let i = 1; i < lines.length; i++) out.push(lines[i] === '' ? '' : cont + lines[i]);
  }
}

export function serialize(doc: Document): string {
  const lines: string[] = [];
  // Explicit stack: nesting depth is unbounded, the call stack is not.
  const stack: Block[] = [];
  for (let i = doc.blocks.length - 1; i >= 0; i--) stack.push(doc.blocks[i]);
  while (stack.length > 0) {
    const block = stack.pop()!;
    renderBlock(doc, block, lines);
    for (let i = block.children.length - 1; i >= 0; i--) stack.push(block.children[i]);
  }
  return (doc.bom ? '﻿' : '') + lines.join(doc.eol) + (doc.trailingNewline ? doc.eol : '');
}
