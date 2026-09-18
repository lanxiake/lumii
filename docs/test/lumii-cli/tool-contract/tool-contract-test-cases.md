# 工具面治理验证（TC）测试用例

> 领域：工具设计与工具面治理
> 执行器：[`run-tool-contract-e2e.mjs`](./run-tool-contract-e2e.mjs)
> 规范：[`../CLI-TEST-SPEC.md`](../CLI-TEST-SPEC.md)
> 背景：[`../../../plans/Agent协作与提示词/2026-09-18-工具面治理执行计划与场景推演.md`](../../../plans/Agent协作与提示词/2026-09-18-工具面治理执行计划与场景推演.md)
> 探针前缀：`[tc-suite]`；探针文件目录：`~/.lumii/workspace/temp/`

## 这套件在验什么

2026-09-18 的工具面复盘发现：**治理的射程按「层」切，而病灶长在「接缝」上**。其中三项已实施：

| 改动 | 内容 | 本套件怎么验 |
|---|---|---|
| ① | 修 5 处失效引用（`old_string` ×3 / `read_file` / `skill_list`） | TC-02（行为面）、TC-03（行为面） |
| ② | 工具失败审计回填 `duration_ms` | TC-01（数据面） |
| ③ | **批次 1：统一 `isError` 契约**——工具失败必须在**顶层**产 `isError: true` | TC-06（bash 非零退出 + 反向）、TC-07（file_edit 前置条件失败） |

**改动 ③ 的分工**（与 ①② 不同，值得单说）：
- **契约本身**（什么是失败、什么刻意不算失败）写在 `packages/agent-runtime/src/types/tool.ts`
  的 `MtBotToolResult` doc 里——它是**给人和模型读的规范**，不是机器检查的；
- **「表态与源码是否一致」**由单测 `tools/__tests__/failure-semantics-guard.test.ts` 守
  （登记表 + 源码计数 + 行为断言，做过变红验证）；
- **「在真实链路上是否真的生效」**由本套件守——单测直接调 `config.execute()`，
  绕过了 `ToolRunner → ToolRegistry → pi-agent-core` 的转换链，
  而那一段（顶层 isError → throw → `is_error` 发给模型）只有真实客户端能覆盖。

**类型系统在这里是缺位的**（2026-09-18 实测）：`AgentToolResult<T>` 本身没有 `isError` 字段，
且 `execute: async () => ({...})` 这种不标注返回类型的写法**不触发 TS 的多余属性检查**——
拼错 `isEror` 也不报错。所以契约必须靠上面三层，不能靠类型。

**文本本身**（schema 描述、错误文案里引用的工具名）由单测
`packages/agent-runtime/src/tools/__tests__/tool-name-references.test.ts` 守——
它能精确到"哪个文件的哪段文本引用了谁"，且做过变红验证（注入失效名即失败）。
**两层分工：单测守文本，CLI 守行为。**

---

## TC-CONTRACT-01 工具失败审计带 duration_ms

- **优先级**：P0
- **层**：L2（数据链路）
- **前置**：客户端已 `dev:restart`（改动 ② 在主进程与 packages 两侧）
- **真实数据**：`tool_audit_log` 表；探针路径指向一个不存在的文件
- **步骤**：
  1. 记录当前 ISO 时间戳作为 baseline
  2. 新建探针会话，要求 agent 用 `file_read` 读一个不存在的文件
  3. 等回合完成，查 `tool_audit_log` 中该时间戳之后的 `file_read` 记录
- **预期**：新增记录数 > 0，且**全部** `duration_ms IS NOT NULL`
- **断言**：**硬**（计数与空值判定都是确定的）
- **为什么用 `file_read`**：它是只读免确认工具，`checkPermission` 返回 allowed 时**不写**权限审计
  （只有 denied / needs_confirmation 才写），所以这张表里查到的 `file_read` 记录必然来自工具执行出口。
  且它读不到文件时是**让宿主异常自然抛出**（源码里既无 `details.success:false` 也无捕获），
  正好走 `onError` 分支——两条出口都要验。
- **基线**：改动前 `tool_audit_log` 非 LLM 记录 **4158 条，`duration_ms` 无一有值**（LLM 记录是 9873/9873 有值）
- **预计回合**：1

## TC-CONTRACT-02 file:// 场景不得调用不存在的 read_file

- **优先级**：P0
- **层**：L3（真实聊天模拟）
- **前置**：日志通道可用；套件会**临时切 detailed 档**（结束恢复）
- **真实数据**：探针文件 `temp/tc-fileurl-probe.txt`（内容 `PROBE-OK-20260918`）
- **步骤**：
  1. 切 `promptStyle.style = detailed`
  2. 写探针文件，新建会话，让 agent 读取 `file:///<探针路径>`
  3. 等回合完成，从日志游标后的 `tool:end` 事件里取工具序列
- **预期**：**不出现** `toolName=read_file`
- **断言**：工具序列 = **硬**；`file_read` 是否被调用 = 不判（模型直接说明 file:// 不可用也算合理行为）
- **为什么必须切 detailed**：minimal 档下简单工具的 schema 描述会被
  `tool-definition-style.ts` 裁掉（`web_fetch` 只有 3 个参数 < 5），
  而 `web-fetch-tool.ts:30` 的失效引用正在那段描述里——**只有 detailed 档才把这句话发给模型**。
  生产实测 minimal 621 次 / terse 18 次，所以这个用例的失败面在生产里其实更小；
  它守的是"这句话存在时会不会误导模型"。
- **基线**：日志里实测出现过 `tool:end toolName=read_file isError=true` × 1
  （`Tool read_file not found`），且该名字在全仓库的唯一出处就是那行描述
- **预计回合**：1

### 对照实验（2026-09-18 实测，结论与预期不符）

**做法**：把 `web-fetch-tool.ts:30` 的描述临时改回失效的 `read_file` → `dev:restart` → 连跑 3 次 TC-02。

**结果**：

| 样本 | 描述里写的是 | 模型实际调用 | 结果 |
|---|---|---|---|
| 改动后 ×2 | `` `file_read` `` | `file_read` | PASS |
| **改动前（注入失效引用）×3** | `` `read_file` `` | **`file_read`** | **PASS** |
| | | | **3/3 未被误导** |

**结论：这处失效引用在当前模型上不产生可观测的行为差异。**

**由此修正本文先前的一处归因**：日志里那 1 次 `Tool read_file not found`，
先前被归因给 `web-fetch-tool.ts:30` 的描述引用（理由是"该名字在代码库里唯一"）。
对照实验说明这个推理不成立——**更可能来自模型自身的先验**（`read_file` 在训练语料里极常见），
而不是这行文字的诱导。**那是过度归因。**

**修复仍然保留**，理由是成本与风险不对称：改动是 1 行文本、零行为风险，
消除的是一个"万一被模型当真"的误导源；但**不应把它计入"已获得的行为收益"**。

**这也给守卫的价值重新定了位**：`tool-name-references.test.ts` 抓的是**文本一致性**，
不是"能观测到的行为改善"。同类失效引用的真正危害场景应逐个实测，不要凭名字推断。

## TC-CONTRACT-03 真实文件编辑一次成功、无参数校验失败

- **优先级**：P0
- **层**：L3
- **前置**：日志通道可用
- **真实数据**：探针文件 `temp/tc-edit-probe.md`（内容含「原始内容 A」）
- **步骤**：
  1. 写探针文件，新建会话，要求 agent 把「原始内容 A」改成「修改后的内容 B」
  2. 等回合完成，取工具序列与 `Validation failed` 计数
  3. 回读文件内容
- **预期**：至少一次成功的 `file_edit`；**无** `Validation failed`；文件里出现新内容且旧内容消失
- **断言**：工具序列与文件内容 = **硬**；无参数校验失败 = **硬**（日志正则）
- **这条守的是什么**：`file-edit-tool.ts` 的两处错误文案曾把参数名写成 `old_string`
  （schema 里是 `oldString`）。错误文案在 `content` 里、**全档位可见**——
  minimal 档也躲不掉。模型照着错的参数名重试时，那次失败会走参数校验路径，
  而校验在 `tool.execute` 之前抛错，**不进 hook 链**，所以在统计里完全不可见。
  这条用例是少数能在事件层抓到它的地方。
- **预计回合**：1

## TC-CONTRACT-04 提示词分组现状（INFO）

- **优先级**：P2
- **层**：L2
- **真实数据**：最近一次 `[llm-prompt:full]` 转储里的 `Groups:` 行
- **预期**：记录 `Other Tools` 与 `Desktop Control` 的数量
- **断言**：**INFO，不是 PASS/FAIL**
- **为什么不做成断言**：0.3 实施后剩余未归类的是**运行时动态注册**的工具（工具进化产物），
  它们本来就无法被静态守卫覆盖，只能靠运行时告警兜底。把它算成失败会掩盖这个区别。
- **基线（0.3 前）**：`Other Tools (9)` + `Desktop Control (18)`
- **0.3 后实测**：`Other Tools (3)` —— 补入 6 个静态可枚举的工具（云同步 5 个 + 开发转交 1 个）后，
  剩下 3 个由运行时告警点名：`file-term-replace` / `node-read-file-script` / `replace-js-terms`
- **预计回合**：0（复用前序回合的日志）

## TC-CONTRACT-05 工具面与守卫射程的覆盖率

- **优先级**：P2
- **层**：L2
- **真实数据**：日志里的 `tools=N/M` 行
- **预期**：报告本次请求暴露了多少工具，以及**两层守卫**的覆盖率、运行时告警兜底了几个
- **断言**：`tools=N/M` 行存在 = **硬**；覆盖率数字 = 观察值
- **基线（0.3 前）**：`tools=116/116`（含 MCP）；非 MCP 分组合计 94，守卫射程 68 → 覆盖 **72.3%**
- **0.3 后实测**：静态射程 **91**（54 内置 + 37 宿主）→ 覆盖 **96.8%**；
  另由运行时告警兜底 3 个动态注册工具。**静态覆盖率不是 100%，而那缺口是有意为之的**——
  见 TC-05 的 note 与 `CLAUDE` 侧说明。
- **预计回合**：0

## TC-CONTRACT-06 失败必须被标记（批次 1）——bash 非零退出

- **优先级**：P0
- **层**：L3（真实聊天模拟）+ L2（数据面交叉验证）
- **前置**：客户端已 `dev:restart`（批次 1 改的是 `packages/agent-runtime`，主进程直接读 `src`，无需 build）
- **真实数据**：探针会话 + `tool_audit_log` 表
- **步骤**：
  1. **6a**：新建会话，要求 agent **原样**执行 `exit 3`（明说不要加 `|| true` 之类的兜底）
  2. **6b**：另起会话，要求 agent 原样执行 `echo batch1-ok`
  3. 从日志游标后的 `tool:end` 事件取两次的 `isError`
  4. 查 `tool_audit_log` 中 6a 之后的 `bash` 记录，看 `is_error` 维度
- **预期**：6a 至少一次 `bash isError=true`；6b 无一次 `isError=true`；审计表里有 `is_error=1` 的 bash 行
- **断言**：三条全为**硬**
- **为什么必须成对验**：只验"非零变红"的话，一个「无脑全部标 isError」的实现也能通过。
  契约第 3 条明确「非理想结局 ≠ 失败」，而**过度标记与漏标同样是契约违反**——
  它会让失败率失去诊断价值，那正是批次 1 要修的问题的另一面。
- **为什么用 `exit 3` 而不是 `false`**：`false` 在部分 shell 里会被 agent 用 `|| true` 消解；
  `exit 3` 的退出码明确且非 1，能从日志区分是不是它。
  （注：日志目前只记 `isError`，不记 exitCode，所以这条区分用于人工复核，不进断言。）
- **DB 口径为什么要一起查**：计划 §四 A6 要求"两个独立来源互证"。
  日志说标了、DB 里查不到，说明审计出口没接到同一个 `isError`——
  这条比单看日志多守一层接线错误。
- **预计回合**：2

### 实测（2026-09-18，批次 1 实施后）

```
✅ [TC-CONTRACT-06] PASS — 6a 的 2 次 bash 调用中有 1 次被标为失败
   （模型执行 exit 3 后又自己跑了一次探测，那次成功、未标）；
   6b 的 1 次调用未被误标；审计表同步记录 is_error=1 × 1（日志与 DB 两个口径一致）
```

**日志与审计表逐条对上了**——这是本用例最有说服力的一点：

| 时刻 | 模型的动作 | 日志（`tool:end`） | 审计表 |
| --- | --- | --- | --- |
| 15:12:01.229 | 执行 `exit 3` | `isError=true`，`resultPreview.details = {}` | `is_error=1`，`179ms`，`(no output)` |
| 15:12:06.724 | **自己**跑 `echo "prev_exit_code=$?"` 探测 | `isError=false`，`details = {"exitCode":0}` | 无（成功不写失败记录） |

> **为什么第二次调用不是缺陷**：提示词已说明"这是预期行为"，模型仍要亲眼确认退出码——
> 这是合理的行为，不是用例没写清楚。
> 而它恰好带来两个**意外的观测**：

1. **契约第 2 条的实证**：第一次的 `details` 是 `{}` —— 工具原本返回 `details: {exitCode: 3}`，
   但顶层 `isError` 被转成 throw 后，pi-agent-core 重建 result 时**清空了 details**。
   契约里写的那条副作用，在真实链路上被原样观测到。
2. **同一次会话里两条路径对照**：失败 → `details: {}`；成功 → `details: {"exitCode":0}` 完整保留。
   这说明 `isError` 不是"多写一个字段"，而是**改变 result 的形态**。

> **审计表那条为什么只有 1 条**：不是漏记——**成功的调用本来就不写失败审计**，
> 而 6a 里唯一失败的就是 `exit 3` 那一次。日志与 DB 在此处是 **1:1 精确对应**。

## TC-CONTRACT-07 失败必须被标记（批次 1）——file_edit 前置条件失败

- **优先级**：P0
- **层**：L3
- **前置**：客户端已 `dev:restart`
- **真实数据**：探针文件 `temp/tc-edit-fail-probe.md`（内容含「原始内容 A」）
- **步骤**：
  1. 写探针文件，新建会话
  2. 要求 agent 用 `file_edit` 把「绝不存在的字符串-XYZ」替换成「替换后」，
     并明说这是刻意构造的失败场景，**不要**改用 `file_write` 绕过、也不要先读文件换个存在的字符串
  3. 等回合完成，取 `tool:end` 里 `file_edit` 的 `isError`；回读探针文件
- **预期**：至少一次 `file_edit isError=true`；文件内容保持原样（确实替换失败）
- **断言**：两条全为**硬**
- **这条与 TC-06 互补在哪**：TC-06 走的是"宿主抛异常/非零退出码"，
  这条走的是**工具自己判定的前置条件不满足**——不是异常、不是退出码，
  而是 `if (!result.found) return {...}` 这种**正常返回的失败**。
  这类失败在批次 1 之前**完全不被标记**：模型只看到一段说 `Error: ...` 的普通文本，
  得自己读出"这是失败"。这是契约最典型的盲区，也是 `details.success: false` 无消费方的直接后果。
- **文件回读断言的作用**：防止"为了变红而制造假失败"——如果 agent 其实改成功了，
  这条会红，说明用例的构造前提（字符串确实不存在）不成立。
- **预计回合**：1

### ⚠️ 本用例第一版是假阳性（2026-09-18 实测发现并修正）

**症状**：用例 PASS，但 `is_error=1` 那条审计记录的 `result_summary` 是
`[file_edit 被拒绝] ... 文件存在但未被 file_read 读取过`——而不是 `oldString not found`。

**根因**：探针文件是套件用 `fs.writeFileSync` **刚创建**的，agent 没读过它，
于是 `read-before-write` hook 在 **beforeExecute 阶段**就把它拦下了
（`tool-runner.ts` 的短路路径同样会产生 `isError: true`）。
**那次失败压根没进到 `file-edit-tool.ts` 内部**，验的是 hook 短路，不是工具的失败分支。

**为什么危险**：它 PASS 了。如果不查 `result_summary`，这条用例会一直是绿的，
并让人以为"file-edit-tool 的两处失败分支有覆盖"——**而实际上一次都没验到**。
这与上一轮 A3a 的缺陷是同一类：**验收条件必须能让正确的对象变红**。

**两处修正**：

1. **提示词改成两步**（先 `file_read` 再 `file_edit`）——满足 hook 的"编辑前必须先读"，
   让失败真正发生在工具内部；
2. **断言失败的来源**，而不只是"失败了"：

```js
assert(!marked.includes("被拒绝"), "是 hook 拦的，不是工具自身分支")
assert(marked.includes("not found in"), "失败来源必须是 oldString 未找到")
```

**实测（修正后）**：

```
✅ [TC-CONTRACT-07] PASS — file_edit 的 oldString 未找到已标失败（1/1），
   失败来源已确认为工具自身分支，文件未被改动
```

日志证据（`tool:end` 事件的 resultPreview）：
`Error: \`oldString\` not found in ...tc-edit-fail-probe.md (tried exact, line_trimmed, whitespace_normalized)`

> **顺带发现的坑**：日志的 `resultPreview` **会被截断**（实测约 400 字符）。
> 上面那行的文本在 `...verify the exact content before` 处就断了，**没有闭合的 `}`**——
> 所以断言里**不能**用 `resultPreview=(\{.*\})` 这类要求完整 JSON 的正则，
> 只能取 `resultPreview=` 之后的整段做**子串**判断。
> （第一版修正正是踩了这个坑：断言写对了，但提取方式让它永远取到空串。）

---

## TC-CONTRACT-08 宿主工具的失败也必须被标记（批次 1 宿主侧延伸）

- **优先级**：P0
- **层**：L3（真实聊天模拟）
- **前置**：客户端已 `dev:restart`——**改的是 `apps/windows` 主进程**，不重启不生效
- **真实数据**：探针会话；`session_resume` 传一个不存在的 sessionKey
- **步骤**：
  1. **8a**：新建会话，要求 agent 调用 `session_resume`，`sessionKey` 传 `nonexistent-session-key-for-tc08`
  2. **8b**：另起会话，要求 agent 调用 `session_list`（必然成功）
  3. 从日志游标后的 `tool:end` 事件取两次的 `isError`
- **预期**：8a 至少一次 `isError=true`；8b 无一次 `isError=true`
- **断言**：两条全为**硬**
- **为什么必须单独验宿主机侧**：批次 1 先覆盖了 `packages` 的**内置工具**，
  而宿主工具有**两套**载荷约定（2026-09-18 核实，合计 196 处）：

  | 约定 | 处数 | 分布 |
  | --- | --- | --- |
  | `{ ok: false }` | 102 | app-ui / screen-record / client-cmd / integration / wiki / browser |
  | `{ status: 'error' \| 'not_found' \| 'partial' }` | 94 | maintenance / cron / handoff / sync / todo-write |

  两者由 `bridge-utils.ts` 的 `jsonToolResult` 统一提到顶层 `isError`。
  这条链路**横跨两个包**——宿主工具经 `bridge-instance-factory → assembleAgent →
  assembleTools` 装配，与内置工具**走同一个 ToolRunner**。
  单测能证明 `jsonToolResult` 返回了 isError，但证明不了它在真实链路上被转成 `is_error` 发给模型。
- **为什么选 `session_resume`**：它的失败是**确定性**的（传不存在的 key 必然 `{ok:false, message:'会话不存在'}`），
  不需要构造环境异常（如 `app_screenshot` 的 `capture_failed` 得让 UI 出问题）。
- **8b 反向断言的作用**：防"宿主工具一律标失败"——那种实现同样违反契约。
- **预计回合**：2

---

## 不在本套件覆盖范围内的

| 项 | 为什么不在 | 在哪验 |
|---|---|---|
| 描述文本里的工具名引用 | CLI 没有工具定义转储通道（只有 `tools=N/M` 计数与 system prompt 转储） | 单测 `tool-name-references.test.ts` |
| 参数校验失败是否入库 | 事件层已可见（日志），入库是**观察项**（执行计划 §三 1.3 明确不立即做） | 执行计划 §四 A6 |
| `isError` 契约的**静态一致性** | CLI 测不了"源码里有没有标"，只能测"行为上标没标" | 单测 `failure-semantics-guard.test.ts`（登记表 + 变红验证） |
| **宿主侧**工具的 `isError`（`jsonToolResult` 路径） | 见下方"批次 1 暴露的宿主侧缺口"——**尚未实施** | 执行计划 §三 批次 1 的发现记录 |
| 云同步超时保持 `isError:false` | 属回归断言，需真实同步冲突场景 | 执行计划 §四 A6 的回归断言 |
| `web_search` 零结果保持 `isError:false` | 零结果是"非理想结局"不是失败（契约第 3 条 b），需触发真实零结果查询 | 执行计划 §四 A6 的回归断言 |

### 批次 1 暴露的宿主侧缺口（已记录，未实施）

批次 1 只覆盖了 `packages/agent-runtime` 的**内置工具**。核查宿主侧时发现另一个结构性问题：

`apps/windows` 的宿主工具用一个统一构造器返回结果——

```ts
// apps/windows/src/main/agent-runtime/bridge-utils.ts:30
export function jsonToolResult(data: unknown): AgentToolResult<unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], details: undefined }
}
```

它的返回类型是 `AgentToolResult<unknown>`——**类型上就没有 `isError`**，
所以所有经它返回的失败（如 `app_screenshot` 的 `{ ok: false, error: 'capture_failed' }`）
都只把失败编码进 JSON 文本，模型得自己读 `ok: false`。

**规模**：`ok: false` 在宿主侧有 **95 处**，分布在 7 个文件
（`bridge-screen-record-tools` 27 / `bridge-tool-registrar-integration` 26 /
`bridge-tool-registrar-client-cmd` 18 / `bridge-app-ui-tools` 15 / `bridge-wiki-tools` 6 /
`bridge-tool-registrar-handoff` 2 / `bridge-browser-tools` 1）。
其中多少是**工具失败**、多少只是**业务字段**，需要逐个判语义——不能按数量直接改。

**机制是通的**：宿主工具经 `bridge-instance-factory` → `assembleAgent` → `assembleTools`
（`packages/agent-runtime/src/host-kit/tool-assembly.ts`）装配，**走同一个 ToolRunner**，
所以顶层 `isError` 会被正常转成 throw。缺的只是"没人标"。

**不在本套件范围内的原因**：范围与归属未定——是否纳入批次 1、还是作为独立批次，
需要先决策（宿主侧还有一个文件正被其他会话修改）。

## 运行方式

```bash
cd <repo root>
node docs/test/lumii-cli/tool-contract/run-tool-contract-e2e.mjs

# 只跑某条
TC_ONLY=TC-CONTRACT-01 node docs/test/lumii-cli/tool-contract/run-tool-contract-e2e.mjs

# 保留现场（不恢复 promptStyle、不删探针文件）
TC_NO_RESTORE=1 node docs/test/lumii-cli/tool-contract/run-tool-contract-e2e.mjs
```

**副作用与恢复**：套件会临时改 `promptStyle.style`（TC-02 需要 detailed），结束时恢复原值；
探针文件写在 `~/.lumii/workspace/temp/` 下，结束时删除；不触碰任何用户业务数据。

运行期间会在同目录留一个 `.tc-suite-original-style.json`（记录本次的原始档位）——
**这是给"进程被强杀、来不及恢复"兜底的**：正常结束会删掉它，
若它还在，说明上次没恢复干净，下次启动会自动还原（见下方"踩坑 3"）。

---

## 本套件开发中踩到的三个坑（2026-09-18）

### 1. 恢复动作必须挂在 `process.on('exit')`，不能只写在末尾

**症状**：一次对照实验后，用户的 `promptStyle` 被静默改成了测试用的 `detailed`，
此后每次运行都把 detailed 当成"原始值"再"恢复"成 detailed——**用户的设置就这样被测试吃掉了**。

**根因**：恢复代码写在主流程末尾，而主流程在「连续 3 个用例失败」时会 `process.exit(1)`
（`runCase` 的行为，见 `CLI-TEST-SPEC.md` §2.4），**那会跳过末尾的恢复**。

**修法**：把恢复包进 `restoreAll()` 并注册到 `process.on('exit')` 上——任何退出路径
（正常结束 / 提前终止 / 未捕获异常）都会触发。`exit` 钩子里只能做同步操作，
而 harness 的 `ui()` 是 `execFileSync`，满足条件。另加 3 次重试应对应用忙。

**通用性**：**任何会改全局设置（`promptStyle` / 模型 / 开关）的套件都要这么做**。
prompt-style 套件用的是末尾恢复，同样有这个风险。

### 2. `dev:restart` 后立刻跑会全线 `connection_failed`

**症状**：重启后马上跑套件，三条用例连续以 `conversation create 退出码 3: connection_failed` 失败，
套件按「连续 3 个失败即终止」提前退出。

**根因**：应用还没起来，控制口不可达。这是**环境问题不是产品缺陷**（`CLI-TEST-SPEC.md` §8 分类）。

**修法**：主流程开头加 `preflight()` 预检，不通过直接 `exit(3)` 并打印可读提示
（"若刚 dev:restart 过，等约 20 秒再跑"）。**比让三条用例依次报错强**——
后者会被误读成产品缺陷。

### 3. `process.on('exit')` 对**信号强杀无效**——坑 1 的第二次发作

**症状**（同一天下午）：套件被 `SIGTERM` 中断后，用户的 `promptStyle` **又一次**停在
`detailed`，探针文件也残留了。

**根因**：坑 1 的修法（把恢复注册到 `process.on('exit')`）只覆盖了「进程正常退出」。
`SIGTERM` / `SIGINT` 的默认行为是**直接终止**，不触发 `exit` 事件——
除非显式注册信号处理器。当时文档里写的"任何退出路径都会触发"是**错的**。

**修法（三重保险，逐层兜底）**：

| 层 | 手段 | 覆盖 |
| --- | --- | --- |
| 1 | 保留 `process.on('exit')` | 正常退出、未捕获异常 |
| 2 | 新增 `SIGINT` / `SIGTERM` 处理器 | 可控中断（Ctrl+C、`TaskStop`） |
| 3 | **把原始值落盘**，下次启动先自愈 | 连 `SIGKILL` 都能兜住——那种情况下**连信号处理器都不跑** |

第 3 层是关键：它不依赖"进程有机会做善后"这个前提，而是把善后推迟到**下次启动**。

> **顺序要紧**：启动时是「先自愈、再重读原始值」。
> 因为读 `originalStyle` 时，若上次留下了 `detailed`，读到的就是那个残留值——
> 直接用它当"原始值"，会把残留**固化**成用户设置（这正是坑 1 描述的那种连锁反应）。

**验证（实测，不是"看代码觉得对"）**：手工制造残留现场
（`promptStyle=detailed` + 状态文件记着 `terse`）后跑套件：

```
🩹 检测到上次运行未恢复干净，已把 promptStyle 还原为 terse
   原始 promptStyle=terse（TC-02 会切 detailed，结束恢复）
...
↩️  已恢复 promptStyle=terse
```

跑完复核：`promptStyle=terse`，状态文件已清理。

**通用性**：这条对**所有**"改了全局状态又必须还原"的测试套件都成立。
`process.on('exit')` 不是"任何退出路径"的保证，只是"正常退出路径"的保证。
