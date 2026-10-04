// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderInline } from '../../src/editor/inline';

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
    expect(container.textContent).toBe('TODO buy [[milk]]\nkey:: valuelast line');
    expect(container.textContent).toContain('\n');
  });

  test('a fenced block renders as one code span and inline syntax inside is not interpreted', () => {
    const { container } = render(<div>{renderInline('```\n**x** [[y]]\n```', ctx())}</div>);
    expect(container.querySelector('.inline-fence')!.textContent).toBe('```\n**x** [[y]]\n```');
    expect(container.querySelector('strong')).toBeNull();
  });
});
