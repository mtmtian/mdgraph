import { describe, expect, it } from 'vitest';
import {
  ensureId,
  findBlock,
  indent,
  mergeWithPrevious,
  outdent,
  setBlockText,
  walk,
} from '../../src/parser/ops';
import { parse } from '../../src/parser/parse';
import { serialize } from '../../src/parser/serialize';

// Codex review round 1 (docs/review-parser-codex-r1.md). Items marked
// "(rule amended)" keep the implementation and the PLAN §3 text was amended to
// match; the rest are fixed in code and keep the original expectations.
const p = (text: string) => parse('p.md', text);
const uuid = '11111111-1111-4111-8111-111111111111';

describe('parser adversarial review — PLAN §3', () => {
  it.each([4096, 10000])('H01: every finite input must round-trip at nesting depth %i (§3.5)', (depth) => {
    const input = Array.from({ length: depth }, (_, d) => '\t'.repeat(d) + '-').join('\n');
    // Keep a multi-MiB input out of the assertion diff while retaining the exact
    // byte-equality oracle. A thrown serializer error is a failed round-trip.
    let outcome: string;
    try {
      outcome = serialize(p(input)) === input ? 'identical' : 'different';
    } catch (error) {
      outcome = String(error);
    }
    expect(outcome).toBe('identical');
  });

  it('H01: lookup and edit operations also survive a 10000-deep outline', () => {
    const depth = 10000;
    const input = Array.from({ length: depth }, (_, d) => '\t'.repeat(d) + '- n' + d).join('\n');
    const doc = p(input);
    let count = 0;
    for (const _ of walk(doc)) count++;
    expect(count).toBe(depth);
    let deepest = doc.blocks[0];
    while (deepest.children.length > 0) deepest = deepest.children[0];
    expect(findBlock(doc, deepest.id)?.block).toBe(deepest);
    const edited = setBlockText(doc, deepest.id, 'edited');
    expect(serialize(edited).endsWith('- edited')).toBe(true);
    expect(serialize(doc)).toBe(input);
  });

  it('H01: indent shifts a deep subtree without recursion', () => {
    const depth = 3000;
    const nested = Array.from({ length: depth }, (_, d) => '\t'.repeat(d + 1) + '- n' + d);
    const doc = p(['- a', '- b', ...nested].join('\n'));
    const out = indent(doc, doc.blocks[1].id);
    expect(out.blocks.length).toBe(1);
    expect(serialize(out).split('\n').length).toBe(depth + 2);
    expect(serialize(out).split('\n')[2]).toBe('\t\t- n0');
  });

  it('M01: a fence opens only when the rest of the opening line has no backtick (rule amended)', () => {
    const inline = ['- ```a`\n- b', '```a`\n- b', '- a\n  ```b`\n- c', '- ```x```\n- b'];
    expect(JSON.stringify(inline.map((input) => p(input).blocks.length))).toBe('[2,2,2,2]');
    const fenced = ['- ```a\n- b', '```a\n- b', '- a\n  ```b\n- c'];
    expect(JSON.stringify(fenced.map((input) => p(input).blocks.length))).toBe('[1,1,1]');
  });

  it('M02: continuationIndent comes from the first non-blank continuation line (rule amended)', () => {
    const doc = p('- a\n \n  b');
    expect(JSON.stringify([doc.continuationIndent, doc.blocks[0].content])).toBe(
      JSON.stringify(['  ', 'a\n\nb']),
    );
  });

  it('M03: only spaces and tabs are indentation; a fullwidth space is content (rule amended)', () => {
    // The fullwidth-space line is not an indented continuation: it starts a raw run.
    const doc = p('- a\n  b\n\u3000c');
    expect(doc.blocks.map((b) => [b.kind, b.content])).toEqual([
      ['bullet', 'a\nb'],
      ['raw', '\u3000c'],
    ]);
    expect(p('- a\n\u3000- b').blocks.map((b) => b.kind)).toEqual(['bullet', 'raw']);
    expect(p('\u3000- b').blocks.map((b) => b.kind)).toEqual(['raw']);
  });

  it('M03: a line holding only "\\r" is a raw line, not a blank continuation', () => {
    // "\r" alone between two lines of an LF file: not blank, not indented.
    const doc = p('- a\n\r\n  b');
    expect(doc.blocks.map((b) => [b.kind, b.content])).toEqual([
      ['bullet', 'a'],
      ['raw', '\r\n  b'],
    ]);
    expect(p('- a\n \t \n  b').blocks.map((b) => [b.kind, b.content])).toEqual([['bullet', 'a\n \nb']]);
  });

  it('M04: lines split on LF only; a lone CR is an ordinary character (rule amended)', () => {
    const head = p('- a\rb').blocks[0];
    const continuation = p('- a\n  k:: b\rc').blocks[0];
    expect(
      JSON.stringify([head.kind, head.content, continuation.properties, continuation.content]),
    ).toBe(JSON.stringify(['bullet', 'a\rb', [{ key: 'k', value: 'b\rc' }], 'a']));
  });

  it('M05: task is recognised on bullet blocks only; raw blocks are always null (rule amended)', () => {
    expect(JSON.stringify(['TODO', 'DOING x', 'DONE'].map((input) => p(input).blocks[0].task))).toBe(
      '[null,null,null]',
    );
    expect(
      JSON.stringify(['- TODO', '- DOING x', '- DONE'].map((input) => p(input).blocks[0].task)),
    ).toBe('["TODO","DOING","DONE"]');
  });

  it('M06: setBlockText preserves a lone CR in unchanged raw content (§3.3, §3.6)', () => {
    const input = 'a\rb';
    const doc = p(input);
    expect(serialize(setBlockText(doc, doc.blocks[0].id, input))).toBe(input);
  });

  it('M07: ensureId keeps a valid uuid id:: and overwrites a non-uuid one (rule amended)', () => {
    const valid = p('- a\n  id:: 22222222-2222-4222-8222-222222222222');
    expect(ensureId(valid, valid.blocks[0].id, uuid)).toBe(valid);
    const bad = p('- a\n  id:: bad');
    const out = ensureId(bad, bad.blocks[0].id, uuid);
    expect(serialize(out)).toBe('- a\n  id:: ' + uuid);
    expect(out.blocks[0].id).toBe(uuid);
  });

  it('M08: empty raw lines stay empty and do not clear rawLines when a subtree shifts (rule amended)', () => {
    const down = p('- p\n- b\n  - c\n\n- z');
    const indented = indent(down, down.blocks[1].id);
    const up = p('- p\n  - c\n    - g\n\n- z');
    const outdented = outdent(up, up.blocks[0].children[0].id);
    expect(
      JSON.stringify({
        indented: serialize(indented),
        outdentedGrandchildRawLines: outdented.blocks[1].children[0].rawLines,
      }),
    ).toBe(
      JSON.stringify({
        indented: '- p\n  - b\n    - c\n\n- z',
        outdentedGrandchildRawLines: ['  - g', ''],
      }),
    );
  });

  it('M09: mergeWithPrevious refuses when either block is raw (rule amended)', () => {
    const results = ['a\n- b', '- a\nb'].map((input) => {
      const doc = p(input);
      const result = mergeWithPrevious(doc, doc.blocks[1].id);
      return result === null ? null : [serialize(result.doc), result.caret];
    });
    expect(JSON.stringify(results)).toBe(JSON.stringify([null, null]));
  });

  it('L01: links and tags list content occurrences first, then property occurrences (rule amended)', () => {
    const bullet = p('- [[A]]\n  p:: [[B]]\n  [[C]]').blocks[0];
    const raw = p('p:: [[A]]\n[[B]]').blocks[0];
    const tagged = p('- #A\n  tags:: B\n  #C').blocks[0];
    expect(JSON.stringify([bullet.links, raw.links, tagged.tags])).toBe(
      JSON.stringify([['A', 'C', 'B'], ['B', 'A'], ['A', 'C', 'B']]),
    );
  });

  it('L02: tags property values also exclude inline code before extraction (§3.4)', () => {
    const block = p('- tags:: `x`').blocks[0];
    expect(JSON.stringify([block.links, block.tags])).toBe('[[],[]]');
    expect(p('- tags:: a, `x`, b').blocks[0].tags).toEqual(['a', 'b']);
  });

  it('L03: tags property items drop [[ ]] and then one leading # (rule amended)', () => {
    const block = p('- tags:: #x').blocks[0];
    expect(JSON.stringify([block.links, block.tags])).toBe('[["x"],["x"]]');
    expect(p('- tags:: [[#y]]').blocks[0].tags).toEqual(['y']);
  });

  it('L04: tags properties split on commas outside [[ ]] only (rule amended)', () => {
    expect(p('- tags:: [[a,b]]').blocks[0].tags).toEqual(['a,b']);
    expect(p('- tags:: [[a,b]], c').blocks[0].tags).toEqual(['a,b', 'c']);
  });

  it('L05: a plain #tag cannot start with [ or # (rule amended)', () => {
    for (const text of ['- #[a', '- ##a']) {
      const block = p(text).blocks[0];
      expect(JSON.stringify([block.links, block.tags])).toBe('[[],[]]');
    }
  });

  it('L06: removing inline code cannot fabricate whitespace before a hash (§3.4)', () => {
    const block = p('- x`c`#tag').blocks[0];
    expect(JSON.stringify([block.links, block.tags])).toBe('[[],[]]');
    // the placeholder is not itself a tag / link character
    expect(p('- #`c`').blocks[0].tags).toEqual([]);
    expect(p('- #a`c`').blocks[0].tags).toEqual(['a']);
    expect(p('- [[a`c`b]]').blocks[0].links).toEqual([]);
    expect(p('- `c` #t').blocks[0].tags).toEqual(['t']);
  });

  it('L07: markdown-link destinations and bare URLs do not yield page links (§3.4)', () => {
    const inputs = ['- [x](https://a/[[b]])', '- https://a/[[b]]'];
    expect(JSON.stringify(inputs.map((input) => p(input).blocks[0].links))).toBe('[[],[]]');
    // text part of a markdown link and text around URLs still count
    expect(p('- [[[a]]](https://x/[[b]]) https://y/z [[c]]').blocks[0].links).toEqual(['a', 'c']);
  });

  it('L08: a property value containing a tagged wiki link still contributes its page (§3.4)', () => {
    const block = p('- p:: #[[x]]').blocks[0];
    expect(JSON.stringify(block.links)).toBe('["x"]');
    expect(block.tags).toEqual(['x']);
  });
});
