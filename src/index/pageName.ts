import type { Document } from '../parser/types';
import type { PageKey } from './types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const JOURNAL_RE = /^(\d{4})[_-](\d{2})[_-](\d{2})$/;

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** "pages/a%2Fb.md" -> "a/b"; "pages/a___b.md" -> "a/b"; "journals/2022_06_25.md" -> "Jun 25th, 2022". */
export function nameFromPath(path: string): string {
  const segs = path.split('/');
  const file = segs[segs.length - 1] ?? path;
  const stem = file.replace(/\.md$/i, '');
  if (segs.length >= 2 && segs[segs.length - 2] === 'journals') {
    const m = JOURNAL_RE.exec(stem);
    if (m) {
      const month = Number(m[2]);
      if (month >= 1 && month <= 12) return `${MONTHS[month - 1]} ${ordinal(Number(m[3]))}, ${m[1]}`;
    }
  }
  return safeDecode(stem).replace(/___/g, '/');
}

/** `[[Foo Bar]]`, `#foo bar` and "Foo bar.md" all map to "foo bar". */
export function toKey(name: string): PageKey {
  return name.trim().toLowerCase();
}

/** Value of the `title::` property of the file's first block, if any. */
export function titleOf(doc: Document): string | undefined {
  const first = doc.blocks[0];
  if (!first) return undefined;
  const title = first.properties.find((p) => p.key === 'title')?.value.trim();
  return title ? title : undefined;
}
