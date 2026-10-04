// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderInline, type InlineOptions } from '../../src/editor/inline';
import { extractInline } from '../../src/parser/syntax';

afterEach(cleanup);

function ctx() {
  return {
    resolveBlock: vi.fn((uuid: string) => (uuid === '11111111-1111-4111-8111-111111111111' ? 'target line' : undefined)),
    onOpenPage: vi.fn(),
    onOpenBlock: vi.fn(),
  };
}

describe('renderInline', () => {
  test('code, bold, italic', () => {
    const { container } = render(<div>{renderInline('a `x*y*` **b** *c*', ctx())}</div>);
    expect(container.querySelector('code')!.textContent).toBe('x*y*');
    expect(container.querySelector('strong')!.textContent).toBe('b');
    expect(container.querySelector('em')!.textContent).toBe('c');
  });

  test('page links and tags call onOpenPage with the bare name', async () => {
    const c = ctx();
    render(<div>{renderInline('see [[Foo Bar]] #tag and #[[multi word]]', c)}</div>);
    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: '[[Foo Bar]]' }));
    await user.click(screen.getByRole('link', { name: '#tag' }));
    await user.click(screen.getByRole('link', { name: '#[[multi word]]' }));
    expect(c.onOpenPage.mock.calls.map((a) => a[0])).toEqual(['Foo Bar', 'tag', 'multi word']);
  });

  test('block refs show the first line, fall back to the raw text, and open the block', async () => {
    const c = ctx();
    render(
      <div>
        {renderInline('((11111111-1111-4111-8111-111111111111)) ((22222222-2222-4222-8222-222222222222))', c)}
      </div>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: 'target line' }));
    expect(c.onOpenBlock).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    expect(screen.getByRole('link', { name: '((22222222-2222-4222-8222-222222222222))' })).toBeTruthy();
  });

  test('bare URLs are plain text: no anchor, and # inside is not a tag', () => {
    const { container } = render(<div>{renderInline('go https://example.com/a#frag, now', ctx())}</div>);
    expect(container.querySelector('a')).toBeNull();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(container.textContent).toBe('go https://example.com/a#frag, now');
  });

  test('property lines are dimmed, task keyword is a badge, newlines are kept', () => {
    const { container } = render(<div>{renderInline('TODO buy [[milk]]\nkey:: value\nlast line', ctx())}</div>);
    expect(container.querySelector('.inline-task-todo')!.textContent).toBe('TODO');
    expect(container.querySelector('.inline-prop')!.textContent).toBe('key:: value');
    // the rendered text is exactly the input, newline after a property line included
    expect(container.textContent).toBe('TODO buy [[milk]]\nkey:: value\nlast line');
  });

  test('markup without hidden markers renders exactly the input text', () => {
    const input = 'a [[x]] #t\nkey::v [[y]]\n  k2:: 1\n```\nz\n```\nb\n';
    const { container } = render(<div>{renderInline(input, ctx())}</div>);
    expect(container.textContent).toBe(input);
  });

  test('a fenced block renders as one code span and inline syntax inside is not interpreted', () => {
    const { container } = render(<div>{renderInline('```\n**x** [[y]]\n```', ctx())}</div>);
    expect(container.querySelector('.inline-fence')!.textContent).toBe('```\n**x** [[y]]\n```');
    expect(container.querySelector('strong')).toBeNull();
  });
});

const UUID = '11111111-1111-4111-8111-111111111111';

/** Everything on screen that can be clicked, found by clicking it. */
async function clickables(text: string, opts?: InlineOptions) {
  cleanup();
  const c = ctx();
  const { container } = render(<div>{renderInline(text, c, opts)}</div>);
  const user = userEvent.setup();
  for (const el of screen.queryAllByRole('link')) await user.click(el);
  return {
    pages: [...new Set(c.onOpenPage.mock.calls.map((a) => a[0] as string))],
    blocks: [...new Set(c.onOpenBlock.mock.calls.map((a) => a[0] as string))],
    hasTaskBadge: container.querySelector('.inline-task') !== null,
  };
}

describe('renderInline and extractInline agree (one tokenizer)', () => {
  // [input, pages that must be clickable, block refs that must be clickable, options]
  const cases: [string, string[], string[], InlineOptions?][] = [
    ['**#tag**', [], []],
    ['**a #tag** and *b #it*', ['tag', 'it'], []],
    ['**[[bold link]]** *[[it link]]*', ['bold link', 'it link'], []],
    ['[[ ]] and #[[ ]] and [[real]]', ['real'], []],
    ['foo:: #bar', [], []],
    ['foo:: [[B]] #[[C]] #no ((' + UUID + '))', ['B', 'C'], []],
    ['tags:: a, [[b c]], #d, `x`', ['a', 'b c', 'd'], []],
    ['TAGS:: [[a, b]], #[[c]]', ['a, b', 'c'], []],
    ['````\n[[A]]\n````', [], []],
    ['```\n[[A]] #t\n```\n[[after]]', ['after'], []],
    ['```js``` [[B]]', ['B'], []],
    ['```\n[[unclosed]]', [], []],
    ['```x\n[[A]]\n``` [[still fenced]]\n```\n[[out]]', ['out'], []],
    ['`[[no]] #no` [[yes]]', ['yes'], []],
    ['[[a`c`b]] x`c`#t #`c`', [], []],
    ['see https://a.b/[[z]]#frag, [t](http://u/[[v]]) [[ok]]', ['ok'], []],
    ['((' + UUID + ')) ((22222222-2222-4222-8222-222222222222)) k:: ((' + UUID + '))', [], [UUID, '22222222-2222-4222-8222-222222222222']],
    ['[[a [[b]]]] #a.b. (see #c)', ['b', 'a.b', 'c'], []],
    ['TODO [[x]] #y', ['x', 'y'], []],
    ['TODO [[x]] #y', ['x', 'y'], [], { task: false }],
  ];

  test.each(cases)('%j', async (input, pages, blocks, opts) => {
    const shown = await clickables(input, opts);
    const found = extractInline(input);
    expect(shown.pages.sort()).toEqual([...pages].sort());
    expect(shown.blocks.sort()).toEqual([...blocks].sort());
    expect(shown.pages.sort()).toEqual([...new Set(found.links)].sort());
    expect(shown.blocks.sort()).toEqual([...new Set(found.refs)].sort());
  });

  test('raw block text: a leading TODO is not a task badge', async () => {
    expect((await clickables('TODO x', { task: false })).hasTaskBadge).toBe(false);
    expect((await clickables('TODO x')).hasTaskBadge).toBe(true);
    expect((await clickables('x\nTODO y')).hasTaskBadge).toBe(false);
  });

  test('200 random mixes of syntax fragments', async () => {
    const parts = [
      '[[A]]', '[[ ]]', '#t', '#[[M w]]', '**', '*', '`', '```', '````', '((' + UUID + '))', 'k::', 'tags::', ', ',
      'https://x.y/[[Z]]', '[l](u/[[Q]])', 'TODO', 'plain', '#', '[[', ']]', '(', ')',
    ];
    const seps = [' ', ' ', '\n', ''];
    // tiny LCG (helpers/parser needs a file: URL, which jsdom does not provide)
    let seed = 99;
    const rng = {
      int: (n: number) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return Math.floor((seed / 0x100000000) * n);
      },
      pick: <T,>(xs: readonly T[]): T => xs[rng.int(xs.length)],
    };
    for (let i = 0; i < 200; i++) {
      let input = '';
      for (let k = 1 + rng.int(8); k > 0; k--) input += rng.pick(parts) + rng.pick(seps);
      const shown = await clickables(input);
      const found = extractInline(input);
      const label = JSON.stringify(input);
      expect([label, shown.pages.sort()]).toEqual([label, [...new Set(found.links)].sort()]);
      expect([label, shown.blocks.sort()]).toEqual([label, [...new Set(found.refs)].sort()]);
    }
  });
});
