import { describe, expect, it } from 'vitest';
import { indent, insertAfter, mergeWithPrevious, outdent, setBlockText, ensureId, walk } from '../../src/parser/ops';
import { parse } from '../../src/parser/parse';
import { serialize } from '../../src/parser/serialize';
import type { Block, Document } from '../../src/parser/types';
import { makeRng, simplifyDoc } from './helpers/parser';

type Rng = ReturnType<typeof makeRng>;

const WORDS = [
  'alpha',
  'beta [[Page One]]',
  'gamma #tag',
  'delta #[[multi word]]',
  'TODO task',
  'DONE finished',
  'ref ((11111111-1111-4111-8111-111111111111))',
  '`code [[x]]`',
  'unicode 中文 text',
  'a:: not at start',
  'trailing space ',
  '',
];
const PROPS = ['key:: value', 'id:: 11111111-1111-4111-8111-111111111111', 'tags:: [[a]], b', 'empty::', 'k::v'];
const RAW = ['# Heading', 'plain paragraph', '---', '**bold** text', '<div>html</div>', 'title:: page title', '> quote'];
const FENCES = ['```', '```js', '````', '``` trailing'];
const CHAOS_ALPHABET = ' \t-*+#:[]()`\r\n.,a1';

/** One random file built from bullet/raw/blank/property/fence/indent pieces. */
function genFile(rng: Rng): string {
  const eol = rng.chance(0.3) ? '\r\n' : '\n';
  const unit = rng.pick(['  ', '    ', '\t', '   ', ' ']);
  const n = rng.int(16);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const ws = rng.chance(0.07) ? rng.pick([' ', '\t ', ' \t', ' ']) : unit.repeat(rng.int(4));
    switch (rng.int(9)) {
      case 0:
      case 1:
      case 2:
        out.push(ws + rng.pick(['-', '*', '+', '-', '-']) + (rng.chance(0.06) ? '' : ' ') + rng.pick(WORDS));
        break;
      case 3:
        out.push(ws + (rng.chance(0.5) ? '  ' : '') + rng.pick(WORDS));
        break;
      case 4:
        out.push(rng.pick(['', '', '  ', '\t']));
        break;
      case 5:
        out.push(ws + (rng.chance(0.5) ? '  ' : '') + rng.pick(PROPS));
        break;
      case 6:
        out.push(ws + (rng.chance(0.5) ? '  ' : '') + rng.pick(FENCES));
        break;
      case 7:
        out.push(rng.pick(RAW));
        break;
      default: {
        let s = '';
        const len = rng.int(8);
        for (let k = 0; k < len; k++) s += CHAOS_ALPHABET[rng.int(CHAOS_ALPHABET.length)];
        out.push(s.replace(/[\r\n]/g, rng.chance(0.5) ? '' : '\r'));
      }
    }
  }
  let text = out.join(eol);
  if (out.length > 0 && rng.chance(0.65)) text += eol;
  if (rng.chance(0.2)) text = '﻿' + text;
  return text;
}

describe('parser property: serialize(parse(x)) === x', () => {
  it('holds for 200 seeded random files', () => {
    const rng = makeRng(20240607);
    for (let i = 0; i < 200; i++) {
      const text = genFile(rng);
      let out: string;
      try {
        out = serialize(parse('gen.md', text));
      } catch (e) {
        throw new Error(`sample #${i} threw ${String(e)}: ${JSON.stringify(text)}`);
      }
      if (out !== text) {
        throw new Error(`sample #${i} not idempotent.\n input: ${JSON.stringify(text)}\noutput: ${JSON.stringify(out)}`);
      }
    }
  });

  it('transient ids are unique within every random Document', () => {
    const rng = makeRng(7);
    for (let i = 0; i < 200; i++) {
      const text = genFile(rng);
      const ids = [...walk(parse('gen.md', text))].map((r) => r.block.id);
      const dup = ids.filter((id, k) => ids.indexOf(id) !== k && id.startsWith('tmp-'));
      if (dup.length > 0) throw new Error(`duplicate ids ${dup.join()} for ${JSON.stringify(text)}`);
    }
  });

  it('degenerate inputs', () => {
    for (const text of ['', '\n', '\r\n', '﻿', '﻿\n', '- ', '-', '```', '\n\n\n', '- a\r', '- a\r\n\n- b\r\n', 'x'.repeat(10)]) {
      expect(serialize(parse('d.md', text))).toBe(text);
    }
  });
});

// ---------------------------------------------------------------------------
// Ops on random *clean* outlines: after any sequence of ops the serialized
// text re-parses to exactly the Document the ops produced.

function genOutline(rng: Rng): string {
  const eol = rng.chance(0.3) ? '\r\n' : '\n';
  const unit = rng.pick(['  ', '    ', '\t']);
  const out: string[] = [];
  if (rng.chance(0.4)) out.push('title:: Page', '');
  const n = 1 + rng.int(9);
  let depth = 0;
  for (let i = 0; i < n; i++) {
    depth = i === 0 ? 0 : Math.min(rng.int(depth + 2), depth + 1);
    const ind = unit.repeat(depth);
    out.push(`${ind}${rng.pick(['-', '*'])} ${rng.pick(WORDS.filter((w) => w && !w.includes('::') && !w.startsWith('`')))}`);
    if (rng.chance(0.25)) out.push(`${ind}  k${i}:: v${i}`);
    if (rng.chance(0.25)) out.push(`${ind}  second line ${i}`);
  }
  return out.join(eol) + (rng.chance(0.8) ? eol : '');
}

function allBlocks(doc: Document): Block[] {
  return [...walk(doc)].map((r) => r.block);
}

describe('ops property: results stay serializable and stable', () => {
  it('300 random op sequences over seeded outlines', () => {
    const rng = makeRng(4242);
    let uuidCounter = 0;
    for (let s = 0; s < 60; s++) {
      const text = genOutline(rng);
      let doc = parse('gen.md', text);
      const history = [text];
      for (let step = 0; step < 5; step++) {
        const blocks = allBlocks(doc);
        const b = rng.pick(blocks);
        const op = rng.int(6);
        const before = serialize(doc);
        let label = '';
        switch (op) {
          case 0:
            label = 'setBlockText';
            doc = setBlockText(doc, b.id, `edited ${step} [[L${step}]]\nkx:: vx\nmore`);
            break;
          case 1:
            label = 'insertAfter';
            doc = insertAfter(doc, b.id)?.doc ?? doc;
            break;
          case 2:
            label = 'indent';
            doc = indent(doc, b.id);
            break;
          case 3:
            label = 'outdent';
            doc = outdent(doc, b.id);
            break;
          case 4:
            label = 'mergeWithPrevious';
            doc = mergeWithPrevious(doc, b.id)?.doc ?? doc;
            break;
          default:
            label = 'ensureId';
            uuidCounter++;
            doc = ensureId(doc, b.id, `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`);
        }
        const after = serialize(doc);
        history.push(`${label} ${b.id} -> ${JSON.stringify(after)}`);
        if (JSON.stringify(simplifyDoc(parse(doc.path, after))) !== JSON.stringify(simplifyDoc(doc))) {
          throw new Error(`unstable after ${label}\n${history.join('\n')}\nbefore: ${JSON.stringify(before)}`);
        }
        // ids must stay unique
        const ids = allBlocks(doc).map((x) => x.id);
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });
});
