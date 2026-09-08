# Bash 命令工具进化闭环 — 设计

日期：2026-09-08
状态：已实现（M1 采集挖掘 / M2 草拟审批注册 / M3 每日调度）

## 背景与目标

Agent 运行时最高频的工具是 `bash`，命令由模型现场编写，存在三类问题：

1. **重复劳动**：同一操作（如 `pnpm --filter xxx build`）每次重新生成，浪费 token 且耗时；
2. **易错**：语法、路径引用、平台差异（Windows/Git Bash）、转义容易写错，出错后靠重试修复；
3. **难以审计**：命令散落在会话里，没有统一的行为口径。

目标：**自动采集 bash 调用 → 挖掘高频命令模式 → LLM 草拟参数化工具 → 人工审批 → 注册为系统工具**，模型下次直接调用工具而非重写命令。

与已停用的 skill-evolution（`apps/windows/src/main/index.ts:900-940`，"效果不太好"）的本质区别：

- **skill 是软建议**：一段提示词文本，模型可以不遵守、用偏，效果不可控；
- **参数化工具是硬接口**：模型只能按 JSON Schema 传参，执行路径固定，出错面收窄为参数取值本身。

因此工具化恰好解决 skill 进化"效果不太好"的根因，且可以直接复用其整条管道骨架。

## 架构总览

```
[Agent 事件流 tool:start / tool:end]
        │  (bash 工具调用时)
        ▼
BashCommandLogger ──写入──▶ SQLite 表 bash_command_log
                                  │
                                  │  (cron 每日任务 / 首次启用)
                                  ▼
CommandPatternMiner：归一化（参数抽象）→ 聚合（计数/错误率/天数）→ 过滤
                                  │
                                  ▼ 候选模式 Top N（每天最多 2 个，防打扰）
BashToolDrafter（LLM）：模式 + 真实样本 → ToolDraft{name, description,
                        parameters(JSON Schema), commandTemplate, isReadOnly}
                                  │
                                  ▼
ToolQualityGate（纯规则）：Schema 合法 / 占位符与参数一致 / 样本回放还原 /
                          危险命令黑名单 / 名称冲突 → 不通过则丢弃
                                  │
                                  ▼ 待审批
对话内审批（inject_message，复用 skill-evolution 模式）
                                  │
                    ┌─────────────┴─────────────┐
                    ▼ 确认                       ▼ 拒绝
ToolWriter 落盘                       仅删除 pending
workspace/tools/<name>/tool.json
        │
        ▼
ToolRegistry.register(模板执行器工具) + bridge.invalidateInstance()
        │
        ▼
下一轮对话：模型可直接调用新工具（无需重启应用）
```

## 模块设计

### 1. BashCommandLogger（采集）

- **挂点**：Agent 运行时事件订阅处（`bridge-instance-factory.ts` 的 richHandler / eventSink，与 `onTurnComplete` 同源），监听 `tool:start`（有 `args.command`）与 `tool:end`（有 `isError`、可算 `durationMs`）。`tool:start` 时把 command 暂存 Map<toolCallId, string>，`tool:end` 时一次写入。
- **新表**（SQLite，走 `packages/agent-runtime/src/storage/local-database.ts` 的 DatabaseAdapter + schema 迁移）：

```sql
CREATE TABLE bash_command_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  conversation_id TEXT,
  tool_call_id TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT,
  is_error INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_bash_cmd_ts ON bash_command_log(created_at);
```

- 写入失败静默降级（不阻塞 agent 主链路），与 `tool_audit_log` 同策略。
- 保留期：超过 60 天的记录由 cron 任务清理，控制库体积。

### 2. CommandPatternMiner（挖掘，纯函数可单测）

输入：SQLite 拉取的最近 N 天记录；输出：`CommandPattern[]`。

**归一化（参数抽象）**：
- 按 `&&` / `;` / 换行拆分命令链，每段单独成模式（`cmd1 && cmd2` 拆为两个候选，同时保留整体模式仅在拆分后仍≥2段时）；
- 抽象规则（顺序敏感）：
  - 引号内内容（`"..."` / `'...'`）→ `{{string}}`；
  - 路径（盘符绝对路径 `C:\...`、POSIX 绝对路径、`./`、`../`）→ `{{path}}`；
  - 纯数字参数 → `{{num}}`；
  - `git commit -m <msg>` 等已知"消息位"→ `{{msg}}`；
  - 文件名/扩展名（`.json`、`.ts` 等 token）→ `{{file}}`；
- 归一化后模式长度 < 20 字符的丢弃（`ls`、`git status` 这类不值得工具化）。

**聚合**：模式 → { count, errorCount, errorRate, avgDurationMs, distinctDays, samples[] }。

**过滤**：
- `count < 5` 或 `distinctDays < 1` 剔除；
- 已有专用工具覆盖的剔除（对照表，与 bash-tool.ts description 中的"NEVER use bash for..."清单一致）：`find`→glob、`grep`→grep、`cat/head/tail`→file_read、`ls`→list_dir、`mkdir`→file_mkdir、`cp/mv`→file_copy/file_move、`sed/awk`→file_edit、`echo >`→file_write；
- 已在候选/已注册工具中的模式去重。

**排序**：`errorRate * 2 + 归一化频率` 加权，高错误率优先（"高频且高犯错"最值得固化）。

### 3. BashToolDrafter（LLM 草拟）

- 输入：单个模式 + ≤10 条真实样本（含成功/失败结果摘要）+ 现有工具名清单 + 黑名单说明。
- 输出 JSON：`{ name, description, whenToUse, whenNotToUse, parameters: JSONSchema, commandTemplate, isReadOnly }`。
- 硬性 prompt 约束：
  - `commandTemplate` 必须是**样本中真实出现过的命令的占位符化**（占位符 `{{paramName}}`），禁止发明新命令结构；
  - `parameters` 每个参数必须被模板使用，模板每个占位符必须有对应参数；
  - 参数类型限定 `string | number | boolean | enum`，string 参数必须有 `pattern` 或 `minLength` 等约束；
  - `name` kebab-case、含动词、避免与现有工具重名；
  - 禁止读外的破坏性默认（`rm`、`git reset --hard`、`git push --force` 等模板默认拒绝，除非样本频率极高且描述明确风险）。
- LLM 调用：`bridge.callLLM(prompt, instanceId)`（复用 `BridgeContextCompactor.callLLM` 三级降级，跟随用户会话模型）。

### 4. ToolQualityGate（质量门，纯规则可单测）

不调 LLM，全部本地规则：

1. JSON Schema 合法（ajv 编译通过，参数类型在白名单内）；
2. 模板占位符集合 === 参数名集合（双向一致）；
3. **回放校验**：将每条样本按参数代入模板（占位符替换 + 单引号转义），与样本原命令字符串比较，还原率 ≥ 80% 才通过——约束 LLM 不瞎编模板；
4. 危险黑名单正则（`rm -rf /`、`curl … | sh`、`:(){ :|:& };:`、`> /dev/sd`、`chmod -R 777 /` 等）拒绝；
5. `name`：kebab-case、非空、不与内置工具（bash/file_read/glob/grep/…）及已注册工具重名；
6. `description`/`whenNotToUse` 非空。

任一失败即丢弃草稿（记日志，不进审批）。

### 5. ToolWriter + 运行时注册（落盘 + 生效）

- **落盘**：`~/.lumii/workspace/tools/<name>/tool.json`（仿 skill 目录结构；workspace 内目录，不进仓库、不随 git）：
  ```json
  {
    "name": "pnpm-build",
    "description": "...",
    "whenToUse": "...",
    "whenNotToUse": "...",
    "parameters": { "type": "object", "properties": { ... } },
    "commandTemplate": "pnpm --filter {{pkg}} build",
    "isReadOnly": false,
    "needsPermission": true,
    "status": "approved",
    "samples": [...],
    "createdAt": "..."
  }
  ```
- **待审批**：`workspace/tool-evolution-pending.json`（仿 `skill-evolution-pending.json`，串行锁防并发）。
- **模板执行器**（新工具工厂 `createTemplateTool`，放 `packages/agent-runtime/src/tools/` 或宿主 tool-providers）：执行时把参数值单引号转义后替换占位符，走 `context.executeCommand`（继承权限弹窗、超时、取消、审计），返回 stdout/stderr/exitCode。
- **生效**：`ToolRegistry.register()` + `bridge.invalidateInstance()`（已有模式，MCP 工具变更同路径）——下一轮对话重建实例即可用，**无需重启**。
- **启动加载**：app 启动时读取 `workspace/tools/*/tool.json` 中 `status=approved` 的注册。
- 用户可在权限弹窗中"总是允许"降低打扰。

### 6. 审批交互（对话内，复用 skill-evolution 模式）

- 触发 `inject_message`：以 assistant 消息形式询问，如："检测到命令 `pnpm --filter <pkg> build` 最近使用 12 次（2 次失败），已草拟工具 `pnpm-build`。回复"启用"保存，回复"不用"丢弃。"
- 确认/拒绝：关键词识别（中英文，复用 `feedback-manager.detectSignal` 思路）。
- IPC 旁路：提供 `tool:confirm_draft` / `tool:reject_draft` 命令，后续可接设置页 UI（本期不做设置页，先对话内闭环）。

### 7. 调度（cron）

- 挂 `cron-scheduler` 每日任务：凌晨 3 点运行「挖掘 → 草拟 → 质量门 → 生成候选」；每天最多产出 2 个待审批候选（防打扰）；错误率 Top 的优先。
- 数据不足（< 5 条记录）时静默跳过。
- 审批队列积压 > 5 时暂停新草拟。

## 安全考量

| 风险 | 对策 |
|---|---|
| LLM 草拟任意危险命令 | 模板必须来自观察样本（回放校验 ≥80%）；危险黑名单；破坏性命令默认拒绝 |
| 参数注入（`; rm -rf` 等） | 参数值单引号转义；string 参数 schema 约束；不在 shell 字符串拼接 |
| 覆盖内建工具 | 名称冲突检查（内置清单 + 已注册清单） |
| 工具被恶意/误用 | `needsPermission: true` 默认，首次调用权限弹窗；`isReadOnly` 精确标注 |
| 数据隐私 | 命令日志只落本地 SQLite，60 天滚动清理，不参与云同步 |

## 里程碑

- **M1 采集 + 挖掘**：BashCommandLogger + 新表 + CommandPatternMiner（纯函数 + 单测）。让数据先积累。
- **M2 草拟 + 质量门 + 审批 + 注册**：BashToolDrafter + ToolQualityGate + ToolWriter + 模板执行器 + invalidateInstance 接线 + 对话内审批。
- **M3 调度 + 治理**：cron 每日任务 + 清理任务；（设置页管理 UI 列为后续，不在本期）。

## 测试策略

- `CommandPatternMiner`：归一化/聚合/过滤 纯函数单测（含 Windows 路径、引号、多命令链样本）；
- `ToolQualityGate`：schema 校验、占位符一致性、回放校验、黑名单、重名各分支单测；
- `BashCommandLogger`：事件合成 → 落库集成测试（用测试 DatabaseAdapter，仓库已有惯例）；
- 模板执行器：参数转义与占位符替换单测；
- 端到端：注册 → invalidateInstance → 下一轮工具列表含新工具（可复用现有 lifecycle 测试模式）。

## 关键文件

| 位置 | 说明 |
|---|---|
| `apps/windows/src/main/agent-runtime/bash-tool-evolution/`（新目录） | logger、miner、drafter、quality-gate、writer、engine、调度接线 |
| `packages/agent-runtime/src/tools/template-tool.ts`（新） | 模板执行器工具工厂（纯 TS，可单测） |
| `packages/agent-runtime/src/storage/` | bash_command_log 表 schema + repo |
| `apps/windows/src/main/agent-runtime/bridge-*` | 事件挂点、注册 + invalidateInstance 接线 |
| `apps/windows/src/main/agent-runtime/cron-scheduler.ts` | 每日挖掘任务 |

## 参考

- skill-evolution 管道：`apps/windows/src/main/skill-evolution/`（状态机、observer、drafter、quality-gate、writer、user-dialog 全部可作模板）
- 运行时工具注册先例：`agent-runtime-ipc.ts:535-562`（配置变更后 invalidateInstance）
- Bash 工具定义：`packages/agent-runtime/src/tools/built-in/bash-tool.ts`
- 设计访谈记录：2026-09-08 对话（用户确认：统计 Lumii agent-runtime、直接做自动闭环）
