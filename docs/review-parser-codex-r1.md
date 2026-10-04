# Parser 对抗性审查

共 **18 项：高 1、中 9、低 8**。每项对应 [parser-codex.test.ts](../tests/unit/parser-codex.test.ts) 中同编号的一个 `it(...)`，全部使用普通 `expect(...).toBe(...)`，没有 `it.fails`、跳过或放宽断言。

唯一判据：[PLAN.md §3](../PLAN.md)。现有测试用于了解覆盖范围，不覆盖规格；本文明确指出两者不一致之处。受审 HEAD：`8024ab8b28ef9491774bada0b1570933c7ec1574`。环境：Node `v24.18.1`、pnpm `11.7.0`、Vitest `5.0.3`。

高严重度项表现为深层嵌套时 `serialize` 抛异常，无法完成往返。其余独立执行的 33,042 个普通边界/固定种子样本均满足字节相等；没有发现能正常返回却改变字节的无编辑往返反例。中严重度包含文件格式元数据、块结构和编辑操作的规则错误；行内抽取错误列为低。

任务清单：

- [x] 读取 §3、parser 契约、全部实现与现有 parser 测试。
- [x] 检查幂等边界、结构、行内抽取并缩减反例。
- [x] 检查六个操作、子树位移、未触及块和输入 Document 的原文。
- [x] 将确认问题写为 18 条失败测试和以下 18 个条目。
- [x] 运行指定命令，确认 18 条均以对应的期望/实际值不符失败；核对修改范围。

验证记录：

```text
pnpm vitest run tests/unit/parser.idempotence.test.ts tests/unit/parser.structure.test.ts tests/unit/parser.property.test.ts tests/unit/parser.ops.test.ts
Test Files: 4 passed
Tests: 69 passed | 1 skipped

pnpm vitest run tests/unit/parser-codex
Test Files: 1 failed
Tests: 18 failed (18)
Exit code: 1（预期）

pnpm exec oxlint tests/unit/parser-codex.test.ts
Exit code: 0
```

原有测试跳过的是未设置 `MDGRAPH_REAL_GRAPH` 的真实语料检查，本次没有读取真实语料。以下输入和实际字符串均使用 JSON 字符串转义；全角空格另用等价的 `\u3000` 标明。操作用例先执行 `doc = parse('p.md', x)`，再对指定块调用操作。

## H01 — 深层嵌套令序列化栈溢出

**严重度：高；依据：§3.5 对任意输入成立的往返不变量。**

输入为 4,096 行空 bullet，深度依次为 0–4,095，只有 Tab、`-` 和换行，共 8,394,751 字节。为避免在文档展开约 8 MiB 字符串，完整输入用以下可直接运行的 `JSON.stringify` 生成式给出：

```js
const x = Array.from({ length: 4096 }, (_, depth) => '\t'.repeat(depth) + '-').join('\n');
JSON.stringify(x);
// 开头的 JSON 字符串片段："-\n\t-\n\t\t-\n\t\t\t-..."
```

实际：`parse` 成功；`serialize` 抛出 `"RangeError: Maximum call stack size exceeded"`。期望：正常返回与 `x` 完全相同的字符串。测试将精确字符串比较的结果转为 `"identical"`，避免失败日志展开整个输入；实收上述异常文本。

定位：`src/parser/serialize.ts:17`，对子块递归调用 `renderBlock`。反例已将每行内容缩成单个 `-`；4,096 是本环境稳定复现的深度，栈上限随运行环境变化，不声称它是跨环境最小阈值。

## M01 — 以三个反引号开头的围栏被后续反引号阻止

**严重度：中；依据：§3.2 围栏以三个反引号开始，bullet 头行以其开头也开启围栏。**

最小输入：````"- ```a`\n- b"````。实际顶层块数为 `2`，content 分别为 ````"```a`"````、`"b"`；期望块数 `1`、content 为 ````"```a`\n- b"````，因为围栏未闭合。

同一问题也在 raw 开头 ````"```a`\n- b"```` 和 bullet 延续行 ````"- a\n  ```b`\n- c"```` 复现。测试实际块数 `[2,2,2]`，期望 `[1,1,1]`。

定位：`src/parser/syntax.ts:48`，开围栏的后缀被限定为不含反引号。§3 未规定这一后缀限制，不能用额外的 Markdown 方言规则替代。

## M02 — 跳过第一条只有空白的延续行

**严重度：中；依据：§3.1 第一条 bullet 延续行决定 `continuationIndent`；§3.2 空白行也是延续行；§3.3 按此前缀去缩进。**

输入：`"- a\n \n  b"`。

实际 `[continuationIndent, content]`：`["  ","a\n\nb"]`。期望：`[" ","a\n\n b"]`。第一条延续行已有一个空格，第二条的两个空格只能去掉其中一个。

定位：`src/parser/parse.ts:61`，检测时无条件跳过空白行。

## M03 — 不足一个前缀的全角空白未从 content 去除

**严重度：中；依据：§3.3 延续行缩进不足时去掉实际前导空白。**

输入：`"- a\n  b\n\u3000c"`。实际 content：`"a\nb\n\u3000c"`；期望：`"a\nb\nc"`。

前一条延续行确定前缀是两个普通空格；最后一行只有一个全角空格，属于不足的前导空白。行分类已经将它识别为延续行。

定位：`src/parser/parse.ts:82`，回退只识别普通空格和 Tab，没有遵循行分类使用的空白范围。

## M04 — 单独 CR 被当作 bullet/属性正文，违背规定的正则

**严重度：中；依据：§3.2 `^(\s*)([-*+])(?: (.*))?$`；§3.3 `^\s*([^\s:]+):: ?(.*)$`。**

输入一：`"- a\rb"`。实际 `kind="bullet"`、content 为 `"a\rb"`；期望 `kind="raw"`、content 为 `"- a\rb"`。

输入二：`"- a\n  k:: b\rc"`。实际 properties 为 `[{"key":"k","value":"b\rc"}]`、content 为 `"a"`；期望 properties 为 `[]`、content 为 `"a\nk:: b\rc"`。

两段正则的 `.` 未启用跨行匹配，不能匹配正文中间的 `\r`。此处的 CR 两侧都有字符，排除了 `$` 可在末尾行终止符前匹配的边界歧义。字节往返仍成立，错误在结构。

定位：`src/parser/parse.ts:5`、`src/parser/syntax.ts:28`，将规格中的 `.*` 改成了可吞入 CR 的 `[^]*`。

## M05 — raw content 首行的任务状态被忽略

**严重度：中；依据：§3.3 按 content 首行识别 `TODO`、`DOING`、`DONE`，没有限定块类型。**

最小输入：`"TODO"`。实际 `task=null`；期望 `task="TODO"`。测试同时检查 `"DOING x"`、`"DONE"`，实际 `[null,null,null]`，期望 `["TODO","DOING","DONE"]`。

定位：`src/parser/syntax.ts:191`，仅对 bullet 调用 `parseTask`。现有 `parser.structure.test.ts` 的 “task keyword only on bullets” 自行增加了 §3 没有的限制。

## M06 — setBlockText 把原样提交的单独 CR 改成 LF

**严重度：中；依据：§3.3 raw 的其余行原样作为 content；§3.6 按 §3.3 重切 editableText，未规定将单独 CR 变成换行。**

输入 `x="a\rb"`，操作 `setBlockText(doc, doc.blocks[0].id, x)`。

实际序列化输出：`"a\nb"`；期望：`"a\rb"`。原样提交同一段 raw 内容就改变了内容和字节。这里记录的是编辑操作错误；未编辑的 `serialize(parse(x))` 能正确保留该输入。

定位：`src/parser/ops.ts:130`，`replace(/\r\n?/g, '\n')` 也匹配单独 CR。

## M07 — ensureId 覆盖已有的非 UUID id::

**严重度：中；依据：§3.6 “无 `id::` 时”追加，“已有则返回原值”；§3.3 非 UUID id 属性只影响 persistentId，不代表属性不存在。**

输入：`"- a\n  id:: bad"`。操作：`ensureId(doc, doc.blocks[0].id, '11111111-1111-4111-8111-111111111111')`。

实际输出：`"- a\n  id:: 11111111-1111-4111-8111-111111111111"`；期望保持 `"- a\n  id:: bad"`。

定位：`src/parser/ops.ts:330` 只保护 `persistentId=true`，随后在 331–335 行覆盖已有属性。

## M08 — 子树重缩进跳过空的 rawLines 行

**严重度：中；依据：§3.6 子孙 `rawLines !== null` 时“对每行”位移；去不掉一个 indentUnit 时标记 `rawLines=null`。§3.5 的再生空行规则只适用于 `rawLines===null` 的块。**

indent 输入：`"- p\n- b\n  - c\n\n- z"`，对 `b` 调用 `indent`。

- 实际输出：`"- p\n  - b\n    - c\n\n- z"`。
- 期望输出：`"- p\n  - b\n    - c\n  \n- z"`。
- 子块 `c` 的第二条原始行是空字符串，也应增加一个两空格 indentUnit；它保留了 rawLines，不能套用再生块的空行规则。

outdent 输入：`"- p\n  - c\n    - g\n\n- z"`，对 `c` 调用 `outdent`。实际 `g.rawLines=["  - g",""]`；期望 `g.rawLines=null`，因为空行无法去掉一个 indentUnit，实际可去的空白为零。此分支的最终文本相同，但原始行保留标记违反了规定的回退条件。

定位：`src/parser/ops.ts:84`、`src/parser/ops.ts:89`，两个方向均对 `l === ''` 提前豁免。两条路径合计为一个缺陷。

## M09 — mergeWithPrevious 拒绝含 raw 的相邻叶块

**严重度：中；依据：§3.6 合并到前一个可见块、追加 content 并返回原 content 长度，未排除 raw 块。**

输入一：`"a\n- b"`，对第二块调用 `mergeWithPrevious`。实际返回 `null`；期望得到序列化文本 `"ab"`、`caret=1`。

输入二：`"- a\nb"`，同样对第二块调用。实际返回 `null`；期望得到 `"- ab"`、`caret=1`。

两例均无子块，合并后的 raw 块仍无子块，不涉及 raw 不能承载子树的契约边界。

定位：`src/parser/ops.ts:276`，任意一侧为 raw 即拒绝。现有 ops 测试将这一额外限制当成正确行为，§3.6 没有该限制。

## L01 — 属性与正文的链接、标签顺序颠倒

**严重度：低；依据：§3.4 links/tags/refs 按精确字符串去重并保留出现顺序。**

最小输入：`"p:: [[A]]\n[[B]]"`。实际 links 为 `["B","A"]`；期望 `["A","B"]`。

bullet 变体 `"- [[A]]\n  p:: [[B]]\n  [[C]]"` 的 links，以及 `"- #A\n  tags:: B\n  #C"` 的 tags，实际均为 `["A","C","B"]`，期望均为 `["A","B","C"]`。

定位：`src/parser/syntax.ts:178`、`src/parser/syntax.ts:183`，先扫描全部 content，再扫描全部 properties，丢掉原文交错顺序。

## L02 — tags:: 的行内代码进入标签和链接

**严重度：低；依据：§3.4 先剔除行内代码，再抽取各项，包括属性值。**

输入：``"- tags:: `x`"``。实际 `[links,tags]` 为 ``[["`x`"],["`x`"]]``；期望 `[[],[]]`。

定位：`src/parser/syntax.ts:185`，直接将属性值送入 `splitTagsValue`，绕过了行内代码过滤。

## L03 — tags:: 的标签名被额外删去开头 #

**严重度：低；依据：§3.4 tags:: 按逗号拆分、去掉 `[[ ]]` 后进入 tags 和 links；精确字符串与大小写须保留。**

输入：`"- tags:: #x"`。实际 `[links,tags]` 为 `[["x"],["x"]]`；期望 `[["#x"],["#x"]]`。属性项规则没有把属性值转换为 `#tag` 正文语法的步骤。

定位：`src/parser/syntax.ts:164`，增加了未规定的去 `#` 转换。

## L04 — tags:: 未按规定在括号内逗号处分割

**严重度：低；依据：§3.4 “按逗号拆分”，没有括号内逗号豁免。**

输入：`"- tags:: [[a,b]]"`。实际 tags 为 `["a,b"]`、长度 `1`；期望按逗号拆分得到 `2` 项。

测试只断言项数，不预设拆分后不成对括号片段的名称处理方式；两个分片 `"[[a"`、`"b]]"` 均非空且不同。

定位：`src/parser/syntax.ts:153`，只有 `depth===0` 才切分。现有 “splits on commas outside [[ ]]” 测试增加了 §3.4 没有的条件。

## L05 — 普通标签不能以左方括号开头

**严重度：低；依据：§3.4 普通 tag 的字符/末尾限制没有禁止 `[`；本例以 `a` 结尾，并满足 `#` 前为行首。**

输入：`"- #[a"`。实际 `[links,tags]` 为 `[[],[]]`；期望 `[["[a"],["[a"]]`。它不是完整的 `#[[multi word]]`，应由普通 tag 规则识别。

定位：`src/parser/syntax.ts:70`，普通 tag 分支的 `(?![[#])` 额外排除了起始 `[`。

## L06 — 剔除行内代码时凭空制造了标签前的空白

**严重度：低；依据：§3.4 先剔除行内代码，且 `#` 前必须是行首或空白。**

输入：``"- x`c`#tag"``。实际 `[links,tags]` 为 `[["tag"],["tag"]]`；期望 `[[],[]]`。

原文 `#` 前是反引号；剔除代码后是 `"x#tag"`，两种情况下都不满足标签边界。实际实现将代码替换为一个空格，得到了 `"x #tag"`。

定位：`src/parser/syntax.ts:85`。

## L07 — Markdown 目标 URL 和裸 URL 内部的字样被抽成页面链接

**严重度：低；依据：§3.4 Markdown 链接 `[text](url)`、裸 URL 不算链接。**

输入一：`"- [x](https://a/[[b]])"`。输入二：`"- https://a/[[b]]"`。

两例实际 links 均为 `["b"]`；期望均为 `[]`。`[[b]]` 在 URL 内，没有独立的页面链接位置。

定位：`src/parser/syntax.ts:85`–`86`，只移除代码就直接扫描链接，没有跳过 URL。现有测试用 `https://x.y/[[z]]` 并断言抽出 `z`，同样与这里的 §3.4 要求不符。

## L08 — 属性值中的 #[[x]] 没有进入 links

**严重度：低；依据：§3.4 属性值中的 `[[x]]` 进入 links，且 `#[[multi word]]` 本身也是页面链接。**

输入：`"- p:: #[[x]]"`。实际 links 为 `[]`；期望 `["x"]`。测试只约束页面链接，不扩大对一般属性值的 tags/ref 抽取要求。

定位：`src/parser/syntax.ts:187`，扫描器将 `#[[x]]` 标成 tag 后，此处只接收 `kind==='link'`，丢弃了它携带的页面链接。

## 覆盖记录与边界

除持久化的 18 条失败测试外，执行了不落文件的只读探测：

- 39 种行片段两两组合，分别以 LF、CRLF 拼接，共 3,042 个往返样本；另以 LCG 种子 `0xC0D3` 生成 30,000 个含 BOM、混合换行、围栏、属性、Tab/空格、全角空白、末尾空白的样本。全部字节相同。不能据此推断任意输入已被穷尽。
- 36 条明确期望的结构/语法/操作边界检查通过，覆盖下列清单。
- 六个操作分别在两空格、四空格、Tab 文件中配合 LF/CRLF 检查，共 36 组；同时检查原始 Document、未触及 raw 前缀块和末尾兄弟的原文。全部保持；未将“被操作块可按 §3.5 再生”误判为未触及块损坏。

本次只增加两个授权文件。没有修改 `src/`、已有测试，也没有提交。没有运行浏览器/e2e；本轮交付是 parser 缺陷复现，失败测试就是验收结果。

## 未发现问题的方向

- **普通往返**：空文件、只有空行、BOM-only、无末尾换行、LF、CRLF、混合 LF/CRLF、单独 `\r`、Tab、尾部空格和非 outliner 文本，均保持原文；深度异常见 H01。
- **常规围栏**：头行 ````"- ```js"````、延续行围栏、raw 围栏、未闭合围栏、LF 文件的围栏内容中出现 CRLF；围栏内的伪 bullet 不另建块，常规围栏内链接不会被抽取。带额外反引号的开围栏例外见 M01。
- **深度与前缀**：两空格/四空格/Tab 检测；Tab 文件中的 Tab/空格混合按 Tab 个数计深度；空格文件按前导空白长度计深度；不整除向下取整。全角空白不足前缀和空白延续行的例外见 M02、M03。
- **bullet 与 raw**：`-`、`*`、`+` 裸 marker，marker 后多个空格，空 bullet 后紧跟 raw，raw 中间出现 `key::`，正文中出现 `::`，属性行后遇正文停止属性区，均符合对应规则。
- **属性与 id**：头行/延续行/raw 开头的 `key::` 无值，非 UUID `id::` 保留为普通属性并分配 tmp id；有效 UUID 的精确值和大小写保留。ensureId 覆盖非 UUID 的例外见 M07。
- **抽取正常边界**：`#[[multi word]]`、没有合法前置边界的 `a#[[x]]` 不记为 tag、`[[a [[b]]]]` 只取 `b`、`((not-a-uuid))` 不生成 ref、有效 UUID refs 精确去重并保留大小写/顺序。
- **bullet task**：独立 `TODO`/`DOING`/`DONE`、后接普通空格、大小写区别、`TODOS`、后接 Tab，常规边界正确；raw task 例外见 M05。
- **setBlockText**：正常修改后重抽取；有效 `id::` 保留、属性顺序保留，原 Document 不变；单独 CR 例外见 M06。
- **insertAfter**：无子块时插同级，有子块时插第一个子块，marker 继承、depth、新空 content 正确；原父块和既有子块字节保持。本轮没有确认该操作独有的缺陷。
- **indent/outdent**：普通子树深度位移、无前兄弟/depth 0 的 no-op、outdent 收编后续兄弟、非空行只移动前缀并保留内部空格/marker、缩进不足时置 `rawLines=null`，均正确；空原始行例外见 M08。
- **mergeWithPrevious**：bullet 合入父块或前兄弟最深末端后代、子块接入、caret 为原 content 长度，常规路径正确；相邻 raw 叶块例外见 M09。
- **ensureId**：没有 id 时追加、已有有效 UUID 时保留，正常；已有非 UUID 的情况见 M07。
- **未触及块字节与纯函数**：上述六操作的 36 组检查均未修改无关块或输入 Document；没有为这些未复现的猜测增加失败测试。
