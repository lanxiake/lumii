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

1. **测试基线**：`apps/windows` 全量（`pnpm --filter ./apps/windows test:all`）**当前无既有失败**——旧账 39 个（8 文件）与 6 个（`command-allowlist` / `goto` / `feishu-login-service` / `wiki-commands` / `WikiTopicPicker`×2）已于 2026-09-15 先后清零；只剩满载跑序下偶发的 30 秒超时摆动位（`vcs-repo` / `performance-monitor` / `WikiGraphView` / `pet-model-resolver`），**单跑通过即视为摆动**。开工前仍按实测记录失败集合，完工后对比「不新增」；**各计划文档里写的旧数字（39 个等）以本条为准**。
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

### E2E 全量回归（2026-09-13 晚，AT 套件）

- 场景化套件 `docs/test/lumii-cli/agent-team/` 全量 18 用例（真实 LLM + claude CLI + tick）：逐项「设计验收对照」见用例文档 §五之二，综合报告见套件目录 `agent-team-report.md`。
- 首轮 16 例 **14 PASS**；两失败定位并处置（AT-UI-02 用例断言修正 / AT-L2-04 对云同步冲突互斥容错）；补测 AT-S8（维护代操设置）/ AT-S9（资讯管线归属）一次通过。
- 连带修复：**中止云同步冲突处理导致的 tick 互斥泄漏**（`bridge.ts` 冲突处理执行加超时兜底，否则自主心跳静默停摆）；另记录「控制口全局串行队列被长任务占用」问题，建议后续评估。

---

## 七、后续计划（阶段 1 之后）

阶段 1（A/B/C/D）完成后，专项 Agent 线按以下计划继续推进，体例同上（小步快跑，每片独立提交 / 验证 / 回滚）：

| # | 计划 | 范围 | 状态 |
|---|---|---|---|
| 05 | [队长制：主助手接团队](./05-队长制-主助手接团队.md) | 主助手看见团队（F1）、桌面一键转交（F2）、渠道一键转交（F3） | F1 / F2 完成；F3 代码完成，QQ 复核待跑 |
| 06 | [体验深挖：地基篇](./06-体验深挖-地基篇.md) | G1 共享层修正、G2 通知补点、G3 委托可见、G4 协作通路 | G1-G4 代码完成；DD 套件（`docs/test/lumii-cli/agent-deepdive/`）已跑 |
| 07 | [新手指引](./07-新手指引.md) | 功能目录与只读工具、向导体验、使用统计、主动推荐、会话内推荐、询问组件优化、指南应用内入口 | 片 6 代码完成待人工验收；其余待开工 |
| 08 | [委托可见性：身份与过程](./08-委托可见性.md) | P1 名称与身份统一、P2 子 Agent 过程归属、P3 中断残留收尾 | P1 / P2 / P3 代码完成，待人工验收 |
| 09 | [项目上下文路由](./09-项目上下文路由.md) | P1 工具沙箱纳入已注册项目、P2 转交提案携带项目、P3 无绑定不静默降级、P3b ACP 失败落库与监听判定 | P1 / P2 / P3 / P3b 代码完成，待人工验收 |
| 10 | [渠道会话路由重构](./10-渠道会话路由重构.md) | S1 接续开关归位、S2 渠道身份落库、S3 路由单一真相源（+开发上下文跟随会话）、S4 接续改提示式、S5 入口裁决与「1」消歧、S6 卫生清理 | S1-S6 代码完成，待人工验收 |

> 10 的背景：2026-09-15 排查「渠道转交结果没回到渠道」时发现会话路由的状态散落三处（adapter 内存 Map / ChannelSessionStore / 微信 /link），且**sessionKey 前缀 ≠ 此刻服务它的渠道**（同一个 `qbot:` 键先后被微信与 QQ 适配器服务）。详见该文档 §一、§二。

> 09 的背景：2026-09-14 排查「客户端未把项目级任务转交给灵栖开发」时发现**两层失败**——主助手因适用域过窄未转交，且即使转交也进不了项目目录（`resolveDevContext` 只认 dev-context 与 `codingDevAgentBindings`，`codingDevProjects` 不参与）。详见该文档 §一。
