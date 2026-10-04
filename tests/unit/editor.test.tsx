// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import Outline from '../../src/editor/Outline';
import { flatten } from '../../src/editor/keys';
import { createFileStore } from '../../src/storage/idb';
import { editableTextOf } from '../../src/store/types';
import { createWorkspaceStore } from '../../src/store/workspace';
import { importedFiles } from './index.graphHelpers';

const BASIC = 'pages/basic.md';
const JOURNAL = 'journals/2022_06_25.md';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

afterEach(cleanup);

let dbCounter = 0;
async function setup(path = BASIC) {
  const store = createWorkspaceStore({ fileStore: createFileStore(`mdgraph-editor-test-${++dbCounter}`) });
  const files = importedFiles();
  await store.getState().importFiles('graph', files, files.length);
  const user = userEvent.setup();
  render(<Outline path={path} store={store} />);
  return { store, user };
}

const items = () => [...document.querySelectorAll<HTMLLIElement>('li.block')];
const blocksOf = (store: Awaited<ReturnType<typeof setup>>['store'], path = BASIC) => flatten(store.getState().docs.get(path)!.blocks);
const textarea = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: '编辑块' });
/** The rendered (non-editing) view of the n-th block: 1 First, 2 second, 3 child, 4 grandchild, 5 DONE third, 6 DOING fourth. */
const view = (n: number) => items()[n].querySelector<HTMLElement>('.block-view')!;

describe('Outline rendering', () => {
  test('renders one li per block with depth, DOM id = block id, no bullet dot for raw blocks', async () => {
    const { store } = await setup();
    const blocks = blocksOf(store);
    expect(blocks.length).toBe(7);
    expect(items().map((li) => li.id)).toEqual(blocks.map((b) => b.id));
    expect(items().map((li) => Number(li.dataset.depth))).toEqual([0, 0, 0, 1, 2, 0, 0]);
    expect(blocks[0].kind).toBe('raw');
    expect(items()[0].querySelector('.block-dot')!.textContent).toBe('');
    expect(items()[1].querySelector('.block-dot')!.textContent).toBe('•');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  test('[[Link Target]] is clickable and opens the page; ((uuid)) shows the referenced first line', async () => {
    const { store, user } = await setup();
    const links = screen.getAllByRole('link', { name: /Link Target/ });
    expect(links.length).toBeGreaterThan(0);
    await user.click(links[0]);
    expect(store.getState().currentPage).toBe('link target');
    // Clicking a link must not switch the block into edit mode.
    expect(screen.queryByRole('textbox')).toBeNull();

    const grandchild = items()[4];
    expect(within(grandchild).getByRole('link').textContent).toBe('TODO second block');
  });
});

describe('Outline editing', () => {
  test('clicking a block shows a textarea with editableTextOf, without id::', async () => {
    const { store, user } = await setup();
    const second = blocksOf(store)[2];
    expect(second.persistentId).toBe(true);
    await user.click(view(2));
    expect(textarea().value).toBe(editableTextOf(second));
    expect(textarea().value).toContain('key:: value');
    expect(textarea().value).not.toContain('id::');
    expect(document.activeElement).toBe(textarea());
  });

  test('Enter commits, inserts a sibling after, focuses it and marks the file dirty', async () => {
    const { store, user } = await setup();
    const before = blocksOf(store);
    await user.click(view(1));
    await user.keyboard('{Enter}');
    const after = blocksOf(store);
    expect(after.length).toBe(before.length + 1);
    expect(after[2].content).toBe('');
    expect(after[2].depth).toBe(after[1].depth);
    expect(store.getState().dirty.has(BASIC)).toBe(true);
    expect(items().length).toBe(before.length + 1);
    expect(document.activeElement).toBe(textarea());
    expect(textarea().value).toBe('');
    expect(items()[2].contains(textarea())).toBe(true);
  });

  test('Shift+Enter inserts a newline and does not create a block', async () => {
    const { store, user } = await setup();
    await user.click(view(1));
    await user.keyboard('{Shift>}{Enter}{/Shift}x');
    expect(textarea().value.endsWith('\nx')).toBe(true);
    expect(blocksOf(store).length).toBe(7);
  });

  test('Tab / Shift+Tab change depth and keep focus on the block', async () => {
    const { store, user } = await setup();
    await user.click(view(5));
    const id = blocksOf(store)[5].id;
    expect(blocksOf(store)[5].depth).toBe(0);
    await user.keyboard('{Tab}');
    expect(blocksOf(store).find((b) => b.id === id)!.depth).toBe(1);
    expect(items().find((li) => li.id === id)!.dataset.depth).toBe('1');
    expect(document.activeElement).toBe(textarea());
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(blocksOf(store).find((b) => b.id === id)!.depth).toBe(0);
    expect(document.activeElement).toBe(textarea());
  });

  test('Backspace at offset 0 merges into the previous block with the caret at the join', async () => {
    const { store, user } = await setup();
    await user.click(view(6));
    await user.keyboard('{Home}{Backspace}');
    const blocks = blocksOf(store);
    expect(blocks.length).toBe(6);
    expect(blocks[5].content).toMatch(/^DONE third blockDOING fourth/);
    expect(document.activeElement).toBe(textarea());
    expect(textarea().selectionStart).toBe('DONE third block'.length);
    expect(textarea().selectionEnd).toBe('DONE third block'.length);
  });

  test('Backspace merge into a block with property lines maps the caret into the textarea text', async () => {
    const { store, user } = await setup();
    await user.click(view(3));
    await user.keyboard('{Home}{Backspace}');
    const merged = blocksOf(store)[2];
    expect(merged.id).toBe('11111111-1111-4111-8111-111111111111');
    expect(textarea().value).toBe(editableTextOf(merged));
    const join = textarea().value.indexOf('child of second');
    expect(join).toBeGreaterThan(0);
    expect(textarea().selectionStart).toBe(join);
  });

  test('ArrowUp / ArrowDown on the first / last line move focus to the neighbouring block', async () => {
    const { user } = await setup();
    await user.click(view(5));
    await user.keyboard('{ArrowUp}');
    expect(textarea().value).toContain('grandchild referencing');
    expect(textarea().selectionStart).toBe(textarea().value.length);
    await user.keyboard('{ArrowDown}');
    expect(textarea().value).toBe('DONE third block');
    expect(textarea().selectionStart).toBe(0);
  });

  test('Escape leaves edit mode', async () => {
    const { user } = await setup();
    await user.click(view(5));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  test('editing text and blurring writes through setBlockText', async () => {
    const { store, user } = await setup();
    await user.click(view(5));
    await user.keyboard(' edited');
    await user.keyboard('{Escape}');
    expect(blocksOf(store)[5].content).toBe('DONE third block edited');
    expect(store.getState().dirty.has(BASIC)).toBe(true);
    expect(screen.getByText(/third block edited/)).toBeTruthy();
  });

  test('blur without modification does not make the file dirty', async () => {
    const { store, user } = await setup();
    await user.click(view(2));
    await user.keyboard('{Escape}');
    await user.click(view(1));
    await user.click(document.body);
    expect(store.getState().dirty.size).toBe(0);
  });
});

describe('Outline autocomplete', () => {
  test('typing [[Bas lists pages; Enter inserts [[Basic Page]] and puts the caret after ]]', async () => {
    const { store, user } = await setup();
    await user.click(view(1));
    // user-event treats `[` as a key-descriptor opener: `[[` types one literal `[`.
    await user.keyboard(' [[[[Bas');
    const options = screen.getAllByRole('option');
    expect(options.length).toBeLessThanOrEqual(20);
    expect(options.some((o) => o.textContent?.includes('Basic Page'))).toBe(true);
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('listbox')).toBeNull();
    const ta = textarea();
    expect(ta.value).toContain('[[Basic Page]]');
    expect(ta.selectionStart).toBe(ta.value.indexOf('[[Basic Page]]') + '[[Basic Page]]'.length);
    expect(blocksOf(store).length).toBe(7);
  });

  test('arrow keys move the selection, Esc closes, typing ]] closes', async () => {
    const { user } = await setup();
    await user.click(view(1));
    await user.keyboard(' [[[[');
    const all = screen.getAllByRole('option');
    expect(all.length).toBeGreaterThan(1);
    expect(all[0].getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('textbox')).toBeTruthy();
    await user.keyboard('Bas]]');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  test('page candidates list real pages before virtual ones', async () => {
    const { store, user } = await setup();
    await user.click(view(1));
    await user.keyboard(' [[[[');
    const names = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    const pages = [...store.getState().index.state.pages.values()];
    expect(pages.some((p) => p.path === null)).toBe(true);
    const firstVirtual = names.findIndex((n) => n.includes('虚拟页'));
    if (firstVirtual >= 0) expect(names.slice(firstVirtual).every((n) => n.includes('虚拟页'))).toBe(true);
  });

  test('typing (( then picking a hit ensures a uuid in the referenced file and inserts ((uuid))', async () => {
    const { store, user } = await setup();
    expect(store.getState().dirty.size).toBe(0);
    await user.click(view(1));
    await user.keyboard(' ((journal');
    const option = screen.getAllByRole('option').find((o) => o.textContent?.includes('journal entry'))!;
    expect(option.textContent).toContain('Jun 25th, 2022');
    await user.keyboard('{Enter}');
    expect(store.getState().dirty.has(JOURNAL)).toBe(true);
    const m = /\(\(([^)]+)\)\)/.exec(textarea().value);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(UUID_RE);
    const journalBlock = blocksOf(store, JOURNAL).find((b) => b.persistentId)!;
    expect(journalBlock.id).toBe(m![1]);
    await user.keyboard('{Escape}');
    expect(blocksOf(store)[1].refs).toContain(m![1]);
  });
});
