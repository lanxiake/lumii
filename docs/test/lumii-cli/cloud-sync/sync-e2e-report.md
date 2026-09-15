# 云同步端到端（真实客户端 + 本地 git 远程） 测试报告

- **生成时间**: 2026-09-15T14:51:11.554Z（开始 2026-09-15T14:50:29.751Z）
- **驱动方式**: 全部经 lumii-ui CLI 真实调用（conversation/send/context 等），真实客户端 + 真实 LLM，无 SQL 播种
- **数据库**: C:\Users\ADMINI~1\AppData\Local\Temp\lumii-sync-e2e-dev-a-SEBpYK\data\agent-runtime.db
- **被测端**: 真实 Electron 客户端（LUMII_CLIENT_DATA_DIR=C:\Users\ADMINI~1\AppData\Local\Temp\lumii-sync-e2e-dev-a-SEBpYK）
- **驱动方式**: app-ui-cli（lumii-ui.mjs）经 app-ui-control HTTP 控制口驱动
- **远程仓库**: 本地 smart-HTTP git 服务器（git http-backend），裸仓库 C:\Users\ADMINI~1\AppData\Local\Temp\lumii-sync-e2e-gitroot-hPBbPn\repo.git
- **运行命令**: node docs/test/lumii-cli/cloud-sync/run-sync-e2e.mjs
- **环境变量**: SYNC_E2E_ONLY=SYNC-E2E-18 SYNC_E2E_VERBOSE=0
- **覆盖范围**: 本地→远端增删改、远端→本地增删改、无冲突自动合并、冲突检测、服务端 5xx、认证失败、未启用短路、批量删除熔断、嵌套目录、重目录剪枝、profile 同步、幂等性
- **已知限制**: 冲突落决（resolve_sync_conflict）无 CLI 入口，本套件只验证到「进入 conflict 且未误推送」；落决逻辑由单测 apps/windows/src/main/cloud-sync/sync-manager.test.ts 覆盖

## 概要

| 指标 | 值 |
|---|---|
| 总数 | 1 |
| 通过 | 1 |
| 失败 | 0 |
| 跳过 | 0 |
| 通过率 | 100.0% |

## 逐条结果

| ID | 状态 | 说明 | 耗时 |
|---|---|---|---|
| SYNC-E2E-18 | ✅ | 双方改同一文件时进入 conflict 状态且不误推送 —— 进入 conflict 且远端未被覆盖（涉及 1 个文件），落决收尾成功 | 9.8s |

## 失败与跳过明细

无。


## 证据

逐条原始证据见 [sync-e2e-evidence.jsonl](./sync-e2e-evidence.jsonl)。
