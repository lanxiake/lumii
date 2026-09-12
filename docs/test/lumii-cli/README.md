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
├── autonomous/            # 自主进化专项
├── agent-team/            # 一等公民 Agent 团队：场景化旅程（成员会话/日报送达/开发模式续接）
├── cloud-sync/            # 云同步专项
└── materials/             # 真实文档样本（docx/mp4/PDF，gitignore 不提交）
```

## 测试套件

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
| [autonomous-life-test-cases.md](./autonomous/autonomous-life-test-cases.md) | 心跳 tick/主动消息/Mood/牵挂/日记/token 预算 |
| [autonomous-effectiveness-test-cases.md](./autonomous/autonomous-effectiveness-test-cases.md) | **有效性验证（EVO-A/B/C）**：变体淘汰学习 / 短板闭环 / 生命感——回答「是否真的有用、能否真的自主进化」 |
| [run-autonomous-cli-suite.mjs](./autonomous/run-autonomous-cli-suite.mjs) | 数据链路执行器 |
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

### 云同步专项（cloud-sync/）

| 文件 | 说明 |
|---|---|
| [run-cloud-sync-suite.mjs](./cloud-sync/run-cloud-sync-suite.mjs) | Schema/导出 JSONL/merge 规则/完整同步流程 |
| [cloud-sync-cli-test-report.md](./cloud-sync/cloud-sync-cli-test-report.md) | 最新报告 |

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
| `agent-team/run-agent-team-e2e.mjs`（2026-09-13） | **10/11（1 SKIP）** | 场景化：灵栖开发列目录 / 灵栖维护记忆体检（红线零改动）/ 灵栖情报偏好落 agent_memories / 日报由 chronicler 真实产出（agent_id 硬验证）/ claude 两轮续接（node 版本追答复述）/ 日常聊天回归；tick 多 Agent 条件用例待配置 autonomousAgents 后重跑 |
| 场景记忆存量迁移 | **已执行并验证** | 2 条项目偏好迁入 `scene-memory/`；真实数据聊天验证：注入日志命中 + 负例零误注入 |

## 相关规范与设计

- [CLI-TEST-SPEC.md](./CLI-TEST-SPEC.md) — 测试规范（分层/方法/格式/安全）
- [autonomous/autonomous-effectiveness-report.md](./autonomous/autonomous-effectiveness-report.md) — 自主进化有效性验证报告（三问结论 / 缺陷清单 / 条件清单）
- `docs/design/记忆设计/2026-09-12-scene-memory-design.md` — 场景记忆设计（chat 记忆套件的验证对象）
- `docs/superpowers/specs/2026-09-09-lightweight-cloud-sync-design.md` — 云同步设计
