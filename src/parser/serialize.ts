import type { Block, Document } from './types';

function renderBlock(doc: Document, block: Block, out: string[]): void {
  if (block.rawLines !== null) {
    for (const line of block.rawLines) out.push(line);
  } else if (block.kind === 'raw') {
    for (const p of block.properties) out.push(p.key + ':: ' + p.value);
    for (const line of block.content.split('\n')) out.push(line);
  } else {
    const indent = doc.indentUnit.repeat(block.depth);
    const cont = indent + doc.continuationIndent;
    const lines = block.content.split('\n');
    out.push(indent + block.marker + ' ' + lines[0]);
    for (const p of block.properties) out.push(cont + p.key + ':: ' + p.value);
    for (let i = 1; i < lines.length; i++) out.push(lines[i] === '' ? '' : cont + lines[i]);
  }
  for (const child of block.children) renderBlock(doc, child, out);
}

export function serialize(doc: Document): string {
  const lines: string[] = [];
  for (const block of doc.blocks) renderBlock(doc, block, lines);
  return (doc.bom ? '﻿' : '') + lines.join(doc.eol) + (doc.trailingNewline ? doc.eol : '');
}
