# 13 · 开发 Agent 的记忆与会话记录

> 创建：2026-09-16
> 状态：**讨论稿 · 部分拍板 · B1 已落地**（B1 见 §七；A2/A3 待拍板）
> 上位：[12 · 一级公民的积累与演化](./12-一级公民的积累与演化.md)
> 前置事实：另见 [12b](./12b-开发实施计划.md)（工具面收敛、预算守卫）
>
> **已拍板（2026-09-16）**：**A1（Lumii 当 MCP server）暂不做。**
> 判据有三条：① 开发场景的天然共享层是**项目文件**（CLI 本就能读写，`CODE_DEV_PROMPT`
> 也让它先读 `AGENTS.md` / `CLAUDE.md`），而实测 code-dev 名下 5 条记忆里**4 条是项目性的**
> （实施计划路径、测试基线、项目进展、设计决策），本该也大多已经落在项目文件里；
> ② 「读」这一半受 `readView: own` 限制——挂上 MCP 也只能搜到自己名下那几条，要放开得先谈
> 「开发该不该看到用户的全部工作记忆」，那是另一个决策；③ 痛点强度不如 B1（会话记录缺失
> 是用户直接可感知的）。
> **结论**：价值成立但属基础设施投资，需要时再立项；届时建议分两步——先只支持 claude
> 且只读，写能力等只读跑顺再加。

---

## 一、缘起

用户观察：「当前客户端开发 Agent 的会话记录和记忆好像是没有的。」

核实结果：**两样都不是"没有"，但都只在"壳"的层面**——开发 Agent 有会话（5 个）、有记忆
（5 条），可这两样都不是它自己挣来的：记忆全部来自自动分段总结，会话里的执行过程一条没留。

2026-09-16 已提交三笔补上了其中一部分（见 §2.4），本文处理**剩下的两个**，它们恰好都
在用户日常走的那条路上（绑定 CLI，走 ACP）。

---

## 二、现状实测（2026-09-16，本机）

### 2.1 链路形态：不是 ACP 协议，是 spawn CLI + 解析 stdout JSONL

先说清楚这条路的真身，后面几个方案的可行性都由它决定：

`runCodingDevAcpPrompt` → `runLocalAcpCli`（`apps/windows/src/main/coding-dev-local-runner.ts`）
按后端拼命令行 `spawn` 出去，读 stdout 逐行喂 `AcpToolStreamParser`：

| 后端 | 命令行（实测 `--help` 与源码一致） |
|---|---|
| claude | `claude -p --output-format stream-json --verbose [--resume <id>]`，prompt 走 **stdin** |
| codex | `codex exec [resume <id>] --skip-git-repo-check --json <prompt>` |
| cursor | `cursor-agent --output-format stream-json --trust [-p <prompt>]` |
| opencode | `opencode run [--session <id>] --format json <prompt>` |

关键性质：

- **单向双通道**：Lumii → CLI 只有 prompt（stdin 或 argv），CLI → Lumii 只有 stdout 流 +
  stderr。**没有任何反向 RPC**，Lumii 无法在 CLI 干活途中与它交互。
- **spawn 时不注入任何额外配置**：`env: { ...process.env }`，没有 MCP、没有 Lumii 的工具面。
  这就是为什么 `CODE_DEV_DEF.tools` 里那份白名单在这条路上**完全不参与**。
- **多轮上下文靠 CLI 自己的会话**：`--resume <cliSessionId>`，Lumii 只存一个 id
  （`runtime_state` 的 `acp-session:<backend>:<sessionKey>`）。

### 2.2 缺口 A：开发 Agent 写不了工作记忆

`handleUserSend` 在 ACP 分支直接 `controller.startRun(...)` 返回，不经过 AgentInstance：

| 记忆通道 | 内核兜底档 | ACP 路径 |
|---|---|---|
| `memory_manage` / `memory_search` 工具 | ✅ 已补（`6471678d`） | ❌ CLI 没有这些工具 |
| autoExtract（`MemoryIntegration`） | ✅ 按 turnCount 节流 | ❌ 整条链路不经过它 |
| 分段总结（`SegmentMemoryPipeline`） | ✅ | ✅ 走 `observeUserTurn`，与路径无关 |

所以开发 Agent 名下的 5 条记忆**全部**来自分段总结，且段的 `close_reason` 清一色是
`app_quit`——它们是应用退出时才被强制关闭并总结的，不是干活时自然沉淀的。

而两侧提示词都把「开发记代码任务」当作既定事实：`CHRONICLER_PROMPT` 的取数来源写着它，
`SYSTEM_KEEPER_PROMPT` 的跨 Agent 去重素材也把它算在内。**这一块一直是空的。**

### 2.3 缺口 B：工具过程不落库 ✅ **已由 B1 解决**（`2a10df7c`，见 §七）

ACP 路径下的 assistant 消息由 `AcpRunController.persistAssistantMessage` 落库，只写
`{ type: 'text', text }` —— 工具调用、思考过程**只推事件给渲染层**（`agent:tool:start/end`），
从不写库。对比内核路径落的是完整的 `assistant_parts`。

后果：重启客户端后，开发会话里只剩「用户提问 + 一段总结」，看不到它改过哪些文件、跑过什么
命令。同一个会话里两种格式混着，肉眼就能分辨哪几轮是 CLI 干的（`b17abc42` 实测）。

**但数据其实一直在手里**——ACP 的工具事件是结构化的：

```ts
// coding-dev-backends-stub/contracts.ts:47
type CodingDevToolProgress = { toolCallId; toolName; phase: 'start'|'progress'|'end'; args?; result?; isError? }
```

与落库目标几乎一一对应（`packages/agent-runtime/src/storage/assistant-parts.ts:6`）：

| AssistantPart(tool) | CodingDevToolProgress | 备注 |
|---|---|---|
| `id` | `toolCallId` | ✅ |
| `name` | `toolName` | ✅ 解析器还额外做了 id→name 回填 |
| `args` | `args` | ✅ |
| `result` / `isError` | `result` / `isError` | ✅ |
| `status: running\|done\|error\|interrupted` | `phase: start\|progress\|end` | 需映射 |

渲染层也早就能解析 `assistant_parts`（内核路径在用，`conversation-commands.ts` 有共享 parser）。

### 2.4 今天已解决的部分（不在本文范围）

| 提交 | 解决什么 | 边界 |
|---|---|---|
| `6471678d` | 开发 Agent 工具面补 `memory_manage` + `memory_search` | **只在无 CLI 绑定的内核兜底档生效** |
| `347f47da` | 工作记忆页可辨来源 Agent（筛选条 + 徽标） | 让「开发名下有什么」第一次看得见 |
| `a6a98eba` | `/memory` 命令读错返回结构（恒报「没有记忆」） | — |

第 1 条**没有**解决 §2.2 —— 用户日常绑 claude，走的是 ACP。

### 2.5 MCP 可行性实测

方案 A1 依赖「给 CLI 挂 MCP」，逐家实测（`--help`）：

| CLI | MCP 入口 | 证据 |
|---|---|---|
| claude | `--mcp-config <configs...>` | ✅ 本机 `claude --help` |
| codex | `codex mcp` 子命令；`-c/--config key=value` 覆盖配置 | ✅ 本机 `codex --help` |
| opencode | `opencode mcp` 子命令 | ✅ 本机 `opencode --help` |
| cursor | **未实测**——本机未安装 `cursor-agent`，`--help` 拿不到 | ⚠️ |

Lumii 自身：只有 **MCP client**（`packages/agent-runtime/src/tools/mcp/mcp-client.ts`，531 行，
**自研实现**，未依赖官方 SDK），仓库里**没有 server 端**。

---

## 三、方案对比

### 3.1 缺口 A：让开发 Agent 能写工作记忆

**A1 · Lumii 当 MCP server，spawn 时把配置挂给 CLI**

- 做什么：写一个 stdio JSON-RPC server，把工作记忆的读写（至少 `memory_manage` /
  `memory_search`）暴露成 MCP 工具；`runLocalAcpCli` 按后端注入配置（claude 用
  `--mcp-config`，codex/opencode 写各自 config，cursor 待定）。
- 成本：**大**（server ~300 行 + 四家注入方式 + 权限模型 + cursor 待实测）
- 覆盖：**最全** —— CLI 在干活途中随时读写，粒度最好；不依赖模型自觉
- 风险：把写权限交给外部进程；四家配置方式各异且会随 CLI 版本漂移，是长期维护面
- 未决：Lumii 的 MCP server 要不要只用官方 SDK（引入新依赖）还是照 client 自研

**A2 · 宿主代写（转交完成时落一条）**

- 做什么：`dev-handoff-executor.ts` 的 `reportToOriginSession` 已经是收尾钩子，手上就有
  提案摘要与开发会话的最终回复；在那里往工作记忆写一条 `project` 类条目。
- 成本：**小**（一处接线 + 内容组装 + 去重/节流考虑）
- 覆盖：**窄** —— 只覆盖「主助手转交」这条路。用户直接在开发会话里聊的场景
  （库里 `bbbc46e7`「按评审修订 07-新手指引.md」、`4989e96f`「评审07新手指引方案」看着都是）
  覆盖不到
- 风险：低。但记的是二手摘要，**过程细节丢失**——这与 §2.3 是同一个问题的两面

**A3 · 让 CLI 自己调 `lumii-ui` 写**

- 做什么：给 `lumii-ui` 加记忆写入命令，扩 `command-allowlist`（现全是只读：list / search /
  stats / provenance / archive-cold / unarchive / rebuild-index），再在 `CODE_DEV_PROMPT`
  里教 CLI 用它。
- 成本：**小-中**（CLI 命令 + 白名单评审 + 提示词）
- 覆盖：所有 CLI 场景（不限转交）
- 风险：**依赖模型主动性**。12 文档刚记录过这个失败模式（「记忆靠提示词偶然写几条」，
  情报的 5 条就是这么来的）。另外白名单开写权限 = 给外部进程一条往记忆库写任意内容的通道，
  超出技术选择，属安全边界决策

### 3.2 缺口 B：让工具过程落库

**B1 · run 结束时组装 `assistant_parts`**

- 做什么：`AcpRunController` 在 `handleToolProgress` 里收集 start/end（现在只用于算时长与
  定位文本位置），run 收尾时组装成 `AssistantPartsContent`，`persistAssistantMessage` 换格式。
- 成本：**中**（收集 + 组装 + `phase→status` 映射 + 与渲染层共享 parser 对齐 + 测试）
- 收益：重启后能看到工具卡片；**更关键的是记忆提取的素材从"一段总结"变成"过程"**
- 风险：格式不一致会让渲染异常——但现有 `assistant_parts` 路径已被大量使用，且有测试兜底

**B2 · 只拼一条「改了哪些文件、跑了什么命令」的摘要文本**

- 成本：小；收益也小。属于 B1 的残次版，除非目标只是"让用户看得见"而不求"存得下"

---

## 四、推荐与理由

**B1 先做 → A2 紧跟。A1 暂不做（已拍板，理由见文首），A3 不推荐。**

- **B1 先做**：这两个缺口里唯一「数据已经齐、只差组装」的，且它让开发会话的痕迹第一次
  完整留存。A2 若要落地，也因为 B1 才有据可查。
- **A2 紧跟**：最小成本让「转交」这条路径立刻闭环，风险低。它的窄覆盖是已知取舍，不是缺陷
  ——转交恰恰是主助手主动派活的主路径。
- **A1 暂不做**：真正的解，但见文首的三条判据——共享层已有项目文件、读受 readView 限制、
  紧迫性不如 B1。留作基础设施投资。
- **A3 不做**：把「模型会不会主动记」当成机制依赖，12 文档已经证明过它不可靠；且白名单
  开写权限是需要单独论证的安全决策，不该混在能力补全里顺手做。

三件事互相独立，可各自提交、各自回滚。

**顺序上的一个额外好处**：B1 完成后，A2 写下的记忆可以带 `source_message_id` 指回开发会话
的具体回合——凭据链是完整的；反过来先做 A2，会留下一批"无据可查"的记忆条目。

---

## 五、待拍板

| # | 事项 | 状态 / 选项 |
|---|---|---|
| 1 | ~~A1 做不做~~ | ✅ **已拍板：暂不做**（2026-09-16，理由见文首） |
| 2 | A1 的 MCP server 实现方式 | ⏸ 随 A1 一并搁置（届时再定：引官方 SDK / 照 client 自研） |
| 3 | A3 的白名单 | 待定（本文推荐不开；A3 不做则不涉及） |
| 4 | ~~是否先做 B1~~ | ✅ **已落地**（`2a10df7c`，见 §七） |
| 5 | A2 写记忆的粒度与节流 | **待拍板**（每次转交都写 / 仅成功时写 / 带节流） |

---

## 六、证据与未实测项

**已实测**：四家 CLI 的 MCP 入口（claude/codex/opencode 三家 `--help`；cursor 本机未安装）；
`lumii-ui` 的 memory 命令面（`commands.mjs`）；`command-allowlist.ts` 的默认拒绝语义与
现有记忆条目；ACP 工具事件字段与 `AssistantPart` 的对应关系（两侧类型定义实读）；
`b17abc42` 会话里两种落库格式并存。

**未实测 / 待核实**：

- cursor 的 MCP 支持与配置方式（本机未安装）
- codex / opencode 的 MCP 配置是写入全局 config 还是可按进程覆盖——若只能写全局，A1 会
  污染用户的 CLI 配置，需要另想注入方式
- ~~`phase: 'progress'` 在落库时如何表示~~ → **B1 已定**：只收集 start/end，progress 是流式
  中间态，`AssistantPart` 没有对应态，直接丢弃
- ~~`textPositionAtStart` 能否还原交错顺序~~ → **B1 已定**：不做交错，理由见 §七

**相关**：[[12b]] 的工具预算守卫——若 A1 落地，给 code-dev 加工具需同步改
`packages/agent-runtime/src/agent/builtin/__tests__/tool-budget.test.ts` 的预算并说明理由。

---

## 七、实施记录

### B1 ✅ 工具过程落库（提交 `2a10df7c`）

`AcpRunController` 在 `handleToolProgress` 里把 start/end 收集成 `CollectedToolCall`，run
收尾时组装成 `assistant_parts`（与内核路径同格式），三处落库点（成功 / 中止 / 失败）都带上
已收集的工具。原先 `AcpRunHandle` 上那个只服务于耗时计算的 `toolStartTextPositions` 并入
`CollectedToolCall`。

**三个决定**（都是查证后定的，不是拍脑袋）：

1. **工具在前、正文在后，不做交错**。正文取自 CLI 的 `final_result`（`runLocalAcpCli` 的
   `finalResult ?? messageTexts`），与流式 message **不同源**——拿流式累积的
   `textPositionAtStart` 去切它必然错位。而渲染层的 `splitProcessAndAnswer` 本来就是
   「最后一个工具之后才算答案区」，这个顺序正好落在它的预期里（过程折叠、答案外露）。
2. **没等到 end 的工具落成 `interrupted`**，与渲染层 `finalizeAssistantParts` 的映射一致
   （`08-委托可见性` §5 正是为这个加的），否则重启后卡片会显示成「还在跑」。
3. **正文为空也落库**：失败与中止时过程本身就是最有价值的信息。

**顺带修一个 bug**：工具耗时此前取的是 `toolStartTextPositions`（存的是**文本位置**），用
`Date.now()` 去减它得到天文数字，而渲染层 `formatDuration` 优先采信后端值——工具卡片的
耗时一直是错的。

**真机验证**（重启客户端 → 建 code-dev 会话并把会话级 dev-context 指向 claude → 发一条
「用 bash 执行 ls」）：

| | assistant 消息的 `content_json` |
|---|---|
| 改前 | `{ type: 'text', text: '…' }` |
| 改后 | `{ type: 'assistant_parts', parts: [ {type:'tool', name:'PowerShell', status:'done'}, {type:'text', …} ] }` |

**验证时踩到的一个约束**（对以后的验证有用）：`lumii-ui` 的控制口**不允许向 composer
注入文本**（`act --action type` 返回 `blocked_composer`），而 `send` 是绕过渲染层直达主进程
的——所以「斜杠命令」类功能无法用 CLI 验证。反过来，**给会话配 ACP 后端可以绕开这个限制**：
`dev-context.json` 每次读取都走文件（无缓存），直接往里写一条 `{backendId:'claude'}` 即可，
不必重启。

**遗留**：ACP 的工具 result 目前是短摘要（`File written: …`），与内核路径的完整 result
（实测最大单条 14KB、整条消息 750KB）不同——这是 CLI 输出形态决定的，不是本次引入的问题。
