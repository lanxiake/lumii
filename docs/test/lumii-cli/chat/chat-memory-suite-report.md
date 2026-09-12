# 聊天记忆套件 测试报告

- **生成时间**: 2026-09-12T13:37:44.021Z（开始 2026-09-12T13:34:30.403Z）
- **驱动方式**: 全部经 lumii-ui CLI 真实调用（conversation/send/context 等），真实客户端 + 真实 LLM，无 SQL 播种
- **数据库**: C:\Users\Administrator\.lumii\data\agent-runtime.db
- **回合超时**: 180000ms
- **用例过滤**: （全部）
- **探针**: chat-probe-project（别名 chat-probe-alias，标记「蓝色协议」）
- **user-memory.md**: 已变化（快照 1961 → 2187 字符），探针行已清理 1 行

## 概要

| 指标 | 值 |
|---|---|
| 总数 | 9 |
| 通过 | 8 |
| 失败 | 0 |
| 跳过 | 1 |
| 通过率 | 88.9% |

## 逐条结果

| ID | 状态 | 说明 | 耗时 |
|---|---|---|---|
| CHAT-MEM-09 | ✅ | 注册表与场景文件就绪，命中解析可依赖 | 0.0s |
| CHAT-MEM-03 | ✅ | 注入日志命中（1 条）；回复体现「蓝色协议」 | 20.5s |
| CHAT-MEM-04 | ✅ | 无关消息未注入探针场景（窗口内其它注入 0 条，均不含探针） | 12.8s |
| CHAT-MEM-05 | ✅ | scene_memory 工具写入成功，场景文件已含「pnpm typecheck」 | 12.4s |
| CHAT-MEM-06 | ✅ | 全局 user-memory.md 无场景约定内容 | - |
| CHAT-MEM-07 | ✅ | 主动回忆命中：「记得，是刚才记在 ChatProbe（chat-probe-alias）项目记忆里的这条：

**提交代码前必须先运行 …」 | 19.4s |
| CHAT-MEM-01 | ✅ | 记忆提取落盘，内容含「pnpm」 | 17.6s |
| CHAT-MEM-02 | ✅ | memory search 命中 1 条（首条: {"id":"c3408c669fcf4d3502e8c30ad350d41c","category":"general","content":"我写代码时习惯） | 0.2s |
| CHAT-MEM-08 | ⏭️ | 渠道记忆需真实渠道（微信/飞书）消息触发，CLI 会话为 ipc 渠道不具备条件 | - |

## 失败与跳过明细

- **CHAT-MEM-08** SKIP: 渠道记忆需真实渠道（微信/飞书）消息触发，CLI 会话为 ipc 渠道不具备条件

## 覆盖范围

- 记忆提取落盘（MEM-01）、memory_search 兜底（MEM-02）
- 场景记忆命中注入正例（MEM-03）/ 负例（MEM-04）
- scene_memory 工具写入（MEM-05）与全局无污染（MEM-06）
- 主动回忆（MEM-07）、注册表一致性（MEM-09）；渠道记忆受限 SKIP（MEM-08）

## 探针与副作用

- 探针数据：`scene-memory/_registry.json`（临时项）+ `project-chat-probe-project.md`（已恢复）
- `user-memory.md`：探针句按行清理（不整文件恢复，避免覆盖应用/用户新写入）；状态：已变化（快照 1961 → 2187 字符），探针行已清理 1 行


## 证据

逐条原始证据见 [chat-memory-suite-evidence.jsonl](./chat-memory-suite-evidence.jsonl)。
