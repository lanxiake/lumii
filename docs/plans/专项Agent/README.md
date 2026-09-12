# 专项 Agent · 阶段 1 实施计划

> 创建：2026-09-13
> 前置设计：[专项 Agent 设计（一等公民）](../../design/专项AGENT/专项Agent设计.md)（v3.1，§9 实施路线）
> 原则：小步快跑——每片可独立提交、独立验证、可单独回滚；完成一片结算一片（体例参考 [客户端优化](../客户端优化/README.md)）。
> 状态：**未开工**。开工时把切片总表的状态列改为进行中/已完成。

---

## 一、切片总表

| 片 | 范围 | 体量 | 风险 | 前置 | 计划 |
|---|---|---|---|---|---|
| **A · 运行时贯通** | cron 归属修正、tick 多 Agent 遍历、`evolution:` 会话泛化、per-agent 自主开关、失败可见性 | main 3 文件 + AgentsPage | 中（动自主引擎编排层） | 无 | [01-运行时贯通.md](./01-运行时贯通.md) |
| **B · code-dev 闭环** | 开发上下文（项目+工具）、`/project`、会话级后端、per-run cwd 与渠道接线、多轮续接、模式 chip、权限参数、退出清理、绑定 UI | main 9 文件 + renderer 4 文件 | 中高（跨桌面 + 双渠道 + CLI 参数） | A | [02-code-dev闭环.md](./02-code-dev闭环.md) |
| **C · system-keeper** | 定义与两档工具面、运维手册技能、四个维护闭环（记忆 / Wiki / 指南 / 客户端自动化） | 定义 + skill + 少量 main | 低（新增为主） | A1/A2/A3 | [03-system-keeper.md](./03-system-keeper.md) |
| **D · 团队转正** | `chronicler` / `info-curator` 定义 + 6 条预置任务迁移 | 定义 + seed 迁移 | 低（只换执行者，口径不变） | A + B1 + C1/C2 的定义模式 | [04-团队转正.md](./04-团队转正.md) |

**执行顺序**：A → B → C → D。B 内部 B1→B5 有依赖链，按文档编号执行；C 不依赖 B 的任何一项，可与 B 交替。

## 二、共同基线（每片开工前先跑一遍）

1. **测试基线**：`apps/windows` 的完整测试存在既有失败（约 39 个 / 8 个文件，以开工实测为准）——不是本计划引入。开工前记录失败集合，完工后对比「不新增」。
2. **重启纪律**：改主进程后必须重启应用（`pnpm dev:restart`；被单实例锁拦住时用 `stop-dev.ps1 -KillAllElectron` 清干净再起）。
3. **心跳红线**：任何与自主 / 心跳相关的验证前，先查 `SELECT COUNT(*) FROM messages WHERE is_streaming=1`，非 0 先清理（abort 残留占位会让心跳全部空转，有两次稳定复现的教训）。
4. **回归套件**：自主相关统一跑 `docs/test/lumii-cli/run-autonomous-life-e2e.mjs`（23 用例）与 `run-autonomous-full-e2e.mjs`（11 用例）。
5. **渠道验证**：微信 / 飞书的手工验证需要真实账号在运行中的 app 上做，不能只靠单测。

## 三、回归门槛（阶段 1 收尾时全绿）

- [ ] `run-autonomous-life-e2e.mjs`（23 用例）全绿
- [ ] `run-autonomous-full-e2e.mjs`（11 用例）全绿
- [ ] `apps/windows` 失败集合与基线一致（不新增）
- [ ] 手工验收：见各片文档「验收」节（开发上下文 / 多轮续接 / 渠道 `/project` / 记忆精炼 / 团队迁移口径）

## 四、明确不做（本阶段）

| 项 | 理由 |
|---|---|
| 双层 Agent 循环、code-dev 自主 | 设计 §5.1 |
| 研究 / 创作 / 日程常驻 Agent | 设计 §2.5「克制」 |
| per-agent 预算、信箱新表、L1/L2/L3 分级 | 设计 §9「明确不做」 |
| 卡死检测（无进展）、变更摘要 / 一键重启、会话接续 | 设计 阶段 2 |

## 五、设计文档缺口记录（实施时顺手核对）

以下行号取自 2026-09-13 工作区，实施时若漂移以代码为准：

| 引用点 | 当前状态 |
|---|---|
| `bridge.ts:1129-1151` cron saveMessage / addMemory 注入 | 已核对，签名待扩 agentId |
| `evolution-tick.ts:25` `EVOLUTION_AGENT_ID` | 已核对，硬编码 |
| `conversation-commands.ts:293 / :582` 精确匹配 | 已核对（设计只记了删除守卫一处，实际有两处） |
| `bridge.ts:1223` `hasActiveUserTurn` SQL | 已核对 |
| `user-commands.ts:197-218` ACP 分支 | 已核对，未传 cwd |
| 渠道 `getBackend(channelUserId, sessionKey)` | 微信 `:346`、飞书 `:322`，未传 cwd |

---

## 六、实施记录（2026-09-13）

**A/B/C/D 四片代码全部落地，自动验证通过；人工验收项见下表。**

| 片 | 状态 | 自动验证 | 待人工验收 |
|---|---|---|---|
| A · 运行时贯通 | ✅ 完成 | 相关单测 37 例 + agent-runtime 全量 512 例绿 | app.json 配 autonomousAgents 后 tick 汇总串；失败目标落会话 + 通知 |
| B · code-dev 闭环 | ✅ 完成 | 单测 31 例（解析器/runner/dev-context/acp-run）+ 两包 typecheck 绿 | 桌面两会话双项目互不串；微信 `/project`（列表/切换/off）；两轮续接（日志含 `--resume`）；codex 真实写文件；退出应用无 CLI 残留 |
| C · system-keeper | ✅ 完成 | 单测 40 例（goal-executor/tick-signals）；手册技能文件已入库 | 重启后选择器出现「灵栖维护」；`skill_invoke` 加载手册；记忆精炼/Wiki 策展/指南同步演练 |
| D · 团队转正 | ✅ 完成 | seed 测试 14 例绿 | 老库升级迁移查库（4 条 → chronicler、news-pipeline → info-curator，用户改过的不动）；`cron run seed-daily-report` 口径与迁移前一致 |

### 实施中的实测校准（已回填设计 §4.1/§5.7/附录 A.5）

- **codex**：Windows 上 `-s workspace-write` 仍无法写文件（沙箱不可用，写失败但模型回复"完成"）；`--dangerously-bypass-approvals-and-sandbox` 实测可写 → `buildLocalCliArgs` 按平台自动选择。
- **claude**：查明默认可写来自用户 `~/.claude/settings.json` 的 `defaultMode=bypassPermissions` → 实现取「不显式传参、尊重用户 CLI 配置」（显式 `acceptEdits` 会拒 Bash 类工具，挡住"跑测试"）。
- **cursor-agent**：本机未登录（`agent login` / `CURSOR_API_KEY`），`-f`/`--trust` 行为待登录后实测（代码暂保留 `--trust` + resume）。
- **codex 失败可见性**：写文件失败事件（`item.completed / file_change status:"failed"`）已被解析器识别为失败工具卡片——修复了"模型说完成、用户以为改好了"。

### 实施中新增（计划未列，均为补漏）

- 设置面板新增「默认编码后端」下拉——桌面 `/claude` 改会话级后，全局默认需 UI 入口（B3 的补漏）。
- codex 解析器新增 `file_change` 事件识别（含失败态）。
- `conversation:delete` 同步清理该会话的 CLI 续接键（4 后端）。
