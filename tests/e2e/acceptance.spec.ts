import { Buffer } from 'node:buffer';
import { expect, test, captureZip, fixtureBytes, importGraph, openPage, pageItem, IMPORTED_PATHS, firstBullet } from './helpers';

const EDITED = 'First block with a [[Link Target]] and a #tag EDITED';

test('1. 首屏：导入控件可见，存储提示不是失败状态', async ({ page, requests }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '导入文件夹' })).toBeVisible();
  await expect(page.getByTestId('import-input')).toBeAttached();
  await expect(page.getByRole('status')).toContainText('存储可用');
  await expect(page.locator('.banner-warn')).toHaveCount(0);
  expect(requests.length).toBeGreaterThan(0);
});

test('2. 导入后页面列表正确，且跳过 logseq/bak', async ({ page }) => {
  await page.goto('/');
  await importGraph(page);
  for (const name of ['Basic Page', 'ns/child', 'Renamed Deep', 'Jun 25th, 2022']) {
    await expect(pageItem(page, name)).toBeVisible();
  }
  await expect(page.getByText('stale backup')).toHaveCount(0);
  await expect(page.locator('nav[aria-label="页面列表"]')).not.toContainText('stale backup');
});

test('3. 零外部请求：导入、浏览、编辑、导出、刷新全程只访问 localhost:4173', async ({ page, requests }) => {
  await page.goto('/');
  await importGraph(page);
  await openPage(page, 'Basic Page');
  await beginEditFirstBullet(page);
  await page.keyboard.press('Escape');
  await captureZip(page, '导出全部 zip');
  await page.reload();
  await expect(pageItem(page, 'Basic Page')).toBeVisible();
  expect(requests.length).toBeGreaterThan(0);
  // The shared fixture re-checks every URL at teardown; assert the same here so the failure is local.
  expect(requests.filter((u) => !/^(data:|blob:|about:)/.test(u) && !u.startsWith('http://localhost:4173'))).toEqual([]);
});

test('4. 不改动导出全部 zip，13 个 md 与原文件逐字节相同', async ({ page }) => {
  await page.goto('/');
  await importGraph(page);
  const files = await captureZip(page, '导出全部 zip');
  expect(Object.keys(files).sort()).toEqual([...IMPORTED_PATHS].sort());
  expect(IMPORTED_PATHS).toHaveLength(13);
  for (const p of IMPORTED_PATHS) {
    const actual = Buffer.from(files[p]!);
    const expected = fixtureBytes(p);
    expect(actual.equals(expected), `${p} bytes differ (got ${actual.length}, want ${expected.length})`).toBe(true);
  }
});

test('5. 编辑第一个块后仅改动 zip 只含 pages/basic.md 且只有一行 diff', async ({ page }) => {
  await page.goto('/');
  await importGraph(page);
  await openPage(page, 'Basic Page');
  await editFirstBlock(page);
  await expect(page.locator('.page-title .tag-dirty')).toHaveText('未导出');

  const files = await captureZip(page, /导出仅改动 zip/);
  expect(Object.keys(files)).toEqual(['pages/basic.md']);
  const after = Buffer.from(files['pages/basic.md']!).toString('utf8').split('\n');
  const before = fixtureBytes('pages/basic.md').toString('utf8').split('\n');
  expect(after).toHaveLength(before.length);
  const diff = after.map((l, i) => [before[i], l] as const).filter(([a, b]) => a !== b);
  expect(diff).toHaveLength(1);
  expect(diff[0]![1]).toContain('EDITED');
  expect(diff[0]![1]).toBe(`- ${EDITED}`);
});

test('6. 刷新后页面列表与编辑内容仍在', async ({ page }) => {
  await page.goto('/');
  await importGraph(page);
  await openPage(page, 'Basic Page');
  await editFirstBlock(page);

  await page.reload();
  await expect(pageItem(page, 'Basic Page')).toBeVisible();
  await expect(pageItem(page, 'ns/child')).toBeVisible();
  await openPage(page, 'Basic Page');
  await expect(firstBullet(page)).toContainText('EDITED');
  await expect(page.locator('.page-title .tag-dirty')).toHaveText('未导出');
});

test('7. 虚拟页 Link Target：反链含两条引用、面包屑，点击跳转并滚动到块', async ({ page }) => {
  await page.goto('/');
  await importGraph(page);
  await openPage(page, 'Link Target');
  await expect(page.locator('.tag-virtual').first()).toBeVisible();

  const panel = page.getByRole('region', { name: '反向链接' });
  const items = panel.locator('.bl-item');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('First block with a');
  await expect(items.nth(1)).toContainText('DOING fourth');
  await expect(panel.locator('.bl-crumbs').first()).toContainText('Basic Page');

  await items.nth(0).locator('.bl-crumbs').click();
  await expect(page.locator('.page-title')).toContainText('Basic Page');
  await expect(firstBullet(page)).toBeInViewport();

  // Second reference points at the last block of the page; the jump must bring it into view too.
  await openPage(page, 'Link Target');
  await items.nth(1).locator('.bl-crumbs').click();
  await expect(page.locator('.page-title')).toContainText('Basic Page');
  await expect(page.locator('.outline > li', { hasText: 'DOING' })).toBeInViewport();
});

test('8. 编辑器键盘：Enter 新建块，[[ 补全插入 Link Target', async ({ page }) => {
  await page.goto('/');
  await importGraph(page);
  await openPage(page, 'Basic Page');

  const blocks = page.locator('.outline > li');
  const before = await blocks.count();
  await beginEditFirstBullet(page);
  const input = page.locator('textarea.block-input');
  await expect(input).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(blocks).toHaveCount(before + 1);
  await expect(input).toBeFocused();

  await page.keyboard.type('[[Lin');
  const list = page.getByRole('listbox');
  await expect(list).toBeVisible();
  const target = list.getByRole('option', { name: /Link Target/ });
  await expect(target).toBeVisible();
  // Candidates are listed real pages first, so Link Target (virtual) is not the default selection.
  for (let i = 0; i < 20 && (await target.getAttribute('aria-selected')) !== 'true'; i++) await page.keyboard.press('ArrowDown');
  await expect(target).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue(/\[\[Link Target\]\]/);
});

async function editFirstBlock(page: import('@playwright/test').Page): Promise<void> {
  await beginEditFirstBullet(page);
  const input = page.locator('textarea.block-input');
  await expect(input).toBeFocused();
  await input.fill(EDITED);
  await page.keyboard.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(firstBullet(page)).toContainText('EDITED');
}

// Enter on a focused block view starts editing. Keyboard instead of a mouse click: see the fixme test
// at the end of this file (bullet <li> is squeezed to 1em wide, so the text column is not clickable).
async function beginEditFirstBullet(page: import('@playwright/test').Page): Promise<void> {
  await firstBullet(page).locator('.block-view').focus();
  await page.keyboard.press('Enter');
}

// KNOWN src BUG (not fixed here, M6 does not own src/**): editor.css `.block-bullet { flex: none; width: 1em }`
// is meant for the bullet <span>, but Outline gives bullet-kind <li> the same class name (`block block-bullet`),
// so those rows collapse to ~15px wide and the text wraps one character per line (block-view is 0px wide).
test.fixme('9. 布局：bullet 块的文本列有可点击的宽度', async ({ page }) => {
  await page.goto('/');
  await importGraph(page);
  await openPage(page, 'Basic Page');
  const box = await firstBullet(page).locator('.block-view').boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(200);
});
