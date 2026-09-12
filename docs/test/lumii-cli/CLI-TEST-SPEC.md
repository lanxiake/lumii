# Lumii CLI 测试规范

> 版本：2026-09-12（v1.0）
> 适用：`docs/test/lumii-cli/` 下全部套件与用例文档。
> 定位：本规范定义「如何用 `lumii-ui` CLI 驱动**真实运行的 Lumii 客户端**做功能验证」，其中 **L3 真实聊天模拟是最接近用户真实操作的测试**——通过真实会话、真实 LLM、真实落库来验证功能与用户体验一致。

---

## 1. 测试分层

| 层 | 名称 | 驱动方式 | 断言类型 | 单用例耗时 | 用途 |
|---|------|---------|---------|-----------|------|
| **L1** | 命令面 smoke | CLI 单命令 | 退出码 / JSON 结构 / 字段存在性 | 秒级 | CLI 参数解析、错误处理、命令不崩 |
| **L2** | 数据链路 | DB/文件播种 → CLI 动作 → 回读 DB/文件 | 落库内容 / 状态机 / 计数增量 | 秒级（可含 agent 调用） | 管道正确性，不依赖 LLM 输出质量 |
| **L3** | 真实聊天模拟 | `conversation create` + `send` + 观察真实回合 | 落库 + 日志 + 语义软断言 | 30–120 秒 | 用户视角端到端：功能在真实对话中按预期工作 |

选择原则：**能用 L1/L2 验证的就不放到 L3**（L3 慢且依赖 LLM 非确定性）；但涉及「用户在对话中触发的链路」（如场景记忆注入、聊天摄入 Wiki）**必须**有 L3 覆盖——L1/L2 无法证明该链路对用户真的生效。

## 2. 真实聊天模拟标准方法（L3）

### 2.1 会话与命名空间

```js
const c = okJson(ui(['conversation', 'create', '--title', '[chat-suite] xxx']))
const sk = c.sessionKey ?? c.id          // 返回 { sessionKey, conversationId }
```

- 会话标题必须带 `[chat-suite]` 前缀（或套件专用前缀）——用于识别探针会话、避免与用户真实会话混淆、便于人工清理。
- 不删除用户已有会话；测试产生的探针会话默认保留（便于人工核查），清理由报告注明。
- 双会话隔离用例：两会话交叉发送，断言消息互不串。

### 2.2 发送与回合完成判定

```js
const s = okJson(ui(['send', '--session', sk, '--text', text]))   // 返回 { runId }
```

**`send --wait` 不存在**（仅 usage 字符串噪声，实现未处理该参数）——禁止使用，会被静默忽略。

回合完成判定两条通道，二选一或组合：

1. **轮询 CLI 消息**（推荐，纯 CLI）：
   ```js
   // context messages 返回 { items: [{id, role, content, contentJson, toolCalls[], ...}] }
   pollUntil(() => lastAssistantStable(sk, { minId: baselineMsgId }), timeoutMs, 2500)
   ```
   完成信号：出现新的 `role === 'assistant'` 消息，且该消息内容在两次轮询间稳定（防止流式中截断）。assistant 正文与工具调用在 `contentJson.parts[]`。
2. **轮询 DB 落库**（管道型断言更稳）：等目标表计数/行状态变化，如 `messages` 表新行、`autonomous_satisfaction_scores` 新评分、`runtime_state` 键更新。

超时默认 120–180 秒（`CHAT_TURN_TIMEOUT_MS` 可覆盖）；复杂工具调用回合放宽到 240 秒。超时即 FAIL，证据中记录已等待轮数与最后消息状态。

### 2.3 断言策略

- **baseline-delta**：动手前记录基线（计数、文件 mtime、日志行号），动作后断言增量——禁止断言绝对值（用户数据不可控）。
- **硬断言**（可确定）：落库行、文件产出、API 字段、信号计数（如 `resends`/`aborts`）、日志标记。失败即 FAIL。
- **软断言**（LLM 非确定）：回复语义、是否调用某工具、回答是否记得早前事实。判定用宽松匹配（关键词/正则/字段存在），**禁止精确文本断言**；允许 1 次追加重试（换会话重发），重试仍失败记 FAIL 并在 note 标注 `(soft, retried)`。
- 每个用例在文档中标注断言类型（硬/软）与预计 LLM 回合数。

### 2.4 超时、限流与重试

- 统一 `ui()` 封装：命中 `error === 'rate_limited'` 或输出含该串时退避重试 `sleep(min(20000, 5000*(i+1)))`，默认 retries=6。
- 长时间阻塞命令（`cron run` 等）用 `timeoutMs` 显式覆盖并 retries=0。
- 连续 3 个 FAIL 即终止套件（防止环境性问题刷屏），报告标注「提前终止」。

### 2.5 日志证据通道

应用实时日志在 `~/.lumii/logs/app/mtbot-<日期>.log`（按天文件，约 270 万字符/2.4 万行）。日志断言用**行号游标**（cursor 记录文件路径 + 行数）：

```js
const cursor = logCursor()            // 记录当前行数
// ... 触发动作 ...
logSince(cursor, /\[buildSceneMemorySections\] 注入场景记忆 scene=project key=xxx/)
```

用途：验证无 CLI 出口的内部行为（如 prompt 注入块、场景记忆命中）。局限：日志文件缺失（打包环境/路径变化）时相关断言降级为 SKIP 并在报告中说明；日志按天切分，跨天运行需重新取游标（lib 已用「最新修改文件」探测兜底）。
**⚠️ 路径陷阱（2026-09-12 实测）**：仓库根 `.lumii-dev.log` 是历史遗留文件、内容停滞在早期日期——用它断言会全部假阴性。务必用 `~/.lumii/logs/app/` 下的当日文件（lib `logChannelAvailable()` 探测的即是后者）。

## 3. 用例文档格式

文件名 `<域>-test-cases.md`（如 `chat-test-cases.md`），每条用例：

```markdown
#### CHAT-MEM-03 场景记忆命中注入（正例）
- **优先级**: P0
- **前置**: 探针场景 key 已注册于 _registry.json
- **真实数据**: 探针项目别名「<alias>」；user-memory.md 快照
- **步骤**: 1) 创建会话 2) 发送含别名的消息 3) 等待回合完成
- **预期**: 日志出现 `[buildSceneMemorySections] 注入 … key=<key>`；回复体现偏好内容
- **断言**: 日志匹配=硬；回复语义=软
- **预计回合**: 1
```

ID 规则：`<域大写>-<子域>-<序号>`（`CHAT-CORE-01`、`MEM-03`、`CMP-02`、`WIKI-01`）。

## 4. 证据与报告

### 4.1 evidence.jsonl（逐条证据）

套件启动时 truncate 旧文件，每用例追加一行：

```json
{"ts":"2026-09-12T13:00:00.000Z","id":"CHAT-CORE-01","status":"PASS","note":"…","durationMs":42000,
 "sessionKey":"…","runId":"…","turns":1,"refs":{"logLines":12},"stack":null}
```

`status ∈ {PASS, FAIL, SKIP, INFO}`；FAIL 必须带 `note`（可读原因）+ 可选 `stack`；SKIP 必须带原因（环境缺失/开关跳过）。

### 4.2 report.md（套件报告）

必须含：① 头部元信息（生成时间、客户端版本/构建、驱动方式「全部经 lumii-ui CLI 真实调用」、数据库路径、运行命令与关键环境变量）；② 概要统计（总数/通过/失败/跳过/通过率）；③ 逐条结果表；④ 失败与 SKIP 明细及三级分类；⑤ 覆盖范围与已知限制。

## 5. 目录与命名约定

- 按功能域组织：`general/`、`chat/`、`wiki/`、`autonomous/`、`cloud-sync/`；共享库在 `lib/`。
- 执行器命名：`run-<域>-<范围>.mjs`；产物 `<套件名>-evidence.jsonl` + `<套件名>-report.md`（与执行器同目录）。
- 路径基准：脚本内一律 `path.resolve(__dirname, '../../../..')` 定位仓库根（子目录深度 = docs/test/lumii-cli/<域>）；禁止硬编码他人机器路径，机器相关路径走环境变量。
- **双轨边界**：`lib/cli-harness.mjs` 供 chat 套件使用；历史脚本不强制迁移（各脚本按修改需求顺带迁移），但**新增套件必须用 lib**，禁止再复制 `ui()/record()` 等 helper。
- 测试素材放 `materials/`（.gitignore 忽略，需手动放置）；脚本在目录缺失时快速失败并提示。

## 6. 副作用与安全

- **探针命名空间**：探针会话标题前缀、探针场景 key（如 `chat-probe-*`）、探针 agent 命名空间（如 `autonomous-test-*`）必须可与用户真实数据区分。
- **写前快照**：测试将写用户数据文件（`user-memory.md`、`scene-memory/`、`_registry.json`）时，先复制快照；测试结束恢复（`*_NO_RESTORE=1` 可跳过便于人工观察）。恢复动作写入证据。
- **DB**：默认只读（`node:sqlite` `readOnly: true` 或仅 SELECT）；不执行 `DELETE/UPDATE` 用户业务数据（探针行除外）。
- **不删除**：默认不删除任何用户业务数据；Wiki 源删除类用例需显式开关（`WIKI_CLI_ALLOW_DELETE=1`）。
- **限流感知**：批量发送会触发上游限流——套件按顺序执行，不用并发轰炸。

## 7. 命令面基线（2026-09-12）

- **权威源**：`node apps/windows/resources/app-ui-cli/lumii-ui.mjs help --json`（或 `commands.mjs` 的 `COMMANDS` 注册表）。本文档不复制完整命令表，避免漂移。
- **基线数量**：77 条命令（2026-09-12 核对）+ `help` 内置命令。
- **help 一致性校验**：L1 套件断言 `help --json` 返回的 `commands` 数组非空，且命令名与注册表一致（新增命令时必须同步更新用例文档）。
- **已知已删命令**（历史用例文档引用但注册表已无，遇到即标注过时）：`agent list`、`agent info`、`agent send`、`cron create`、`cron delete`、`wiki overview`、`wiki read`、`wiki capture`、`memory read`。
- **参数格式易错点**：`wiki search` / `memory search` 用**位置参数**（`wiki search <关键词>`），不是 `--q`。

## 8. 缺陷三级分类与处理

发现失败时先分类，再决定动作：

| 分类 | 判据 | 处理 |
|---|---|---|
| **产品缺陷** | CLI/控制口/客户端行为与设计不符，且非环境因素 | 记录复现步骤 → 修复代码 → 回归该用例；报告标「产品缺陷」 |
| **用例过时** | 命令已删/改名、返回结构变化、断言基于旧行为 | 更新用例文档与执行器；报告标「用例过时」；同批排查同类断言 |
| **环境问题** | 应用未运行、模型未配置、日志通道缺失、网络/限流 | 标 SKIP 或 FAIL(env) 并在报告注明；不计入产品缺陷 |

流程：套件 FAIL → 人工复核（证据 + 日志 + 手动 CLI 复现）→ 分类 → 按类处理 → 修复后重跑该套件至 PASS 或明确 SKIP。

## 9. 覆盖矩阵（2026-09-12）

| 功能域 | L1 命令面 | L2 数据链路 | L3 真实聊天 |
|---|---|---|---|
| 通用 CLI / UI | `general/run-lumii-cli-suite`、`run-ui-cli-suite` | — | — |
| 会话与对话体验 | general 冒烟（conversation list） | — | `chat/run-chat-core-suite` |
| 记忆（个人/场景/工作） | memory* 命令冒烟 | — | `chat/run-chat-memory-suite` |
| 上下文压缩 | context usage/messages | — | `chat/run-chat-compression-suite` |
| Wiki | wiki* 命令面 | `wiki/run-wiki-cli-suite`、三级分类 | `chat/run-chat-wiki-suite`（聊天摄入） |
| 自主进化 | autonomous 命令面 | `autonomous/run-autonomous-cli-suite` | `autonomous/run-autonomous-{e2e,full-e2e,life-e2e,planning-e2e}` |
| 云同步 | cloudsync status | `cloud-sync/run-cloud-sync-suite` | 缺口（多设备同步难以单机模拟，见各报告限制） |
| 工具进化 | tool-evolution* 命令面 | 缺口 | 缺口 |
| 技能 / 设置 / 桌宠 | 缺口（无专用套件） | — | — |

维护要求：新增功能域或套件时同步更新本矩阵；矩阵行「缺口」状态应逐步收敛。

---

## 附：常见陷阱清单（沉淀自实际执行）

1. `send --wait` 不存在——等待回合必须显式轮询。
2. 控制口失败也返回退出码 0 ——必须同时校验 `json.ok !== false`（`okJson` 三重校验）。
3. `help --json` 返回 `{commands:[...]}` 对象，不是数组。
4. `goto` 成功字段是 `ok` 而非 `success`；`cron list` 列表字段是 `jobs`；`screenshot` 返回 `refs`/`previewPath`（无 `jpeg`/`elements`）。
5. CLI 未知命令输出中文「未知命令」，不是 `Unknown`。
6. 移动脚本目录后必须同步 `ROOT` 相对层级，否则 CLI 路径解析失败（表现为全部用例 exit 3 / 控制口不可达）。
7. 应用运行中写 `user-memory.md` 等文件时，应用侧写入可能以内存旧内容覆盖（历史上迁移产物曾因此回滚）——迁移/写入类操作后必须立即回读验证。
8. `abort` 为尽力而为：不假设「中止即停止生成」（实测中止后长文仍完整落库）；生成期间发送的后续消息会排队——发送新回合前先等会话安静，并为排队预留更宽的超时窗口。
9. 测试消息可能经真实记忆链路写入全局 `user-memory.md`（提取链路正确工作的证据）——套件必须清理探针句（按行删除，不整文件恢复），避免污染用户真实记忆。
10. 日志路径陷阱：仓库根 `.lumii-dev.log` 内容停滞（历史遗留），实时日志在 `~/.lumii/logs/app/mtbot-<日期>.log`——用错文件会让注入类断言全部假阴性（首次 MEM-03 即此原因）。
