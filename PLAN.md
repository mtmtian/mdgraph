# mdgraph — 执行计划（给实现 Agent 的唯一规格）

纯前端、可离线、**只面向 Firefox** 的 Logseq 式 Markdown 管理工具。Markdown 文件是唯一真相源；前端只做「解析 → 索引 → 多视图」，不自建私有格式。

决策背景见 `docs/DECISIONS.md`（Q1–Q17）。本文件与 `src/**/types.ts` 中的契约冲突时，以契约文件为准并在 PR 说明中指出。

---

## 0. 硬约束（违反即失败）

1. **只支持 Firefox。** 禁止 `showDirectoryPicker` / `showOpenFilePicker` / `showSaveFilePicker` / `FileSystemHandle.requestPermission` 等 Chromium 专有 API。`pnpm check:api` 会 grep 源码并失败。能力探测只允许降级提示，不允许报错中断。
2. **运行时零网络请求。** 不用 CDN、在线字体（只用 `system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`）、遥测、云 API。所有依赖为 npm 包并打进产物。e2e 用 Playwright `page.on('request')` 断言除 `http://localhost:*` 之外零请求。
3. **严禁后端。** 只有 `vite preview` 这类静态服务器。
4. **数据不出浏览器。** 只存 IndexedDB 和用户显式导出的文件。
5. **做不到的功能停下来写进 README「已知限制」**，不绕路到 Electron/Tauri/Chromium API。
6. **不新增本计划之外的功能模块**（没有日志视图、图谱、query、任务面板、同步、alias、新建/删除/重命名文件）。

## 1. 技术栈（已安装，勿改版本线）

React 19 + TypeScript 6 + Vite 8；zustand 5；fflate；vitest 5（单测）；@playwright/test 1.63 + Firefox（e2e，已下载到 ms-playwright 缓存）；fake-indexeddb（存储单测）；oxlint。样式用普通 CSS / CSS Modules，无 UI 库。Markdown 块级解析器与行内语法自写，不用 remark/marked；全文搜索自写倒排索引。

## 2. 目录与所有权

```
src/
├── parser/   types.ts(契约,已写) parse.ts serialize.ts syntax.ts ops.ts      ← M1
├── fs/       import.ts export.ts                                            ← M2
├── storage/  types.ts(契约,已写) idb.ts                                     ← M2
├── index/    types.ts(契约,已写) pageName.ts blockIndex.ts pageIndex.ts refIndex.ts searchIndex.ts index.ts(组合+增量) ← M3
├── store/    types.ts(契约,已写) workspace.ts                               ← M3
├── editor/   Outline.tsx BlockEditor.tsx Autocomplete.tsx inline.ts(行内渲染) ← M4
├── views/    PageView.tsx PageList.tsx Backlinks.tsx ImportPanel.tsx ExportPanel.tsx StorageBanner.tsx ← M5
├── App.tsx main.tsx index.css                                               ← M3 建壳，M4/M5 只在各自组件内改
tests/        unit/*.test.ts (vitest)  e2e/*.spec.ts (playwright)
fixtures/synthetic/graph/   合成语料（已写，提交）   fixtures/synthetic/expected/*.json 手写期望
fixtures/real/              不提交；真实语料通过环境变量 MDGRAPH_REAL_GRAPH 原地只读
scripts/check-forbidden-api.mjs
```

**单向数据流**：views/editor 只读 `store.docs` + `store.index`，只通过 store 的 action 写。写路径固定为：`parser/ops` 改树 → `serialize` 该文件 → `storage.updateText` → `index.upsertDocument`。

## 3. 格式规则（解析器规格，M1 必须逐条实现并测试）

### 3.1 文件级
- 保留 BOM（`﻿` 开头）、EOL（整文件统一按首个换行判断 `\n` / `\r\n`）、是否以 EOL 结尾。
- `indentUnit`：第一条有缩进的 bullet 行的前导空白若含 Tab 则为 `\t`，否则为该空白本身（2 或 4 空格）；无缩进 bullet 时默认 `'  '`。
- `continuationIndent`：第一条 bullet 延续行相对于其 bullet 行缩进的多出部分；没有则默认 `'  '`。
- 深度 = 前导空白长度 ÷ indentUnit 长度（Tab 文件按 Tab 个数）。不整除时向下取整，原文仍靠 `rawLines` 保留。

### 3.2 行分类（顺序判定，带 fence 状态）
1. 若处于 ``` 围栏内：归当前块（bullet 延续或 raw 延续）。围栏在某块的延续行或 raw 行中以 ```` ``` ```` 开始，以同样的 ```` ``` ```` 结束；bullet 头行本身以 ``` 开头也开启围栏。
2. bullet 行：`^(\s*)([-*+])(?: (.*))?$`（允许空 bullet `- `）。新建 bullet 块，深度按 3.1。
3. 否则，当前块是 bullet 且（本行为空白行 **或** 前导空白 > 0）：作为该 bullet 的延续行。
4. 否则：raw 行。进入/延续一个 raw run，直到下一条 bullet 行为止（raw run 内部允许空行）。

### 3.3 块内容
- bullet：`content` 第 1 行 = 头行去掉 `marker + ' '`。紧跟头行的、匹配 `^\s*([^\s:]+):: ?(.*)$` 的延续行是属性行（连续，遇到第一条非属性延续行停止）；其余延续行去掉「块缩进 + continuationIndent」前缀（不足则去掉实际前导空白）后作为 content 后续行。**头行本身是属性行**（如 `- date:: [[x]]`）时：properties 含该项，content 为空字符串。
- raw：开头连续的属性行进入 `properties`（这是 Logseq 的页面属性写法），其余行原样 join('\n') 为 content（结尾空行保留为末尾 `\n`）。
- `task`：content 首行以 `TODO ` / `DOING ` / `DONE ` 开头（或整行恰为该词）。
- `id`：`id::` 属性值为 uuid 形态时 `persistentId=true`；否则 `id = 'tmp-' + 递增计数或随机`，`persistentId=false`。
- `rawLines`：该块（不含子块）的全部原始行，不含 EOL。

### 3.4 行内抽取（`syntax.ts`）
先剔除行内代码 `` `…` `` 和围栏内的行，再抽取：
- `[[Page]]` → links（不处理嵌套 `[[a [[b]]]]`，按最内层匹配）
- `#tag`（`#` 前为行首或空白，tag 为非空白非 `#,.;:!?)]` 结尾字符串）与 `#[[multi word]]` → tags 且同时进入 links
- `((uuid))` → refs（uuid 正则 8-4-4-4-12 十六进制）
- 属性值中的 `[[x]]` → links；`tags::` 属性值按逗号拆分，每项去掉 `[[ ]]` 后进入 tags 与 links
- Markdown 链接 `[text](url)`、裸 URL 不算链接。
- links/tags/refs 按精确字符串去重，保留原大小写与出现顺序。

### 3.5 序列化（`serialize.ts`）—— 最高优先级
- `rawLines !== null` 的块：逐行原样输出，再输出子块。
- `rawLines === null` 的 bullet 块：`indent = indentUnit.repeat(depth)`；头行 `indent + marker + ' ' + contentLines[0]`（content 为空且无属性时输出 `indent + marker + ' '`… 若原文件习惯是 `-` 不带尾空格无法得知，统一带空格）；然后属性行 `indent + continuationIndent + key + ':: ' + value`（顺序按 `properties`）；然后 content 其余行加同样前缀（空行输出为空字符串，不带前缀）。
- `rawLines === null` 的 raw 块：属性行 `key:: value` 然后 content 按行原样。
- 拼接：行 join(eol)，`trailingNewline` 为真时末尾加 eol，`bom` 为真时前置 `﻿`。
- **不变量**：`serialize(parse(text)) === text` 对任意输入成立（含空文件、只有空行的文件、无尾换行、CRLF、BOM、Tab、围栏、非 outliner 内容）。

### 3.6 编辑操作（`ops.ts`，纯函数，返回新 Document，被改块 `rawLines=null`）
- `setBlockText(doc, id, editableText)`：按 3.3 规则把 textarea 文本重新切成 content + properties；**保留原有 `id::` 属性**（editableText 中不含它）；重新抽取 links/tags/refs/task。
- `insertAfter(doc, id)`：新空 bullet 块（marker 继承，depth 同级）；当目标块有子块时插为第一个子块。
- `indent(doc, id)`：成为前一个兄弟的最后一个子块；无前兄弟则 no-op。其子树深度 +1。
- `outdent(doc, id)`：depth 0 no-op；否则移到父块之后作为父块的兄弟，原来位于其后的兄弟成为它的子块（Logseq 行为）。
- `mergeWithPrevious(doc, id)`：把 content 追加到前一个可见块（前兄弟的最深末端后代，或父块）的 content 末尾，删除本块；本块的子块接到被合并块下。返回光标位置 = 被合并块原 content 长度。
- `ensureId(doc, id, uuid)`：无 `id::` 时在 properties 末尾加入并置 `rawLines=null`；已有则返回原值。
- **子树重缩进规则**：indent/outdent 改变子孙深度时，子孙若 `rawLines !== null`，对每行做前缀位移（加一个 indentUnit，或去掉一个 indentUnit；去不掉时去掉实际前导空白中能去的部分并把该块 `rawLines=null`），不重新生成。
- 所有 ops 之后 `serialize` 的输出中，**未被触及的块字节不变**（测试用 diff 行数断言）。

## 4. 页面身份（`index/pageName.ts`）
- 名字来自文件名去 `.md`：`%2F` → `/`，`___` → `/`；`journals/yyyy_MM_dd.md` → `MMM do, yyyy`（英文月份缩写 + 序数 + 年，Logseq 默认格式，硬编码，不读 config.edn）。
- 文件首块（raw 或 bullet）的 `title::` 属性覆盖显示名；文件派生名保留为 alias，二者都能被 `[[ ]]` 解析到。
- `PageKey = name.trim().toLowerCase()`；链接解析大小写不敏感。
- 被引用但无文件的页面是**虚拟页**：出现在页面列表（标记为虚拟），页面视图只显示反链。
- 导入时忽略：非 `.md`、任何路径段以 `.` 开头、`logseq/` 目录整体（含 `bak/`）、`.recycle/`。

## 5. 里程碑与验证门

每个里程碑由独立 worker 在自己的 worktree 完成，**只能改所有权内的文件**（§2），验证门全绿才算完成。所有命令在仓库根目录运行。

### M0 基础（已完成，主会话）
脚手架、依赖、契约、合成语料、本计划。

### M1 解析器（worker A，可与 M2 并行）
文件：`src/parser/{parse,serialize,syntax,ops}.ts`，`tests/unit/parser*.test.ts`。
验证门：
```
pnpm vitest run tests/unit/parser
```
测试必须包含：
1. 幂等：`fixtures/synthetic/graph/**/*.md` 每个文件 `serialize(parse(buf)) === buf`（按字节比较，先用 `TextDecoder` 保留 BOM 即 `{ ignoreBOM: true }`）。
2. 结构：`fixtures/synthetic/expected/{basic,code-fence,mixed-raw}.json` 与简化后的解析结果深比较。
3. 真实语料：`MDGRAPH_REAL_GRAPH` 环境变量指向目录时，递归所有 `.md`（跳过 `logseq/`、`bak/`、`.recycle/`）做幂等检查；变量缺失时 `test.skip` 并打印提示。主会话会用 `/Users/mt/Library/Mobile Documents/iCloud~com~logseq~logseq/Documents` 跑一次。
4. ops：对 basic.md 各执行一次 setBlockText / insertAfter / indent / outdent / mergeWithPrevious / ensureId，用**手写的期望文本**（写在测试里）比较 serialize 结果，并断言未触及行与原文件逐行相同。
5. 属性测试：随机生成 200 个由 bullet/raw/空行/属性行/围栏/不同缩进组成的文件，幂等必须成立（种子固定，失败时打印样本）。

### M2 存储 + 导入导出（worker B，可与 M1 并行）
文件：`src/fs/{import,export}.ts`，`src/storage/idb.ts`，`tests/unit/{storage,import,export}.test.ts`。
- `import.ts`：两条入口都产出 `AsyncIterable<ImportedFile>` + total：(a) `<input type="file" webkitdirectory>` 的 `FileList`（用 `webkitRelativePath`）；(b) 拖拽 `DataTransferItemList` 用 `webkitGetAsEntry()` 递归 `FileSystemDirectoryEntry.createReader().readEntries()`（注意 readEntries 需循环调用直到返回空数组）。剥掉共同的根目录段；按 §4 过滤；**每批 32 个文件**读取（`file.text()`），批与批之间 `await` 让出主线程；单文件失败记入 `failed` 继续。把「`File[]`→`ImportedFile` 流」做成可注入纯函数以便单测。
- `export.ts`：`fflate.zipSync` 或 `zip` 异步版（文件数 > 200 时用异步）；文件名保留相对路径；`downloadBlob(name, blob)` 用 `<a download>` + `URL.createObjectURL` 并 revoke。单文件导出直接 Blob 下载。
- `idb.ts`：实现 `FileStore`；数据库 `mdgraph`，store `files`（key path）与 `meta`；`probe()` 在 `indexedDB` 不存在或 `open` 抛错/被拒时返回 `{ok:false, reason}`，不抛异常。
验证门：
```
pnpm vitest run tests/unit/storage tests/unit/import tests/unit/export
```
测试覆盖：idb 全部方法（fake-indexeddb）；import 的根目录剥离、过滤规则、分批与失败记录（用自造 `File` 对象）；export 的 zip 可被 fflate `unzipSync` 解回且字节一致、`changed` 模式只含 dirty 文件。

### M3 索引 + store + 应用壳（worker C，依赖 M1、M2 合入 main）
文件：`src/index/*.ts`（除 types）、`src/store/workspace.ts`、`src/App.tsx`、`src/main.tsx`、`src/index.css`、`src/views/{ImportPanel,ExportPanel,StorageBanner,PageList}.tsx`、`tests/unit/index*.test.ts`、`tests/unit/store*.test.ts`。
- 索引全部内存；`upsertDocument` 先 `removeDocument(path)` 再加入；`rebuildAll` 清空重建。
- 搜索：token = 小写后按非字母数字、非 CJK 字符切分；CJK 连续串再按单字 + 相邻二字切分；查询取各 token 结果交集，无交集时退化为并集按命中数排序。
- store 启动流程 `boot()`：probe → 不可用则 `notices` 加提示并停止 → `getAll()` → 分批 parse（每批 50 个让出主线程）→ `rebuildAll` → 设置 `dirty`。
- 应用壳：顶栏（工作区名、导入按钮、导出下拉：全部 zip / 仅改动 zip、「全量重建索引」）、左栏页面列表（真实 + 虚拟，搜索框走 `index.search`）、主区 `currentPage` 的占位（M5 替换）、`StorageBanner`（probe 失败或 notices）。导入时若 `dirty.size>0` 先 `window.confirm` 提示「有 N 个文件未导出，导入将覆盖」。进度显示 `done/total`。
验证门：
```
pnpm vitest run tests/unit/index tests/unit/store && pnpm build && pnpm check:api
```
测试覆盖：导入合成语料后与 `fixtures/synthetic/expected/index.json` 逐项比对（importedPaths、pages、pageBacklinks、blockBacklinks）；增量：修改 basic.md 一个块文本后只有该 path 的条目变化；`ensureBlockId` 在跨文件引用场景下让两个 path 进入 `dirty`。

### M4 大纲编辑器（worker D，依赖 M3，与 M5 并行）
文件：`src/editor/*`，`tests/unit/editor*.test.tsx`。
- 每个块一个组件；非聚焦显示渲染态（`inline.ts` 手写极简渲染：行内代码、**粗体**、*斜体*、`[[页]]` 可点击、`((uuid))` 显示被引块 content 首行并可点击、`#tag` 可点击、裸 URL 不可点击只显示文本）；聚焦变 `<textarea>`，内容 = `editableTextOf(block)`；失焦或 Enter 时调用 `store.setBlockText`。
- 快捷键：Enter 新建同级（textarea 内 Shift+Enter 换行）；Tab / Shift+Tab 升降级；Backspace 在光标 0 且有前块时 `mergeWithPrevious`；ArrowUp/Down 在首/末行时移动焦点到前/后块。
- 自动补全：输入 `[[` 弹出页面列表（真实 + 虚拟，按前缀/包含过滤，上下键选择，Enter 插入 `[[Name]]`）；输入 `((` 弹出块搜索（走 `index.search`，显示 content 首行 + 页面名），选中后调用 `store.ensureBlockId` 并插入 `((uuid))`。Esc 关闭。
- raw 块同样可编辑，textarea 内容 = 属性行 + content。
验证门：
```
pnpm vitest run tests/unit/editor && pnpm build
```
测试（@testing-library/react + user-event，jsdom）：Enter 创建块、Tab/Shift+Tab 改层级、Backspace 合并、`[[` 补全插入、`((` 补全触发 ensureBlockId。

### M5 页面视图 + 反链面板（worker E，依赖 M3，与 M4 并行）
文件：`src/views/{PageView,Backlinks}.tsx` 及其 CSS，`tests/unit/views*.test.tsx`。
- `PageView`：标题（显示名 + 虚拟标记 + 文件路径 + dirty 标记）、挂载 `editor/Outline`（M4 未合入时用只读占位列表渲染 content，接口 `<Outline path />` 已定）、下方 `Backlinks`。
- `Backlinks`：`index.backlinksForPage(key)` ∪ 本页所有带 persistentId 块的 `backlinksForBlock`；按来源文件分组；每条显示面包屑（页面名 › 祖先 content 首行…）、引用块 content（行内渲染可复用 `editor/inline.ts`，若 M4 未合入先纯文本）、折叠的子块数量；点击跳转 `store.openPage(sourcePage)` 并滚动到该块（`id` 作为 DOM id）。排除来源 path 等于当前页 path 的条目。
验证门：
```
pnpm vitest run tests/unit/views && pnpm build
```

### M6 e2e + README（worker F，依赖 M4、M5 合入）
文件：`tests/e2e/*.spec.ts`、`playwright.config.ts`、`README.md`、`scripts/check-forbidden-api.mjs` 完善。
Playwright 项目只配 `firefox`，`webServer` 用 `pnpm build && pnpm preview --port 4173`。用例对应验收 1–7：
1. 打开 `http://localhost:4173` 可见导入按钮与存储可用提示。
2. 用 `setInputFiles` 指向 `fixtures/synthetic/graph` 目录（Playwright 支持目录上传到 `webkitdirectory` input；若 Firefox 下不可用，退路是 `page.evaluate` 注入 `File` 列表到 `window.__mdgraphImport`，该钩子只在 `import.meta.env.MODE==='test'` 下暴露并在 README 注明）。断言页面列表含 `Basic Page`、`ns/child`、`Renamed Deep`、`Jun 25th, 2022`，且不含 `stale backup`。
3. 整个用例期间 `page.on('request')` 收集的 URL 全部以 `http://localhost:4173` 开头。
4. 不改动直接「导出全部 zip」，拦截下载，`unzipSync` 后与 fixtures 原字节逐文件相同。
5. 修改 `Basic Page` 第一个块文本后「导出仅改动」，zip 只含 `pages/basic.md`，且该文件只有一行 diff。
6. `page.reload()` 后页面列表与修改内容仍在。
7. 打开 `Link Target`（虚拟页），反链面板列出 basic.md 的两条引用并带面包屑；点击跳转到 `Basic Page`。
验证门：
```
pnpm check:api && pnpm lint && pnpm vitest run && pnpm e2e
```
README 必须写：构建与 `pnpm preview` 启动、在 Firefox 打开、**Firefox 不能原地回写**导致的「导入 → 编辑 → 导出 → 手动覆盖回原目录」工作流、隐私窗口下 IndexedDB 不可用、已知限制清单（§0 第 6 条 + alias 不支持 + 块 id 只在被引用时写入）。

## 6. Codex 的角色（审查者，不写实现）
- M1 合入后：对 `src/parser` 做对抗性审查，目标是构造让 `serialize(parse(x)) !== x` 或让结构解析违背 §3 的输入；产出可直接加入 `tests/unit` 的失败用例。
- M6 合入后：按 §5-M6 的 7 条验收在真实 Firefox（`/Applications/Firefox.app`）独立执行一遍并出报告，不信任 worker 自述。

## 7. 完成定义
`pnpm check:api && pnpm lint && pnpm vitest run && pnpm e2e` 全绿；真实语料幂等测试通过；Codex 两轮审查的缺陷已修复或记入 README 已知限制；`git status` 干净。
