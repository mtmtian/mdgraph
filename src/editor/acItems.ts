import type { IndexApi } from '../index/types';
import type { TriggerKind } from './keys';

export type AcItem =
  | { kind: 'page'; name: string; virtual: boolean }
  | { kind: 'block'; path: string; blockId: string; label: string; pageName: string };

const LIMIT = 20;

/** Page candidates (real pages first, then virtual) or block search hits for `query`. */
export function computeItems(kind: TriggerKind, query: string, index: IndexApi, excludeBlockId?: string): AcItem[] {
  if (kind === 'page') {
    const q = query.trim().toLowerCase();
    const real: AcItem[] = [];
    const virtual: AcItem[] = [];
    for (const p of index.state.pages.values()) {
      if (q && !p.name.toLowerCase().includes(q)) continue;
      (p.path === null ? virtual : real).push({ kind: 'page', name: p.name, virtual: p.path === null });
    }
    const byName = (a: AcItem, b: AcItem) => (a.kind === 'page' && b.kind === 'page' ? a.name.localeCompare(b.name) : 0);
    return [...real.sort(byName), ...virtual.sort(byName)].slice(0, LIMIT);
  }
  if (!query.trim()) return [];
  const items: AcItem[] = [];
  for (const hit of index.search(query, LIMIT + 1)) {
    if (hit.blockId === excludeBlockId) continue;
    const loc = index.state.blocks.get(hit.blockId);
    if (!loc) continue;
    const label = loc.block.content.split('\n', 1)[0] || loc.block.properties.map((p) => `${p.key}:: ${p.value}`)[0] || '';
    items.push({ kind: 'block', path: hit.path, blockId: hit.blockId, label, pageName: index.pageOfPath(hit.path)?.name ?? hit.path });
    if (items.length >= LIMIT) break;
  }
  return items;
}
