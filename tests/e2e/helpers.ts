import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test as base } from '@playwright/test';
import type { Download, Page } from '@playwright/test';
import { unzipSync } from 'fflate';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');
export const GRAPH_DIR = path.join(ROOT, 'fixtures', 'synthetic', 'graph');
const EXPECTED = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'synthetic', 'expected', 'index.json'), 'utf8')) as {
  importedPaths: string[];
};
export const IMPORTED_PATHS = EXPECTED.importedPaths;

const ORIGIN = 'http://localhost:4173';

/** `test` whose every case records all requests and asserts none left the local origin (acceptance 3). */
export const test = base.extend<{ requests: string[] }>({
  requests: async ({ page }, provide) => {
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    await provide(requests);
    // data:/blob:/about: are in-page; anything that would touch the network must be local.
    const external = requests.filter((u) => !/^(data:|blob:|about:)/.test(u) && !u.startsWith(ORIGIN));
    expect(external, 'requests outside http://localhost:4173').toEqual([]);
  },
});
export { expect };

export function pageItem(page: Page, name: string) {
  return page.locator('nav[aria-label="页面列表"] .page-name').getByText(name, { exact: true });
}

export async function importGraph(page: Page): Promise<void> {
  await page.getByTestId('import-input').setInputFiles(GRAPH_DIR);
  await expect(pageItem(page, 'Basic Page')).toBeVisible();
}

export async function openPage(page: Page, name: string): Promise<void> {
  await pageItem(page, name).click();
  await expect(page.locator('.page-title')).toContainText(name);
}

export async function captureZip(page: Page, buttonName: RegExp | string): Promise<Record<string, Uint8Array>> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: buttonName }).click(),
  ]);
  return unzipDownload(download);
}

async function unzipDownload(download: Download): Promise<Record<string, Uint8Array>> {
  const file = await download.path();
  return unzipSync(new Uint8Array(fs.readFileSync(file)));
}

export function fixtureBytes(rel: string): Buffer {
  return fs.readFileSync(path.join(GRAPH_DIR, rel));
}

/** First bullet block (the leading title::/tags:: property block is a raw block and is skipped). */
// Click blocks at their top-left corner: block text contains inline links that navigate.
export function firstBullet(page: Page) {
  return page.locator('.outline > li.block-bullet').first();
}
