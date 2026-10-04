# mdgraph

mdgraph 是一个纯前端、可离线、只面向 Firefox 的 Logseq 式 Markdown 管理工具。你的 Markdown 文件始终是唯一的数据来源：mdgraph 把一个 Logseq graph 文件夹导入浏览器，解析成块（bullet）树，提供页面列表、块级大纲编辑、`[[页面]]` / `#标签` / `((块引用))` 补全与跳转，以及反向链接面板；编辑完再把文件导出回你的磁盘。没有后端、没有账号、没有任何网络请求，数据只存在浏览器的 IndexedDB 和你主动导出的文件里。

## 构建与运行

```sh
pnpm install
pnpm build
pnpm preview          # 固定监听 http://localhost:4173（端口被占用会直接报错，不会换端口）
```

然后用 **Firefox** 打开 <http://localhost:4173>。其他浏览器不保证可用（见「已知限制」）。

## 工作流：导入 → 编辑 → 导出 → 手动覆盖

Firefox 没有 File System Access API，网页**不能**打开本地目录并原地写回文件，所以 mdgraph 没有「保存」按钮，工作流是：

1. 点击「导入文件夹」（或把文件夹拖进页面），选择 Logseq graph 根目录。只导入 `.md` 文件，并跳过 `logseq/bak/` 等备份目录。
2. 在页面里浏览、编辑。每次失焦或结构操作都会写入浏览器的 IndexedDB，刷新页面不会丢；被改过的页面会显示「未导出」标记。
3. 导出，三种粒度：
   - 「导出全部 zip」：所有已导入文件，保留相对路径。
   - 「导出仅改动 zip」：只含自上次导出以来改动过的文件（日常推荐）。
   - 页面右上的「导出此文件」：单个 `.md`。
   导出成功后对应文件的「未导出」标记清除。
4. 把导出的文件手动解压/覆盖回原目录（`pages/`、`journals/` 的相对路径与原目录一致）。

未改动的文件导出后与原文件**逐字节一致**（BOM、CRLF、Tab 缩进、尾换行、非 outliner 内容都原样保留），所以覆盖回去不会产生无关 diff。这一点由 e2e 验收 4 保证。

**导入会覆盖整个工作区**：mdgraph 只有一个工作区，再次导入会替换当前全部内容；若还有未导出的改动，会先弹出确认对话框提示将被覆盖的文件数。请先导出再重新导入。

## 块 id

只有当某个块被 `((块引用))` 引用时，mdgraph 才会给它写入 `id::` 属性（与 Logseq 的行为一致）；单纯编辑块不会生成 id。因此引用一个还没有 id 的块时，被引用块所在的文件也会变成「未导出」。已有的 `id::` 在编辑态隐藏，但始终原位保留，不会被误删。

## 存储与隐私

- 文件正文只存放在 IndexedDB，索引在每次启动时于内存重建，不做持久化。
- 页面顶部的横幅会显示存储是否可用。**Firefox 隐私窗口会禁用 IndexedDB**：此时仍可浏览和编辑已导入的内容，但刷新后不会保留，请改用普通窗口。
- 运行时零网络请求：无 CDN、无在线字体、无遥测。`pnpm check:api` 会扫描源码拒绝 Chromium 专有 API 与远程资源，e2e 会断言全程只访问 `http://localhost:4173`。

## 页面身份规则

- `title::`（文件第一个块的属性）覆盖文件名作为页面名，文件派生名仍可解析到该页面。例如 `pages/basic.md` 含 `title:: Basic Page`，则 `[[Basic Page]]` 和 `[[basic]]` 都指向它。
- 文件名中 `%2F` 与 `___` 都表示命名空间分隔符 `/`：`ns%2Fchild.md` 与 `other___deep.md` 分别是 `ns/child` 与 `other/deep`。
- `journals/` 下的 `yyyy_MM_dd.md` 按 Logseq 默认日期格式显示为 `MMM do, yyyy`，如 `2022_06_25.md` 即 `Jun 25th, 2022`。该格式是写死的，不读取 `config.edn`。
- 页面名大小写不敏感：`[[link target]]` 与 `[[Link Target]]` 是同一页。
- 被引用但没有文件的页面是**虚拟页**：会出现在页面列表（带「虚拟」标记）和补全中，打开后只显示反向链接；v1 不创建新文件。

## 测试与验收

```sh
pnpm test            # vitest 单元测试（解析器、索引、存储、编辑器、视图）
pnpm check:api       # 禁止 Chromium 专有 API 与远程资源
pnpm lint            # oxlint
pnpm e2e             # Playwright Firefox 端到端验收（先 build，再用 pnpm preview 起服务）
```

真实语料的解析幂等检查（只读，不会复制进仓库）：

```sh
MDGRAPH_REAL_GRAPH=/path/to/your/graph pnpm test
```

e2e 覆盖验收 1–7（首屏与存储提示、导入结果、零外部请求、未改动导出逐字节一致、编辑后仅改动导出只有一行 diff、刷新后数据仍在、虚拟页反链与跳转）以及编辑器键盘行为。

**macOS 27 上的 Firefox 限制**：从终端或 agent 启动 Firefox 会因 TCC 保护 `~/Library/Application Support/Firefox` 而报 `Could not find profile folder` 并退出。`playwright.config.ts` 已在启动前把 `CFFIXED_USER_HOME` 指向可写目录 `test-results/cf-home`，所以 `pnpm e2e` 一条命令即可运行；如需自行指定，可预先设置该环境变量。手动在终端启动 Playwright 的 Firefox 时也需要同样设置。

## 已知限制

- 不支持 `alias::`。
- 不做日志（journal）视图、图谱、query、任务面板、同步。
- 不能新建、删除、重命名文件（只编辑已导入的文件）。
- 只保证 Firefox；其他浏览器不保证可用。
- 代码围栏只识别 ```` ``` ````，不识别 `~~~`。
- 空页面无法创建第一个块（store 缺少 `insertFirst`）。
- Enter 不会按光标位置拆分块，而是在当前块后新建一个空块。
- 补全弹层显示在输入框下方，不跟随光标。
- 导入是整库覆盖，没有逐文件合并。
