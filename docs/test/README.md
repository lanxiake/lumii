# docs/test 索引

本目录存放 **CLI / 真实环境** 测试用例与报告（非单元测试源码）。

## 评测套件（离线或按需跑，不进 CI）

| 套件 | 测什么 | 跑一次的代价 |
| --- | --- | --- |
| [`memory-eval/`](./memory-eval/) | 记忆检索与注入的**质量**（对照集 + 离线跑分） | 秒级（离线读库） |
| [`tool-choice/`](./tool-choice/) | **模型会不会按工具面的设计意图选工具**（有专用工具时是否走 shell、语义邻近工具是否选错） | 15~20 分钟（每用例一个真实回合） |

## Lumii CLI 真实环境测试（现行）

见子目录 [`lumii-cli/`](./lumii-cli/README.md)，按功能域组织，规范见 [`CLI-TEST-SPEC.md`](./lumii-cli/CLI-TEST-SPEC.md)。

| 域 | 说明 |
| --- | --- |
| [`general/`](./lumii-cli/general/) | 通用 CLI |
| [`chat/`](./lumii-cli/chat/) | 真实聊天模拟（L3），含上下文压缩套件 |
| [`wiki/`](./lumii-cli/wiki/) | Wiki 知识库 |
| [`autonomous/`](./lumii-cli/autonomous/) | 自主进化 Agent（含原「自主进化Agent」套件，2026-09-17 合并） |
| [`cloud-sync/`](./lumii-cli/cloud-sync/) | 云同步（含 GitCode 真实同步用例） |
| [`agent-capability/`](./lumii-cli/agent-capability/) | Agent 能力全面测试（A–H 套件，2026-08-27） |
| [`agent-curation/`](./lumii-cli/agent-curation/) · [`agent-deepdive/`](./lumii-cli/agent-deepdive/) · [`agent-team/`](./lumii-cli/agent-team/) | Agent 整理 / 体验深挖 / 团队 |
| [`prompt-style/`](./lumii-cli/prompt-style/) · [`channel-routing/`](./lumii-cli/channel-routing/) | 提示词风格实验 / 渠道路由 |

> ⚠️ `CLI-TEST-SPEC.md` §5 规定子目录深度固定为 `docs/test/lumii-cli/<域>`——执行器内的 `ROOT` 按 4 层计算，**不要在这个层级再加子目录**，移动套件后必须同步 `ROOT` 相对层级。

## 历史归档

[`历史归档/`](./历史归档/) 存放已被取代的一次性测试文档（Phase 1/2/3 时代的上下文压缩测试等），只作追溯用。
