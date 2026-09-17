# Lumii CLI 真实环境测试

本目录存放 `lumii-ui` CLI 的 **完整可测路径** 用例、执行器与报告。所有套件通过 CLI 驱动**真实运行的客户端**（控制口 `~/.lumii/runtime/app-ui.json`），不依赖 mock。

📐 **测试规范**：见 [CLI-TEST-SPEC.md](./CLI-TEST-SPEC.md)——分层定义（L1 命令面 / L2 数据链路 / L3 真实聊天模拟）、用例写法、证据格式、命名约定、副作用控制。

## 目录结构

```
docs/test/lumii-cli/
├── CLI-TEST-SPEC.md       # 测试规范（必读）
├── lib/cli-harness.mjs    # chat 套件共享库（新套件专用）
├── general/               # 通用 CLI：help/UI/错误处理
├── chat/                  # 真实聊天模拟（L3）：核心对话/记忆/压缩/Wiki 摄入
├── wiki/                  # Wiki 知识库专项
├── autonomous/            # 自主进化专项（含原「自主进化Agent」套件，2026-09-17 合并）
├── agent-capability/      # Agent 能力全面测试（A–H 套件）
├── agent-team/            # 一等公民 Agent 团队：场景化旅程（成员会话/日报送达/开发模式续接）
├── channel-routing/       # 渠道会话路由（CR）：手工用例——跨渠道接续/路由/项目跟随/转交回流
├── agent-curation/        # 灵栖情报/维护专项（CK）：任务归属与职责能力
├── prompt-style/          # 提示词风格实验（PS）：两档转储形态 + 真实任务双档对照
├── agent-deepdive/        # 体验深挖 · 地基篇（G1-G4）真实使用旅程 E2E
├── cloud-sync/            # 云同步专项（含 GitCode 真实同步用例）
└── materials/             # 真实文档样本（docx/mp4/PDF，gitignore 不提交）
```

## 测试套件

### 渠道会话路由（channel-routing/）

| 文件 | 说明 |
|---|---|
| [channel-routing-test-cases.md](./channel-routing/channel-routing-test-cases.md) | **手工**用例 CR-01~CR-18：迁移与开关、转交结果回流、身份分组、路由一致性、项目跟随、接续提示、卫生回归 |

> 本套件是**手工执行**（不走 CLI harness）：要点分布在客户端界面、渠道消息与真实 CLI 三处，
> 且涉及「跨渠道续聊」这类难以脚本化的时序，脚本化收益低于维护成本。执行前置见文档 §零。

### 通用 CLI（general/）

| 文件 | 说明 |
|---|---|
| [lumii-cli-test-cases.md](./general/lumii-cli-test-cases.md) | 用例：Help/UI/错误处理（部分命令已删，见文首过时标注） |
| [run-lumii-cli-suite.mjs](./general/run-lumii-cli-suite.mjs) | 冒烟执行器：help/screenshot/goto/wiki/agent/cron/memory + 错误处理 |
| [run-ui-cli-suite.mjs](./general/run-ui-cli-suite.mjs) | UI 交互执行器：截图/点击/导航综合 |

### 真实聊天模拟（chat/）— L3 最接近用户真实操作

| 文件 | 说明 |
|---|---|
| [chat-test-cases.md](./chat/chat-test-cases.md) | 四域用例：核心对话体验 / 记忆链路 / 上下文压缩 / Wiki 摄入 |
| [run-chat-core-suite.mjs](./chat/run-chat-core-suite.mjs) | 发送→回复→持久化、编辑/重发/中止、会话隔离 |
| [run-chat-memory-suite.mjs](./chat/run-chat-memory-suite.mjs) | 偏好落盘、场景记忆命中注入（正/负例）、`scene_memory` 工具 |
| [run-chat-compression-suite.mjs](./chat/run-chat-compression-suite.mjs) | 手动/自动压缩、摘要就位、压缩后继续对话 |
| [run-chat-wiki-suite.mjs](./chat/run-chat-wiki-suite.mjs) | 聊天中分享内容→摄入→检索回来 |

### Wiki 专项（wiki/）

| 文件 | 说明 |
|---|---|
| [wiki-p0-test-cases.md](./wiki/wiki-p0-test-cases.md) | P0：收件箱闭环、金标检索、页面、索引、GAP |
| [wiki-p1-test-cases.md](./wiki/wiki-p1-test-cases.md) | P1：双链、修订回滚、清理导出、GAP |
| [wiki-p2-test-cases.md](./wiki/wiki-p2-test-cases.md) | P2：综述 accept/reject、图谱、hybrid、状态 GAP（旧命令） |
| [wiki-p3-test-cases.md](./wiki/wiki-p3-test-cases.md) | 记忆重构三期：知识图谱新模型、按资料抽实体、实体反查 |
| [wiki-p1-implementation-test-cases.md](./wiki/wiki-p1-implementation-test-cases.md) | 记忆重构一期：用途两级目录、口诀分类器、切断聊天摄入 |
| [wiki-p2-implementation-test-cases.md](./wiki/wiki-p2-implementation-test-cases.md) | 记忆重构二期：主题树编辑、重新编目、综述改产资料 |
| [run-wiki-cli-suite.mjs](./wiki/run-wiki-cli-suite.mjs) | Wiki 全子命令 + `command` GAP 执行器 |
| [run-wiki-real-materials-suite.mjs](./wiki/run-wiki-real-materials-suite.mjs) | 真实文档（materials/）摄入→归档→检索→打开 端到端 |
| [run-wiki-three-level-classification-test.mjs](./wiki/run-wiki-three-level-classification-test.mjs) | 三级分类落库链路（历史模型） |
| 各 `*-report.md` / `*-evidence.jsonl` | 最新报告与逐条证据 |

### 自主进化专项（autonomous/）

| 文件 | 说明 |
|---|---|
| [autonomous-test-cases.md](./autonomous/autonomous-test-cases.md) | 15 条 DB/算法用例（SQL 播种 + CLI 回读） |
| [p1-test-cases.md](./autonomous/p1-test-cases.md) | P1 能力边界检测与自我反思（15 条）。**原在 `自主进化Agent/` 套件，2026-09-17 并入本目录** |
| [autonomous-life-test-cases.md](./autonomous/autonomous-life-test-cases.md) | 心跳 tick/主动消息/Mood/牵挂/日记/token 预算 |
| [autonomous-effectiveness-test-cases.md](./autonomous/autonomous-effectiveness-test-cases.md) | **有效性验证（EVO-A/B/C）**：变体淘汰学习 / 短板闭环 / 生命感——回答「是否真的有用、能否真的自主进化」 |
| [run-autonomous-cli-suite.mjs](./autonomous/run-autonomous-cli-suite.mjs) | 数据链路执行器 |
| [run-autonomous-p1-cli.mjs](./autonomous/run-autonomous-p1-cli.mjs) | P1 能力边界/反思执行器（原 `run-p1-cli-suite.mjs`，2026-09-17 随套件并入并改名） |
| [run-autonomous-e2e.mjs](./autonomous/run-autonomous-e2e.mjs) | 真实对话触发回合结束管道（满意度/能力/进化反馈） |
| [run-autonomous-full-e2e.mjs](./autonomous/run-autonomous-full-e2e.mjs) | 全链路：目标→执行→审批→反思 |
| [run-autonomous-life-e2e.mjs](./autonomous/run-autonomous-life-e2e.mjs) | 生命化：心跳/主动消息/日记/预算 |
| [run-autonomous-planning-e2e.mjs](./autonomous/run-autonomous-planning-e2e.mjs) | 主动规划链路 |
| [run-autonomous-effectiveness-e2e.mjs](./autonomous/run-autonomous-effectiveness-e2e.mjs) | **有效性加速实验执行器**（EVO_ONLY=A/B/C、EVO_DIGEST_ONLY、EVO_SKIP_LLM 等开关） |
| [autonomous-effectiveness-report.md](./autonomous/autonomous-effectiveness-report.md) | 有效性验证报告（含三问结论、缺陷清单、条件清单） |

### 一等公民 Agent 团队（agent-team/）— 场景化用户旅程

| 文件 | 说明 |
|---|---|
| [agent-team-test-cases.md](./agent-team/agent-team-test-cases.md) | 旅程地图 + 用例：找成员办事（开发/维护/情报）、日报送达、开发模式续接、日常回归 + L1/L2 数据链路 |
| [run-agent-team-e2e.mjs](./agent-team/run-agent-team-e2e.mjs) | 执行器（`AT_ONLY=S3` 选择性运行、`AT_SKIP_LLM=1` 离线只跑 L1/L2、`AT_SKIP_CLI=1` 跳过 claude 场景、`AT_TICK=1` 启用 tick 条件用例） |
| [agent-team-report.md](./agent-team/agent-team-report.md) | 最新报告（含副作用声明与覆盖限制） |

### 灵栖情报 / 维护专项（agent-curation/）— 归属与职责能力

| 文件 | 说明 |
|---|---|
| [agent-curation-test-cases.md](./agent-curation/agent-curation-test-cases.md) | 用例 CK-01~CK-08：任务归属与会话可见性（L1/L2）+ 职责能力（L3：维护读全用户记忆、情报回读资讯卡、资讯任务落成新一期、体检报告落库） |
| [run-agent-curation-e2e.mjs](./agent-curation/run-agent-curation-e2e.mjs) | 执行器（`CK_ONLY=CK-05,CK-08` 选择性运行、`CK_SKIP_LLM=1` 离线只跑 L1/L2） |
| [agent-curation-report.md](./agent-curation/agent-curation-report.md) | 最新报告 |

> 与 AT 套件的分工：AT 覆盖**团队协作旅程**（主助手接单、委托、转交）；CK 覆盖**这两个 Agent 自身**
> 的归属与取数能力。AT-S9 只按预置 id 断言 news-pipeline，用户自建的资讯任务与手动抓取路径都不在其覆盖内。

### 体验深挖 · 地基篇（agent-deepdive/）

| 文件 | 说明 |
|---|---|
| [agent-deepdive-test-cases.md](./agent-deepdive/agent-deepdive-test-cases.md) | G1–G4 真实使用旅程 E2E 用例 |
| [run-agent-deepdive-e2e.mjs](./agent-deepdive/run-agent-deepdive-e2e.mjs) | 执行器（父进程编排：并行 + UI 串行） |
| [agent-deepdive-report.md](./agent-deepdive/agent-deepdive-report.md) | 最新报告 |

### 提示词风格实验（prompt-style/）— 两档对照

| 文件 | 说明 |
|---|---|
| [prompt-style-test-cases.md](./prompt-style/prompt-style-test-cases.md) | 用例：提示词转储形态（硬）+ 真实任务双档对照（定时提醒/代码小任务/会话连续性）+ 人工验证补充 |
| [run-prompt-style-e2e.mjs](./prompt-style/run-prompt-style-e2e.mjs) | 执行器（`PS_ONLY=PS-LOG` 选择性运行、`PS_NO_RESTORE=1` 保留风格切换、末尾自动恢复原风格） |

### 云同步专项（cloud-sync/）

| 文件 | 说明 |
|---|---|
| [run-cloud-sync-suite.mjs](./cloud-sync/run-cloud-sync-suite.mjs) | Schema/导出 JSONL/merge 规则/完整同步流程 |
| [sync-e2e-test-cases.md](./cloud-sync/sync-e2e-test-cases.md) | 端到端同步用例（本地 smart-HTTP git 远程，A–E 组） |
| [gitcode-sync-test-cases.md](./cloud-sync/gitcode-sync-test-cases.md) | GitCode 真实远程同步用例（Track A/B，需真实私有仓库与令牌）。**原在 `test/` 根，2026-09-17 归入本套件** |
| [cloud-sync-cli-test-report.md](./cloud-sync/cloud-sync-cli-test-report.md) | 最新报告 |

### Agent 能力全面测试（agent-capability/）

| 文件 | 说明 |
|---|---|
| [agent-capability-test-cases.md](./agent-capability/agent-capability-test-cases.md) | 全面测试用例（A–H 套件） |
| [agent-capability-report.md](./agent-capability/agent-capability-report.md) | 执行报告与结论 |
| [run-agent-capability-suite.mjs](./agent-capability/run-agent-capability-suite.mjs) | E2E 执行器（主套件） |
| [run-agent-capability-suite-continue.mjs](./agent-capability/run-agent-capability-suite-continue.mjs) | 中断后续跑 |
| [run-agent-capability-skipped.mjs](./agent-capability/run-agent-capability-skipped.mjs) | SKIP 项 + abort CLI 补跑 |

> 本套件 2026-09-17 从 `test/` 根迁入，执行器内的 `ROOT` 已同步改为 4 层（`'../../../..'`）——迁移脚本目录后必须核对这一处，否则全部用例 exit 3。

### 测试素材（materials/，不提交 Git）

真实文档样本（docx/mp4/PDF），供 `run-wiki-real-materials-suite.mjs` 端到端摄入使用。目录被 `.gitignore` 忽略，需手动放置；套件在目录缺失时快速失败。

## 前置条件

1. **Lumii 桌面应用已运行**（`pnpm dev` 或安装版），控制口 `~/.lumii/runtime/app-ui.json` 可读
2. **chat/ 套件额外要求**：
   - chat 模型已配置（真实 LLM 调用）
   - 日志文件可读（`~/.lumii/logs/app/mtbot-<日期>.log`）——注入/工具调用类日志断言依赖；缺失时相关断言降级为 SKIP
3. Wiki 套件可选：`WIKI_CLI_SKIP_AGENT=1`（跳过模型调用）、`WIKI_CLI_ALLOW_DELETE=1`（仍默认不删业务 source）
4. 应用未运行时的行为：套件检测控制口失败后 exit 3（部分老脚本可能不检测）

## 执行方式

```bash
# 通用冒烟
node docs/test/lumii-cli/general/run-lumii-cli-suite.mjs

# 真实聊天（四域，可分批）
node docs/test/lumii-cli/chat/run-chat-core-suite.mjs
CHAT_ONLY=MEM node docs/test/lumii-cli/chat/run-chat-memory-suite.mjs

# Wiki
node docs/test/lumii-cli/wiki/run-wiki-cli-suite.mjs
WIKI_CLI_SKIP_AGENT=1 node docs/test/lumii-cli/wiki/run-wiki-cli-suite.mjs

# 自主进化
node docs/test/lumii-cli/autonomous/run-autonomous-e2e.mjs
# 自主进化有效性验证（EVO 加速实验，A/B/C 可分批；产物含结论报告）
EVO_ONLY=A node docs/test/lumii-cli/autonomous/run-autonomous-effectiveness-e2e.mjs

# 一等公民 Agent 团队（场景化；S1-S6 真实 LLM）
node docs/test/lumii-cli/agent-team/run-agent-team-e2e.mjs
AT_ONLY=S3 node docs/test/lumii-cli/agent-team/run-agent-team-e2e.mjs     # 只跑「记偏好」场景
AT_SKIP_LLM=1 node docs/test/lumii-cli/agent-team/run-agent-team-e2e.mjs # 离线只跑 L1/L2

# 云同步
node docs/test/lumii-cli/cloud-sync/run-cloud-sync-suite.mjs
```

通用环境变量（chat 套件）：`CHAT_ONLY=<用例ID前缀>` 过滤、`CHAT_SKIP_LLM=1` 跳过真实 LLM 用例、`CHAT_TURN_TIMEOUT_MS` 回合超时、`LUMII_CLI_VERBOSE=1` 详细日志。

## 最近执行（2026-09-12 ~ 09-13，真实客户端）

| 套件 | 结果 | 说明 |
|---|---|---|
| `general/run-lumii-cli-suite.mjs` | **14/14** | 断言已对齐当前命令面（修复 9 处过时断言） |
| `chat/run-chat-core-suite.mjs` | **8/8** | 发送/编辑/重发/中止/隔离/参数错误/列表 |
| `chat/run-chat-memory-suite.mjs` | **8/9**（1 SKIP） | 场景记忆注入正/负例、`scene_memory` 写入、无污染、提取落盘均通过；渠道记忆需真实渠道 SKIP |
| `chat/run-chat-compression-suite.mjs` | **6/6** | compact 基本流/压缩后回忆/usage/原文保留/中止 |
| `chat/run-chat-wiki-suite.mjs` | **4/5**（1 SKIP） | 检索工具调用、聊天不自动摄入（负例）、未找到行为；导入闭环（WIKI-05）异步超时 SKIP |
| `autonomous/run-autonomous-effectiveness-e2e.mjs` | **A 4/4、B 6/7（1 SKIP）、C 3/4+补验** | 有效性验证：变体学习因果链 12/12、闭环产出真实训练工程、Mood/日记事件驱动；**发现 abort 残留致心跳瘫痪等 6 项缺陷**（详见 [有效性报告](./autonomous/autonomous-effectiveness-report.md)） |
| `agent-team/run-agent-team-e2e.mjs`（2026-09-13） | **14/14** | 场景化 + UI 级：四位成员真实办事（开发看环境 / 维护记忆体检零改动 / 情报偏好落记忆 / 记事日报送达）/ claude 两轮续接 + **回复界面实时可见**（修复「事件被静默丢弃」回归护栏）/ 日常聊天回归 / 真实点击自主开关（配置 diff 验证写入并还原）/ 侧栏分组结构 / tick 多 Agent 汇总（assistant + chronicler）；详见 [报告](./agent-team/agent-team-report.md)。**注：AT-UI-01 自主开关用例已于 2026-09-16 随该开关从 AI 团队页移除而下线，套件现为 13 例** |
| 场景记忆存量迁移 | **已执行并验证** | 2 条项目偏好迁入 `scene-memory/`；真实数据聊天验证：注入日志命中 + 负例零误注入 |

## 相关规范与设计

- [CLI-TEST-SPEC.md](./CLI-TEST-SPEC.md) — 测试规范（分层/方法/格式/安全）
- [autonomous/autonomous-effectiveness-report.md](./autonomous/autonomous-effectiveness-report.md) — 自主进化有效性验证报告（三问结论 / 缺陷清单 / 条件清单）
- `docs/design/记忆系统/2026-09-12-场景记忆设计.md` — 场景记忆设计（chat 记忆套件的验证对象）
- `docs/design/数据同步功能/2026-09-09-轻量云同步设计.md` — 云同步设计
