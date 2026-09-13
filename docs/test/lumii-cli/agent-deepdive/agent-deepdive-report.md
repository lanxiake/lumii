# 体验深挖 · 地基篇（G1-G4）真实使用旅程 E2E 测试报告

- **生成时间**: 2026-09-13T16:37:13.314Z（开始 2026-09-13T16:31:49.723Z）
- **驱动方式**: 全部经 lumii-ui CLI 真实调用（conversation/send/context 等），真实客户端 + 真实 LLM，无 SQL 播种
- **数据库**: C:\Users\Administrator\.lumii\data\agent-runtime.db
- **场景范围**: 全量场景
- **环境**: 真实 LLM；转交场景未启用
- **执行方式**: 父进程编排（并行 + UI 串行）
- **应用日志**: C:\Users\Administrator\.lumii\logs\app\mtbot-2026-09-14.log

## 概要

| 指标 | 值 |
|---|---|
| 总数 | 9 |
| 通过 | 6 |
| 失败 | 2 |
| 跳过 | 1 |
| 通过率 | 66.7% |

## 逐条结果

| ID | 状态 | 说明 | 耗时 |
|---|---|---|---|
| DD-G2-01 | ✅ | 失败任务「DD探针·必失败任务」触发通知（2 条日志），标题含任务名、点击跳转 cron:d4f38f82-fd36-4dc5-ae89-aa1b4c0517a3；失败原因=Agent definition not found: __dd_missing_agent_definition__ | 2.6s |
| DD-G1-02 | ✅ | 维护官调用 wiki_overview 读到共享库 308 条（共享库 308 条 / 它自有仅 4 条）；资料零改动；回复「只看不动，已完成统计。你的资料库目前共 **308 条资料**，按一级分类分布： \| 分类 \| 条数 \| 说明 \| \|…」 | 20.1s |
| DD-G1-01 | ✅ | 记忆落库 agent_memories(agent_id=system-keeper)；新会话复述成功（10s）：「LUMII-DD-913」 | 29.4s |
| DD-REG-01 | ✅ | participant=default；回复「收到」 | 13.1s |
| DD-REG-02 | ✅ | 口令落 assistant；新会话复述成功（6s）：「LUMII-DD-REG2」 | 21.9s |
| DD-G4-01 | ✅ | 追加成功（send_message ok，to=agent-1789317246028-gvcc0x）；会话中出现「【传话】系统默认 → 灵栖情报：用户补充提醒：优先看中文来源（IT之家、量子位、机器之心、新智元等），英文源只做交叉验证，不占 8 条名额。请确认选题以中文来源」 | 203.7s |
| DD-G2-02 | ❌ | conversation create 退出码 3: {"ok":false,"error":"app_not_running"}
 | 0.1s |
| DD-G3-01 | ❌ | conversation create 退出码 3: {"ok":false,"error":"app_not_running"}
 | 0.1s |
| DD-G2-03 | ⏭️ | 未启用（DD_WITH_HANDOFF=1 且需 code-dev 绑定 + claude CLI） | - |

## 失败与跳过明细

- **DD-G2-02** FAIL: conversation create 退出码 3: {"ok":false,"error":"app_not_running"}

  ```
  Error: conversation create 退出码 3: {"ok":false,"error":"app_not_running"}

    at assert (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:110:20)
    at okJson (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:103:3)
    at Module.createSession (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:130:13)
    at caseG202 (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/agent-deepdive/run-agent-de
  ```
- **DD-G3-01** FAIL: conversation create 退出码 3: {"ok":false,"error":"app_not_running"}

  ```
  Error: conversation create 退出码 3: {"ok":false,"error":"app_not_running"}

    at assert (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:110:20)
    at okJson (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:103:3)
    at Module.createSession (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:130:13)
    at caseG301 (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/agent-deepdive/run-agent-de
  ```
- **DD-G2-03** SKIP: 未启用（DD_WITH_HANDOFF=1 且需 code-dev 绑定 + claude CLI）

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
