# Tooling 提示词重构实施计划

> 分析来源：对 `docs/temp/系统提示词.md`（真实渲染产物）与其生成代码的逐行实勘。
> 涉及 `packages/agent-runtime/src/prompt/sections/tooling-section.ts`、`misc-sections.ts`、
> `system-prompt-builder.ts`、`tools/built-in/*`、`apps/windows/src/main/agent-runtime/bridge-tool-registrar-*.ts`。

**Goal:** 消除「提示词工具清单」与「运行时工具注册表」两套真相，修掉已经漂移的 7 处错误，
并把 `## Tooling` 节从「重复一遍 tool schema 描述」降级为「分组索引」。

**Architecture:** 在 `MtBotToolConfig` 增加 `promptGroup` + `promptHint` 两个可选元数据字段；
`categorizeTools` 不再消费手写 `TOOL_SUMMARIES`，改为消费由注册表推导的分组视图；
客户端专属工具（guide / app / screen / browser）的分组元数据下沉到 `apps/windows`，
`packages/agent-runtime` 不再硬编码任何客户端工具名。

**Tech Stack:** TypeScript、Vitest、既有 `ToolRegistry` / `assembleTools` / `assembleSystemPrompt` 链路。

**原则:** TDD、小步提交、**先修 bug 再重构**、YAGNI（不引入 tool_search、不做动态 schema 懒加载）。

**预期收益:** `## Tooling` 节当前 5741 字节（占 31381 字节提示词的 18.3%），
目标压到 ~2.3KB；同时消除 8 个「无描述工具」和 3 处会误导模型的错误指令。

**工作方式:** 本任务在 worktree `.worktrees/tooling-prompt-drift`（分支 `fix/tooling-prompt-drift`）
中进行。主工作区有另一个 agent 并行开发 wiki 功能，**不要在主工作区留未提交产物**。

---

## 进度

**P0 — 事实性错误修复（可独立合并，不动接口）**

- [x] P0-T1 `tts_generate` → `speech_generate` 键名修复
- [x] P0-T2 清理 `nodes` 幽灵工具与死代码
- [x] P0-T3 补齐 8 个掉进 Other Tools 的工具分组与描述
- [x] P0-T4 修正 browser 元素定位指令（核实结论见 §3.4 补注）
- [x] P0-T5 修正无法执行的 On-demand tool groups 指令 → `Desktop Control`
- [x] P0-T6 下线 `wiki_capture`
- [x] P0-T7 `session_clear` 纳入安全边界清单
- [x] P0-T8 加漂移守卫测试（runtime + bridge 两侧）

**P1 — 冗余压缩（依赖 P0-T8 的守卫测试）**

- [x] P1-T1 `TOOL_SUMMARIES` 瘦身为 ≤20 字 hint
- [x] P1-T2 消除正文 section 与工具清单的重复陈述
- [x] P1-T3 `task_complete` 四处收敛为一处权威位置
- [x] P1-T4 browser 九工具折叠为一行

**P2 — 结构重构（动 `MtBotToolConfig` 接口，单独评审）**

**P2 — 结构重构（实勘后判定收敛，见 §5 修订）**

- [x] P2-T收 修 `tts_generate` 残留文案（`Path discipline` 例子 + 无害注释/日志）
- [~] P2-T1 `MtBotToolConfig` 加 `promptGroup`/`promptHint`　→ **实勘判定不做**（§5 修订说明）
- [~] P2-T2 `categorizeTools` 改注册表驱动　→ **不做**
- [~] P2-T3 分组重划　→ P1 已并入（P0 阶段已重划 16 组）
- [~] P2-T4 客户端元数据下沉　→ **不做**
- [~] P2-T5 删手写映射表　→ **不做**（映射表是必要的「何时用」索引，非重复）

---

## 0. 代码实勘结论（实施前必读）

### 0.1 数据流锚点

```
ALL_BUILT_IN_TOOL_CONFIGS (tools/built-in/index.ts, 47 个)
  + bridge-tool-registrar-*.ts (guide 3 / browser 9 / app 8 / screen 11)
      ↓ createMtBotTool(config, ctx)   ← description 原样进 schema
  ToolRegistry.getEnabledTools()
      ↓ assembleTools()               → assembledTools.tools
  toolNames = tools.map(t => t.name)  ← host-kit/assemble-agent.ts:151
      ↓ assembleSystemPrompt({ toolNames })
  categorizeTools(toolNames)          ← 只拿到 string[]，元数据全丢
      ↓ 查手写 TOOL_SUMMARIES
  "## Tooling" 节
```

**关键约束：** `categorizeTools` 的入参只有 `readonly string[]`。这是「手写映射表」存在的
根本原因——它拿不到 `category` / `description`。P2 必须改这个签名，把元数据一起传进来。

### 0.2 两套真相的证据

| 事实 | 位置 |
|------|------|
| 工具 description 已经进 schema 发给模型 | `tools/tool-adapter.ts:48` |
| built-in 工具 description 合计 ~24KB | `awk '/^  description:/,/^  parameters:/' *.ts \| wc -c` |
| `TOOL_SUMMARIES` 是独立手写表，与注册表零约束 | `tooling-section.ts:9-90` |
| 无任何测试校验两边一致 | `sections/__tests__/` 只有 `agent-collaboration-section.test.ts` |

### 0.3 易踩坑

1. **`ToolCategory` 不能直接复用做分组。** 现有 6 个值分布极不均：`agent` 20 个、
   `filesystem` 13、`memory` 9、`channel` 4、`web` 2、`shell` 1。`speech_generate` 是
   `channel`、`image_generate` 是 `filesystem`——语义按「执行侧」划分，不是按「模型认知」划分。
   必须新增 `promptGroup`，不要改 `category`（它被 `getByCategory` / 权限逻辑消费）。

2. **`apps/windows` 注册的工具无法在 `packages/agent-runtime` 编译期枚举。**
   守卫测试只能在 `apps/windows` 侧做全量校验；runtime 侧只能校验 built-in 部分。

3. **`promptDetail` 三档（compact / standard / full）都要过一遍。** 分组渲染在三档共用，
   改 `categorizeTools` 会同时影响三档快照。

---

## 1. 问题清单（全部可验证）

### 1.1 P0 事实性错误

| ID | 问题 | 证据 | 后果 |
|----|------|------|------|
| E1 | `TOOL_SUMMARIES` 键名 `tts_generate` 是死键 | 真实注册名 `speech_generate`（`integration-tools.ts:194`） | 该描述永不渲染；`speech_generate` 落进 Other Tools 且无描述（渲染产物第 106 行） |
| E2 | `nodes` 工具从未注册 | 全仓库仅 `tooling-section.ts:111`、`misc-sections.ts:313` 提及 | `buildDeviceRoutingSection` 是永不触发的死代码；`BACKEND_SERVICE_TOOLS` 挂幽灵成员 |
| E3 | 8 个工具无描述掉进 Other Tools | 渲染产物第 103-110 行 | `dashboard_feed_write` / `channel_list` / `channel_send` / `speech_generate` / `wiki_overview` / `wiki_search` / `wiki_read` / `wiki_capture`。其中 `channel_*` 有整节 `## Channel outbound` 教用法，清单里却一字无 |
| E4 | browser 元素定位指令错误 | `bridge-browser-tools.ts:72-75` 真实参数是 `ref`，`index` 仅 legacy | 提示词说 "by index (from snapshot)"，`## Browser Control` 说 "indexes come from `browser_screenshot`"——**bridge 只注册 9 个 browser 工具，没有任何 snapshot 工具**，模型被指向不存在的来源 |
| E5 | On-demand tool groups 指令无法执行 | 只有 a2ui / cron / weixin 三个 guide | 指令要求「先调对应 guide 工具」，但 `app_*`(8) / `screen_record_*`(11) 无 guide；且它们的完整 schema 照样发给模型，所谓「按需加载」只省了提示词几行 |
| E6 | `wiki_capture` 已废弃仍注册并渲染 | 自身 description = "Disabled. ... Do not call this tool."（`wiki-tools.ts:83`） | 花 token 告诉模型「有个工具别调」 |
| E7 | `session_clear` 未纳入安全边界 | `client-command-tools.ts:41`，语义为删除当前 session 全部消息 | `## Safety and Boundaries` 破坏性清单只列了文件/分支/表，遗漏此项 |

### 1.2 P1 冗余（三层）

**第一层 —— `TOOL_SUMMARIES` 整体就是重复。** schema description 已发给模型，
清单再写一遍。最极端案例 `image_generate`：提示词里那 200 字（modelId 选择、失败不重试、
revisedPrompt 合并）在 `image-generate-tool.ts:99-118` 一字不差全有。

**第二层 —— 正文 section 与工具清单互相重复。**

| 重复内容 | 出现位置 |
|---------|---------|
| 「别用 bash 做文件操作」 | `bash-tool.ts` schema、`TOOL_SUMMARIES.bash`、`**Tool preference:**`（builder.ts:214） |
| 「先调 cron_guide」 | `cron_create` 描述 ↔ `cron_guide` 描述（循环互指） |
| 「先 memory_search 拿 drawer_id」 | `TOOL_SUMMARIES.memory_read`、`## Memory`、`## Context Compaction` |
| browser 索引来源 | 九工具逐条 + `## Browser Control` |
| skill 用法 | `Guide Tools` 分组 + `<skills>` 节 Usage |

**第三层 —— `task_complete` 出现四次：** `### Task Completion` 单工具分组、
独立 `## Task Completion` 节（builder.ts:364-369）、`## Honesty and Verification` bullet、
`## Session Tasks` 活跃状态（`runtime-section.ts:113-124`）。**第四处才是权威位置**
（代码注释明确写「权威位置」），前三处在稀释它。

### 1.3 P1 不完善

| ID | 缺口 |
|----|------|
| G1 | `spawn_agent` 只有一句 "Spawn a sub-agent for complex tasks"，但 `## Task Orchestration` 整节建立在 `mode=sync` / `mode=async` 区别上——最关键参数语义清单里没提 |
| G2 | wiki 四工具零指导。`wiki_overview` schema 明确要求 "Call this FIRST before wiki_search"，正文无任何体现，而 memory 有整节 |
| G3 | `ask_user_question` 是核心交互原语，因不在任何分组里掉进 Other Tools |
| G4 | `execute_skill`（`tool-names.ts:28`）已定义但不在 `ALL_BUILT_IN_TOOL_CONFIGS`，也无分组——若后续注册会立刻无描述 |

---

## 2. 目标分组方案

### 2.1 分组重划对照

| 现分组 | 目标分组 | 动作 |
|--------|---------|------|
| `File Tools` | `File Tools` | 不变（9 个，语义内聚） |
| `Command Tools`（bash/web_fetch/web_search） | `Shell` + `Web` | **拆**：bash 与 web 不同风险等级、不同用途 |
| `Media Generation`（image_generate） | `Media Generation` | **合入** `speech_generate`（当前无家） |
| `Task Management`（todo_write）+ `Task Completion`（task_complete） | `Task Management` | **合并**：单工具分组无必要 |
| `Agent Delegation` | `Agent Delegation` | 不变 |
| `Scheduling` | `Scheduling` | 不变 |
| `Guide Tools`（a2ui/cron/weixin + skill_list/search/invoke） | `Skills` + `Reference Guides` | **拆**：技能发现是一等能力，懒加载文档是实现细节 |
| `Backend Services`（message/nodes/memory_search/memory_read/profile_memory/memory_manage/system_prompt） | `Messaging` + `Memory & Knowledge` + `Self-Configuration` | **三拆**：四种不相干能力硬凑 |
| `Client Commands`（session_*/settings_*/info_status + memory_manage） | `Session & Settings` | **移出** `memory_manage`（讲工作记忆，与 session 无关） |
| `Browser Tools`（9 个） | `Browser Tools` | **折叠为一行**，细节交给 `## Browser Control` |
| `Agent Management` | `Agent Management` | 不变 |
| `Other Tools`（8 个无描述） | 消失 | 全部归入正式分组 |
| `On-demand tool groups` | `Desktop Control` | 改为如实描述（见 §3.5） |

### 2.2 目标分组归属明细

```
File Tools          file_read file_write file_edit list_dir file_mkdir
                    file_move file_copy glob grep
Shell               bash
Web                 web_search web_fetch
Media Generation    image_generate speech_generate
Task Management     todo_write task_complete
Agent Delegation    spawn_agent send_message
Agent Management    agent_team_generate agent_team_optimize agent_remove
Scheduling          cron_create cron_list cron_delete
Skills              skill_list skill_search skill_invoke
Memory & Knowledge  memory_search memory_read memory_manage
                    wiki_overview wiki_search wiki_read
Messaging           message channel_list channel_send
Self-Configuration  profile_memory system_prompt
Session & Settings  session_create session_clear session_compact
                    session_resume settings_think settings_backend info_status
Interaction         ask_user_question
Dashboard           dashboard_feed_write
Browser Tools       browser_*（折叠一行）
Desktop Control     app_* screen_record_* screen_screenshot（折叠一行）
Reference Guides    a2ui_guide cron_guide weixin_send_guide
```

`wiki_capture` 不在其中——P0-T6 下线。`nodes` 不在其中——P0-T2 删除。

### 2.3 目标渲染样例（standard 档）

```markdown
## Tooling

Tool names are case-sensitive. Call tools exactly as listed.
Each tool's full parameter contract is in its own schema — the list below is an index.

### File Tools
`file_read` `file_write` `file_edit` `list_dir` `file_mkdir` `file_move` `file_copy` `glob` `grep`
Prefer these over `bash` for any file work.

### Shell
- `bash`: shell-only operations (git, npm, builds, system state)

### Web
- `web_search`: time-sensitive facts
- `web_fetch`: a specific known URL

### Memory & Knowledge
- `memory_search` → `memory_read`: recall past work; search first for `drawer_id`
- `memory_manage`: correct or remove stale working-memory entries
- `wiki_overview` → `wiki_search` → `wiki_read`: knowledge base; overview first

### Browser Tools
`browser_*` (9 tools) — see `## Browser Control` for the interaction loop.
```

**要点：** 单一用途工具用反引号裸列（不写描述），有顺序约束的用 `→` 表达，
风险/偏好类各组最多一行补充。描述细节全部交给 schema。

---

## 3. P0 任务分解

> P0 全部**不动接口**，只改数据与文案，可独立合并。分支：`fix/tooling-prompt-drift`

### P0-T1 修复 `speech_generate` 键名

**文件:** `packages/agent-runtime/src/prompt/sections/tooling-section.ts`

1. 先写测试（红）：`categorizeTools(["speech_generate"])` 断言输出含非空描述。
2. `TOOL_SUMMARIES` 中 `tts_generate` 键改为 `speech_generate`，描述改写为
   ≤20 字 hint：`"Synthesize speech audio to workspace/outputs"`。
3. 加入 `MEDIA_GENERATION_TOOLS` 集合。

**验收:** `speech_generate` 出现在 `### Media Generation` 且有描述；不再出现在 Other Tools。

### P0-T2 清理 `nodes` 幽灵

**文件:** `tooling-section.ts`、`misc-sections.ts`、`runtime-section.ts`

1. 从 `BACKEND_SERVICE_TOOLS` 与 `TOOL_SUMMARIES` 删除 `nodes`。
2. 删除 `buildDeviceRoutingSection`（misc-sections.ts:312-323）及其在
   `system-prompt-builder.ts:375` 的调用。
3. `runtime-section.ts:38` 的 Client context 文案删掉 `/nodes` 引用。
4. 若 `## Device Routing` 被别处引用一并清理。

**验收:** `grep -rn "nodes" packages/agent-runtime/src/prompt` 无残留；typecheck 绿。

**注意:** `buildUserDevicesSection` / `buildDeviceControlSection` 依赖 `params.userDevices`
（非 `nodes` 工具），**不要动**。

### P0-T3 补齐 8 个无家工具

**文件:** `tooling-section.ts`

新增分组常量与 `TOOL_SUMMARIES` 条目（每条 ≤20 字）：

| 工具 | 目标分组 | hint |
|------|---------|------|
| `channel_list` | Messaging | `List channels and peer ids — call before channel_send` |
| `channel_send` | Messaging | `Send text/file to an explicit channel peer` |
| `wiki_overview` | Memory & Knowledge | `Wiki map — call before wiki_search` |
| `wiki_search` | Memory & Knowledge | `Search the Wiki knowledge base` |
| `wiki_read` | Memory & Knowledge | `Read one Wiki page by exact path` |
| `speech_generate` | Media Generation | 见 P0-T1 |
| `dashboard_feed_write` | Dashboard | `Persist news items to the dashboard feed card` |
| `ask_user_question` | Interaction | 沿用现有描述，改挂 `INTERACTION_TOOLS` |

**验收:** `### Other Tools` 分组在默认工具集下不再出现（测试断言）。

### P0-T4 修正 browser 元素定位

**文件:** `bridge-browser-tools.ts`、`misc-sections.ts`

1. `browser_click` / `browser_type` 的 description 把 "by index (from snapshot)"
   改为 "by `ref` from the latest `browser_screenshot` result（`index` is legacy）"。
   —— **前置核实**：先确认 `browser_screenshot` 的返回体是否真的带 ref；
   若不带，则问题是「无处取 ref」，需在 `browser-control` 侧补 ref 输出，
   或改为如实说明「用 `browser_eval` 定位」。**此项须先验证再动手。**
2. `buildBrowserSection`（misc-sections.ts:299-306）的
   "Element indexes come from the most recent `browser_screenshot`" 按核实结果改写。

**验收:** 提示词与真实参数名一致；ref 来源可在代码中指出具体返回字段。

#### 核实结论（2026-08-28，已完成）

前置核实门的结果比预估更糟，**ref 来源确实不存在**：

| 核实项 | 结论 |
|--------|------|
| `browser_screenshot` 返回体 | `{ok, path, targetId, url}`（`agent.snapshot.ts:173-178`）——**不含 ref** |
| ref 的真实产出点 | `GET /snapshot`（`agent.snapshot.ts:185`，`refs` 字段在 285 行） |
| bridge 接了哪些路由 | 仅 `/act`、`/navigate`、`/screenshot`——**没有任何工具打到 `/snapshot`** |

即 `browser_click` / `browser_type` 要求的 `ref` 参数，模型**无从获取**。

**已采取的处理（如实描述，不编造来源）：**
1. `buildBrowserSection` 明说 screenshot 不返回 ref、当前无工具暴露 ref，
   引导改用 `browser_eval` 定位元素。
2. `bridge-browser-tools.ts` 两处 description 补同样的 caveat。
3. `TOOL_SUMMARIES` 的 `browser_click` / `browser_type` 指向 Browser Control 节。

**遗留缺口（另开 issue，不在本计划）：** 把 `GET /snapshot` 接成
`browser_snapshot` 工具，才能真正支持 ref 定位。届时应回滚上述 caveat 文案。

### P0-T5 修正 On-demand tool groups

**文件:** `tooling-section.ts:195-202`

删掉 "Use the relevant guide tool before calling tools in these groups"（无 guide 可用），
改为如实陈述：

```
### Desktop Control
- `app_*` (8 tools): control this desktop client's own UI
- `screen_record_*` / `screen_screenshot` (12 tools): screen recording and desktop capture
Full parameter contracts are in each tool's schema.
```

**验收:** 不再出现指向不存在 guide 的指令。

### P0-T6 下线 `wiki_capture`

**文件:** `tools/built-in/index.ts`、`wiki-tools.ts`、`bridge-wiki-tools.ts`

1. 从 `ALL_BUILT_IN_TOOL_CONFIGS` 移除 `wikiCaptureToolConfig`。
2. 保留导出（可能有外部引用）但标 `@deprecated`；或确认无引用后整体删除。
3. 更新 `bridge-wiki-tools.test.ts` 相关断言。

**验收:** 工具总数 -1；提示词不再出现 `wiki_capture`；wiki 测试绿。

**⚠ 冲突预警:** 主工作区另一个 agent 正在改 wiki 相关代码。本任务动
`wiki-tools.ts` / `bridge-wiki-tools.ts` 前先 `git fetch` 看 main 是否有新的 wiki 提交，
必要时先 rebase。若冲突面大，可把 P0-T6 拆到最后单独做。

### P0-T7 `session_clear` 纳入安全边界

**文件:** `misc-sections.ts` `buildSafetySection`

破坏性清单补入 session 语义：

```
- Destructive (deleting files, directories, or branches; dropping tables;
  killing processes; `rm -rf`; clearing a conversation session; overwriting
  uncommitted work): confirm first.
```

**验收:** `session_clear` 可用时，Safety 节含「clearing a conversation session」。

### P0-T8 漂移守卫测试（本阶段闸门）

**新增:** `packages/agent-runtime/src/prompt/sections/__tests__/tooling-section.test.ts`

1. **built-in 全覆盖**：遍历 `ALL_BUILT_IN_TOOL_CONFIGS`，断言每个 `name`
   都能被 `categorizeTools([name])` 归入非 `Other Tools` 的分组且描述非空。
2. **无死键**：断言 `TOOL_SUMMARIES` 的每个键都存在于
   「built-in 名单 ∪ 客户端已知名单常量」中。
3. **分组不重叠**：断言各分组集合两两交集为空。

**新增:** `apps/windows/src/main/agent-runtime/bridge-tool-registrar.test.ts` 补一例：
把 bridge 实际注册的全部工具名喂给 `categorizeTools`，断言无 `Other Tools`。

**验收:** 两个测试绿；此后任何新增工具漏配分组会立刻红。

---

## 4. P1 任务分解

> 依赖 P0-T8 守卫测试就位。分支：`refactor/tooling-prompt-slim`

### P1-T1 `TOOL_SUMMARIES` 瘦身

**原则:** 每条 hint ≤20 字，只回答「什么时候用它」，不复述参数与规则。
参数契约、失败处理、重试策略一律留在 schema。

重点改写对象：

| 工具 | 现状 | 目标 |
|------|------|------|
| `image_generate` | 200 字，复述 modelId 表 / 失败不重试 / revisedPrompt 合并 | `Generate images to workspace/outputs (model options in schema)` |
| `file_write` | 复述三种 mode 与行号语义 | `Write a file (overwrite/append/range — see schema)` |
| `memory_read` | 复述 drawer_id 取法 | `Read one archived memory drawer by drawer_id` |
| `cron_create` | 「先调 cron_guide」 | `Create a scheduled task` （guide 指向留在 Scheduling 组一行） |
| `memory_manage` | 两句 | `Fix or remove stale working-memory entries` |
| `task_complete` | 三句含 MUST | `Signal task completion` （规则留 Session Tasks） |
| `bash` | 复述用途 | `Shell-only operations` （反 bash 规则留 Tool preference） |

**验收:** 实测渲染产出自 5741 字节降至 3287 字节（−43%）。
原 §8 严格目标 ≤2600 未能一步到位：剩余体量主要在 `Media Generation` /
`Session & Settings` / `Agent Management` 等组的逐条行。若需压到 2600，
须再折叠若干组（见 §8 注记）；本阶段以「正确的−43%」优先于「激进的−55%」。
`pnpm --filter ./packages/agent-runtime test` 绿（1019/1020，1 个失败为 main 既有的 wiki-repo）。

### P1-T2 消除正文与清单重复

| 重复项 | 保留位置 | 删除位置 |
|--------|---------|---------|
| 反 bash 文件操作 | `**Tool preference:**`（builder.ts:214） | `bash` hint、`bash-tool.ts` schema 里的清单可保留（对模型直接可见，成本已付） |
| cron_guide 互指 | `Scheduling` 组一行 `Call cron_guide first for the parameter format` | `cron_create` hint、`cron_guide` hint 二者删一 |
| memory_search → memory_read 顺序 | `## Memory`（`misc-sections.ts:207-211`） | `memory_read` hint、`## Context Compaction` 的重复陈述 |
| browser 索引来源 | `## Browser Control` | 九工具逐条描述（P1-T4 一并折叠） |
| skill 用法 | `<skills>` 节 Usage | `Skills` 组只留工具名 |

**验收:** 上表每项在整份渲染产物中只出现一次（测试用 `fullPrompt` 计数断言）。

### P1-T3 `task_complete` 收敛

1. 权威位置保留 `## Session Tasks`（`runtime-section.ts:113-124`，动态注入、每轮最新）。
2. 删除独立 `## Task Completion` 节（`system-prompt-builder.ts:364-369`），
   把其中唯一不重复的信息（「客户端 todo 与桌面通知依赖此调用」）并入 Session Tasks。
3. `## Honesty and Verification` 的 bullet 改为纯指针，不复述规则。
4. `Task Management` 组内 `task_complete` 只留工具名。

**风险:** `activeTasks` 为空时 `buildActiveTasksSection` 返回 `[]`（runtime-section.ts:85），
此时 `task_complete` 规则会**完全消失**。必须在无活跃任务时保留一句兜底
（放在 `Task Management` 组或 Verification 节），否则模型不知道必须调用它。
**这是 P1-T3 的必测用例。**

**验收:** `task_complete` 相关规则在 fullPrompt 中出现 ≤2 次；无活跃任务场景下仍有兜底指令。

### P1-T4 browser 折叠 + G1/G2 补缺

1. `BROWSER_TOOLS` 渲染改为单行汇总（见 §2.3 样例），九条描述删除。
2. **G1**：`spawn_agent` hint 补 mode 语义 → `Delegate a task (mode=sync blocks, mode=async notifies)`。
3. **G2**：`Memory & Knowledge` 组补一行 wiki 顺序约束 `wiki_overview → wiki_search → wiki_read`。
4. **G4**：`execute_skill` 预置分组（`Skills`）与 hint，避免未来注册即无描述。

**验收:** 守卫测试对 `execute_skill` 也通过；browser 节省 ≥400 字节。

---

## 5. P2 结构重构

> **2026-08-28 修订：实勘后判定，本阶段的接口重构不做。**
>
> 原计划要给 `MtBotToolConfig` 加 `promptGroup`/`promptHint`、改成注册表驱动、
> 删手写映射表。逐层读代码后确认这是过度设计，理由：
>
> 1. **元数据一路丢失，改签名代价大收益零。** `toolNames` 在
>    `assemble-agent.ts:151` 就被 `.map(t => t.name)` 拍成 `string[]`，穿过
>    `ClientSystemPromptParams` / `prompt-assembly.ts` 三层到 `categorizeTools`
>    只剩名字。要让 `promptGroup` 传过去得改 3 个类型 + 3 个调用点 +
>    79 个工具配置各加两字段——纯重构、零用户可见收益。
> 2. **`categorizeTools` 现在的 Set 映射工作正常、被守卫测试锁住、能自愈。**
>    改成「注册表驱动」只是把同一个「名字→分组」映射换个存储位置，
>    不多代码反而多一层类型。
> 3. **真正的重复在 P1 已经解决。** `TOOL_SUMMARIES` 已瘦身为「何时用」索引，
>    不再是 schema 描述的重复；组注/折叠也已在 P1 处理。剩下的映射表是有价值的，
>    不该删。
>
> **P2 实际收敛为文案收尾**（本分支只做这一件）：
> - 修 `misc-sections.ts` `Path discipline` 例子里的 `tts_generate` → `speech_generate`
>   （这一条是 V2 里仍会误导模型的残留，非重构）
> - 统一 `integration-tools.ts` 头注释与 `bridge-tool-registrar-integration.ts`
>   日志里的旧名
>
> 若未来确有「同一工具跨 Agent 复用不同分组」的需求，再回来评估接口方案。

以下原计划内容保留存档，仅作背景：

> 动 `MtBotToolConfig` 公共接口，影响 47 个 built-in + 32 个 bridge 工具。
> **须单独评审后再开工。** 分支：`refactor/tooling-registry-driven`

### P2-T1 接口扩展

**文件:** `packages/agent-runtime/src/tools/tool-adapter.ts`、`types/tool.ts`

```ts
/** 提示词分组标识（仅影响系统提示词呈现，不参与权限/执行逻辑） */
export type PromptGroup =
  | "file" | "shell" | "web" | "media" | "task" | "delegation"
  | "agentMgmt" | "scheduling" | "skills" | "memory" | "messaging"
  | "selfConfig" | "session" | "interaction" | "dashboard"
  | "browser" | "desktop" | "guide"

export interface MtBotToolConfig<...> {
  // ... 现有字段不变
  /** 提示词分组；缺省时 categorizeTools 落入兜底组并触发守卫测试失败 */
  readonly promptGroup?: PromptGroup
  /** ≤20 字「何时用」提示；缺省时清单只渲染工具名 */
  readonly promptHint?: string
}
```

`createMtBotTool` 透传两字段到 `MtBotTool`。**`category` 保持不动**——它被
`ToolRegistry.getByCategory` 与权限逻辑消费，语义是「执行侧归属」，与提示词分组正交。

### P2-T2 `categorizeTools` 改签名

**当前:** `categorizeTools(toolNames: readonly string[]): string[]`
**目标:** `categorizeTools(tools: readonly ToolPromptMeta[]): string[]`

```ts
export interface ToolPromptMeta {
  readonly name: string
  readonly promptGroup?: PromptGroup
  readonly promptHint?: string
}
```

**改造链路（3 处调用点）:**

1. `system-prompt.types.ts` — `ClientSystemPromptParams` 增加
   `toolMeta?: readonly ToolPromptMeta[]`，与 `toolNames` 并存（`toolNames` 仍被
   十余处能力判断消费，**不要删**）。
2. `host-kit/prompt-assembly.ts` — `AssembleSystemPromptOptions` 增加 `toolMeta`。
3. `host-kit/assemble-agent.ts:151` — 从 `assembledTools` 同时导出 meta：
   ```ts
   const toolNames = assembledTools.tools.map(t => t.name)
   const toolMeta  = assembledTools.tools.map(t => ({
     name: t.name, promptGroup: t.promptGroup, promptHint: t.promptHint,
   }))
   ```

**兼容策略:** `toolMeta` 缺省时 `categorizeTools` 退回按 `toolNames` + 内置兜底映射，
保证 P2 分步落地期间提示词不退化。**兜底映射在 P2-T5 删除。**

**前置核实:** `wrapMtBotToolsWithRunner`（`tools/tool-registry.ts`）包装后返回
`AgentTool[]`，需确认 `promptGroup` / `promptHint` 是否被保留；若被剥离，
则 meta 必须在包装**前**（`assembleTools` 内的 `filtered`）采集。

### P2-T3 分组落地

按 §2.2 给 47 个 built-in 工具配置逐个补 `promptGroup` + `promptHint`。
纯机械改动，但需一次做完，否则守卫测试会在中间态红。

### P2-T4 客户端元数据下沉

**文件:** `apps/windows/src/main/agent-runtime/bridge-tool-registrar-{guide,browser}.ts`、
`bridge-app-ui-tools.ts`、`bridge-screen-record-tools.ts`

1. 给 32 个 bridge 工具的 `createMtBotTool` 调用补 `promptGroup` / `promptHint`。
2. **删除** `tooling-section.ts` 中所有客户端工具的硬编码：
   `a2ui_guide` / `cron_guide` / `weixin_send_guide` 的 `TOOL_SUMMARIES` 条目、
   `GUIDE_TOOLS` 中的三项、`app_*` / `screen_record_*` 的前缀判断。
3. `packages/agent-runtime` 从此不含任何客户端专属工具名（符合 AGENTS.md §3 架构边界）。

**验收:** `grep -rn "a2ui_guide\|app_\|screen_record_" packages/agent-runtime/src/prompt`
无结果；bridge 侧守卫测试仍绿。

### P2-T5 删除手写映射表

删掉 `TOOL_SUMMARIES`、`FILE_TOOLS`…`TASK_COMPLETION_TOOLS` 全部常量与 P2-T2 的兜底映射。
守卫测试改为强约束：**任何 `promptGroup` 缺省的工具直接 fail**（不再兜底）。

**验收:** `tooling-section.ts` 行数从 315 降至 ~120；全量测试绿。

---

## 6. 测试策略

| 层级 | 文件 | 覆盖 |
|------|------|------|
| 分组单测 | `prompt/sections/__tests__/tooling-section.test.ts`（新增） | 全覆盖 / 无死键 / 分组不重叠 / Other Tools 为空 |
| 提示词快照 | `__tests__/system-prompt-builder.test.ts`（已存在，需扩） | compact / standard / full 三档各一份快照 |
| 重复计数 | 同上 | §4 P1-T2 表中每项在 fullPrompt 中出现次数断言 |
| 兜底用例 | 同上 | `activeTasks` 为空时 `task_complete` 指令仍存在（P1-T3 风险点） |
| bridge 集成 | `bridge-tool-registrar.test.ts`（扩） | 实际注册的 79 个工具全部有分组 |
| 回归 | `bridge-wiki-tools.test.ts` | `wiki_capture` 下线后不破坏 wiki 链路 |

**命令（在 worktree 内执行）:**

```bash
cd .worktrees/tooling-prompt-drift
pnpm --filter ./packages/agent-runtime test
pnpm --filter ./apps/windows test
pnpm typecheck
pnpm --filter ./apps/windows lint
```

**人工验证（每阶段末）:** `pnpm dev` 起客户端，用 `system_prompt` 工具读回实际提示词，
或在 `docs/temp/` 重新导出一份渲染产物与本次基线（5741 字节 / 31381 字节）对比。

---

## 7. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 削减描述导致模型工具选择变差 | 中 | 逐组削减、每组后跑一轮真实对话冒烟；hint 保留「何时用」而非删空；参数细节本就在 schema 里 |
| P2 改 `MtBotToolConfig` 波及 79 个调用点 | 中 | 两字段全部 `optional`，缺省仍可编译；P2-T2 保留兜底映射，分步落地不退化 |
| `promptGroup` 与 `category` 语义混淆 | 低 | 文档与类型注释明确「category=执行侧、promptGroup=呈现侧」；不复用不合并 |
| P0-T4 browser ref 来源可能根本不存在 | 中 | 任务内置前置核实门；若确认无来源，改为如实描述而非编造，并另开 issue 补 snapshot 能力 |
| `wiki_capture` 下线影响存量会话 | 低 | 工具本已 Disabled，调用即返回拒绝文案；下线只是省 token |
| P1-T3 删 Task Completion 节导致规则丢失 | 高 | 已列为必测用例（无活跃任务兜底）；不通过不合并 |
| 快照测试大面积变更掩盖真实回归 | 中 | 每个 P 阶段独立提交、独立更新快照，禁止跨阶段合并快照变更 |
| **与并行 wiki 开发冲突** | 中 | 本任务在独立 worktree；P0-T6 动 wiki 文件前先 `git fetch` + 视情况 rebase；产物及时提交，不在工作区久留 |

---

## 8. 验收标准

**P0 完成条件**

- [ ] `### Other Tools` 在默认工具集下不出现
- [ ] `grep -rn "nodes\|tts_generate" packages/agent-runtime/src/prompt` 无结果
- [ ] browser 定位指令与真实参数一致，ref 来源可指出具体代码位置
- [ ] 无指向不存在 guide 的指令
- [ ] `wiki_capture` 不在注册表与提示词中
- [ ] Safety 节覆盖 session 清空
- [ ] 漂移守卫测试绿（runtime + bridge 两侧）

**P1 完成条件**

- [x] `## Tooling` 节 5741 → 3287 字节（−43%；≤2600 的严格目标留待更多组折叠，见 note）
- [x] §4 P1-T2 表中每项在 fullPrompt 中仅出现一次（bash 规则、cron_guide、drawer_id、browser 索引已收敛）
- [x] `task_complete` 规则出现 ≤2 次，且无活跃任务时仍有兜底
- [x] `spawn_agent` hint 含 mode 语义；wiki 顺序约束以组注形式可见

**P2 完成条件**

- [ ] `tooling-section.ts` 无任何手写工具名映射表
- [ ] `packages/agent-runtime/src/prompt` 不含客户端专属工具名
- [ ] 新增工具漏配 `promptGroup` 时守卫测试直接失败
- [ ] 全量测试 + typecheck + lint 绿

---

## 9. 不在本计划范围

- 引入 `tool_search` 式的 schema 按需加载（需要改 pi-agent-core 交互协议）
- 重构 `ToolCategory` 现有语义
- 补 browser snapshot 能力（P0-T4 若核实缺失，另开 issue）
- `## Skills` / `## Memory` / `## Task Orchestration` 等非 Tooling 节的内容优化
- MCP 工具分组（`buildMcpSection` 由服务端 hints 驱动，不受本次改造影响）

