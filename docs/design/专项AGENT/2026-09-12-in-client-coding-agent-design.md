# 客户端内编程 Agent — 设计

> 日期：2026-09-12
> 状态：v1 方案草案（P0 待实测回填）
> 目标：用户在客户端发消息，直接驱动本机 claude / codex / cursor / opencode CLI 修改代码，且有一个专用 Agent 承载这一能力
> 相关：`apps/windows/src/main/coding-dev-*.ts`、`apps/windows/src/main/ipc/agent-runtime/user-commands.ts`、`packages/agent-runtime/src/agent/`、`apps/windows/src/renderer/pages/AgentsPage/`
> 参考：`docs/design/2026-09-09-user-presence-channel-design.md`（文档体例）

---

## 0. 结论摘要

| 问题 | 结论 |
|------|------|
| 要不要做「双层 Agent」（Lumii Agent 内部调用 CLI 工具） | **不做**。专用 Agent 是 ACP 会话的**身份与配置载体**，消息直达 CLI，不经过第二层 LLM 循环（§1.2） |
| 专用 Agent 如何定义 | 走**本机绑定配置**（`AgentDevBinding`），不扩展 `AgentDefinition` schema（§3.3） |
| 绑定配置存哪 | `~/.lumii/config/app.json` 的 `AppConfig.codingDevAgentBindings`，与 `codingDevProjects` 并列 |
| 会话如何进入编程模式 | `handleUserSend` 增加一条路由分支：会话绑定的 agent 有 dev binding → 走 ACP（§5.2） |
| 工作目录如何做到 per-agent | `AcpRunController.startRun` 补传 `cwd`；`runCodingDevAcpPrompt` 早已支持该参数（§5.3） |
| 用户入口 | **已存在**。ChatPage 支持选 Agent 开对话（`ChatPage.tsx:844`），AgentsPage 有「发起对话」指令 |
| 优先级 | P0 零代码验证 → P1 骨架（3 处改动）→ P2 入口与提示词 → P3 打磨 |
| 最大风险 | CLI 非交互模式下的**权限策略**与**自改代码的生效闭环**，两者都必须 P0 实测（§4.2） |

---

## 1. 背景

### 1.1 需求

用户希望在 Lumii 客户端里聊天，消息驱动的不是内置 Agent，而是本机已安装的编程 CLI（Claude Code / Codex / Cursor / OpenCode），用来**修改 Lumii 自身的代码**（自举），也支持任意本地项目。期望有一个「专用 Agent」承载这件事，而不是每次手动切换后端。

### 1.2 一个反直觉的结论：不要做双层 Agent

直觉方案是「新增一个 Agent + 一个封装 CLI 的工具」，让 Agent 自主调用。**本设计不采用**，理由：

1. **流式体验会降级**。需求是「CLI 输出流式直显」。ACP 管线（`AcpRunController` → JSONL 解析 → `agent:message:delta` / `agent:tool:start` 事件）已经把这套做完了，工具化会把 CLI 输出降级成「工具结果卡片」。
2. **Token 与延迟翻倍**。CLI 的输出要先回到外层 Agent 的上下文，再由外层转述给用户，等于两次 LLM 处理；长任务还会撑爆外层上下文，必须裁剪，而裁剪就会丢信息。
3. **「专用 Agent」的真实诉求是身份，不是第二层循环**。用户要的是：一个明确的角色、一个默认配置（改哪个目录、用哪个 CLI）、一个入口。这些都不需要额外的 LLM 循环。

因此：**专用 Agent = ACP 会话的身份 + 默认配置 + UI 入口**。Lumii 侧的 Agent 运行时不参与这条链路（沿用现状，见 §2.1）。

---

## 2. 代码事实核查

> 以下基于仓库当前代码，每条注明来源。

### 2.1 已有能力（本设计的地基）

| 能力 | 代码证据 | 结论 |
|------|---------|------|
| 四类 CLI 后端枚举 + 标签 | `coding-dev-backends-stub/contracts.ts:8` `CODING_DEV_BACKEND_IDS = ['lumii','cursor','claude','codex','opencode']` | 后端模型完整 |
| CLI 探测 / 版本 / 安装 | `coding-dev-cli-detect.ts`（`PRIMARY_LOCAL_ACP_TOOLS`、`where.exe`）、`coding-dev-cli-version.ts`、`coding-dev-cli-install.ts` | 无需新增 |
| 非交互调用参数 | `coding-dev-local-runner.ts:44` `buildLocalCliArgs`：claude `-p … stream-json`、codex `exec --json`、cursor `-p --trust`、opencode `run` | 有扩展点 |
| spawn + 流式 JSONL 解析 | `coding-dev-local-runner.ts:76` `runLocalAcpCli`；解析器 `coding-dev-jsonl-parsers.ts` | 无需改动 |
| Run 生命周期（超时/中止/落库/进度事件） | `coding-dev-acp-run.ts:74` `AcpRunController.startRun`，默认超时 1h（`acp-config.ts:9`） | 需加 `cwd` |
| **聊天消息触发 ACP** | `user-commands.ts:197-218`：`getBackendWithFallback` 非 `lumii` → `controller.startRun()` | **路由已存在**，只需加分支 |
| 后端选择持久化（per-peer → user-global → 默认） | `channel/acp-backend-manager.ts:68` `getBackendWithFallback`；`backend-selection.ts` | 可复用 |
| 斜杠命令切换后端 | `weixin-channel-adapter.ts:638-643`（`/claude` `/codex` `/cursor` `/opencode` `/lumii`） | 可复用 |
| 工作目录解析与注入 | `coding-dev-env.ts:36` `resolveCodingDevAcpWorkspacePath`；`:55` `applyCodingDevAcpEnvToProcess` 写 `MTBOT_*_ACP_CWD` | 全局，需 per-run |
| **`cwd` 参数已支持** | `run-coding-dev-acp-prompt.ts:33` 读 `params.cwd`，回退 `process.env.MTBOT_*_ACP_CWD` | **扩展点现成** |
| 项目注册（含外部目录 junction） | `coding-dev-projects.ts:70` `openExistingProject`（Windows 无需管理员权限） | 可复用 |
| 会话 ↔ Agent 绑定 | `conversationRepo.getAgentParticipantId(sessionKey)`（`agent-runtime-ipc.ts:665` 调用） | 现成的查询入口 |
| UI 选 Agent 开对话 | `ChatPage.tsx:844` `handleNewConversation(agentId)` → `conversation:create`（`conversation-commands.ts:91`） | **入口已存在** |
| Agent 定义解析（四级缓存） | `definition-store.ts:84` `get(id)`：内存 → SQLite → API → 内置兜底 | 无需改动 |
| Agent 管理 UI | `AgentsPage/`（`AgentFormModal` 分类/模型/路由/技能字段）、`electronAPI.api.updateAgent/forkAgent` | 可扩展 |
| 本机配置读写 | `config-manager.ts:23` `ConfigManager`，`updateAppConfig`（`:186`）；`types.ts:22` `AppConfig` | 扩展点 |

### 2.2 缺口

| 缺口 | 现状 | 影响 |
|------|------|------|
| **Agent → CLI 后端的绑定** | 后端选择挂在「会话」上（`sessionKey`）或用户全局，与 Agent 无关 | 专用 Agent 无从「自带」CLI |
| **per-run 工作目录** | `startRun` 不传 `cwd`（`coding-dev-acp-run.ts:130`），走进程级环境变量 | 无法「这个 Agent 改 A 项目，那个改 B 项目」 |
| **CLI 侧系统提示词注入** | `buildLocalCliArgs` 只传用户 prompt | 无法让 CLI 知道「你在改 Lumii，仓库结构是…」 |
| **配置 UI** | 只能全局切后端和活动项目 | 用户无法把「某 Agent + 某目录 + 某 CLI」固化成配置 |
| **自改生效闭环** | 无 | 改完源码不重启/重载不生效，用户困惑 |

### 2.3 须修正的认知

- **`bundled-skills/代码开发/coding-agent/SKILL.md` 是 MtBot 时代的遗留资产**。它假设 bash 工具支持 `pty:true` 与 `process` 工具族（`action:log/poll/submit`），但 Lumii 的 `local-bash.ts:45` `executeLocalCommand` 是纯 `spawn`，无 PTY、无 process 工具。**不要照它实现**。其中仍有效的部分：`workdir` 聚焦目录、进度更新节奏、Codex 需要 git 仓库两点。
- `IMPLEMENTED_CODING_DEV_BACKEND_IDS` 当前等于全部后端 ID（`contracts.ts:16`），即四个 CLI 都已实现，不存在「预留未实现」的后端。
- ACP 链路与 Agent 运行时**完全解耦**：`bridge.ts` 中没有任何 `acp` / `codingDev` 引用，ACP 是 IPC 层的旁路。这是本设计选择「不改 Agent 运行时」的前提。

---

## 3. 总体设计

### 3.1 核心概念

**开发会话（Dev Session）**：一个绑定了「开发 Agent」的普通会话。其特殊性在于：

- 该 Agent 在本机配置里有一条 **dev binding**（CLI 后端 + 工作目录）
- 该会话的所有用户消息**绕过内置 Agent**，直达 CLI
- CLI 的流式输出以原生方式回显在聊天界面（工具卡片 + 消息气泡）

**专用 Agent**：一个普通的 `AgentDefinition`（可由用户在 AgentsPage 创建，或 fork 系统 Agent 修改），额外在本机配置里挂一条 binding。Agent 定义本身不承载任何 ACP 语义。

### 3.2 数据流

```
用户在 AgentsPage 选中「灵栖开发」agent → 发起对话
  └─ conversation:create { agentId }  (conversation-commands.ts:91)
     └─ conversation_participants 落库 (participant_type='agent')

用户发消息
  └─ user:send { sessionKey }  (useAgentRuntime.ts:169)
     └─ handleUserSend  (user-commands.ts:85)
        ├─ [新增] agentId = conversationRepo.getAgentParticipantId(sessionKey)
        ├─ [新增] binding = resolveAgentDevBinding(agentId)   ← 查本机配置
        ├─ binding 命中 ──┐
        └─ 未命中 ────────┴─→ 现有手动切换逻辑（保持不动）
                          │
                          └─→ AcpRunController.startRun({ backendId, cwd: binding.workspace })
                              └─ runCodingDevAcpPrompt({ cwd })  ← 已支持
                                 └─ runLocalAcpCli → spawn CLI(cwd)
                                    └─ JSONL 流 → emitProgress
                                       └─ 事件回放：message:delta / tool:start / tool:end
                                          └─ 渲染进程聊天界面（流式直显）
```

### 3.3 为什么绑定配置放本机配置，而不是 `AgentDefinition`

`AgentDefinition` 的权威数据源是 api-server 的 `system_agents` 表（`agent-definition.ts:246-258`）。若把 `devRuntime` 加进定义，需要同时改动 api-server 的 schema、seed、mapper 与客户端缓存，且下列数据**本来就不该跨设备同步**：

| 字段 | 性质 | 放服务端的问题 |
|------|------|--------------|
| `workspace`（工作目录） | 本机绝对路径 | 换设备即失效（`E:\...` vs `/Users/...`） |
| `backendId`（CLI 后端） | 本机已安装的 CLI 决定 | A 机器装了 Codex、B 机器没装 |
| `enabled` | 本机偏好 | 无关同步 |

结论：**配置归属本机**，`AgentDefinition` 只提供「身份」（名称、提示词、分类），binding 只提供「本机怎么跑」。

代价：Agent 与 binding 是弱关联（靠 agentId 字符串）。Agent 被删除时 binding 成为孤儿，需在读取时忽略（不做级联清理，避免耦合）。

---

## 4. P0 — 最小闭环验证（零代码）

**目标**：在不写任何代码的前提下，验证整条链路能否走通，并把「坑」提前暴露。产出直接决定 P1 是否需要调整。

### 4.1 操作步骤

1. 设置面板 → 开发类 AI 工具 → 「打开已有项目」，把 Lumii 仓库目录（如 `E:\my-project\open-source\lumii`）注册为项目（走 `openExistingProject`，junction 挂载，无需管理员权限）
2. 将其设为**活动项目**（`codingDevActiveProject`），使 `MTBOT_*_ACP_CWD` 指向该目录
3. 在对话中用 `/claude` 切换到 Claude Code 后端
4. 发送一条低风险任务，例如：`读一下 packages/agent-runtime/src/agent/builtin/definitions.ts，把 ASSISTANT_DEF 的 maxTurns 从 80 改成 81`
5. 验证：`git diff` 是否出现预期改动；聊天界面是否流式显示了工具调用与文本

### 4.2 必须验证的问题（P1 设计依赖这些答案）

| # | 问题 | 为什么关键 | 若答案不利的应对 |
|---|------|-----------|----------------|
| 1 | 非交互模式下 CLI 的**权限策略**如何？改文件是否需要额外 flag（如 claude 的 `--permission-mode`、codex 的 `--full-auto`）？ | 若 CLI 因权限提示挂起，整条链路不可用 | P1 在 `buildLocalCliArgs` 增加权限参数；或接入 Lumii 权限闸门做前置确认 |
| 2 | CLI 能否正确处理**多行 / 长 prompt**？ | `quoteForCmd`（`coding-dev-local-runner.ts:37`）注释指出：`.cmd`/`.bat` shim（如 cursor 的 `agent.cmd`）会截断到第一行 | 改为通过 stdin 传 prompt（该注释已标记为待办） |
| 3 | 任务耗时是否超出默认 1h 超时？ | `acp-config.ts:9` 默认 3600000ms | 调整 `MTBOT_ACP_TIMEOUT_MS`，或按 Agent 配置超时 |
| 4 | CLI 是否尊重 `cwd`？是否会在父目录乱翻？ | 影响「聚焦」效果与安全边界 | 提示词中显式约束；必要时用 git worktree 隔离 |
| 5 | **改完源码如何生效**？ | Electron 主进程改动需重启，渲染进程可能热重载 | P3 设计生效闭环；提示词中告知 Agent 这一点 |
| 6 | Codex 在非 git 目录是否拒绝运行？ | `buildLocalCliArgs` 已带 `--skip-git-repo-check`（`:57`），需实测是否足够 | 保留该 flag 或要求目标目录是 git 仓库 |
| 7 | 各 CLI 是否支持注入 system prompt？ | 决定 P2 提示词注入的实现方式 | 不支持的退化为 prompt 前缀 |

### 4.3 产出

- 一份实测结论（回填至 §4.2 表格）
- 确认或修正 P1 的改动范围
- 已知坑清单，用于 P2 提示词与 UI 文案

---

## 5. P1 — 专用 Agent 骨架（核心）

三处改动，构成最小可用闭环。

### 5.1 本机绑定配置

**位置**：`apps/windows/src/main/config/types.ts`

```ts
/** 开发类 Agent 的本机绑定：把一个 Agent 身份接到某个 CLI 与工作目录 */
export interface AgentDevBinding {
  /** 对应的 AgentDefinition.id */
  agentId: string
  /** 本机 CLI 后端 */
  backendId: 'claude' | 'codex' | 'cursor' | 'opencode'
  /**
   * 工作目录绝对路径。
   * 缺省时回退到现有全局解析：codingDevActiveProject → codingDevAcpWorkspace → workspaceDirectory
   */
  workspace?: string
  /** 是否启用（停用后该 Agent 退回普通对话） */
  enabled: boolean
}

export interface AppConfig {
  // ... 现有字段
  /** 开发类 Agent 绑定列表 */
  codingDevAgentBindings?: AgentDevBinding[]
}
```

读写沿用 `ConfigManager.updateAppConfig`（`config-manager.ts:186`）。

**解析函数**（新增，建议置于 `coding-dev-env.ts`，与现有 cwd 解析同址）：

```ts
export function resolveAgentDevBinding(
  appConfig: AppConfig,
  agentId: string | undefined,
): AgentDevBinding | undefined {
  if (!agentId) return undefined
  return appConfig.codingDevAgentBindings?.find(
    (b) => b.agentId === agentId && b.enabled,
  )
}
```

### 5.2 会话路由

**位置**：`apps/windows/src/main/ipc/agent-runtime/user-commands.ts:197`

现有逻辑：

```ts
const currentBackend = acpMgr.getBackendWithFallback(LOCAL_USER_ID, command.sessionKey)
if (currentBackend !== DEFAULT_CODING_DEV_BACKEND_ID) {
  // → ACP
}
```

改为（伪代码，保持现有分支不动，仅前置一条新分支）：

```ts
// 1. [新增] Agent 绑定优先：专用开发 Agent 自带后端与目录
const agentId = bridge.conversationRepo.getAgentParticipantId(command.sessionKey)
const binding = resolveAgentDevBinding(getAppConfig(), agentId)

// 2. 手动后端切换（现有逻辑）
const manualBackend = acpMgr.getBackendWithFallback(LOCAL_USER_ID, command.sessionKey)

const effectiveBackend = binding?.backendId
  ?? (manualBackend !== DEFAULT_CODING_DEV_BACKEND_ID ? manualBackend : undefined)

if (effectiveBackend) {
  void controller.startRun({
    runId, sessionKey, backendId: effectiveBackend, text: command.content,
    instanceId, bridge,
    cwd: binding?.workspace,          // [新增] per-run cwd
    pushEvent: (event) => { /* 现有实现不变 */ },
  })
  return { runId }
}
// 3. 主 Agent 路径（现有逻辑不变）
```

**优先级决策**：binding > 手动切换。理由：binding 是用户为该 Agent 显式固化的配置，应压过会话级的临时切换。

**边界**：
- binding 的 `backendId` 对应的 CLI 未安装时，`runLocalAcpCli` 会抛错（`coding-dev-local-runner.ts:88-95` 已有友好提示），错误经 `startRun` 的 catch 转为聊天消息（`coding-dev-acp-run.ts:219-238`）。无需额外处理。
- 用户想临时改回主 Agent 时，现有 `/lumii` 斜杠命令仍可用——但会被 binding 压制。**取舍**：binding 命中时是否仍允许 `/lumii` 覆盖？建议 **允许**（会话级显式指令 > Agent 默认配置），实现为在 `getBackendWithFallback` 命中显式选择时跳过 binding。此点在评审时确认。

### 5.3 per-run 工作目录

**改动 1**：`coding-dev-acp-run.ts`

```ts
export type AcpRunStartOptions = {
  // ... 现有字段
  /** 本次 run 的工作目录；缺省走 MTBOT_*_ACP_CWD 全局解析 */
  cwd?: string
}
```

在 `startRun` 内传给 `runCodingDevAcpPrompt({ ..., cwd: opts.cwd })`（当前 `:130-138` 未传）。

**改动 2**：无需改动。`run-coding-dev-acp-prompt.ts:33-39` 已是「显式 `cwd` → 环境变量 → `process.cwd()`」的优先级链。

**cwd 完整优先级**（最终形态）：

```
binding.workspace                    ← 新增（Agent 级）
  → codingDevActiveProject.realPath  ← 现有（全局活动项目）
  → codingDevAcpWorkspace            ← 现有（已废弃字段，保留回退）
  → workspaceDirectory               ← 现有（主工作区）
  → <mtbotDataDir>/workspace         ← 现有（兜底）
```

### 5.4 改动清单

| 文件 | 改动 | 规模 |
|------|------|------|
| `config/types.ts` | 新增 `AgentDevBinding` 接口 + `AppConfig.codingDevAgentBindings` | +15 行 |
| `coding-dev-env.ts` | 新增 `resolveAgentDevBinding` | +10 行 |
| `coding-dev-acp-run.ts` | `AcpRunStartOptions.cwd` + 透传 | +3 行 |
| `user-commands.ts` | 路由分支 + `cwd` 传参 | +20 行 |
| 测试 | `coding-dev-env.test.ts` 补 binding 解析用例；`user-commands` 路由分支用例 | 新增 |

**总计约 50 行生产代码**。P1 不含任何 UI 改动——配置可先用 `~/.lumii/config/app.json` 手改验证。

---

## 6. P2 — 入口与身份

### 6.1 配置 UI

**首选落点**：`SettingsPage/components/CodingDevAcpPanel`（已有 CLI 检测、项目管理的完整面板），新增「Agent 绑定」区：

- 列出所有 `sourceType ≠ 'system'` 或 `category === 'coding'` 的 Agent（数据源：`agent:definitions:list`）
- 每行：Agent 选择器 + CLI 后端下拉（复用 `CODING_DEV_BACKEND_LABELS`）+ 工作目录选择器（复用 `workspace-ipc.ts` 的目录选择）+ 启用开关
- 复用现有的 CLI 安装状态提示（`coding-dev-cli-detect` 结果）

**次选落点**：AgentsPage 的 Agent 详情面板加「开发运行时」区。优点是位置直觉（在 Agent 上配 Agent），缺点是重复实现 CLI 检测/目录选择。**建议先做首选**。

### 6.2 系统提示词注入

目标：让 CLI 知道「你在改 Lumii 仓库，它的结构是…，完成后请…」。分三步，逐级降级：

| 方式 | 实现 | 覆盖后端 | 备注 |
|------|------|---------|------|
| CLI 原生 flag | `buildLocalCliArgs` 增参数：claude 用 `--append-system-prompt` | 待实测（§4.2 #7） | 最优，不污染用户消息 |
| prompt 前缀 | 把上下文拼在 `params.text` 前 | 全部 | 通用但有污染，需在回显剥离逻辑（`stripUserEcho`, `coding-dev-acp-run.ts:66`）中处理 |
| 不注入 | 仅靠 binding 的 `workspace` 提供上下文 | — | 兜底 |

推荐：**先做 flag（claude 已验证后再扩其他），其余后端走 prompt 前缀**。

提示词内容建议包含：
- 「你在一个 Lumii 客户端仓库中工作，技术栈 pnpm workspace + Electron + TypeScript」
- 「提交前请运行 `pnpm typecheck` 与相关包测试」（对齐 `AGENTS.md` 第 6 条）
- 「修改主进程代码后需要重启应用才生效」

### 6.3 内置 Agent 兜底

在 `packages/agent-runtime/src/agent/builtin/definitions.ts` 增加一个 `builtin:dev` 定义（名称如「灵栖开发」，`category: 'coding'`），作为离线兜底。

**注意**：该文件的架构约束（`definitions.ts:7-24`）明确指出「权威数据源 = api-server `system_agents` 表」，本地仅作离线镜像，且**修改必须同步 api-server 的 `DEFAULT_SYSTEM_AGENTS`**。因此：

- 若接受跨仓库改动 → 两端同步添加
- 若只想动客户端 → **不新增内置 Agent**，改为引导用户在 AgentsPage 自建（UI 已支持，`AgentFormModal` + `api.updateAgent`）

**推荐**：P2 阶段先用「用户自建 Agent + 一条 binding」跑通，内置定义等 api-server 侧排期时再补。

---

## 7. P3 — 打磨

### 7.1 权限与安全

当前 ACP 链路**不经过** Lumii 的权限闸门（`permission-gate-hook.ts:54`、`permission-controller.ts:35`）——CLI 有自己的权限系统。分层策略：

| 层级 | 机制 | 状态 |
|------|------|------|
| CLI 内层 | claude/codex 自己的权限模式 flag | P0 实测后确定 |
| Lumii 外层 | 启动前弹确认（「即将用 Claude Code 修改 `<workspace>`，是否继续」） | P3 可选 |
| 路径约束 | `binding.workspace` 限定范围；复用 `tool-sandbox.ts:22` 的 allowedDirectories 思路 | P3 可选 |

**高风险点**：自改代码意味着 CLI 可以修改 Lumii 自身。若 `workspace` 配置错误指向用户其他项目，破坏面很大。P3 应在启动前校验 `workspace` 存在且是 git 仓库（有 `.git`），否则二次确认。

### 7.2 自改生效闭环

改完源码不生效是自举场景的核心体验问题。方案：

1. **提示词告知**（P2 已含）：让 Agent 在完成后主动说明「需要重启应用」
2. **检测变更**：run 结束后 `git status --porcelain` 检查是否有改动，有则在消息末尾附加提示
3. **一键重启**（可选）：聊天消息上提供「重启应用」按钮，走 `app.relaunch()` + `app.exit()`

### 7.3 多会话并行与并发

- `AcpRunController` 已用 `Map<runId, handle>` 支持多 run 并行，`abortRun`/`abortSession` 已按 runId/sessionKey 精确中止
- `SessionManager.promptLocks`（`session-manager.ts:59`）按 sessionKey 串行——需确认 ACP 路径是否受该锁约束（当前 ACP 在 `sendPrompt` 之前 return，**不受锁约束**），即同一会话可能并发多个 ACP run。P3 需决定是否加锁
- 不同 Agent + 不同 workspace 的并行任务是本设计的天然优势（`cwd` 已 per-run），可在 P3 提供「并行任务」视图

### 7.4 渠道联动

微信 / 飞书等渠道已有 ACP 节流进度（`weixin-channel-adapter.ts:448-464`）。若要让渠道也能进入开发会话，需确认 `AcpRunStartOptions.cwd` 在渠道路径下也有值（`channel-interactive` 相关调用点）。默认行为：渠道走全局 cwd，不绑定 Agent binding。

---

## 8. 优先级总表

| 优先级 | 项目 | 改动面 | 依赖 | 交付标准 |
|--------|------|--------|------|---------|
| **P0** | 最小闭环验证 | 零代码 | 无 | §4.2 七个问题有明确答案；能通过聊天让 CLI 改掉一行代码并 `git diff` 验证 |
| **P1.1** | `AgentDevBinding` 配置 | `config/types.ts` | 无 | `app.json` 可手写配置并被读取 |
| **P1.2** | 会话路由分支 | `user-commands.ts` | P1.1 | 绑定 Agent 的会话自动走 ACP |
| **P1.3** | per-run `cwd` | `coding-dev-acp-run.ts` | 无 | 不同 Agent 指向不同目录，实测验证 |
| **P2.1** | 配置 UI | `CodingDevAcpPanel` | P1 | 面板内可完成绑定，无需手改 json |
| **P2.2** | 系统提示词注入 | `coding-dev-local-runner.ts` | P0 #7 | CLI 输出体现 Lumii 上下文意识 |
| **P2.3** | 内置 Agent 兜底 | 客户端 + api-server | api-server 排期 | 离线可用；两端定义一致 |
| **P3.1** | 权限与路径校验 | `user-commands.ts` 等 | P1 | workspace 非 git 仓库时二次确认 |
| **P3.2** | 生效闭环 | 新逻辑 + UI | P1 | 有改动时提示重启；可一键重启 |
| **P3.3** | 并发与渠道 | `AcpRunController` 等 | P1 | 同会话并发策略明确 |

---

## 9. 风险

| 风险 | 等级 | 说明 | 缓解 |
|------|------|------|------|
| CLI 非交互模式卡在权限提示 | **高** | P0 #1 未验证前，整条链路可能不可用 | P0 优先验证；必要时补权限 flag |
| 多行 prompt 被 `.cmd` shim 截断 | 中 | `quoteForCmd` 注释已标记（`coding-dev-local-runner.ts:31-36`） | 改走 stdin；或对该后端限制单行任务 |
| `workspace` 配错导致误改其他项目 | **高** | 自改代码场景破坏面大 | P3 加 git 仓库校验 + 二次确认 |
| 长任务（>1h）被超时中止 | 低 | 默认 1h，可配 | `MTBOT_ACP_TIMEOUT_MS`；按 Agent 配置 |
| Agent 与 binding 弱关联产生孤儿 | 低 | Agent 删除后 binding 残留 | 读取时忽略；不级联清理 |
| 内置定义客户端/api-server 漂移 | 中 | `definitions.ts:15-16` 明确警告 | P2.3 遵循「先 api-server 后客户端」 |

---

## 10. 待实测确认项

见 §4.2。P0 结束后，其中 #1（权限）、#7（system prompt flag）会直接影响 P1/P2 的实现方式，**必须先有答案再动 P1 代码**。

补充待确认：

- `bridge.conversationRepo.getAgentParticipantId` 在会话有多个 agent 参与者时的行为（本设计假设一对一）
- ACP 路径是否确实不受 `SessionManager.promptLocks` 约束（影响 P3.3 决策）
- 渠道路径下 `startRun` 的调用点（`channel-interactive` 相关）是否需要同步传 `cwd`

---

## 11. 附：与现有机制的关系

| 现有机制 | 本设计的关系 |
|---------|------------|
| 手动后端切换（`/claude` 等 + 设置面板） | **保留**，作为全局/会话级临时覆盖；binding 是其上的「Agent 级固化配置」 |
| 项目管理（`codingDevProjects`） | **保留**，作为全局 cwd 来源；binding.workspace 是 per-agent 覆盖 |
| 主 Agent 路径（`lumii` 后端） | **不受影响**，未绑定 Agent 的会话行为完全不变 |
| 工具系统（`bridge-tool-registrar.ts`） | **不涉及**。本设计不新增工具 |
| Agent 运行时（`agent-instance.ts` / `pi-agent-kernel-adapter.ts`） | **不涉及**。ACP 是 IPC 层旁路（§2.3） |
| 权限闸门（`permission-gate-hook.ts`） | 主 Agent 路径不受影响；ACP 路径的权限由 CLI 自身管理（P3.1 讨论外层补充） |
| `bundled-skills/代码开发/coding-agent` | **不使用**，见 §2.3 |
