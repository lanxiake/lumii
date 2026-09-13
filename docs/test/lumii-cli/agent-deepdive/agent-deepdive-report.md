# 体验深挖 · 地基篇（G1-G4）真实使用旅程 E2E 测试报告

- **生成时间**: 2026-09-13T16:18:22.883Z（开始 2026-09-13T16:09:38.406Z）
- **驱动方式**: 全部经 lumii-ui CLI 真实调用（conversation/send/context 等），真实客户端 + 真实 LLM，无 SQL 播种
- **数据库**: C:\Users\Administrator\.lumii\data\agent-runtime.db
- **场景范围**: DD_ONLY=G2-02,G3-01,G4-01
- **环境**: 真实 LLM；转交场景未启用
- **执行方式**: 父进程编排（并行 + UI 串行）
- **应用日志**: C:\Users\Administrator\.lumii\logs\app\mtbot-2026-09-14.log

## 概要

| 指标 | 值 |
|---|---|
| 总数 | 3 |
| 通过 | 1 |
| 失败 | 2 |
| 跳过 | 0 |
| 通过率 | 33.3% |

## 逐条结果

| ID | 状态 | 说明 | 耗时 |
|---|---|---|---|
| DD-G4-01 | ❌ | 两次尝试主助手均未使用 send_message 带话（回复尾：mplete has already been called and the summary has been presented. Following the silent response rule, if there's nothing to say, respond with NO_REPLY. The user has already received the full report.
）—— 传话通路未被触发 | 246.2s |
| DD-G2-02 | ❌ | 后台委托完成后未外推桌面通知（用户已切到别的会话：「G4-01 传话(第2次)」）；窗口内 DesktopNotify 尾：[2026-09-14 00:16:34.577] [INFO] [Main] [DesktopNotify] title="Lumii · info-curator 已完成" body="本轮任务已完成：看板资讯流已写入今日 5 条 AI 行业动态（政策 1 条 + 编程工具/厂商 4 条，全部来自 IT之家且链接验证有效），筛选依据已记入工作记" convId="d0d7fc85799817000de37074a6d1bfb8" | 57.5s |
| DD-G3-01 | ✅ | 本用例现场发起委托：界面渲染「团队委托灵栖情报已完成详情」；点击展开可见任务/产出 | 104.4s |

## 失败与跳过明细

- **DD-G4-01** FAIL: 两次尝试主助手均未使用 send_message 带话（回复尾：mplete has already been called and the summary has been presented. Following the silent response rule, if there's nothing to say, respond with NO_REPLY. The user has already received the full report.
）—— 传话通路未被触发
  ```
  Error: 两次尝试主助手均未使用 send_message 带话（回复尾：mplete has already been called and the summary has been presented. Following the silent response rule, if there's nothing to say, respond with NO_REPLY. The user has already received the full report.
）—— 传话通路未被触发
    at Module.assert (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:110:20)
    at caseG401 (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/agent-deepdive/run-agent-deepdive-e2e.mjs:721:5)
    at Modul
  ```
- **DD-G2-02** FAIL: 后台委托完成后未外推桌面通知（用户已切到别的会话：「G4-01 传话(第2次)」）；窗口内 DesktopNotify 尾：[2026-09-14 00:16:34.577] [INFO] [Main] [DesktopNotify] title="Lumii · info-curator 已完成" body="本轮任务已完成：看板资讯流已写入今日 5 条 AI 行业动态（政策 1 条 + 编程工具/厂商 4 条，全部来自 IT之家且链接验证有效），筛选依据已记入工作记" convId="d0d7fc85799817000de37074a6d1bfb8"
  ```
  Error: 后台委托完成后未外推桌面通知（用户已切到别的会话：「G4-01 传话(第2次)」）；窗口内 DesktopNotify 尾：[2026-09-14 00:16:34.577] [INFO] [Main] [DesktopNotify] title="Lumii · info-curator 已完成" body="本轮任务已完成：看板资讯流已写入今日 5 条 AI 行业动态（政策 1 条 + 编程工具/厂商 4 条，全部来自 IT之家且链接验证有效），筛选依据已记入工作记" convId="d0d7fc85799817000de37074a6d1bfb8"
    at Module.assert (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:110:20)
    at caseG202 (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/agent-deepdive/run-agent-
  ```

## 副作用声明

- 探针会话（`[deepdive] *`）保留待人工清理（CLI 无删除能力）。
- 探针记忆：`agent_memories` 探针行按 id 清理；万一写入 `user-memory.md` 也按行清理。
- 探针定时任务（`DD探针·必失败任务`）连同运行记录已删除；套件期间后台 cron 临时禁用，结束已恢复（10 条）。
- G2-01 的失败通知为真实产出（验证证据本身），会出现在系统通知里。
- 资料库红线：G1-02 只读断言（归档数 + 有效集逐条比对）确保用户资料零改动。

## 用例设计备注（实测观察）

- 「看资料库现状」类请求主助手会自理（自己调 wiki 工具），只有「整理」类诉求才委托灵栖维护；
  因此「维护官看得见共享库」改为用户直接打开维护会话问现状——同样真实，且判别力更强。
- 「整理」话术会让维护官真实执行归档（2026-09-13 首跑归档 84 条，已全部 restore）——
  所有触碰用户数据的用例必须自带范围约束 + 事后红线校验。

## 覆盖限制（未覆盖项）

- 转交通知（G2-3）默认未跑：需 code-dev 绑定 + claude CLI，`DD_WITH_HANDOFF=1` 时启用；转交执行本体由 AT-F2 覆盖。
- 反思/日记轻提示（G2-4）不弹桌面通知是设计取舍，落库 + 推送由单测覆盖（renderer 推送到 DOM 无法经 CLI 断言）。
- send_message「空闲唤醒」分支：真实旅程中专家实例完成即销毁，难命中 idle 窗口；由 `orchestrator.test.ts` 3 例覆盖。
- 「正在父会话且窗口聚焦时不弹通知」由单测覆盖（CLI 难以稳定复现前台聚焦）。


## 证据

逐条原始证据见 [agent-deepdive-evidence.jsonl](./agent-deepdive-evidence.jsonl)。
