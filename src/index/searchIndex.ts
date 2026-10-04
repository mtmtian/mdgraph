import type { Block } from '../parser/types';

const WORD_RE = /[\p{L}\p{N}\p{M}]+/gu;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Lower-case, split on anything that is not a letter/digit; CJK runs are further
 * split into single characters plus adjacent character pairs (PLAN §5-M3).
 * May contain duplicates.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const run of text.toLowerCase().match(WORD_RE) ?? []) {
    let word = '';
    let cjk: string[] = [];
    const flushWord = () => {
      if (word) out.push(word);
      word = '';
    };
    const flushCjk = () => {
      for (let i = 0; i < cjk.length; i++) {
        out.push(cjk[i]);
        if (i + 1 < cjk.length) out.push(cjk[i] + cjk[i + 1]);
      }
      cjk = [];
    };
    for (const ch of run) {
      if (CJK_RE.test(ch)) {
        flushWord();
        cjk.push(ch);
      } else {
        flushCjk();
        word += ch;
      }
    }
    flushWord();
    flushCjk();
  }
  return out;
}

/** Text that makes a block findable: its content plus property values (except `id`). */
export function searchTextOf(block: Block): string {
  const props = block.properties.filter((p) => p.key !== 'id').map((p) => p.value);
  return props.length > 0 ? `${block.content}\n${props.join('\n')}` : block.content;
}
