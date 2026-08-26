# Agent 能力全面测试用例

- 日期：2026-08-27
- 覆盖范围：主 Agent 任务执行、子 Agent 调度（sync/async）、打断与级联中止、工具链（技能/记忆/Wiki/搜索/文件）、复杂多步编排、边界与护栏（并发/深度）
- 设计/实现锚点：`docs/plans/AGENT优化/2026-08-26-agent-subagent-p0p1-implementation.md`；运行时 `packages/agent-runtime`；控制口 CLI `apps/windows/resources/app-ui-cli/lumii-ui.mjs`
- 执行方式：**以 lumii-ui CLI + 真实模型 + 真实数据为主**；单元测试仅作辅助，不计入本套件通过门槛
- 配套报告：`docs/test/2026-08-27-agent-capability-test-report.md`

---

## 0. 通用约定

### 0.1 CLI 契约

| 项 | 值 |
|---|---|
| CLI | `node apps/windows/resources/app-ui-cli/lumii-ui.mjs` |
| 启动/停止 | `pnpm dev:start` / `pnpm dev:stop` |
| 主进程日志 | 仓库根目录 `.lumii-dev.log` |
| 会话 | `conversation create` → `sessionKey`；发消息 `send --session <key> --text "..."` |
| 打断 | `send abort --session <key>`（运行时生效；CLI 偶发 `command_failed` 响应瑕疵，以日志为准） |
| 读回 | `context messages --session <key> [--limit n]`（正文在 `items[].contentJson` 的 `assistant_parts`） |

### 0.2 日志锚点（断言用）

| 锚点 | 含义 |
|---|---|
| `[SubagentBroker] acquire ok` / `acquire denied` | 并发槽占用 / 超限拒绝 |
| `[SubagentBroker] registerRun` / `finalizeRun` | 子 Agent 注册与结束 |
| `[AgentOrchestrator] spawn async started` / `spawn denied concurrency` | 异步启动 / 并发拒绝 |
| `[AgentRuntime] [subagent-delivery] prompt(internal)` | 父 idle 时内部投递 |
| `[AgentRuntime] [subagent-delivery] followUp` | 父 running 时续轮投递 |
| `[AgentRuntime] [subagent] delivered mode=` | 投递成功 |
| `[AgentRuntime] [subagent] child destroyed after delivery` | 投递后销毁 |
| `[AgentRuntime] [Subagent] complete` | IPC 完成事件 |
| `[AgentRuntime] Aborted agent (cascade)` | 打断级联 |
| `[AgentRuntime] [abortSession]` | 会话中止 |
| `stopReason: aborted` | 消息以中止结束 |
| `[ToolRunner] → <tool>` / `← <tool>` | 工具调用边界 |

### 0.3 判真规则

1. **禁止**仅用用户提示词中的关键字冒充通过（例如提示里写了 `SYNC_OK` 不算）。
2. 工具类断言必须看到 `contentJson` 中 `type=tool` 的真实 `result`，或日志 `ToolRunner`。
3. 子 Agent 完成必须看到 `finalizeRun` + `delivered`（async）或 sync 工具返回中的 `output`/`status=ok`。
4. 打断必须以日志 `Aborted agent` / `stopReason: aborted` 为准，不以 CLI stdout 成败为准。
5. 复杂任务必须以「多工具真实调用 + 最终结构化答复」同时满足才算通过。

### 0.4 调试日志前缀

- 人工/脚本：`[AGENT-CAP-TEST][<CASE-ID>][<阶段>]`，阶段 ∈ {准备, 执行, 断言, 清理, 结束}
- 脱敏：sessionKey 仅记前 8 位；禁止写入 token / API key

### 0.5 套件总览

| 套件 | 目标 | 依赖模型 |
|---|---|---|
| A 冒烟 | CLI↔运行时可用 | 否 |
| B 基础对话 | 单轮/多轮、指令遵循 | 是 |
| C 子 Agent 调度 | sync/async、投递分流、综合 | 是 |
| D 打断与恢复 | abort、级联、恢复可聊 | 是 |
| E 工具能力 | skill/memory/wiki/search/file/bash（按环境） | 是 |
| F 复杂编排 | 多工具 + 子 Agent + 结构化交付 | 是 |
| G 边界护栏 | 并发上限、深度/子工具限制 | 是 |
| H 会话运维 | usage、messages、（可选 compact） | 部分 |

---

## A 套件 — 冒烟（不依赖模型）

### A-01 应用运行时可列工具
- 命令：`tools list`
- 预期：JSON 含 `spawn_agent`，且为启用态（或可识别为 available）
- 失败：`connection_failed` / 无 `spawn_agent`

### A-02 可创建会话
- 命令：`conversation create --title agent-cap-smoke`
- 预期：返回 `sessionKey`
- 失败：无 sessionKey

### A-03 可读取空/新会话消息
- 命令：`context messages --session <key> --limit 5`
- 预期：`items` 数组（可为空）
- 失败：连接错误

### A-04 未知命令退出
- 命令：`lumii-ui no-such-cmd-xyz`
- 预期：非 0 或明确未知命令提示

---

## B 套件 — 基础对话与指令遵循

### B-01 最短指令遵循
- 步骤：`send`「只回复四个字：测试通过」
- 预期：assistant 可见文本含「测试通过」；无无关长文
- 失败：未回复 / 明显跑题且未含关键字

### B-02 多轮上下文保持
- 步骤：
  1. `send`「记住暗号 ALPHA-42，之后只复述暗号」
  2. `send`「暗号是什么？」
- 预期：第二轮回复含 `ALPHA-42`
- 失败：否认记忆或答错

### B-03 拒绝编造工具结果（诚实性）
- 步骤：`send`「不要调用任何工具。用一句话说明你没有调用工具。」
- 预期：无 `ToolRunner →`；回复承认未调工具
- 失败：偷偷调工具

---

## C 套件 — 子 Agent 调度

### C-01 sync 子 Agent
- 提示要点：`spawn_agent mode=sync agentType=builtin:explore name=sync-1 prompt=只回复：SYNC_OK`
- 预期：
  - 日志 `registerRun ... mode=sync` + `finalizeRun ... succeeded`
  - 工具结果含 `SYNC_OK` 或等价 output
- 失败：未调用 / 超时无 finalize

### C-02 双 async 并行 + 投递分流
- 提示要点：两次 `mode=async`（`async-a` / `async-b`），等待两条完成通知后汇总
- 预期：
  - 两次 `spawn async started`
  - 至少一次 `prompt(internal)` 与一次 `followUp`（顺序依赖完成时序，允许两次同模式但须均 `delivered`）
  - 两次 `child destroyed after delivery`
  - 父最终汇总含两子结果关键字
- 失败：有 finalize 无 delivered；或父编造结果且无投递日志

### C-03 sync 后接 async 混合调度
- 提示要点：先 sync 再两个 async，三行列出结果
- 预期：三种 spawn 均真实发生；最终表格式/列表汇总正确
- 失败：跳过某模式或未等 async 完成

### C-04 子 Agent 完成 IPC
- 依赖：C-02 或 C-03
- 预期：日志出现 `[Subagent] complete` 对应每个 async 子
- 失败：无 IPC 完成日志

---

## D 套件 — 打断与恢复

### D-01 父任务中途 abort
- 步骤：发起长任务（多工具 + 长文）→ 出现首个 `ToolRunner` 或 `prompt start` 后 `send abort`
- 预期：`Aborted agent` + `abortSession` + `stopReason: aborted`
- 失败：任务无中止迹象继续跑完长文

### D-02 abort 后会话可恢复
- 依赖：D-01
- 步骤：再 `send`「只回复：恢复成功」
- 预期：assistant 含「恢复成功」
- 失败：会话卡死 / 无法再 send

### D-03 含子 Agent 的级联 abort
- 步骤：spawn 两个长跑 async 子 → 两子 `registerRun` 后 `send abort`
- 预期：父与子均出现 `Aborted agent (cascade)`（或等价 cascade 日志）
- 失败：仅父停、子仍长时间 finalize succeeded 且继续投递（允许极短竞态，但应看到 cascade）

---

## E 套件 — 单项工具能力

> 每条均要求真实 `ToolRunner`；无结果时允许「空结果诚实汇报」，禁止编造命中。

### E-01 skill_search
- 提示：搜索 `agent`，回报命中数量与名称
- 预期：`ToolRunner → skill_search`；回复含真实技能名（若环境有）

### E-02 memory_search
- 提示：搜索 `agent`，有则摘一句，无则写「无命中」
- 预期：`ToolRunner → memory_search`；不编造 id

### E-03 wiki_search 或 wiki_overview
- 提示：先 overview 或 search `agent`；无库则诚实说明
- 预期：对应工具调用成功（`isError=false`）

### E-04 web_search（若启用）
- 提示：搜索一个中性技术词并一句话总结
- 预期：工具调用；失败时明确报错而非假链接

### E-05 file_read / bash（沙箱内）
- 提示：读取仓库内一个已知小文件或 `bash` 执行无害命令（如 `echo CAP_TEST_OK`）
- 预期：工具成功；输出含预期片段
- 跳过条件：工具被 disable 或权限拒绝（记 `SKIP` 并写原因）

### E-06 工具开关可观测
- 步骤：`tools toggle web_search off` → 要求调用 web_search → 再 `on` 恢复
- 预期：关闭期间调用失败或不可用；恢复后可用（或列表状态变化）
- 注意：测完必须恢复 `on`，避免污染环境

---

## F 套件 — 复杂任务编排

### F-01 多工具流水线 + 子 Agent
- 步骤强制顺序：
  1. `skill_search`
  2. `memory_search`
  3. `spawn_agent` async explore
  4. 等待 `[SUBAGENT_COMPLETE]`
  5. 输出固定报告模板（含 DONE）
- 预期：三工具均真实调用；子 delivered；报告字段齐全
- 失败：缺工具 / 未等子完成 / 无 DONE

### F-02 计划—执行—校验
- 提示：先用文字列出 3 步计划，再逐步用工具执行，最后自检「哪一步用了什么工具」
- 预期：存在 ≥2 种不同工具；自检列表与日志工具集合一致
- 失败：只聊天不调用；或自检与日志严重不符

### F-03 并行子任务综合（轻量调研）
- 提示：两个 async explore 分别回答两个简短事实性问题，父综合对比异同（各一句）
- 预期：双 spawn + 双 delivered + 综合答复非复制粘贴单一结果
- 失败：只开一个子 / 未综合

### F-04 错误恢复
- 提示：故意让子 Agent 使用不存在的 `agentType`（或非法参数）一次，再纠正重试成功一次
- 预期：首次工具返回 error；第二次 ok
- 失败：崩溃会话或无法恢复

---

## G 套件 — 边界与护栏

### G-01 并发上限拒绝
- 提示：连续 6 次 async spawn（c1…c6），立即列出每次工具原文
- 预期：前 5 次 ok；第 6 次 error 含 concurrency / max 5；日志 `acquire denied` + `spawn denied concurrency`
- 失败：6 次全 ok 或无明确错误

### G-02 深度/子侧无法再 spawn（行为级）
- 提示：父 async spawn 子，并指令子再 `spawn_agent`
- 预期（满足其一即可）：
  - 子未出现 `spawn_agent` 成功嵌套；或
  - 出现 depth deny；或
  - 子改用其它工具且未产生孙 `registerRun`
- 失败：出现孙 Agent `registerRun` 且父为子、子为孙的两级成功链

### G-03 stale monitor 启动
- 预期：任意首次 orchestrator 创建后日志含 `startStaleMonitor`
- 失败：长期无 monitor（本项观察性，不单独阻塞发布，记 WARN）

---

## H 套件 — 会话运维

### H-01 context usage
- 命令：`context usage --session <key>`
- 预期：返回 usedTokens / contextWindow 等字段（允许 0）

### H-02 context messages 分页/limit
- 命令：`context messages --session <key> --limit 10`
- 预期：`items.length ≤ 10`

### H-03（可选）手动 compact
- 前置：会话足够长
- 命令：`context compact --session <key>`
- 预期：返回压缩前后计数；失败则记 SKIP（不阻塞 Agent 能力结论）

---

## 执行清单（建议顺序）

1. A-01 → A-04  
2. B-01 → B-03  
3. C-01 → C-04  
4. D-01 → D-03  
5. E-01 → E-06（按工具可用性）  
6. F-01 → F-04  
7. G-01 → G-03  
8. H-01 → H-02（H-03 可选）  
9. `pnpm dev:stop`，填写报告

## 通过门槛（本轮「能力可用」定义）

- **必须通过**：A 全过；C-01、C-02、C-04；D-01、D-03；F-01；G-01  
- **应通过**：B-01、B-02、E-01、E-02、D-02、F-03  
- **允许 SKIP**：E-04/E-05/E-06/H-03（环境或权限限制时须写原因）  
- **任一必须项失败** → 总评失败
