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
