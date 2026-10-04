import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parser/parse';
import { extractInline, isUuid, parseProperty, parseTask } from '../../src/parser/syntax';
import { FIXTURES, GRAPH_DIR, readText, simplifyDoc, type Simplified } from './helpers/parser';

interface Expected {
  indentUnit?: string;
  eol?: string;
  bom?: boolean;
  trailingNewline?: boolean;
  blocks: unknown[];
}

function check(name: string): void {
  it(`${name}.md matches expected/${name}.json`, () => {
    const expected = JSON.parse(readFileSync(`${FIXTURES}/expected/${name}.json`, 'utf8')) as Expected;
    const doc = parse(`pages/${name}.md`, readText(`${GRAPH_DIR}/pages/${name}.md`));
    if (expected.indentUnit !== undefined) expect(doc.indentUnit).toBe(expected.indentUnit);
    if (expected.eol !== undefined) expect(doc.eol).toBe(expected.eol);
    if (expected.bom !== undefined) expect(doc.bom).toBe(expected.bom);
    if (expected.trailingNewline !== undefined) expect(doc.trailingNewline).toBe(expected.trailingNewline);
    expect(simplifyDoc(doc)).toEqual(expected.blocks);
  });
}

describe('parser structure vs hand-written expected json', () => {
  check('basic');
  check('code-fence');
  check('mixed-raw');
});

describe('parser file-level detection (PLAN 3.1)', () => {
  const load = (rel: string) => parse(rel, readText(`${GRAPH_DIR}/${rel}`));

  it('detects CRLF, no BOM, trailing newline', () => {
    const doc = load('pages/crlf.md');
    expect([doc.eol, doc.bom, doc.trailingNewline]).toEqual(['\r\n', false, true]);
    expect(doc.blocks.map((b) => b.content)).toEqual(['crlf one', 'crlf two [[Basic Page]]']);
    expect(doc.blocks[0].children[0].content).toBe('crlf child');
  });

  it('detects tab indentation, star/plus markers and a missing trailing newline', () => {
    const doc = load('pages/tabs-no-eol.md');
    expect(doc.indentUnit).toBe('\t');
    expect(doc.trailingNewline).toBe(false);
    expect(simplifyDoc(doc).map((b) => [b.depth, b.content, b.children.length])).toEqual([
      [0, 'top', 2],
      [0, 'star bullet', 0],
      [0, 'plus bullet', 0],
    ]);
    expect(doc.blocks.map((b) => b.marker)).toEqual(['-', '*', '+']);
    expect(doc.blocks[0].children[0].children[0].depth).toBe(2);
  });

  it('detects four-space indentation and nests by depth', () => {
    const doc = load('pages/four-space.md');
    expect(doc.indentUnit).toBe('    ');
    expect(simplifyDoc(doc)[0].children.map((c) => [c.depth, c.content, c.children.length])).toEqual([
      [1, 'b', 1],
      [1, 'd', 0],
    ]);
  });

  it('empty and blank-only files', () => {
    expect(load('pages/empty.md').blocks).toEqual([]);
    const blank = load('pages/blank-lines.md');
    expect(blank.blocks).toHaveLength(1);
    expect(blank.blocks[0].kind).toBe('raw');
    expect(blank.blocks[0].content).toBe('\n');
  });

  it('blank line between bullets belongs to the preceding bullet', () => {
    const doc = load('pages/blank-between.md');
    expect(doc.blocks.map((b) => b.content)).toEqual(['one\n', 'two']);
  });

  it('bullet whose head line is a property line (ns%2Fchild.md)', () => {
    const doc = load('pages/ns%2Fchild.md');
    const b = doc.blocks[1];
    expect(b.content).toBe('');
    expect(b.properties).toEqual([{ key: 'date', value: '[[Jun 25th, 2022]]' }]);
    expect(b.links).toEqual(['Jun 25th, 2022']);
  });

  it('assigns unique transient ids and keeps persistent ids', () => {
    const doc = load('pages/basic.md');
    const ids: string[] = [];
    const visit = (bs: typeof doc.blocks): void => {
      for (const b of bs) {
        ids.push(b.id);
        visit(b.children);
      }
    };
    visit(doc.blocks);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((i) => i.startsWith('tmp-'))).toHaveLength(ids.length - 1);
    expect(ids).toContain('11111111-1111-4111-8111-111111111111');
  });
});

describe('syntax helpers', () => {
  it('extractInline: links, tags, refs, de-duplication and casing', () => {
    expect(
      extractInline('[[A]] and #t1 #[[Multi Word]] ((11111111-1111-4111-8111-111111111111)) [[A]] [[a]] #t1'),
    ).toEqual({
      links: ['A', 't1', 'Multi Word', 'a'],
      tags: ['t1', 'Multi Word'],
      refs: ['11111111-1111-4111-8111-111111111111'],
    });
  });

  it('extractInline: tag boundaries', () => {
    // `#` must follow line start or whitespace; trailing , . ; : ! ? ) ] are not part of the tag.
    expect(extractInline('see #tag, and (#other) plus a#b and x#y # not and ##no #end.').tags).toEqual([
      'tag',
      'end',
    ]);
    expect(extractInline('#first (see #inner) #a.b.').tags).toEqual(['first', 'inner', 'a.b']);
    expect(extractInline('# Heading').tags).toEqual([]);
    expect(extractInline('http://x.com/#anchor').tags).toEqual([]);
  });

  it('extractInline: skips inline code and fenced lines, ignores markdown link destinations and bare urls', () => {
    const text = '`[[no]] #no` [[yes]]\n```\n[[fenced]] #fenced\n```\n[text](http://a.b/c#d) https://x.y/[[z]]';
    const r = extractInline(text);
    expect(r.links).toEqual(['yes']);
    expect(r.tags).toEqual([]);
  });

  it('extractInline: nested links match the innermost', () => {
    expect(extractInline('[[a [[b]]]]').links).toEqual(['b']);
  });

  it('parseProperty', () => {
    expect(parseProperty('  key:: value here')).toEqual({ key: 'key', value: 'value here' });
    expect(parseProperty('k::')).toEqual({ key: 'k', value: '' });
    expect(parseProperty('- k:: v')).toBeNull();
    expect(parseProperty('http://x')).toBeNull();
    expect(parseProperty('plain text')).toBeNull();
  });

  it('parseTask', () => {
    expect(parseTask('TODO x')).toBe('TODO');
    expect(parseTask('DOING')).toBe('DOING');
    expect(parseTask('DONE y')).toBe('DONE');
    expect(parseTask('TODOS x')).toBeNull();
    expect(parseTask('todo x')).toBeNull();
    expect(parseTask('x TODO')).toBeNull();
  });

  it('isUuid', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isUuid('11111111-1111-4111-8111-11111111111')).toBe(false);
    expect(isUuid('zzzzzzzz-1111-4111-8111-111111111111')).toBe(false);
  });
});

describe('parser edge rules', () => {
  const p = (text: string) => parse('x.md', text);

  it('non-uuid id:: stays a plain property with a transient id', () => {
    const b = p('- a\n  id:: not-a-uuid\n').blocks[0];
    expect(b.persistentId).toBe(false);
    expect(b.id.startsWith('tmp-')).toBe(true);
    expect(b.properties).toEqual([{ key: 'id', value: 'not-a-uuid' }]);
  });

  it('property lines only count directly after the head line', () => {
    const b = p('- a\n  text\n  k:: v\n').blocks[0];
    expect(b.properties).toEqual([]);
    expect(b.content).toBe('a\ntext\nk:: v');
  });

  it('tags:: property splits on commas outside [[ ]] and feeds links', () => {
    const b = p('- a\n  tags:: [[x, y]], z\n').blocks[0];
    expect(b.tags).toEqual(['x, y', 'z']);
    expect(b.links).toEqual(['x, y', 'z']);
  });

  it('property values contribute [[links]] only', () => {
    const b = p('- a\n  rel:: [[P]] #nope\n').blocks[0];
    expect(b.links).toEqual(['P']);
    expect(b.tags).toEqual([]);
  });

  it('unclosed fence swallows the rest of the block', () => {
    const doc = p('- a\n  ```\n- b\n- c');
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].content).toBe('a\n```\n- b\n- c');
  });

  it('a fence opened and closed on one line is not a fence', () => {
    const doc = p('- ```x``` inline\n- b');
    expect(doc.blocks).toHaveLength(2);
  });

  it('bullet line may open a fence in its head', () => {
    const doc = p('- ```js\n- not a bullet\n  ```\n- real');
    expect(doc.blocks.map((b) => b.content)).toEqual(['```js\n- not a bullet\n```', 'real']);
  });

  it('indented non-bullet text after a raw run stays raw', () => {
    const doc = p('# h\n  indented\n- b');
    expect(doc.blocks.map((b) => b.kind)).toEqual(['raw', 'bullet']);
    expect(doc.blocks[0].content).toBe('# h\n  indented');
  });

  it('empty bullet and bare dash', () => {
    const doc = p('- \n-\n');
    expect(doc.blocks.map((b) => [b.kind, b.content])).toEqual([
      ['bullet', ''],
      ['bullet', ''],
    ]);
  });

  it('hr and emphasis lines are raw, not bullets', () => {
    const doc = p('---\n**bold**\n-x');
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].kind).toBe('raw');
  });

  it('continuation lines lose block indent + continuationIndent only', () => {
    const doc = p('- a\n  x\n  - b\n      deeper\n    c\n');
    const b = doc.blocks[0].children[0];
    expect(b.content).toBe('b\n  deeper\nc');
  });

  it('task keyword only on bullets', () => {
    const doc = p('TODO raw\n- TODO b');
    expect(doc.blocks.map((b) => b.task)).toEqual([null, 'TODO']);
  });
});
