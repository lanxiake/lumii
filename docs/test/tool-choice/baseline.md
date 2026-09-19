# 工具选择评测 · 基线记录

> 跑分器：[`run-tool-choice-eval.mjs`](./run-tool-choice-eval.mjs) · 对照集：[`eval-set.json`](./eval-set.json) · 判读须知：[`README.md`](./README.md)

## 2026-09-18 · 首次可用基线：**9/15（60.0%）**

### 为什么是"首次可用"

此前三次跑**都不算数**，两次失败原因不同、且都不是模型的选法：

| 次序 | 结果 | 作废原因 |
| --- | --- | --- |
| #1 | 6/15 | t12~t15 全线 `connection_failed`，被计成模型失败（把 ~73% 拉到 40%） |
| #2 | 6/15 | 同上，叠加三条**评测集自身的缺陷**（正则误匹配文件名、跨分号误判、引用了已删的探针文件） |
| #3 | 0/15 | 应用被 VCS 快照冻死（见下），全程 `connection_failed` |

本轮的 15 条**全部执行完毕，零 ENV-ERROR、零 MODEL-BUSY** —— 这是它可用的唯一理由。

### 前置：这次跑之前修掉的东西

基线本身没意义，除非宿主是健康的。本轮之前修的（都不是评测集的问题）：

- **工作区 VCS 快照冻死主线程**：isomorphic-git 按内容全量重算 blob hash，2.7GB/12866 文件实测中位 19.9 秒、最长 53.5 秒，且全程在主进程主线程 —— 由此触发 Windows 事件 1002「Application Hang」。改走真 git 子进程后 2.5 秒。
- **cloud-sync 拖死共享队列**：`sync()` 的防抖只有 60 秒而一次同步要 5~10 分钟，于是每个 tick 都往队列里再塞一次全量同步，**排队者出队后不是被丢弃、是真跑一遍**（实测队列深度 8、`vcs:snapshot` 排队 610 秒）。
- **真 git 自动 gc 打出 iso 读不了的大包**：1.38GB 单包让 log/diff/readBlob 全废。已加 `-c gc.auto=0` 并写进仓库自身 config。

**跑这类评测前必须确认宿主健康**，否则测的是环境不是模型 —— 这个坑本项目踩了三次。

### 结果

| 用例 | 类别 | 结果 | 模型实际行为 |
| --- | --- | --- | --- |
| t01 find-vs-glob | 专用工具优先 | ❌ | `find . -name "*.md" -type f \| wc -l` |
| t02 grep-command-vs-tool | 专用工具优先 | ❌ | **全程没调 `grep`**，序列 `[glob, list_dir, list_dir, file_read, file_read, bash, glob, glob, list_dir, list_dir, bash]` |
| t03 ls-vs-list-dir | 专用工具优先 | ✅ | `list_dir > task_complete` |
| t04 cat-vs-file-read | 专用工具优先 | ✅ | `file_read > bash > bash` |
| t05 sed-vs-file-edit | 专用工具优先 | ✅ | `file_read > channel_send > file_edit > file_read` |
| t06 echo-redirect-vs-file-write | 专用工具优先 | ✅ | `file_write > file_read > task_complete` |
| t07 mkdir-vs-file-mkdir | 专用工具优先 | ✅ | `file_mkdir` |
| t08 mv-vs-file-move | 专用工具优先 | ❌ | 用 bash，序列 `[bash, glob, bash]` |
| t09 cp-vs-file-copy | 专用工具优先 | ❌ | 用 bash，序列 `[bash, list_dir, file_read, file_read]` |
| t10 memory-vs-wiki | 语义邻近工具 | ✅ | `bash > memory_search > ...` |
| t11 skill-search-vs-invoke | 语义邻近工具 | ❌ | 越级调 `skill_invoke` + `execute_skill` |
| t12 file-read-vs-wiki-read | 语义邻近工具 | ✅ | `wiki_overview > wiki_search > ...` |
| t13 no-phantom-tools | 不存在的工具 | ✅ | `file_read > file_read` |
| t14 batch-vs-serial | 批量与多步 | ✅ | `glob > glob` |
| t15 guide-before-use | 引导先行 | ❌ | **只调了 `cron_guide`，没建任务** |

| 类别 | 通过 |
| --- | --- |
| 专用工具优先 | 5/9 |
| 语义邻近工具 | 2/3 |
| 不存在的工具 | 1/1 |
| 批量与多步 | 1/1 |
| 引导先行 | 0/1 |

### 判读

**① 失败集中在"shell 先验"这一类。** t01/t08/t09 都是同一件事：`find`/`mv`/`cp` 在 shell 里是本能，而工具描述里明明写着「用专用工具（NOT `find`/`mv`/`cp`）」。**模型读了规则但没照做** —— 这正是工具面设计要解决的问题，不是评测集判错了。

**② t02 比 t01 更严重。** 它**从头到尾没调 `grep`** —— 不是"用了 shell 的 grep"，是连专用工具都没想起来，改用 glob + file_read 硬找。工具名 `grep` 同时是 shell 命令，这层歧义可能是原因之一。

**③ t15 是"引导有用但不够"。** 模型**确实先查了引导**（`cron_guide`）—— "引导先行"的意图生效了；但查完没有执行。当前断言只认 `cron_create`，所以判红。**这是个正向信号强度的问题，不是纯粹的失败**，值得后续单独看。

**④ t11 是典型的越级。** search → invoke → execute 三件套的语义分层没被模型区分开，直接去 invoke 一个猜的名字。

**⑤ 单次跑不能当结论。** 模型是随机的（见 README 特性一）：同一份代码、同一条提示词，t01 在不同轮次里 FAIL/PASS 都出现过。**本表是趋势的起点，不是分数**。至少要两次以上都失败的用例才值得动手改工具面 —— 按这个标准，t08/t09/t11 在两轮里都失败了。

### 复现

```bash
node scripts/verify-tool-choice-eval.mjs          # 前置校验，必做
node docs/test/tool-choice/run-tool-choice-eval.mjs
```

宿主需先确认健康：应用空闲、无后台重活、模型端点没有别的会话在压。

---

## 2026-09-19 · 第二轮：**12/15（80.0%）**

### 跑法

同一份跑分器与对照集，**工具面与首轮完全一致**——`fe454abd..HEAD` 之间
`tools/built-in`、`prompt/sections`、工具注册器零行为改动（唯一相关提交是一段类型注释）。
宿主为同日 13:26 启动的 dev 实例（HEAD 构建）。15 条全部执行完毕，零 ENV-ERROR、零 MODEL-BUSY。
冷却调至 20s（`TC_COOLDOWN_MS=20000`），仅降低端点并发、不影响判据。

### 结果

| 用例 | 首轮 09-18 | 本轮 09-19 | 本轮实际行为 |
| --- | --- | --- | --- |
| t01 find-vs-glob | ❌ | ✅ | `glob > bash` |
| t02 grep-command-vs-tool | ❌ | ✅ | `grep > glob > list_dir > bash …`（首个调用就是 `grep`） |
| t03 ls-vs-list-dir | ✅ | ✅ | `list_dir > bash > bash` |
| t04 cat-vs-file-read | ✅ | ✅ | `file_read` |
| t05 sed-vs-file-edit | ✅ | ❌ | `file_read > glob > glob > list_dir > grep`（没走到 `file_edit`） |
| t06 echo-redirect-vs-file-write | ✅ | ✅ | `file_write > file_read > task_complete > bash` |
| t07 mkdir-vs-file-mkdir | ✅ | ✅ | `file_mkdir` |
| t08 mv-vs-file-move | ❌ | ✅ | `file_move > bash …` |
| t09 cp-vs-file-copy | ❌ | ✅ | `file_copy > bash > glob > bash` |
| t10 memory-vs-wiki | ✅ | ✅ | `memory_search > bash > file_read` |
| t11 skill-search-vs-invoke | ❌ | ❌ | 越级直调 `skill_invoke` + `execute_skill` |
| t12 file-read-vs-wiki-read | ✅ | ✅ | `bash > wiki_overview > wiki_search …` |
| t13 no-phantom-tools | ✅ | ✅ | `file_read > list_dir > bash …` |
| t14 batch-vs-serial | ✅ | ✅ | `glob > glob > bash` |
| t15 guide-before-use | ❌ | ❌ | 只调 `cron_list`，没建任务（⚠️ 失实，见文末更正） |

| 类别 | 首轮 | 本轮 |
| --- | --- | --- |
| 专用工具优先 | 5/9 | **8/9** |
| 语义邻近工具 | 2/3 | 2/3 |
| 不存在的工具 | 1/1 | 1/1 |
| 批量与多步 | 1/1 | 1/1 |
| 引导先行 | 0/1 | 0/1 |

### 判读

**① 首轮的三条「shell 先验」失败本轮全部通过——而工具面没变。**
t01/t02/t08/t09 本轮 PASS，其中 t08/t09 的**首个**调用就是 `file_move`/`file_copy`。
两轮之间工具面零改动（见「跑法」），这只能归因于**模型随机性**（见上文特性一）。
→ 按准入标准（两轮都失败才动手），**它们不再是合格候选**；
「shell 本能压过专用工具」作为**系统性失败**未获数据支持，场景化工具集因此失去前提。

**② 唯一在两轮里都失败的是 t11（技能三件套越级）**，且本轮形态与首轮一致：
越级直调 `skill_invoke` + `execute_skill`。注意 `execute_skill` 是 09-18 才接线的（批次 3），
**本轮是它在已注册状态下的复现**——不是"工具不存在"造成的。
它是本轮唯一满足准入门槛的候选。

**③ t15 两轮失败但形态变了**：首轮只调 `cron_guide`，本轮只调 `cron_list`——都是
「查了但没执行」。仍属正向信号强度问题，需先设计判据（首轮判读 ③ 的结论不变），
不做工具面改造。

> ⚠️ **2026-09-19 晚更正**：本条整段作废——**次轮记录可证失实**（模型实际执行了，连任务都建了，
> 只是发生在证据快照之后）；首轮数据不可考、可疑同源。缺陷机理、判据重设计与验证见文末
> 「t15 复核」一节。

**④ t05 是新增的反向翻转（首轮 PASS → 本轮 FAIL）**：只失败一轮，按标准不构成候选。

**⑤ 分数不可跨轮横向解读。** 12/15 vs 9/15 的差全部来自随机翻转（含一个反向的 t05），
**两轮都过的稳定项是 11/15**（t03/t04/t06/t07/t10/t12/t13/t14 两轮全过，
t01/t02/t08/t09 一对一错，t05 一对一错）。后续改动工具面之后，应以上面这张
**逐用例两轮表**为对照，而不是拿总分做趋势。

---

## 2026-09-19 · t11 修复与验证（第二轮之后，同日）

### 诊断：不是"越级"，是被**失实指导**引过去的

从日志取到第二轮 t11 的真实序列（13:39:50 起）：

```
skill_search("代码审查, code review, …") → skill_search("代码, 编程, …") → skill_search() 列出全部
  → execute_skill('skillnet', 'search "code review 代码审查" --limit 5')   ← 失败：技能不存在
  → skill_invoke("skillnet")                                              ← 加载 31,485 字符文档
```

每一步都不是模型自己发明的：

- `skill_search` 的描述与零结果 hint 当时都写着「**If no local skills match, ALWAYS call
  `execute_skill` with skillnet**」——模型照做了；
- 而本机 `skillnet` 是**文档技能**（`[executable]` 列表里没有它），
  `execute_skill('skillnet', …)` **必然失败**（"技能不存在: skillnet"）；
- 失败 hint 又说「若是首次执行，可先用 `skill_invoke` 读它的 SKILL.md」——于是走到越级调用。

**即：这是一条「提示词指向工具面没给的路径」的链**（与工具面治理文档 §二 场景 4 的
`task_complete not found` 同类），不是"模型不守分层"。
它同时说明本用例的 reject 判据抓的**不只是猜名字**——任何走不到 search 为止的行为链都会被抓住，
这是对的：用户问的是一句话答案，不是一次 31KB 的文档加载。

### 改动（最小面：三处文案，`skill-tools.ts` + `execute-skill-tool.ts`）

| 位置 | 改动 |
| --- | --- |
| `skill_search` 描述 | 改为 **discovery first**：凡「有没有…的技能」这类问题先用它、并**从结果作答**；远程市场改为「用户主动的下一步，经 `skill_invoke` 加载，不是 `execute_skill`」 |
| `skill_search` 零结果 hint | 改为「如实报告；远程市场是用户主动的下一步」——不再给一条必然失败的 execute 指令 |
| `skill_invoke` 描述 | 补前置条件：传**已经知道**的名字（来自系统提示词列表或 skill_search 结果）；没有确切名字就先 search，**不要猜** |
| `execute_skill` 描述 | 补「id 取 `[executable]` 列表；技能列表里可见的其他 id（如 `skillnet`）不可执行，到这里会失败」 |

**守卫**（防回归）：
- `skill-tools.test.ts` 新增两条断言——零结果 hint 不含 `execute_skill`、描述里市场入口是 `skill_invoke`；
- `tool-name-references.test.ts` 的 `ALLOWED_NON_TOOL_BACKTICKS` 加 `skillnet`（技能名而非工具名，已附理由）。

### 验证

| 观测 | 结果 |
| --- | --- |
| 修复前（两轮评测） | ❌ ❌ —— 序列均含 `execute_skill` + `skill_invoke` |
| 修复后连跑 4 次（`TC_ONLY=t11`） | ✅ ✅ ✅ ✅ —— **每次序列都只有 `skill_search`** |

`@mtbot/agent-runtime` 全量 214 文件 / 2149 用例全绿；两包 `tsc` 干净。

> **为什么 4 次够**：这条不是"调提示词碰运气"——修复的对象是一条**必然失败**的指令，
> 删掉它之后"失败 hint 诱导 skill_invoke"的链条整体消失。修复前后各 2+ 次观测一致，
> 且机理解释完整（见「诊断」）。**换工具面后仍应以本节的序列为准重跑。**

---

## 2026-09-19 晚 · t15 复核：两轮「失败」都是**测量失真**（附跑分器两处修正）

### 结论先说

t15 此前记的两轮失败**都不是模型的失败**：

- **次轮「只调 `cron_list`，没建任务」是假记录。** 真实回合（会话消息 parts 可完整复原）：
  `cron_list → ask_user_question（渠道未承接，挂 5 分 13 秒被拒答）→ cron_guide
  → cron_create('cron' 表达式被工具拒绝) → cron_create('at' 自续链成功) → task_complete`，
  **任务真建进了 `local_cron_jobs`**（enabled、次日 09:00 首触发、自续）。
- **首轮「只调 cron_guide」不可考**：09-18 的评测数据不在当前数据根
  （`~/.lumii` 下 09-18 只有一个会话，当日应用日志也无任何 cron 工具行）。
  同一跑分器、同一判定逻辑，可疑同源，但无法复原。

### 失真来自两处（都已修）

| # | 缺陷 | 机理 | 实测代价 |
| --- | --- | --- | --- |
| 1 | 回合终点判定 | `sendAndWait` 用「正文文本连续两次轮询（5s）不变」判回合结束——**长思考 / 等用户回答时正文恰好不变**，回合被提前判完 | t15：13:42:42 取走证据，回合 13:48:30 才结束（`agent:end` 落定）；连 13:42:37 的 `ask_user_question` 都差点漏掉 |
| 2 | 日志参数截断 | `logging-hook.ts:23` 把 params 预览**截断在 200 字符**，长参数调用行尾没有收尾 `}`；跑分器正则要求 `params={...}` 完整闭合 → **整条调用被静默丢掉** | 复现回合 8 条调用只解析出 5 条：`ask_user_question` / `cron_create` / `memory_manage` 全丢（即使 #1 修好，t15 的 `cron_create` 照样丢） |

### 修法

| 层 | 改动 |
| --- | --- |
| `lumii-cli/lib/cli-harness.mjs` `sendAndWait` | 回合终点改为**最新 assistant 消息 `is_streaming=0`**（agent:start 建流式占位行、agent:end 落定；`bridge-agent-instance-events.ts:831`）——宿主给的唯一真终点 |
| `run-tool-choice-eval.mjs` 证据源 | 日志 → **会话消息 parts**（`fetchMessages` → `parts[type=tool].name/args`）：无截断、无渲染桥接问题 |
| `run-tool-choice-eval.mjs` 回合预算 | 默认 180s → **600s**：提问挂起要等超时被拒答（实测 ~5 分 13 秒）再继续；预算小于它会把合法回合误判成 MODEL-BUSY |
| `run-tool-choice-eval.mjs` 副产物清理 | 用例前后快照 `local_cron_jobs` / `agent_memories`，结束（含失败路径）删除新增项——**评测真的会改用户数据**（见「副产物」） |

### t15 判据重设计（用户拍板：保留真实问法）

题面补全任务内容、**保留「每天早上 9 点」**：

> 帮我建一个每天早上 9 点跑的定时任务：搜集当天的 AI 新闻，写一句话摘要发给我

- 硬判据：`expectTools: ["cron_create"]`（任务必须建出来）；`cron_guide` 保持**观察项**（不硬断言，序列全程打印）；
- `turnTimeoutMs: 720000`（提问路径最长要 ~9 分钟）；
- **能力事实**（决定题面怎么解读）：`cron_create` 只支持 `at`/`every`，
  **做不到精确的「每天 9 点」**（`every` 首次触发 = 创建时刻 + 间隔）——
  模型如何处理这个缺口本身就是要观测的行为。

### 顺带修掉的文案失实链（与 t11 同类）

`cron_guide`、`cron_create` 的包内 schema 与工具描述**三处**都宣称支持 cron 表达式
（guide 还给了 `"0 9 * * 1-5"` 示例），而本机唯一实现**必然拒绝** `cron`
（`bridge-tool-registrar-cron.ts:97-103`：调度器支持，Agent 工具刻意不开放）。
模型照 guide 做必然碰壁——真实回合里正是：试 `"0 9 * * *"` 被拒 → 自造 at 自续链。

**验证**：修好后第一轮实测，模型读完新 guide **主动向用户说明限制**再确认方案
（"有个限制需要先跟你确认"）——这正是期望行为。
守卫插曲：`host-tool-failure-semantics.test.ts` 拦下第一次改法——把「失败」字样写进了
`jsonToolResult` 实参内的注释，被判成漏标的失败载荷（注释已移到实参外）。

### 验证记录

| 观测 | 结果 |
| --- | --- |
| 修复前（两轮正赛） | ❌❌ —— 记录本身失真（见上） |
| harness 修后、证据源未换（21:25:37 会话） | ❌ 8 条调用只解析出 5 条（`ask_user_question`/`cron_create`/`memory_manage` 被日志截断吞掉）→ 据此发现缺陷 #2 |
| 证据源换 parts 后（21:28:34） | ✅ 序列 13 条全、含 `cron_create`；副产物已清理 |
| 再跑（21:31:29） | ✅ 序列 7 条全、含 `cron_create`；副产物已清理 |
| 第三次（21:41:13，验证记忆清理） | ✅ 序列 10 条全、含 `cron_create`；清理实证：1 个定时任务 + **1 条记忆条目** |
| t11 回归（21:30:01） | ✅ 只有 `skill_search`，无越级——t11 修复保持 |
| 全量单测 | agent-runtime 214 文件 / 2149 用例全绿；apps/windows 285 文件 / 2648 用例 0 失败；两包 `tsc` 干净 |
| 数据侧终检 | 跑完后 `local_cron_jobs` / `agent_memories` 零残留 |

### 副产物与清理（用户数据红线）

这批复核**实证了评测会改用户数据**：

| 副产物 | 来源 | 处置 |
| --- | --- | --- |
| `local_cron_jobs` 新任务（自续链、enabled=1、次日 09:00 触发） | t15 真实回合建任务（三轮各一条） | 全部已删；跑分器已加用例级快照/清理（走控制口 `cron:delete`，与用户手删同路径） |
| `agent_memories` 一条 reference（「AI新闻早报-每天9点」） | 模型回合内 `memory_manage add` | 已删；跑分器已加同款差集清理 |

残留局限（跑分器注释留痕）：模型若**去重更新**一条已存在的记忆（实测相同内容 `add`
会更新而非新建），变更不在 id 差集里、不会回滚。

