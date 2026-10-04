/**
 * Independent M6 acceptance: production UI + original fixture bytes only.
 * No imports from src/, no existing tests, no application/store/IndexedDB hooks.
 *
 * Terminal 1: pnpm build && pnpm preview
 * Terminal 2:
 *   export CFFIXED_USER_HOME=$PWD/test-results/cf-home
 *   mkdir -p "$CFFIXED_USER_HOME"
 *   node scripts/acceptance/run.mjs
 *
 * Writes evidence to a new OS temporary directory (printed on completion).
 * Exit 0 = all 7 required cases and all 3 explorations pass; otherwise exit 1.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { firefox, expect as playwrightExpect } from '@playwright/test';
import { unzipSync } from 'fflate';

const root = fileURLToPath(new URL('../../', import.meta.url));
const baseURL = 'http://localhost:4173';
const fixtureDir = path.join(root, 'fixtures/synthetic/graph');
const expected = JSON.parse(await readFile(path.join(root, 'fixtures/synthetic/expected/index.json'), 'utf8'));
const importedPaths = [...expected.importedPaths].sort();
assert.equal(importedPaths.length, 13, 'Acceptance fixture must contain 13 importable Markdown files');
const originals = Object.fromEntries(await Promise.all(importedPaths.map(async (p) => [p, await readFile(path.join(fixtureDir, p))])));
const artifactDir = await mkdtemp(path.join(tmpdir(), 'mdgraph-codex-acceptance-'));
const require = createRequire(import.meta.url);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const evidence = {
  startedAt: new Date().toISOString(),
  root,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  scriptSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
  baseURL,
  artifactDir,
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    playwright: require('@playwright/test/package.json').version,
    firefoxExecutable: firefox.executablePath(),
    CFFIXED_USER_HOME: process.env.CFFIXED_USER_HOME ?? null,
  },
  criteria: [
    ['M1', '首屏导入控件与可用存储提示'],
    ['M2', '目录导入、页面命名及备份排除'],
    ['M3', '全程本地请求且 console.error/pageerror 为零'],
    ['M4', '全部 ZIP 的 13 文件逐字节一致'],
    ['M5', '首块追加 EDITED，仅改动 ZIP 一文件一行；首个正文块补充复核'],
    ['M6', '刷新保留工作区和 EDITED'],
    ['M7', '虚拟页两条反链、面包屑及滚动跳转'],
    ['X1', 'Tab/Shift+Tab 仅修改预期缩进行'],
    ['X2', '引用 journals 无 id 块，两个文件变脏并写 id::'],
    ['X3', '有未导出修改时重新导入弹确认，取消保留修改'],
  ],
  fixtureHashes: Object.fromEntries(importedPaths.map((p) => [p, { bytes: originals[p].length, sha256: sha256(originals[p]) }])),
  requests: [],
  consoleErrors: [],
  pageErrors: [],
  dialogs: [],
  downloads: [],
  results: [],
};

// Line-level evidence including final newline/CR bytes. LCS handles added id lines.
function lineDiff(before, after) {
  const a = before.toString('utf8').split('\n');
  const b = after.toString('utf8').split('\n');
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const edits = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; }
    else if (i < a.length && (j === b.length || dp[i + 1][j] >= dp[i][j + 1])) edits.push({ kind: '-', line: ++i, text: a[i - 1] });
    else edits.push({ kind: '+', line: ++j, text: b[j - 1] });
  }
  return edits;
}

function exactPaths(actual, wanted) {
  assert.deepEqual(Object.keys(actual).sort(), [...wanted].sort(), 'ZIP entry names must match exactly, including no extra directory or excluded-file entries');
}

function equalBytes(actual, wanted, label) {
  assert.ok(Buffer.from(actual).equals(wanted), `${label}: exported bytes differ; diff=${JSON.stringify(lineDiff(wanted, Buffer.from(actual)))}`);
}

function oneAppendedLine(before, after) {
  const diff = lineDiff(before, after);
  assert.equal(diff.length, 2, `Expected one replaced line, got ${JSON.stringify(diff)}`);
  assert.equal(diff[0].kind, '-');
  assert.equal(diff[1].kind, '+');
  assert.equal(diff[0].line, diff[1].line);
  assert.equal(diff[1].text, `${diff[0].text} EDITED`);
  assert.equal(before.toString('utf8').split('\n').length, after.toString('utf8').split('\n').length);
  return diff;
}

// Negative controls exercise our own comparators without touching the app/fixture.
const altered = Buffer.from(originals['pages/basic.md']);
altered[0] ^= 1;
assert.throws(() => equalBytes(altered, originals['pages/basic.md'], 'negative byte control'));
assert.throws(() => exactPaths({ 'pages/basic.md': altered, 'pages/notes.txt': Buffer.alloc(0) }, ['pages/basic.md']));
assert.throws(() => oneAppendedLine(Buffer.from('a\nb\n'), Buffer.from('a EDITED\nb EDITED\n')));
evidence.negativeControls = ['one-byte corruption rejected', 'extra ZIP entry rejected', 'two changed lines rejected'];

let browser;
let main;
let phase = 'startup';
const sessions = [];
const expect = playwrightExpect.configure({ timeout: 10_000 });

async function saveJSON() {
  await writeFile(path.join(artifactDir, 'results.json'), `${JSON.stringify(evidence, null, 2)}\n`);
}

async function session(label) {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 720 } });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = await context.newPage();
  const s = { label, context, page, closed: false };
  sessions.push(s);
  page.setDefaultTimeout(10_000);
  page.on('request', (r) => evidence.requests.push({ session: label, phase, url: r.url(), method: r.method(), resourceType: r.resourceType() }));
  page.on('console', (m) => { if (m.type() === 'error') evidence.consoleErrors.push({ session: label, phase, text: m.text(), location: m.location() }); });
  page.on('pageerror', (e) => evidence.pageErrors.push({ session: label, phase, message: e.message, stack: e.stack }));
  page.on('dialog', async (d) => {
    evidence.dialogs.push({ session: label, phase, type: d.type(), message: d.message(), action: 'dismiss' });
    try { await d.dismiss(); } catch (e) { evidence.dialogs.push({ session: label, phase, handlerError: e.message }); }
  });
  await page.goto(baseURL, { waitUntil: 'load' });
  await expect(page.getByRole('status')).toHaveText('存储可用（IndexedDB）');
  return s;
}

async function closeSession(s) {
  if (s.closed) return;
  await s.context.tracing.stop({ path: path.join(artifactDir, `${s.label}-trace.zip`) });
  await s.context.close();
  s.closed = true;
}

const list = (page) => page.getByRole('navigation', { name: '页面列表' });
const pageButton = (page, name) => list(page).locator('button.page-item').filter({ has: page.getByText(name, { exact: true }) });
const changedButton = (page) => page.getByRole('button', { name: /^导出仅改动 zip/ });

async function importFixture(page) {
  await page.locator('input[type=file][webkitdirectory]').setInputFiles(fixtureDir);
  await expect(page.getByTitle('当前工作区')).toHaveText('graph');
  await expect(pageButton(page, 'Basic Page')).toBeVisible();
  await expect(page.getByRole('button', { name: '导入文件夹', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '导出全部 zip', exact: true })).toBeEnabled();
  await expect(changedButton(page)).toHaveText('导出仅改动 zip (0)');
  await expect(page.getByRole('alert')).toHaveCount(0);
}

async function openPage(page, name, filePath) {
  await pageButton(page, name).click();
  await expect(page.locator('.page-title')).toContainText(name);
  if (filePath) await expect(page.locator('.page-path')).toHaveText(filePath);
}

async function capture(page, label) {
  await page.screenshot({ path: path.join(artifactDir, `${label}.png`), fullPage: true });
  await writeFile(path.join(artifactDir, `${label}.txt`), await page.locator('body').innerText());
}

async function downloadZip(page, mode, label) {
  const button = mode === 'all' ? page.getByRole('button', { name: '导出全部 zip', exact: true }) : changedButton(page);
  await expect(button).toBeEnabled();
  const waiting = page.waitForEvent('download');
  await button.click();
  const download = await waiting;
  const saved = path.join(artifactDir, `${label}.zip`);
  await download.saveAs(saved);
  assert.equal(await download.failure(), null);
  const zipBytes = await readFile(saved);
  const contents = Object.fromEntries(Object.entries(unzipSync(zipBytes)).map(([p, bytes]) => [p, Buffer.from(bytes)]));
  const metadata = { phase, label, suggestedFilename: download.suggestedFilename(), path: saved, zipSha256: sha256(zipBytes), entries: Object.keys(contents).sort() };
  evidence.downloads.push(metadata);
  await expect(changedButton(page)).toHaveText('导出仅改动 zip (0)');
  await expect(changedButton(page)).toBeDisabled();
  return { contents, metadata };
}

async function appendEdited(page, kind) {
  const block = kind === 'literal-first' ? page.locator('.outline > .block').first() : page.locator('.outline > .block-bullet').first();
  const className = await block.getAttribute('class');
  // The first raw block contains clickable tags; click its plain title text.
  await block.locator('.block-view').click({ position: { x: 5, y: 5 } });
  const input = page.getByRole('textbox', { name: '编辑块', exact: true });
  const before = await input.inputValue();
  await input.fill(`${before} EDITED`);
  await page.locator('.page-title').click();
  await expect(input).toHaveCount(0);
  await expect(block).toContainText('EDITED');
  await expect(changedButton(page)).toHaveText('导出仅改动 zip (1)');
  return { kind, className, textareaBefore: before, textareaAfter: `${before} EDITED` };
}

async function runCase(id, steps, assertion, fn) {
  phase = id;
  const result = { id, steps, assertion, startedAt: new Date().toISOString(), observation: {} };
  evidence.results.push(result);
  console.log(`START ${id}`);
  try {
    await fn(result.observation);
    result.status = 'PASS';
  } catch (e) {
    result.status = 'FAIL';
    result.error = { message: e.message, stack: e.stack };
    for (const s of sessions.filter((s) => !s.closed)) {
      try { await capture(s.page, `${id}-${s.label}-failure`); } catch (captureError) { result.captureError = captureError.message; }
    }
  }
  result.finishedAt = new Date().toISOString();
  console.log(`${result.status} ${id}${result.error ? `: ${result.error.message}` : ''}`);
  await saveJSON();
}

try {
  assert.ok(process.env.CFFIXED_USER_HOME, 'Export CFFIXED_USER_HOME before launching Firefox; see script header');
  await mkdir(process.env.CFFIXED_USER_HOME, { recursive: true });
  evidence.environment.headless = !process.argv.includes('--headed');
  browser = await firefox.launch({ headless: evidence.environment.headless });
  evidence.environment.firefoxVersion = browser.version();

  await runCase('M1', '新建隔离 Firefox 会话；导航到生产 preview 首屏。', '导入按钮可见可用，目录 input 存在且有 webkitdirectory；存储明确可用，无 alert。', async (o) => {
    main = await session('main');
    const p = main.page;
    await expect(p.getByRole('button', { name: '导入文件夹', exact: true })).toBeVisible();
    await expect(p.getByRole('button', { name: '导入文件夹', exact: true })).toBeEnabled();
    await expect(p.locator('input[type=file][webkitdirectory]')).toHaveCount(1);
    await expect(p.getByRole('alert')).toHaveCount(0);
    o.storage = await p.getByRole('status').innerText();
    o.importControls = await p.locator('input[type=file]').evaluateAll((els) => els.map((el) => ({ type: el.type, directory: el.hasAttribute('webkitdirectory'), multiple: el.multiple })));
    o.userAgent = await p.evaluate(() => navigator.userAgent);
    await capture(p, 'M1-initial');
  });

  await runCase('M2', 'setInputFiles 上传 fixtures/synthetic/graph 目录，等待导入按钮恢复可用。', '列表包含四个指定页面，不含 stale backup；工作区 graph，无导入失败提示。', async (o) => {
    await importFixture(main.page);
    const p = main.page;
    o.pages = await list(p).locator('.page-name').allTextContents();
    for (const name of ['Basic Page', 'ns/child', 'Renamed Deep', 'Jun 25th, 2022']) assert.ok(o.pages.includes(name), `Missing page: ${name}`);
    assert.ok(!o.pages.some((name) => /stale backup/i.test(name)));
    await expect(list(p)).not.toContainText('stale backup');
    o.workspace = await p.getByTitle('当前工作区').innerText();
    await capture(p, 'M2-imported');
  });

  await runCase('M4', '未修改时点击导出全部 zip；捕获下载并用 fflate.unzipSync 解包。', 'ZIP 路径精确等于 importedPaths 的 13 项；逐文件字节一致，不含 logseq/bak 或 .txt。', async (o) => {
    const { contents, metadata } = await downloadZip(main.page, 'all', 'M4-all');
    o.download = metadata;
    exactPaths(contents, importedPaths);
    assert.ok(!Object.keys(contents).some((name) => /(^|\/)logseq\/bak\//i.test(name) || /\.txt$/i.test(name)));
    o.files = importedPaths.map((name) => ({ path: name, originalBytes: originals[name].length, exportedBytes: contents[name].length, originalSha256: sha256(originals[name]), exportedSha256: sha256(contents[name]), identical: originals[name].equals(contents[name]) }));
    for (const name of importedPaths) equalBytes(contents[name], originals[name], name);
  });

  await runCase('M5', '点击 Basic Page 第一个实际 DOM 块的文本，textarea 末尾追加 EDITED，点击标题失焦，再导出仅改动；另用干净会话复核首个正文 bullet。', '两种首块解释各自仅导出 pages/basic.md；各只有一行替换，替换内容严格为原行加 EDITED。', async (o) => {
    await openPage(main.page, 'Basic Page', 'pages/basic.md');
    o.literalFirst = await appendEdited(main.page, 'literal-first');
    const first = await downloadZip(main.page, 'changed', 'M5-first-raw-changed');
    o.literalFirst.download = first.metadata;
    exactPaths(first.contents, ['pages/basic.md']);
    o.literalFirst.diff = oneAppendedLine(originals['pages/basic.md'], first.contents['pages/basic.md']);
    await capture(main.page, 'M5-edited');

    const support = await session('first-bullet');
    try {
      await importFixture(support.page);
      await openPage(support.page, 'Basic Page', 'pages/basic.md');
      o.firstBullet = await appendEdited(support.page, 'first-bullet');
      const second = await downloadZip(support.page, 'changed', 'M5-first-bullet-changed');
      o.firstBullet.download = second.metadata;
      exactPaths(second.contents, ['pages/basic.md']);
      o.firstBullet.diff = oneAppendedLine(originals['pages/basic.md'], second.contents['pages/basic.md']);
      assert.equal(o.firstBullet.diff[0].line, 4, 'The first body bullet is source line 4');
    } finally { await closeSession(support); }
  });

  await runCase('M6', '在同一主会话执行 page.reload()，等待页面列表恢复，再打开 Basic Page。', '工作区 graph、四个指定页面及首块 EDITED 均保留，存储无失败提示。', async (o) => {
    const p = main.page;
    await p.reload({ waitUntil: 'load' });
    await expect(p.getByTitle('当前工作区')).toHaveText('graph');
    await expect(pageButton(p, 'Basic Page')).toBeVisible();
    o.pages = await list(p).locator('.page-name').allTextContents();
    for (const name of ['Basic Page', 'ns/child', 'Renamed Deep', 'Jun 25th, 2022']) assert.ok(o.pages.includes(name));
    await openPage(p, 'Basic Page', 'pages/basic.md');
    await expect(p.locator('.outline > .block').first()).toContainText('EDITED');
    await expect(p.getByRole('alert')).toHaveCount(0);
    o.firstBlock = await p.locator('.outline > .block').first().innerText();
    o.storage = await p.getByRole('status').innerText();
    await capture(p, 'M6-reloaded');
  });

  await runCase('M7', '缩小视口使 Basic Page 第四个正文块不在主栏视口内；打开 Link Target，检查两条反链并点击第四块的面包屑。', 'Link Target 为虚拟页，来自 Basic Page 的反链恰好两条且均含面包屑；跳到 pages/basic.md，指定目标块完整进入视口。', async (o) => {
    const p = main.page;
    await p.setViewportSize({ width: 1280, height: 360 });
    await openPage(p, 'Basic Page', 'pages/basic.md');
    await p.locator('.app-main').evaluate((el) => { el.scrollTop = 0; });
    const targetText = 'DOING fourth [[Link Target]] again and [[link target]] lowercase';
    const target = p.locator('.outline > .block').filter({ hasText: targetText });
    o.before = await target.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const m = document.querySelector('.app-main').getBoundingClientRect();
      return { block: { top: r.top, bottom: r.bottom }, main: { top: m.top, bottom: m.bottom }, intersects: r.bottom > m.top && r.top < m.bottom };
    });
    assert.equal(o.before.intersects, false, 'Precondition: the destination block must begin outside the clipped main viewport');
    await openPage(p, 'Link Target');
    await expect(p.locator('.page-title')).toContainText('虚拟页（无文件）');
    const backlinks = p.getByRole('region', { name: '反向链接', exact: true });
    const group = backlinks.getByRole('region', { name: '来自 Basic Page', exact: true });
    await expect(backlinks.locator('.bl-group')).toHaveCount(1);
    await expect(group.locator('.bl-item')).toHaveCount(2);
    o.items = await group.locator('.bl-item').evaluateAll((els) => els.map((el) => ({ crumbs: el.querySelector('.bl-crumbs').textContent.trim(), text: el.querySelector('.bl-text').textContent.trim() })));
    assert.ok(o.items.every((item) => item.crumbs.includes('Basic Page')));
    assert.ok(o.items.some((item) => item.text.includes('First block with a [[Link Target]] and a #tag')));
    assert.ok(o.items.some((item) => item.text === targetText));
    await capture(p, 'M7-backlinks');
    await group.locator('.bl-item').filter({ hasText: targetText }).getByRole('button', { name: 'Basic Page', exact: true }).click();
    await expect(p.locator('.page-path')).toHaveText('pages/basic.md');
    await expect(target).toHaveClass(/block-flash/);
    await expect(target).toBeInViewport({ ratio: 1 });
    o.after = await target.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const main = document.querySelector('.app-main');
      const m = main.getBoundingClientRect();
      return { id: el.id, text: el.textContent, block: { top: r.top, bottom: r.bottom }, main: { top: m.top, bottom: m.bottom }, scrollTop: main.scrollTop, fullyVisible: r.top >= Math.max(0, m.top) && r.bottom <= Math.min(window.innerHeight, m.bottom) };
    });
    assert.ok(o.after.fullyVisible, 'Destination must also be inside the scrollable main pane, not only the window');
    await capture(p, 'M7-jump');
    await p.setViewportSize({ width: 1280, height: 720 });
  });

  await runCase('X1', '干净工作区打开 four-space，编辑 d，按 Tab 并失焦导出；再次编辑 d，按 Shift+Tab 并失焦导出。', '两次各仅 four-space.md 的第4行缩进改变；Tab 为4到8空格，Shift+Tab 恢复原文件所有字节。', async (o) => {
    const s = await session('indent');
    try {
      const p = s.page;
      await importFixture(p);
      await openPage(p, 'four-space', 'pages/four-space.md');
      const d = () => p.locator('.outline .block-view').filter({ hasText: /^d$/ });
      await d().click();
      const input = p.getByRole('textbox', { name: '编辑块', exact: true });
      await input.press('Tab');
      await expect(p.locator('.outline > .block').filter({ has: input })).toHaveAttribute('data-depth', '2');
      await p.locator('.page-title').click();
      const indented = await downloadZip(p, 'changed', 'X1-tab');
      o.tabDownload = indented.metadata;
      exactPaths(indented.contents, ['pages/four-space.md']);
      const before = originals['pages/four-space.md'];
      const expectedTab = Buffer.from(before.toString('utf8').replace('    - d\n', '        - d\n'));
      o.tabDiff = lineDiff(before, indented.contents['pages/four-space.md']);
      equalBytes(indented.contents['pages/four-space.md'], expectedTab, 'Tab');
      assert.equal(o.tabDiff.length, 2);
      await d().click();
      await input.press('Shift+Tab');
      await expect(p.locator('.outline > .block').filter({ has: input })).toHaveAttribute('data-depth', '1');
      await p.locator('.page-title').click();
      const outdented = await downloadZip(p, 'changed', 'X1-shift-tab');
      o.shiftTabDownload = outdented.metadata;
      exactPaths(outdented.contents, ['pages/four-space.md']);
      o.shiftTabDiff = lineDiff(indented.contents['pages/four-space.md'], outdented.contents['pages/four-space.md']);
      equalBytes(outdented.contents['pages/four-space.md'], before, 'Shift+Tab restored original');
      assert.equal(o.shiftTabDiff.length, 2);
      await capture(p, 'X1-outdented');
    } finally { await closeSession(s); }
  });

  await runCase('X2', '干净工作区在 Basic Page 首个正文块末尾输入 ((unreferenced，选择 Jun 25th, 2022 的无 id 块，失焦并导出仅改动。', '补全插入合法 UUID 引用；恰好 basic.md 和 journals/2022_06_25.md 两文件；被引用块后新增匹配 id::，其余字节不变。', async (o) => {
    const s = await session('reference');
    try {
      const p = s.page;
      const journalPath = 'journals/2022_06_25.md';
      const journal = originals[journalPath].toString('utf8');
      assert.ok(!/^\s*id::/m.test(journal), 'Precondition: original journal has no id:: property');
      await importFixture(p);
      await openPage(p, 'Basic Page', 'pages/basic.md');
      await p.locator('.outline > .block-bullet').first().locator('.block-view').click({ position: { x: 5, y: 5 } });
      const input = p.getByRole('textbox', { name: '编辑块', exact: true });
      const text = await input.inputValue();
      await input.fill(`${text} ((unreferenced`);
      const option = p.getByRole('option').filter({ hasText: 'unreferenced block without id' });
      await expect(option).toHaveCount(1);
      await expect(option).toContainText('Jun 25th, 2022');
      o.suggestion = await option.innerText();
      await capture(p, 'X2-completion');
      await option.click();
      const after = await input.inputValue();
      const match = /\(\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)\)$/i.exec(after);
      assert.ok(match, `Completion did not insert a UUID reference: ${after}`);
      o.uuid = match[1];
      assert.equal(after, `${text} ((${o.uuid}))`);
      await p.locator('.page-title').click();
      await expect(changedButton(p)).toHaveText('导出仅改动 zip (2)');
      const result = await downloadZip(p, 'changed', 'X2-reference');
      o.download = result.metadata;
      exactPaths(result.contents, ['pages/basic.md', journalPath]);
      const source = originals['pages/basic.md'].toString('utf8');
      const expectedBasic = Buffer.from(source.replace('- First block with a [[Link Target]] and a #tag\n', `- First block with a [[Link Target]] and a #tag ((${o.uuid}))\n`));
      const expectedJournal = Buffer.from(journal.replace('- unreferenced block without id\n', `- unreferenced block without id\n  id:: ${o.uuid}\n`));
      o.basicDiff = lineDiff(originals['pages/basic.md'], result.contents['pages/basic.md']);
      o.journalDiff = lineDiff(originals[journalPath], result.contents[journalPath]);
      equalBytes(result.contents['pages/basic.md'], expectedBasic, 'reference source');
      equalBytes(result.contents[journalPath], expectedJournal, 'referenced journal');
      await capture(p, 'X2-reference-created');
    } finally { await closeSession(s); }
  });

  await runCase('X3', '干净工作区修改 Basic Page 首个正文块但不导出；再次选择同一导入目录；捕获并取消原生确认框。', '出现 confirm 且明确1文件未导出及覆盖风险；取消后修改和 dirty=1 保留。', async (o) => {
    const s = await session('confirm');
    try {
      const p = s.page;
      await importFixture(p);
      await openPage(p, 'Basic Page', 'pages/basic.md');
      o.edit = await appendEdited(p, 'first-bullet');
      const pendingDialog = p.waitForEvent('dialog');
      await p.locator('input[type=file][webkitdirectory]').setInputFiles(fixtureDir);
      const dialog = await pendingDialog;
      o.dialog = { type: dialog.type(), message: dialog.message(), action: 'dismiss' };
      assert.equal(dialog.type(), 'confirm');
      assert.match(dialog.message(), /1 个文件未导出/);
      assert.match(dialog.message(), /导入将覆盖/);
      await expect(p.locator('.outline > .block-bullet').first()).toContainText('EDITED');
      await expect(changedButton(p)).toHaveText('导出仅改动 zip (1)');
      await expect(p.locator('.page-path')).toHaveText('pages/basic.md');
      o.afterCancel = await p.locator('.outline > .block-bullet').first().innerText();
      await capture(p, 'X3-cancel-preserves-edit');
    } finally { await closeSession(s); }
  });

  for (const s of sessions) await closeSession(s);
  await browser.close();
  browser = null;

  await runCase('M3', '在每个 page 首次 goto 前注册 request、console 和 pageerror 监听，持续到所有主流程与探索会话关闭。', '每个被记录请求 URL 均以 http://localhost:4173 开头；console.error 和 pageerror 均为0，且确实捕获到初始资源请求。', async (o) => {
    o.requestCount = evidence.requests.length;
    o.sessions = sessions.map((s) => s.label);
    o.distinctURLs = [...new Set(evidence.requests.map((r) => r.url))];
    o.externalRequests = evidence.requests.filter((r) => !r.url.startsWith(baseURL));
    o.consoleErrors = evidence.consoleErrors;
    o.pageErrors = evidence.pageErrors;
    assert.ok(evidence.requests.length > 0, 'Request observer cannot pass vacuously');
    assert.equal(o.externalRequests.length, 0);
    assert.equal(o.consoleErrors.length, 0);
    assert.equal(o.pageErrors.length, 0);
  });
} catch (e) {
  evidence.fatal = { message: e.message, stack: e.stack };
  console.error(e.stack);
} finally {
  for (const s of sessions.filter((s) => !s.closed)) {
    try { await closeSession(s); } catch (e) { evidence.cleanupError = e.message; }
  }
  if (browser) await browser.close();
  evidence.finishedAt = new Date().toISOString();
  evidence.summary = {
    requiredPassed: evidence.results.filter((r) => r.id.startsWith('M') && r.status === 'PASS').length,
    requiredFailed: evidence.results.filter((r) => r.id.startsWith('M') && r.status === 'FAIL').length,
    explorationPassed: evidence.results.filter((r) => r.id.startsWith('X') && r.status === 'PASS').length,
    explorationFailed: evidence.results.filter((r) => r.id.startsWith('X') && r.status === 'FAIL').length,
    notExecuted: evidence.criteria.filter(([id]) => !evidence.results.some((r) => r.id === id)).map(([id]) => id),
  };
  await saveJSON();
  console.log(JSON.stringify({ ...evidence.summary, artifactDir }, null, 2));
  if (evidence.fatal || evidence.summary.requiredFailed || evidence.summary.explorationFailed || evidence.summary.notExecuted.length) process.exitCode = 1;
}
