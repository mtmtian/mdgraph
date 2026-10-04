import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Block, Document } from '../../../src/parser/types';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const FIXTURES = join(REPO_ROOT, 'fixtures/synthetic');
export const GRAPH_DIR = join(FIXTURES, 'graph');

/** Decode bytes the way the import layer must: keep a BOM as U+FEFF. */
export function decode(buf: Uint8Array): string {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(buf);
}

export function readText(file: string): string {
  return decode(readFileSync(file));
}

/** Recursively list `.md` files (absolute paths), skipping segments in `skipSegments` relative to `root`. */
export function listMarkdown(root: string, skipSegments: string[] = []): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(root, full).split(sep);
      if (rel.some((seg) => skipSegments.includes(seg))) continue;
      const st = statSync(full);
      if (st.isDirectory()) visit(full);
      else if (st.isFile() && name.endsWith('.md')) out.push(full);
    }
  };
  visit(root);
  return out;
}

export interface Simplified {
  kind: string;
  depth: number;
  content: string;
  properties: [string, string][];
  task: string | null;
  links: string[];
  tags: string[];
  refs: string[];
  persistentId?: string;
  children: Simplified[];
}

/** Shape used by fixtures/synthetic/expected/*.json. */
export function simplifyBlock(b: Block): Simplified {
  const s: Simplified = {
    kind: b.kind,
    depth: b.depth,
    content: b.content,
    properties: b.properties.map((p) => [p.key, p.value]),
    task: b.task,
    links: b.links,
    tags: b.tags,
    refs: b.refs,
    children: b.children.map(simplifyBlock),
  };
  if (b.persistentId) s.persistentId = b.id;
  return s;
}

export function simplifyDoc(doc: Document): Simplified[] {
  return doc.blocks.map(simplifyBlock);
}

/** Minimal LCS line diff: lines only in `before` (removed) and only in `after` (added). */
export function lineDiff(before: string[], after: string[]): { removed: string[]; added: string[] } {
  const n = before.length;
  const m = after.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = before[i] === after[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) removed.push(before[i++]);
    else added.push(after[j++]);
  }
  while (i < n) removed.push(before[i++]);
  while (j < m) added.push(after[j++]);
  return { removed, added };
}

/** Small deterministic PRNG (LCG, Numerical Recipes constants). */
export function makeRng(seed: number): {
  next(): number;
  int(n: number): number;
  pick<T>(xs: readonly T[]): T;
  chance(p: number): boolean;
} {
  let s = seed >>> 0;
  const next = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (xs) => xs[Math.floor(next() * xs.length)],
    chance: (p) => next() < p,
  };
}
