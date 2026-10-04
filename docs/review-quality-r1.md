# 代码质量审查 R1（PR #1，受审 HEAD 944e17a）

按 thermo-nuclear 标准（结构简化优先、职责边界、类型与抽象、关键路径）对 `74de04b..944e17a` 全部 diff 审查。三路并行只读审查（parser / store+index / editor+views+fs+storage），主会话逐条核对代码后裁决。

## 阻断（合并前修复）

| # | 位置 | 问题 | 裁决 |
|---|---|---|---|
| P1 | parser/parse.ts、syntax.ts | 缩进空白混用 `\s` 与「空格/Tab」，全角空格被当缩进、只含 `\r` 的行被当空白延续行；M03/M04 只落实一半 | 统一 `INDENT_WS` 常量，所有行分类正则共用 |
| P2 | syntax.ts splitRawBody、serialize.ts、store/types.ts editableTextOf | raw 块 content 无法区分「零行」与「一个空行」；再生成会多出空行；store 层靠特判补丁 | 模型层消歧：raw 的 content = 全部原始行（含属性行），properties 只是派生只读；删掉 store 特判 |
| P3 | ops.ts mergeWithPrevious | 自己展平整棵树 O(n·depth)，10000 层耗 695 MB；`isParent` 两分支重复 | 用已有 `pathOf`，先删后替换；删除 flatten / isParent |
| P4 | editor/inline.tsx 与 parser/syntax.ts | 行内语法两份实现且已分叉：`**#tag**`、`[[ ]]`、`foo:: #bar`、`tags:: a, b`、四反引号围栏、`` ```js``` [[B]] ``、raw 首行 TODO 在渲染与索引间不一致 | 单一 `tokenize()`，抽取与渲染都消费 token；加一致性测试 |
| B1 | store/workspace.ts importFiles | 先 clear IDB 与内存，再分批写入；中途失败留下内存与 IDB 各一半 | 全部读入内存后 `replaceAll` 单事务落库，成功后一次性替换内存 |
| B2 | store/workspace.ts、views/ImportPanel.tsx | 只有 updateText 走串行队列；导入期间可编辑、可重入、拖放区不检查 busy | 所有 IDB 操作同一队列；导入中编辑 no-op；拒绝重入 |
| B3 | store/workspace.ts、storage/idb.ts markExported | 内存用导出快照、IDB 用当时库里的文本，异步 zip 期间编辑会被错误标成已导出 | `markExported(entries{path,text})`，importedText = 传入文本，经队列执行 |

## 一并修复（非阻断但改动小、收益明确）

- S1 四份状态（`texts`/`imported`/`docs`/`dirty`）合一为 `files` Map + `publish()`。
- S3 `IndexApi.pageOfPath`，替换 Backlinks / PageList / acItems / inlineContext 四处各自重建的 path→页面映射。
- S4/S5 index 内部冗余 `fileEntries` 与 `viaOf` 双分支。
- S6 同一 `id::` 跨文件时 blocks/search 记账被误删；按 (path,id) 记账并暴露冲突。
- S7/E11 导入失败文件名丢失；`onProgress` 透传到 store 与 notice。
- parser 顺手：`shiftBlock` 去布尔参数；`makeBlock`/`withBody` 收敛「构块 + id + rawLines=null + 重新派生」；`setBlockText` 保持运行时 id 稳定；`splitBulletBody`/`splitRawBody` 合并。

## 延后（记入 follow-up，不阻断合并）

- E3 编辑器 `editingId` 与 `focusRequest` 合并为一个 state。
- E4 `caretInEditable` 是 `editableTextOf` 的逆映射，应与之同层；`keys.ts` 名不副实。
- E5 `store?: WorkspaceStore` 逐层传递 7 个组件，改 `WorkspaceContext`。
- E6 `BlockEditor` 只读态与 `BlockText` 重复；`ReadOnlyBlocks` 默认导出已无人使用；两套树渲染缩进不一致。
- E7 「跳转到块」DOM 操作两份（inlineContext / Backlinks），收敛为 `revealBlock(id)`。
- E8 块标签推导四种写法，收敛为 `blockLabel(block)`。
- E10 视图以 `docs` 引用变化当重算触发器，3 处 `oxlint-disable`；store 暴露 `indexVersion`，分组逻辑抽纯函数。
- E11 其余：`readInBatches` 与 store 的双重分批、`planImport` 薄包装、为测试放宽的生产签名。
- parser-8：`ops → serialize → parse` 不保证结构幂等（content 续行形如 `- b`），已写进 PLAN §3.5 作为非目标。
- S2 乐观写：IDB 写失败只进 notice，`dirty` 不反映「未持久化」。

## 禁止项复核

`src/` 与 `index.html` 无 fetch / XHR / WebSocket / sendBeacon / 外部 URL / `show*Picker` / `FileSystemHandle`；fflate 异步 zip 用本地 Worker。无违规。
