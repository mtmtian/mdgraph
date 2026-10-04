// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createFileStore } from '../../src/storage/idb';
import type { ImportedFile } from '../../src/storage/types';
import { createWorkspaceStore, useWorkspace } from '../../src/store/workspace';
import type { WorkspaceStore } from '../../src/store/workspace';
import BlockText from '../../src/views/BlockText';
import ImportPanel from '../../src/views/ImportPanel';
import PageView from '../../src/views/PageView';
import { importedFiles } from './index.graphHelpers';

let dbCounter = 0;
const scrollIntoView = vi.fn();

beforeEach(() => {
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
});
afterEach(cleanup);

async function setup(files: ImportedFile[] = importedFiles()): Promise<WorkspaceStore> {
  const store = createWorkspaceStore({
    fileStore: createFileStore(`mdgraph-views-test-${++dbCounter}`),
    download: { zip: async () => {}, markdown: () => {} },
  });
  await store.getState().importFiles('graph', files, files.length);
  return store;
}

const open = (store: WorkspaceStore, page: string) => act(() => store.getState().openPage(page));

const panel = () => screen.getByRole('region', { name: '反向链接' });
const groupNames = () =>
  within(panel())
    .queryAllByRole('heading', { level: 4 })
    .map((h) => h.textContent?.replace(/\d+$/, '').trim());
const items = () => within(panel()).queryAllByRole('listitem');
const itemTexts = () => items().map((li) => li.textContent ?? '');

describe('PageView + Backlinks', () => {
  test('virtual page: marker shown, backlinks list basic.md entries with breadcrumb', async () => {
    const store = await setup();
    render(<PageView store={store} />);
    open(store, 'Link Target');

    expect(screen.getByText('虚拟页（无文件）')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '导出此文件' })).toBeNull();
    expect(groupNames()).toEqual(['Basic Page']);
    const texts = itemTexts();
    expect(texts).toHaveLength(2);
    expect(texts.some((t) => t.includes('First block with a [[Link Target]] and a #tag'))).toBe(true);
    expect(texts.some((t) => t.includes('DOING fourth [[Link Target]] again and [[link target]] lowercase'))).toBe(true);
    for (const t of texts) expect(t).toContain('Basic Page');
  });

  test('real page header: name, path, export button; dirty marker after an edit', async () => {
    const store = await setup();
    render(<PageView store={store} />);
    open(store, 'Basic Page');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Basic Page');
    expect(screen.getByText('pages/basic.md')).toBeTruthy();
    expect(screen.queryByText('未导出')).toBeNull();
    const block = store.getState().docs.get('pages/basic.md')!.blocks[1]!;
    expect(document.getElementById(block.id)).not.toBeNull();

    act(() => store.getState().setBlockText('pages/basic.md', block.id, 'edited first'));
    expect(screen.getByText('未导出')).toBeTruthy();
    expect(screen.getByRole('button', { name: '导出此文件' })).toBeTruthy();
    await store.flush();
  });

  test('Basic Page: four source groups, basic.md itself excluded', async () => {
    const store = await setup();
    render(<PageView store={store} />);
    open(store, 'Basic Page');

    expect([...groupNames()].sort()).toEqual(['Jun 25th, 2022', 'bom', 'crlf', 'mixed-raw']);
    const all = itemTexts().join('\n');
    expect(all).toContain('crlf two [[Basic Page]]');
    expect(all).toContain('with bom [[Basic Page]]');
    expect(all).toContain('bullet after raw [[Basic Page]]');
    expect(all).toContain('journal entry referencing [[Basic Page]]');
    expect(all).not.toContain('DOING fourth');
    expect(all).not.toContain('grandchild referencing');
  });

  test('self references are hidden: Renamed Deep is empty, ns/child lists other___deep', async () => {
    const store = await setup();
    render(<PageView store={store} />);
    open(store, 'Renamed Deep');
    expect(within(panel()).getByText('没有反向链接')).toBeTruthy();
    expect(items()).toHaveLength(0);

    open(store, 'ns/child');
    expect(groupNames()).toEqual(['Renamed Deep']);
    expect(itemTexts()[0]).toContain('links to [[ns/child]] and [[other/deep]] and [[Renamed Deep]]');
  });

  test('block reference to uuid 1111: only the journal entry remains (basic.md grandchild is a self reference)', async () => {
    const store = await setup();
    render(<PageView store={store} />);
    open(store, 'Basic Page');
    // ((uuid)) renders as the referenced block's first line ("TODO second block"), not the raw uuid
    const refs = itemTexts().filter((t) => t.includes('journal entry referencing') && t.includes('TODO second block'));
    expect(refs).toHaveLength(1);
    expect(refs[0]).toContain('journal entry referencing');
  });

  test('block backlinks are merged in even when the referencing block does not link the page', async () => {
    const store = await setup([
      { path: 'pages/a.md', text: '- target block\n  id:: 22222222-2222-4222-8222-222222222222\n- other' },
      { path: 'pages/b.md', text: '- parent\n  - see ((22222222-2222-4222-8222-222222222222))\n    - kid one\n      - kid two' },
    ]);
    render(<PageView store={store} />);
    open(store, 'a');
    expect(groupNames()).toEqual(['b']);
    const item = items()[0]!;
    expect(item.textContent).toContain('see target block'); // ((uuid)) resolved to the target block text
    expect(item.textContent).toContain('b › parent');
    expect(within(item).getByText('ref')).toBeTruthy();

    // children are collapsed behind a count (all descendants) and expand on click
    expect(within(item).queryByText('kid one')).toBeNull();
    await userEvent.click(within(item).getByRole('button', { name: /2 个子块/ }));
    expect(within(item).getByText('kid one')).toBeTruthy();
    expect(within(item).getByText('kid two')).toBeTruthy();
  });

  test('breadcrumb truncates ancestor labels to 40 chars and falls back to the first property', async () => {
    const long = 'x'.repeat(60);
    const store = await setup([
      { path: 'pages/a.md', text: '- hi' },
      { path: 'pages/b.md', text: `- ${long}\n  - date:: 2020\n    - child [[a]]` },
    ]);
    render(<PageView store={store} />);
    open(store, 'a');
    const crumbs = within(items()[0]!).getAllByRole('button')[0]!;
    expect(crumbs.textContent).toContain(`${'x'.repeat(40)}…`);
    expect(crumbs.textContent).not.toContain('x'.repeat(41));
    expect(crumbs.textContent).toContain('date:: 2020');
  });

  test('clicking a backlink opens the source page and scrolls to the block', async () => {
    const store = await setup();
    render(<PageView store={store} />);
    open(store, 'Link Target');
    const first = items()[0]!;
    const hit = store
      .getState()
      .index.backlinksForPage('link target')
      .find((b) => first.textContent!.includes(b.source.block.content))!;

    await userEvent.click(within(first).getAllByRole('button')[0]!);

    expect(store.getState().currentPage).toBe('basic page');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' }));
    const el = scrollIntoView.mock.contexts[0] as HTMLElement;
    expect(el.id).toBe(hit.source.block.id);
    expect(el.classList.contains('block-flash')).toBe(true);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Basic Page');
  });
});

describe('BlockText', () => {
  test('renders [[page]], #tag and #[[tag]] as clickable elements that open the page', async () => {
    const store = await setup([]);
    render(<BlockText store={store} text={'see [[Some Page]] and #tag and #[[multi word]]\nline two a#nottag'} />);

    const container = document.querySelector('.block-text')!;
    expect(container.textContent).toBe('see [[Some Page]] and #tag and #[[multi word]]\nline two a#nottag');
    expect(screen.getAllByRole('link')).toHaveLength(3);

    await userEvent.click(screen.getByRole('link', { name: '[[Some Page]]' }));
    expect(store.getState().currentPage).toBe('some page');
    await userEvent.click(screen.getByRole('link', { name: '#tag' }));
    expect(store.getState().currentPage).toBe('tag');
    await userEvent.click(screen.getByRole('link', { name: '#[[multi word]]' }));
    expect(store.getState().currentPage).toBe('multi word');
  });
});

describe('ImportPanel while an import is running', () => {
  test('picking or dropping a folder is ignored, without even asking to confirm the overwrite', async () => {
    const importFiles = vi.fn(async () => {});
    const original = useWorkspace.getState().importFiles;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    useWorkspace.setState({ importFiles, importing: { done: 1, total: 5, failed: [] }, dirty: new Set(['a.md']) });
    try {
      render(<ImportPanel />);
      expect((screen.getByRole('button', { name: '导入文件夹' }) as HTMLButtonElement).disabled).toBe(true);

      const input = screen.getByTestId('import-input') as HTMLInputElement;
      const file = new File(['- x'], 'a.md', { type: 'text/markdown' });
      fireEvent.change(input, { target: { files: [file] } });
      const zone = screen.getByText(/导入中 1\/5/);
      fireEvent.drop(zone, { dataTransfer: { items: [] } });
      await new Promise((r) => setTimeout(r, 10));

      expect(confirm).not.toHaveBeenCalled();
      expect(importFiles).not.toHaveBeenCalled();
    } finally {
      useWorkspace.setState({ importFiles: original, importing: null, dirty: new Set() });
      confirm.mockRestore();
    }
  });
});
