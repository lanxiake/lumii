# B · code-dev 闭环（实施计划）

> 前置：A 片（路由与归属）。对应设计 §5（§5.1-§5.11）。
> **已验证前提**（2026-09-12 实测，见设计 §4.1 与附录 A.5）：
> - claude `-p` 非交互可用；`--resume <id>` 续接实测通过（缓存命中，成本约新跑 1/9）；多行 argv 安全（.exe）；stdin 传 prompt 可用
> - **codex 默认沙箱拒绝写文件且静默假成功** → 必须显式 `-s workspace-write`
> - opencode 默认输出是格式化文本 → 需 `--format json`；cursor 当前传的 `--trust` 不在其帮助中（应为 `-f`，待补测）
> - `params.cwd` 注入点现成（`run-coding-dev-acp-prompt.ts:33-39` 已有 cwd 形参并透传 spawn），但 `AcpRunStartOptions` 无 cwd、三个调用点均未传

## B0 · 总览

| 步 | 内容 | 文件 | 依赖 |
|---|---|---|---|
| B1 | `selectable` 机制 + `code-dev` 定义 + 选择器放行 + 入口 | definitions / types / agents-repo / useAgents / DetailPanel | 无 |
| B2 | 开发上下文存储 + 绑定解析 | 新 `coding-dev-dev-context.ts` / `coding-dev-env.ts` / `config/types.ts` | 无 |
| B3 | `/project`（桌面+微信+飞书）+ 会话级后端 + 默认后端下拉 | slash-command-executor / coding-dev-commands / 新 `switch-project.ts` / 两 adapter / shared | B2 |
| B4 | 路由接入开发上下文 | `user-commands.ts` | B2 B3 |
| B5 | per-run cwd 透传 + 渠道接线 + OPENCODE 回落缺口 | acp-run / 两 adapter / prompt 回落链 | B2 |
| B6 | **多轮续接**（捕获 → 持久化 → resume → 降级） | jsonl-parsers / local-runner / contracts / acp-run | B5 |
| B7 | 模式可见性 chip + 退出 | 新 IPC + ChatPage 头部 | B4 |
| B8 | 权限显式参数 | `buildLocalCliArgs` | B6（同函数） |
| B9 | 退出清理 `dispose()` | `index.ts` | 无 |
| B10 | 绑定配置 UI | CodingDevAcpPanel + IPC | B2 |

### P0 补测清单（B6/B8 动参数前必须完成）

| # | 测什么 | 怎么测 |
|---|---|---|
| 1 | codex `exec resume <id> --skip-git-repo-check --json <prompt>` 是否兼容、JSONL 中的会话标识字段名 | 临时目录两轮 `codex exec`，抓 `--json` 输出 |
| 2 | opencode `--format json` 输出结构与会话标识字段 | 同上 |
| 3 | cursor `-f` 行为、`.cmd` 多行 argv 是否截断、init 事件 session_id 字段 | 同上 |
| 4 | claude `--permission-mode acceptEdits` 下 Bash 类工具是否被拒（决定 B8 默认档；被拒会挡住「跑测试」） | 临时目录跑「创建文件 + 执行 pnpm -v」 |

结果回填设计附录 A.5。

---

## B1 · 定义机制 + code-dev 定义

1. `packages/agent-runtime/src/types/agent-definition.ts`：`AgentDefinition` 增
   `/** 系统 Agent 是否出现在会话选择器（默认 false；仅 code-dev/system-keeper 等对话型系统 Agent 置 true） */ selectable?: boolean`
2. `packages/agent-runtime/src/agent/builtin/definitions.ts`：新增 `CODE_DEV_DEF`（追加进 `BUILTIN_AGENT_DEFINITIONS`）：
   - `id: 'code-dev'`、`name: '灵栖开发'`、`sourceType: 'system'`、`selectable: true`、`isActive: true`
   - `systemPrompt`（放 `prompts.ts`，新条目 `CODE_DEV_PROMPT`）：绑定项目内完成可验证的代码改动；遵守仓库 `AGENTS.md`；改完跑 `pnpm typecheck` 与相关测试；主进程改动需重启生效；**无绑定/无 ACP 后端时用 pi 兜底档工具工作**。
   - pi 兜底档 `tools` 白名单：`bash`、`file_read/file_write/file_edit/file_mkdir/file_move/file_copy`、`list_dir/glob/grep`、`todo_write`、`profile_memory`、`skill_list/skill_search/skill_invoke`、`web_search/web_fetch`
   - `modelTier: 'balanced'`、`maxTurns: 80`、`canSpawnSubAgents: false`（v1）、`memory: { scope: 'user', autoExtract: true }`
   - 文件头「必须同步 api-server」约束的处理：独立版无 api-server（`agents-repo.ts:1-9` 明言），在新增定义处补一行注释说明；回流完整版时同步 `DEFAULT_SYSTEM_AGENTS`。
3. `apps/windows/src/main/agents-repo.ts`：`AgentRecord` 增 `selectable?: boolean`；`systemAgentRecords()` 映射 `selectable: def.selectable`。
4. 选择器放行：`apps/windows/src/renderer/hooks/business/useAgents/`（过滤逻辑约 `:128-142`）——数据源 `agent-service.getAgents` 当前只放 `userId` 非空的用户 Agent（系统 Agent 统一显示为「系统默认」占位）；改为 `a.userId || a.selectable`。
5. `apps/windows/src/renderer/pages/AgentsPage/views/DetailPanel.tsx:94-101`：系统 Agent 分支在「基于此创建」旁增「发起对话」按钮（复用 `onStartChat(agent.id)`，与用户 Agent 分支一致）。
6. 确认 `conversation:create`（`conversation-commands.ts:91-116`）对系统 Agent id 走 `createInstanceById` 正常（`builtin:explore` 已有先例）。

**测试/验收**：重启后选择器出现「灵栖开发」；选中发起对话 → 会话 participant `id='code-dev'`；不选 Agent 的默认路径不变。

---

## B2 · 开发上下文存储 + 绑定解析

1. 新文件 `apps/windows/src/main/coding-dev-dev-context.ts`（模板：`coding-dev-backends-stub/backend-selection.ts`，同目录落 `coding-dev-backends/dev-context.json`）：
   ```ts
   export type DevContextRecord = {
     backendId?: CodingDevBackendId   // 会话级工具覆盖（/claude、/lumii 写入）
     projectName?: string             // 会话级项目覆盖（/project 写入，存 name 不存路径）
     updatedAt: string
   }
   export function setDevContextBaseDir(dir: string): void            // index.ts 注入
   export function getDevContext(accountId: string, peerId: string): DevContextRecord | undefined
   export function setDevContext(accountId: string, peerId: string, patch: Pick<...>): DevContextRecord
   export function clearDevContext(accountId: string, peerId: string): boolean
   ```
2. `apps/windows/src/main/index.ts:1311-1314`：与 `setBackendSelectionBaseDir` 并排调用 `setDevContextBaseDir(directoryManager.getDirectory('config'))`。
3. `apps/windows/src/main/config/types.ts`：增 `AgentDevBinding`（`agentId` / `backendId` / `workspace?` / `enabled` / `permissionMode?`）与 `AppConfig.codingDevAgentBindings?: AgentDevBinding[]`。
4. `apps/windows/src/main/coding-dev-env.ts` 增：
   ```ts
   export function resolveAgentDevBinding(appConfig: AppConfig, agentId?: string): AgentDevBinding | undefined
   export function resolveProjectPathByName(appConfig: AppConfig, name?: string): string | undefined
   ```
   （`resolveProjectPathByName` 复用 `codingDevProjects`；`enabled !== true` 视为未绑定。）

**测试**：dev-context 读写/清理单测；`resolveAgentDevBinding` 单测（命中/未启用/未配置）。

---

## B3 · `/project` 与命令层

1. shared（`apps/windows/src/shared/agent-runtime-commands.ts`）：
   - `codingDev:setBackend`（`:1365`）增可选 `sessionKey?: string`；
   - 新增 `codingDev:setProject { sessionKey: string; projectName: string | null }`；
   - 新增只读 `codingDev:getDevContext { sessionKey: string }` → `{ backendId, projectName?, projectPath?, source: 'session'|'binding'|'global' }`（B7 chip 也用）。
2. `apps/windows/src/main/ipc/agent-runtime/coding-dev-commands.ts`：
   - `handleCodingDevSetBackend`：`command.sessionKey ? setDevContext('local-user', sessionKey, { backendId }) : ` 现有 user-global 分支（CLI/控制面不带 sessionKey，行为不变）；
   - 新增 `handleCodingDevSetProject`（校验项目名存在于 `codingDevProjects`，`null` = 清除）与 `handleCodingDevGetDevContext`（按 §5.3 优先级解析后返回）。
3. 桌面 `apps/windows/src/renderer/pages/ChatPage/commands/slash-command-executor.ts`：
   - `handleBackend`（`:337-370`）payload 增当前 `sessionKey`（`CommandContext` 若未携带则补——实施时确认 `commands/types.ts`）；
   - `/lumii` 显式写 `'lumii'`（压制 binding，设计 §5.3）；
   - 新增 `/project [name|off]`：无参列 `codingDevProjects` + 当前会话项目；有参校验后发 `codingDev:setProject`；`off` 清除。注册方式与 `/models` 同级（命令注册表 + `executeSlashCommand` case）。
4. 渠道：新文件 `apps/windows/src/main/channel/slash-commands/switch-project.ts`（仿 `switch-backend.ts`）：
   - `createProjectCommand()`：列表 / 切换 / `off`；写 `setDevContext(channelUserId, sessionKey, { projectName })`；
   - **不做 user-global 同步**（项目是会话级的；桌面全局项目归设置页管理）；
   - 注册进微信 `buildRegistry()`（`weixin-channel-adapter.ts:626-648`）与飞书 `buildRegistry()`（`feishu-channel-adapter.ts:487-505`）。
5. `CodingDevAcpPanel`：增「默认编码后端」下拉（写 user-global，走 `codingDev:setBackend` 不带 sessionKey 的分支）。

**测试**：dev-context 命令单测；手工：微信 `/project`（列表 / 切换 / off）回执正确，桌面 `/project` 同理。

---

## B4 · 路由接入（`user-commands.ts:197-218`）

```ts
const appConfig = configManager.getAppConfig()                    // 复用现有 configManager 注入
const devCtx = getDevContext(LOCAL_USER_ID, command.sessionKey)
const binding = resolveAgentDevBinding(appConfig, bridge.conversationRepo.getAgentParticipantId(command.sessionKey))
const manual = acpMgr.getBackendWithFallback(LOCAL_USER_ID, command.sessionKey)
const effectiveBackend = devCtx?.backendId ?? binding?.backendId ?? manual
const workspace = resolveProjectPathByName(appConfig, devCtx?.projectName) ?? binding?.workspace

if (effectiveBackend !== DEFAULT_CODING_DEV_BACKEND_ID) {
  void controller.startRun({ runId, sessionKey: command.sessionKey, backendId: effectiveBackend,
    text: command.content, instanceId, bridge, cwd: workspace, pushEvent: /* 现状 */ })
  return { runId }
}
```

- 优先级：**会话显式 > Agent 绑定 > user-global（旧机制） > 默认**（设计 §5.3）。
- 未绑定、无 dev-context 的会话行为完全不变（回归硬项）。
- `getAgentParticipantId` 用法参照 `conversation-commands.ts:279`。

**测试**：优先级单测（4 种组合）；手工：项目 A/B 两个会话互不串（验收节）。

---

## B5 · per-run cwd 与渠道接线

1. `apps/windows/src/main/coding-dev-acp-run.ts`：`AcpRunStartOptions`（`:46-56`）增 `cwd?: string`；`startRun` 内 `runCodingDevAcpPrompt({ ..., cwd: opts.cwd })`（当前 `:130-138` 未传）。
2. 微信（`weixin-channel-adapter.ts`）：`handleAcpPrompt` 增 `cwd` 参数；调用点 `:346-349` 用 `resolveProjectPathByName` 解析会话项目后传入；`:540-547` 调 `runCodingDevAcpPrompt` 时带 `cwd`。
3. 飞书（`feishu-channel-adapter.ts`）：`:322-324` 同步解析；`:413-421` `startRun` 增 `cwd`。
4. `run-coding-dev-acp-prompt.ts:33-39` 回落链补 `MTBOT_OPENCODE_ACP_CWD`（env 侧已写入全部键，唯独回落链缺它）。

**验收**：微信 `/project lumii` 后发「输出当前目录」→ 回执含项目路径；桌面两会话两目录互不串。

---

## B6 · 多轮续接（P1 关键项）

### 捕获（解析器）

- `coding-dev-jsonl-parsers.ts`：
  - `ParsedLine` 增 `{ kind: 'session'; sessionId: string }`；
  - `parseClaudeJsonLine`：`obj.type==='system' && obj.subtype==='init' && typeof obj.session_id==='string'` → 返回 session（其余 `system` 事件保持 ignore）；测试样本已证明 init 事件含 session_id（`coding-dev-jsonl-parsers.test.ts:60,79`）；
  - `parseCursorJsonLine` 同理（字段名按 P0 实测确认）；
  - `AcpToolStreamParser` 增字段 `cliSessionId: string | null` + `getCliSessionId()`，`parseLine` 捕获；该事件不产生可见进度（保持静默）。
- codex / opencode 的会话标识：按 P0 结果补 parser 分支（拿不到就只支持 claude/cursor 续接，其余后端待办）。

### 拼参与透传

- `CodingDevLightweightBackendOutput`（`contracts.ts:35-39`）增 `cliSessionId?: string`；`LocalAcpRunParams` 增 `cliSessionId?: string`（作为 resume 输入）；`runLocalAcpCli` 的 `close` 分支 `resolve({ text, cliSessionId: parser.getCliSessionId() ?? undefined })`。
- `buildLocalCliArgs(toolId, cmd, prompt, opts?: { cliSessionId?: string })`：

| 后端 | 无续接 | 有续接 |
|---|---|---|
| claude | `-p <prompt> --output-format stream-json --verbose` | 追加 `--resume <id>` |
| codex | `exec --skip-git-repo-check --json <prompt>` | 改子命令形态 `exec resume <id> --skip-git-repo-check --json <prompt>` |
| opencode | `run <prompt>` | `run --session <id> --format json <prompt>`（`--format json` 同时修输出解析） |
| cursor | `-p <prompt> --output-format stream-json --trust` | `-p <prompt> --resume <chatId> --output-format stream-json`（`--trust` 在 B8 一并处理） |

### 存储与降级（`coding-dev-acp-run.ts`）

- key：`acp-session:${backendId}:${sessionKey}`，经 `bridge.runtimeStateRepo`（KV，`bridge.ts:672`）；
- `startRun` 前 `get` → 作为 `cliSessionId` 传入 runner；runner 返回带 `cliSessionId` → `set` 写回；
- **失败降级**：非 abort 的失败且本次带了 resume → 清 key → 不带 resume 重试一次 → 成功则在最终文本追加「（CLI 上下文已重置）」；重试仍失败走现有错误路径。只重试一次，防死循环；
- 清理：`conversation:delete`（`conversation-commands.ts:288-332`）时删 4 个后端的 `acp-session:*:${sessionKey}` key；
- 后端切换天然隔离（key 含 backendId）。

### 测试/验收

- 单测：解析器 claude init → sessionId；`buildLocalCliArgs` 各后端带/不带 resume 的 argv 断言；
- 手工：桌面两轮「记住数字 42 → 我刚才让你记住什么」；微信同验；断言日志出现 `--resume`。

---

## B7 · 模式可见性 chip

1. 渲染层经 `codingDev:getDevContext`（B3）取当前会话上下文（`source` 区分会话值/绑定/全局）。
2. ChatPage 会话头部（`ChatContainer` 顶部区域，实施时定位具体组件）增 chip：`Claude Code · lumii`；点开菜单：
   - 「退出开发模式」→ 发 `codingDev:setBackend { backendId: 'lumii', sessionKey }`；
   - 「切换项目」→ 内联列表（`codingDevProjects`）或跳设置页。
3. 刷新时机：会话切换、收到 `settings:backend-changed` / 新 `settings:dev-context-changed` 事件。

**验收**：绑定会话显示 chip；退出后下一条消息走主 Agent；未绑定会话不显示任何东西。

---

## B8 · 权限显式参数（集中在 `buildLocalCliArgs`）

| 后端 | 加的参数 | 备注 |
|---|---|---|
| claude | `--permission-mode acceptEdits` | P0#4 决定；若 Bash 被拒挡住跑测试，改评估 `bypassPermissions` 或 `--allowedTools` 放行常用命令 |
| codex | `-s workspace-write` | **必加**，否则静默假成功 |
| cursor | `--trust` → `-f` | 先按 P0#3 实测确认 |
| opencode | 暂不加 | 默认可写（实测）；观察 |

**验收**：codex 后端真实创建文件（`test -f` 验证）；claude 后端能改文件 + 能跑通一条 `pnpm -v`。

---

## B9 · 退出清理

- `apps/windows/src/main/index.ts` `performCleanup`（`:1553-1604`）在 `agentRuntimeBridge.destroyAll()` 前调 `getAcpRunController().dispose()`（模块单例 `coding-dev-acp-run.ts:471-476`；`dispose` 实现 `:271-284` 已存在）。
- **验收**：跑一个长任务（如让 CLI 执行 60s 命令）时退出应用 → 任务管理器无残留 node/CLI 子进程。

---

## B10 · 绑定配置 UI

- `CodingDevAcpPanel` 增「Agent 绑定」区：每行 = Agent（用户 Agent + `selectable` 系统 Agent）+ 后端下拉（`CODING_DEV_BACKEND_LABELS`）+ 项目/目录选择（复用项目列表）+ `permissionMode`（默认 / acceptEdits / bypass）+ 启用开关；
- 读写 `app.json.codingDevAgentBindings`（复用 app 配置 IPC；接线方式参照 A4 的模式）；
- `permissionMode` 生效路径：B4 解析 binding → `AcpRunStartOptions.permissionMode` → runner → `buildLocalCliArgs`（B6 的 opts 一并带）。

**验收**：UI 保存的绑定在下一条消息生效；停用后回落 user-global。

---

## B 片验收总表

- [ ] 选择器出现「灵栖开发」；发起对话正常
- [ ] 项目 A/B 两个会话分别 `/project`，消息在各自目录执行，互不串
- [ ] 微信 `/project`（列表 / 切换 / off）回执正确；切换后消息在目标目录执行
- [ ] 桌面与微信两轮追问均带上下文（日志含 `--resume`）
- [ ] codex 后端真实写文件（不再假成功）
- [ ] 绑定会话 chip 显示正确；「退出开发模式」后走主 Agent
- [ ] 退出应用无 CLI 残留进程
- [ ] 回归：未绑定会话行为与改造前一致（life-e2e + 手工抽查）

## 风险与回滚

| 风险 | 缓解 |
|---|---|
| resume 参数与某些 CLI 版本不兼容 | 参数集中在一处，可逐后端回退为「不续接」；降级重试兜底 |
| 桌面 `/claude` 从 user-global 改会话级造成预期差 | 设置面板「默认编码后端」承担全局；chip 明示；回滚点 = B3/B4 提交 |
| cursor `.cmd` 多行 argv 截断 | 已知问题不恶化：长任务建议单行描述；stdin 方案列阶段 2 |
