import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const FIXTURE_ROOT = join(import.meta.dirname, '../../../fixtures/synthetic');
export const GRAPH_DIR = join(FIXTURE_ROOT, 'graph');

export interface FixtureFile {
  /** Path relative to the fixtures root folder, '/'-separated, without the root folder name. */
  rel: string;
  bytes: Uint8Array;
}

export function walkGraph(dir = GRAPH_DIR, prefix = ''): FixtureFile[] {
  const out: FixtureFile[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...walkGraph(full, rel));
    else out.push({ rel, bytes: new Uint8Array(readFileSync(full)) });
  }
  return out;
}

export function expectedImportedPaths(): string[] {
  const j = JSON.parse(readFileSync(join(FIXTURE_ROOT, 'expected/index.json'), 'utf8')) as {
    importedPaths: string[];
  };
  return j.importedPaths;
}

/** Build `{relativePath:'graph/<rel>', file}` entries like a webkitdirectory FileList would give. */
export function graphEntries(rootName = 'graph'): Array<{ relativePath: string; file: File }> {
  return walkGraph().map((f) => ({
    relativePath: `${rootName}/${f.rel}`,
    file: new File([f.bytes.slice()], f.rel.split('/').pop()!),
  }));
}
