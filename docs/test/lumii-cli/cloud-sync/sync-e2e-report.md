# 云同步端到端（真实客户端 + 本地 git 远程） 测试报告

- **生成时间**: 2026-09-17T06:19:59.897Z（开始 2026-09-17T06:17:59.933Z）
- **驱动方式**: 全部经 lumii-ui CLI 真实调用（conversation/send/context 等），真实客户端 + 真实 LLM，无 SQL 播种
- **数据库**: C:\Users\75791\AppData\Local\Temp\lumii-sync-e2e-dev-a-Bjy6vN\data\agent-runtime.db
- **被测端**: 真实 Electron 客户端（LUMII_CLIENT_DATA_DIR=C:\Users\75791\AppData\Local\Temp\lumii-sync-e2e-dev-a-Bjy6vN）
- **驱动方式**: app-ui-cli（lumii-ui.mjs）经 app-ui-control HTTP 控制口驱动
- **远程仓库**: 本地 smart-HTTP git 服务器（git http-backend），裸仓库 C:\Users\75791\AppData\Local\Temp\lumii-sync-e2e-gitroot-xcD9y0\repo.git
- **运行命令**: node docs/test/lumii-cli/cloud-sync/run-sync-e2e.mjs
- **环境变量**: SYNC_E2E_ONLY=(全部) SYNC_E2E_VERBOSE=0
- **覆盖范围**: 本地→远端增删改、远端→本地增删改、无冲突自动合并、冲突检测、冲突落决（含快照过期重试）、服务端 5xx、认证失败、未启用短路、批量删除安全阀（含指纹确认与「不自动放行」事故回归）、嵌套目录、重目录剪枝、profile 同步、幂等性、分级传输（超阈值文件不阻塞阶段一 + 阶段二补传 + mtime 容差零重传）、同步范围规则（排除/强制包含）
- **已知限制**: Agent 侧 5 个云同步工具（cloud_sync_read_file / resolve_sync_conflict / cloud_sync_git / cloud_sync_push / cloud_sync_now）需要真实 LLM 与真实会话，不进本套件（会引入非确定性）；日常由 apps/windows/src/main/agent-runtime/bridge-tool-registrar-sync.test.ts 覆盖，端到端由人工用 lumii-ui send 对真实客户端验证。同步范围规则里的 glob 按**每层目录名**匹配（如 *.secret 命中任意层级），不支持 docs/*.secret 这类带目录前缀的路径模式。

## 概要

| 指标 | 值 |
|---|---|
| 总数 | 22 |
| 通过 | 22 |
| 失败 | 0 |
| 跳过 | 0 |
| 通过率 | 100.0% |

## 逐条结果

| ID | 状态 | 说明 | 耗时 |
|---|---|---|---|
| SYNC-E2E-01 | ✅ | 首次同步把本地 workspace 文件推送到远端 —— 远端已收到 workspace/files/first.md | 1.2s |
| SYNC-E2E-02 | ✅ | 本地新增文件同步后出现在远端 —— 新增已传播 | 1.1s |
| SYNC-E2E-03 | ✅ | 本地修改文件同步后远端内容更新 —— 修改已传播 | 2.0s |
| SYNC-E2E-04 | ✅ | 本地删除文件同步后从远端消失（核心回归） —— 删除已传播，无关文件未受影响 | 3.9s |
| SYNC-E2E-05 | ✅ | outputs 目录的删除同样传播 —— outputs 增删均传播 | 3.1s |
| SYNC-E2E-06 | ✅ | 远端新增文件同步后出现在本地 —— 远端新增已拉取到本地 | 4.5s |
| SYNC-E2E-07 | ✅ | 远端删除文件同步后本地也删除 —— 远端删除已传播到本地 | 3.2s |
| SYNC-E2E-08 | ✅ | 远端修改文件同步后本地内容更新 —— 远端修改已拉取到本地 | 3.3s |
| SYNC-E2E-09 | ✅ | 本地与远端改不同文件时自动合并，双方内容都保留 —— 无冲突自动合并成功 | 4.6s |
| SYNC-E2E-10 | ✅ | git 服务端 5xx 时同步失败但不崩、状态可恢复 —— 故障期 state=error，恢复后同步成功 | 3.5s |
| SYNC-E2E-11 | ✅ | 认证失败（token 不匹配）时同步不成功且不污染远端 —— 认证失败未污染远端（state=error） | 1.6s |
| SYNC-E2E-12 | ✅ | 未启用云同步时 sync 返回 success:false 且不改动任何数据 —— 未启用时安全短路 | 0.3s |
| SYNC-E2E-13 | ✅ | 超阈值删除：挡下后不自动放行，仅凭指纹确认才执行 —— 挡下 → 再次同步仍挡下（事故回归）→ 错误指纹拒绝 → 正确指纹放行 | 6.5s |
| SYNC-E2E-14 | ✅ | 嵌套目录结构完整同步，删除也传播 —— 嵌套目录增删均正确 | 2.2s |
| SYNC-E2E-15 | ✅ | 排除 .git 与 node_modules，不进同步仓 —— 重目录被正确剪枝 | 1.3s |
| SYNC-E2E-16 | ✅ | profile（soul.md）随同步传播 —— profile 已同步 | 1.1s |
| SYNC-E2E-17 | ✅ | 重复同步幂等：无变更时不产生额外提交 —— 重复同步不产生空提交 | 2.3s |
| SYNC-E2E-18 | ✅ | 双方改同一文件时进入 conflict 状态且不误推送 —— 进入 conflict 且远端未被覆盖（涉及 1 个文件），落决收尾成功 | 6.0s |
| SYNC-E2E-19 | ✅ | 冲突期间远端再前进：落决被拒后自动刷新快照并收敛（本 Incident 回归） —— 落决被拒 → 快照自动刷新 → 二轮收敛，远端新提交未丢失 | 31.1s |
| SYNC-E2E-20 | ✅ | 超阈值文件不阻塞阶段一，改由阶段二队列补传 —— 阶段一 3791ms 未被 8MB 文件阻塞；阶段二补齐且字节数一致 | 7.6s |
| SYNC-E2E-21 | ✅ | 已传完的大文件不再重传（mtime 精度死循环回归） —— mtime 差 0.36ms；两轮同步零重传（tip 2c5bae1→2c5bae1） | 6.9s |
| SYNC-E2E-22 | ✅ | 范围规则：排除项不参与同步，强制包含无视阈值走阶段一 —— 排除命中 files/ 与 outputs/ 均不传；强制包含把 2MB 拉回阶段一；撤规则后恢复 | 6.5s |

## 失败与跳过明细

无。


## 证据

逐条原始证据见 [sync-e2e-evidence.jsonl](./sync-e2e-evidence.jsonl)。
