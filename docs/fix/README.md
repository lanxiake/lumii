# 问题修复记录

本目录存放**故障的诊断与修复记录**。命名：`YYYY-MM-DD-<功能>-<问题>-fix.md`。

写作要点：复现步骤 + 根因（含代码位置证据）+ 修复代码 + 回归验证方法。完整模板见 [`../wiki/05-implementation/02-功能实施模板.md`](../wiki/05-implementation/02-功能实施模板.md)。

| 文档 | 问题 |
| --- | --- |
| [`2026-08-09-voice-call-realtime-transcript-fix.md`](2026-08-09-voice-call-realtime-transcript-fix.md) | 语音通话实时转写不显示（ASR 离线模式不支持流式中间结果） |
| [`2026-08-13-session-loss-db-lock-misdetection-fix.md`](2026-08-13-session-loss-db-lock-misdetection-fix.md) | 新建会话重启后丢失（`isIoErr()` 误判数据库锁） |
| [`2026-09-07-agent-message-order-fix.md`](2026-09-07-agent-message-order-fix.md) | Agent 消息顺序错乱 |
| [`2026-09-07-cloud-sync-conflict-detection-fix.md`](2026-09-07-cloud-sync-conflict-detection-fix.md) | 云同步符号链接与冲突检测误触发 Agent 处理 |

已沉淀为方法论的案例另见 [`../wiki/07-debugging-and-fixes/`](../wiki/07-debugging-and-fixes/)。
