import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parser/parse';
import { deriveFields, tokenize, type Token } from '../../src/parser/syntax';
import { makeRng } from './helpers/parser';

const UUID = '11111111-1111-4111-8111-111111111111';

/** Compact view: kind:source for each token, children in brackets. */
function show(text: string, opts?: { task?: boolean }): string[] {
  const one = (t: Token): string =>
    `${t.kind}:${text.slice(t.start, t.end)}` + (t.children ? `[${t.children.map(one).join('|')}]` : '');
  return tokenize(text, opts).map(one);
}

/** The tokens of one call must tile the text and nest cleanly. */
function expectTiles(text: string, tokens: Token[], lo = 0, hi = text.length): void {
  let at = lo;
  for (const t of tokens) {
    expect(t.start).toBe(at);
    expect(t.end).toBeGreaterThan(t.start);
    at = t.end;
  }
  expect(at).toBe(hi);
}

describe('tokenize', () => {
  it('kinds and priority', () => {
    expect(show('a [[P]] #t #[[M w]] ((' + UUID + ')) `c` https://x/y [t](u)')).toEqual([
      'text:a ',
      'pageLink:[[P]]',
      'text: ',
      'tag:#t',
      'text: ',
      'tagLink:#[[M w]]',
      'text: ',
      `blockRef:((${UUID}))`,
      'text: ',
      'code:`c`',
      'text: ',
      'url:https://x/y',
      'text: [t]',
      'mdlink:(u)',
    ]);
  });

  it('emphasis wraps whole tokens; the boundary rules still look at the real previous character', () => {
    expect(show('**a [[L]]** *x*')).toEqual(['bold:**a [[L]]**[text:a |pageLink:[[L]]]', 'text: ', 'italic:*x*[text:x]']);
    // `#` right after a marker is not preceded by whitespace: no tag
    expect(show('**#t**')).toEqual(['bold:**#t**[text:#t]']);
    // a `*` inside a link or code is not a marker
    expect(show('*a [[b*c]] d*')).toEqual(['italic:*a [[b*c]] d*[text:a |pageLink:[[b*c]]|text: d]']);
    expect(show('`*` x *y*')).toEqual(['code:`*`', 'text: x ', 'italic:*y*[text:y]']);
  });

  it('fences: open/close rules, unclosed runs to the end, one token for the whole block', () => {
    expect(show('a\n````\n[[A]]\n```\n[[B]]\n````\nz')).toEqual([
      'text:a\n',
      'fence:````\n[[A]]\n```\n[[B]]\n````',
      'text:\nz',
    ]);
    expect(show('```js``` [[B]]').at(-1)).toBe('pageLink:[[B]]');
    expect(show('x\n```\n[[A]]')).toEqual(['text:x\n', 'fence:```\n[[A]]']);
    expect(show('```\nx\n``` y\n```')).toEqual(['fence:```\nx\n``` y\n```']);
  });

  it('property lines: value mode, tags list, no task badge', () => {
    expect(show('k:: #no [[Yes]] ((' + UUID + '))')).toEqual([
      'property:k:: #no [[Yes]] ((' + UUID + '))[text:#no |pageLink:[[Yes]]|text: ((' + UUID + '))]',
    ]);
    expect(show('tags:: a, [[b, c]], #d, `x`')).toEqual([
      'property:tags:: a, [[b, c]], #d, `x`[tag:a|text:, |tag:[[b, c]]|text:, |tag:#d|text:, `x`]',
    ]);
    expect(show('TODO:: x')).toEqual(['property:TODO:: x[text:x]']);
    expect(show('TODO x')[0]).toBe('task:TODO');
    expect(show('TODO x', { task: false })).toEqual(['text:TODO x']);
    expect(show('a\nTODO x')).toEqual(['text:a\nTODO x']);
  });

  it('tags:: values name the page the way deriveFields reports it', () => {
    const f = (v: string) => deriveFields('bullet', 'x', [{ key: 'tags', value: v }]).tags;
    expect(f('[[a,b]], c')).toEqual(['a,b', 'c']);
    expect(f('#x, [[#y]], #[[z w]], , `c`')).toEqual(['x', 'y', 'z w']);
    expect(f('[[ ]]')).toEqual([]);
  });

  it('every token list tiles its text, for random fragment mixes', () => {
    const parts = ['[[A]]', '#t', '**', '*', '`', '```', '((' + UUID + '))', 'k::', 'tags::', ', ', 'https://x.y', '[l](u)', 'TODO', 'p', '#', '[[', ']]'];
    const seps = [' ', '\n', ''];
    const rng = makeRng(5);
    for (let i = 0; i < 300; i++) {
      let text = '';
      for (let k = 1 + rng.int(9); k > 0; k--) text += rng.pick(parts) + rng.pick(seps);
      const tokens = tokenize(text);
      expectTiles(text, tokens);
      const nested = (ts: Token[]): void => {
        for (const t of ts) {
          if (t.children) {
            const mark = t.kind === 'bold' ? 2 : t.kind === 'italic' ? 1 : 0;
            if (t.kind === 'property') expectTiles(text, t.children, t.valueStart!, t.end);
            else expectTiles(text, t.children, t.start + mark, t.end - mark);
            nested(t.children);
          }
        }
      };
      nested(tokens);
    }
  });
});

describe('P1: indentation is spaces and tabs only', () => {
  const p = (text: string) => parse('w.md', text);

  it('a full-width space never indents a bullet or continues one', () => {
    const doc = p('- a\n　- b');
    expect(doc.blocks.map((b) => [b.kind, b.content, b.children.length])).toEqual([
      ['bullet', 'a', 0],
      ['raw', '　- b', 0],
    ]);
  });

  it('a line holding only "\\r" is a raw line, not a blank continuation', () => {
    expect(p('- a\n\r').blocks.map((b) => [b.kind, b.content])).toEqual([
      ['bullet', 'a'],
      ['raw', '\r'],
    ]);
  });

  it('fences and properties use the same whitespace', () => {
    expect(p('- a\n  　k:: v').blocks[0].properties).toEqual([]);
    // closing fence with a trailing full-width space does not close
    expect(p('- ```\n  x\n  ```　\n- b').blocks).toHaveLength(1);
  });
});
