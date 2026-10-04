# mdgraph 独立 Firefox 验收报告

**当前结论：正式验收 0 通过、0 产品失败、7 项环境阻塞；额外探索 0 通过、0 产品失败、3 项环境阻塞。尚不能接受 M6 已完成。**

Firefox 在创建浏览器页面之前即 `SIGABRT` 退出。已按任务说明设置 `CFFIXED_USER_HOME`，无头与有头启动均失败。本报告没有把未执行的断言记为通过，也没有把启动故障归为 mdgraph 产品缺陷。已请求在普通终端执行独立脚本；截至本报告写入时，尚无该次运行证据。

## 范围与可复核性

- 验收日期：2026-10-04，Asia/Taipei。
- 源码 HEAD：`bb5247be2e97bf82eddde3b75ff0831ba7c1454a`；开始时工作区干净。
- 依据：`PLAN.md` §5-M6、本次任务的七条验收及三项额外探索。
- 独立脚本：[scripts/acceptance/run.mjs](../scripts/acceptance/run.mjs)。读取规格、`src/App.tsx`、`src/views/*.tsx`、`src/editor/*.tsx`、相关 store 契约及 fixture 后自行选择控件；未读取、复制或运行 `tests/e2e/**`，未依赖已有测试结论。
- 浏览器操作仅经过真实 UI；脚本不调用应用内部 store、解析器或导入测试钩子，不改写 IndexedDB。探索分别使用独立浏览器上下文。
- 导出期望来自 fixture 原始字节及 `fixtures/synthetic/expected/index.json` 的 `importedPaths`，严格核对 13 个路径。ZIP 用 `fflate.unzipSync` 解包；每项结果记录步骤、断言、实际观察、差异、哈希及异常。
- 请求/错误监听在每个页面首次导航之前注册，覆盖主流程及所有探索，直到上下文关闭。M3 最后结算，并要求实际捕获到请求，防止空集合误判通过。
- “第一个块”按 DOM 实际首块执行；Basic Page 此块是页首属性 raw 块。M5 另外在干净上下文复核首个正文 bullet（fixture 第 4 行），两者都必须满足一文件、一行替换。
- 每次运行向系统临时目录写入 `results.json`；实际进入页面后还会记录截图、页面文本、下载 ZIP 和 Playwright trace。**本次两次启动均未进入页面，因此没有截图、下载或交互 trace。**

## 七条验收

表中步骤与断言均已写入独立脚本；“阻塞”表示步骤尚未获得浏览器执行证据，不等于产品失败。

| 条目 | 步骤 | 断言 | 实际观察 | 结果 |
| --- | --- | --- | --- | --- |
| M1 首屏可用 | 启动 Firefox，访问 `http://localhost:4173` | “导入文件夹”按钮可见可用；目录 input 存在；明确显示“存储可用（IndexedDB）”，无失败提示 | Firefox 在 `firefox.launch()` 阶段退出，未创建页面。preview 的 HTTP 200 仅证明服务器可访问 | 阻塞 B01 |
| M2 导入与页面列表 | `setInputFiles` 上传 `fixtures/synthetic/graph`，等待导入完成 | 列表含 Basic Page、ns/child、Renamed Deep、Jun 25th, 2022，不含 stale backup；工作区名 graph | 未执行目录上传或读取页面列表 | 阻塞 B01 |
| M3 请求与错误 | 在首次导航前注册 `page.on('request')`、`console`、`pageerror`，覆盖所有会话 | 所有请求 URL 以 `http://localhost:4173` 开头；`console.error`/`pageerror` 均为 0；捕获请求数大于 0 | 页面未创建，监听未开始。记录中请求数为 0，不能据此判通过 | 阻塞 B01 |
| M4 全量 ZIP | 未编辑时点击“导出全部 zip”，捕获下载，解包 | 路径精确等于 13 项 `importedPaths`；每文件逐字节一致；不含 logseq/bak 与 .txt | 已读取 13 份原始 fixture 并计算哈希，但没有下载 ZIP 可供比较 | 阻塞 B01 |
| M5 单块修改 | 打开 Basic Page，点击首块进入 textarea，追加 ` EDITED`，点击标题失焦，导出仅改动；另复核首个正文 bullet | 两个独立场景都只含 `pages/basic.md`；与原文件相比恰好替换 1 行，该行仅追加 ` EDITED`，总行数不变 | UI 编辑及下载均未执行；一行 diff 判定器已通过反向自检，不能替代产品行为证据 | 阻塞 B01 |
| M6 刷新保留 | 主会话 `page.reload()`，重新打开 Basic Page | graph 工作区和四个指定页面仍在；首块保留 EDITED，无存储失败提示 | 未执行刷新，未验证 IndexedDB 持久化 | 阻塞 B01 |
| M7 虚拟页反链 | 在较小视口确认第四正文块原本不在主栏视口内；打开 Link Target，点击对应反链面包屑 | 虚拟页；来自 Basic Page 的引用恰好 2 条、均有 Basic Page 面包屑；跳到 `pages/basic.md`，指定块完整进入主栏及窗口视口 | 未读取反链或执行跳转；不能由组件源码推断通过 | 阻塞 B01 |

## 额外探索

| 条目 | 步骤 | 断言 | 实际观察 | 结果 |
| --- | --- | --- | --- | --- |
| X1 Tab / Shift+Tab | 干净导入，打开 four-space，编辑 `d`，按 Tab、失焦并导出；再 Shift+Tab、失焦并导出 | 两次都只导出 `pages/four-space.md`；第 4 行由 4 空格变 8 空格，再恢复原始全部字节；其余行不变 | 浏览器尚未启动，未执行键盘操作或导出 | 阻塞 B01 |
| X2 跨文件块引用 | 干净导入，在 Basic Page 首个正文块末尾输入 `((unreferenced`；选择 Jun 25th, 2022 的 `unreferenced block without id`；失焦并导出仅改动 | 插入合法 UUID 引用；恰好包含 `pages/basic.md`、`journals/2022_06_25.md`；被引用块后新增同 UUID 的 `id::` 行，其余字节不变 | fixture 已确认目标 journal 原文无 `id::`；补全、双文件变脏和导出均未实测 | 阻塞 B01 |
| X3 导入覆盖确认 | 干净导入，修改首个正文块但不导出，再次选择同一目录；捕获并取消对话框 | 弹出原生 confirm，说明 1 个文件未导出及覆盖风险；取消后 EDITED 与 dirty=1 保留 | 尚未执行重复导入，未观察到确认框 | 阻塞 B01 |

## B01：Firefox 启动阻断及最小复现

**严重度：验收阻断（环境，P1）；产品严重度未定。** 七条正式验收和三项探索均依赖真实 Firefox，此故障阻断全部行为证据。目前没有证据说明 mdgraph 页面本身导致崩溃。

环境实测：macOS 27.2 / arm64；Node `v24.18.1`；pnpm `11.7.0`；Playwright `1.63.0`；构建日志 Vite `8.3.2`。使用已下载的 Playwright Firefox：

```text
~/Library/Caches/ms-playwright/firefox-1543/firefox/Nightly.app/Contents/MacOS/firefox
```

本次按用户指定的 `import { firefox } from '@playwright/test'` 驱动下载版 Firefox；没有把 `/Applications/Firefox.app` 另行验收为通过。崩溃记录标记下载版版本为 155.0，尚未得到运行中的 `browser.version()` 回应。

最小触发点是 `firefox.launch()`：尚未调用任何 `page.goto()`，不需要导入数据或执行应用逻辑。两次实际运行：

| 时间（UTC+8） | 启动方式 | 实际结果 | 证据 |
| --- | --- | --- | --- |
| 18:31:13 | `firefox.launch({ headless: true })` | 子进程启动后 `SIGABRT`，`Failed to launch the browser process` | `/var/folders/my/mrwplh2d04lfj4ypd6tv70dc0000gn/T/mdgraph-codex-acceptance-vFxsPy/results.json` |
| 18:32:21 | `firefox.launch({ headless: false })` | 同样在页面创建前 `SIGABRT` | `/var/folders/my/mrwplh2d04lfj4ypd6tv70dc0000gn/T/mdgraph-codex-acceptance-xAaBtL/results.json` |

两次均已设置：

```text
CFFIXED_USER_HOME=<repo>/.worktrees/codex-accept/test-results/cf-home
```

对应目录已创建。本次错误不同于已知的 `Could not find profile folder`。第一份 macOS 崩溃记录的主线程包含：

```text
abort
___RegisterApplication_block_invoke
_RegisterApplication
TransformProcessType
```

这定位到 Firefox 的 macOS 应用注册阶段；**具体是执行环境权限还是系统/Firefox 兼容问题，尚未证实**。当前执行工具不允许提权，未更改系统权限、浏览器安装或安全设置，也未换浏览器冒充 Firefox 验收。

## 重跑方式

在仓库根目录使用两个终端。服务端：

```sh
pnpm build && pnpm preview
```

验收端：

```sh
export CFFIXED_USER_HOME=$PWD/test-results/cf-home
mkdir -p "$CFFIXED_USER_HOME"
node scripts/acceptance/run.mjs
```

有头启动对照命令为 `node scripts/acceptance/run.mjs --headed`。脚本输出 `artifactDir`；读取该目录的 `results.json`、下载 ZIP 和 trace 即可审阅真实结果。主流程及探索全部通过时退出码为 0；有失败、未执行项或启动故障时退出码为 1。脚本不修改本报告，必须根据真实产出更新结果表。

M7 会设置 1280×360 视口，并先断言目标不在主栏视口内。若此前置条件未成立，应报告脚本前置条件失败，不能当作产品滚动缺陷。普通流程使用 1280×720。

## 已执行验证与工作区卫生

| 检查 | 实际结果 | 证明边界 |
| --- | --- | --- |
| `pnpm build` | 退出成功；50 modules transformed | 只证明构建成功 |
| `pnpm preview` | 4173 启动成功，strictPort | 只证明静态服务启动 |
| Node 读取 `http://localhost:4173` | HTTP 200，引用本地 JS/CSS | 不是浏览器首屏或运行时零网络验收 |
| `node --check scripts/acceptance/run.mjs` | 退出 0 | 只证明脚本语法有效 |
| `pnpm exec oxlint scripts/acceptance/run.mjs` | 退出 0 | 只证明验收脚本静态检查通过 |
| 独立比较器反向验证 | 单字节破坏、多余 ZIP 路径、两行同时变化均被拒绝 | 只验证自写判定器；未替代实际下载比较 |
| `git diff --check` | 退出 0 | 不构成产品验收 |
| 文件范围检查 | 仅新增本报告与 `scripts/acceptance/run.mjs`；无已有跟踪文件修改 | 未修改 src、tests、README 或配置；未 git commit |

本次产生的构建产物与用户指定的 `test-results/cf-home` 为忽略的运行时目录；两次失败运行的 JSON 留在上述临时目录，以保留唯一启动证据。未删除既有文件。preview 暂保留，供已请求的普通终端重跑连接。

## 执行清单

- [x] 读取规格、fixture 和界面代码，自行确定选择器。
- [x] 构建并运行 preview。
- [x] 写入独立脚本，完成语法、静态检查及比较器反向验证。
- [x] 尝试无头与有头 Firefox 启动，保存真实失败证据。
- [ ] 获得可运行的 Firefox 会话，完成七条验收与三项探索。
- [ ] 根据实际页面、下载和 trace 证据更新结论；当前不可判定 M6 通过。

## 补记：主会话在可启动 Firefox 的环境中执行同一脚本（2026-10-04）

Codex 的沙箱无法启动 Firefox（`TransformProcessType` 阶段 `SIGABRT`），主会话在同一 worktree（HEAD `bb5247b`）用相同命令执行 `scripts/acceptance/run.mjs`（`CFFIXED_USER_HOME` 与 `TMPDIR` 均指向 `test-results/` 下目录），脚本未做任何修改：

```json
{ "requiredPassed": 7, "requiredFailed": 0, "explorationPassed": 3, "explorationFailed": 0, "notExecuted": [] }
```

M1–M7 与 X1–X3 全部 PASS；截图、下载的 ZIP、`results.json` 与 trace 位于运行输出的 `artifactDir`（`test-results/` 下，不入库）。
