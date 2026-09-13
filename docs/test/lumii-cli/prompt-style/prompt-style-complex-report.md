# 提示词风格实验 P2 复杂任务实测 测试报告

- **生成时间**: 2026-09-13T10:34:25.575Z（开始 2026-09-13T10:29:05.515Z）
- **驱动方式**: 全部经 lumii-ui CLI 真实调用（conversation/send/context 等），真实客户端 + 真实 LLM，无 SQL 播种
- **数据库**: C:\Users\Administrator\.lumii\data\agent-runtime.db
- **风格切换**: app-ui CLI `settings set promptStyle.style`（结束恢复原值）
- **探针会话前缀**: [pc-suite]
- **说明**: 复杂任务（多工具调用）双档对照；工具序列来自助手消息 JSON 解析

## 概要

| 指标 | 值 |
|---|---|
| 总数 | 6 |
| 通过 | 5 |
| 失败 | 1 |
| 跳过 | 0 |
| 通过率 | 83.3% |

## 逐条结果

| ID | 状态 | 说明 | 耗时 |
|---|---|---|---|
| PC-C1-DETAILED | ✅ | file-stats\stats.py + report.md 落地；工具序列=[todo_write>file_write>todo_write>file_write>file_write>todo_write>file_write>todo_write>bash]；39295ms；prompt=33690；含 todo；file_write=true；bash=true；脚本含统计逻辑=是 | 41.3s |
| PC-C1-TERSE | ✅ | file-stats\stats.py + report.md 落地；工具序列=[todo_write>file_write>file_write>file_write>file_write>file_write>file_write>todo_write>bash>file_write>list_dir>todo_write>list_dir>task_complete]；41569ms；prompt=18223；含 todo；file_write=true；bash=true；脚本含统计逻辑=是 | 43.6s |
| PC-C2-DETAILED | ✅ | 简报 ai-coding-tools-brief-20260913.md（1640 字符）；工具序列=[web_search>web_search>web_search>web_search>web_search>web_fetch>web_fetch]；web_search=true；file_write=false；3条=true；命名合规=true；39969ms；prompt=33690 | 41.8s |
| PC-C2-TERSE | ✅ | 简报 ai-coding-brief\AI编程工具动态简报-20260913.md（1692 字符）；工具序列=[web_search>web_search>web_search>web_fetch]；web_search=true；file_write=false；3条=true；命名合规=true；34332ms；prompt=18220 | 36.2s |
| PC-C3-DETAILED | ❌ | 未观察到技能检索/加载或执行动作（技能命中异常） | 21.6s |
| PC-C3-TERSE | ✅ | 工具序列=[web_search>bash]；回复含温度=true；22647ms；prompt=18742 | 24.3s |

## 失败与跳过明细

- **PC-C3-DETAILED** FAIL: 未观察到技能检索/加载或执行动作（技能命中异常）
  ```
  Error: 未观察到技能检索/加载或执行动作（技能命中异常）
    at assert (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:110:20)
    at file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/prompt-style/run-prompt-style-complex.mjs:358:5
    at runCase (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:518:18)
    at maybe (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/prompt-style/run-prompt-style-complex.mjs:68:10)
    at runSkillCase (fi
  ```
## 复杂任务双档对照

| 用例 | 档位 | 提示词 chars | 回合耗时 | 工具序列 | 备注 |
|---|---|---|---|---|---|
| PC-C1-DETAILED | detailed | 33690 | 39.3s | todo_write>file_write>todo_write>file_write>file_write>todo_write>file_write>todo_write>bash | 报告含统计=是；bash=true |
| PC-C1-TERSE | terse | 18223 | 41.6s | todo_write>file_write>file_write>file_write>file_write>file_write>file_write>todo_write>bash>file_write>list_dir>todo_write>list_dir>task_complete | 报告含统计=是；bash=true |
| PC-C2-DETAILED | detailed | 33690 | 40.0s | web_search>web_search>web_search>web_search>web_search>web_fetch>web_fetch | ai-coding-tools-brief-20260913.md；web_search=true；3条=true；命名=true |
| PC-C2-TERSE | terse | 18220 | 34.3s | web_search>web_search>web_search>web_fetch | ai-coding-brief\AI编程工具动态简报-20260913.md；web_search=true；3条=true；命名=true |
| PC-C3-DETAILED | detailed | 34209 | 19.9s | web_fetch | skill检索=false；skill加载=false；bash=false；回复含温度=true |
| PC-C3-TERSE | terse | 18742 | 22.6s | web_search>bash | skill检索=false；skill加载=false；bash=true；回复含温度=true |


## 证据

逐条原始证据见 [prompt-style-complex-evidence.jsonl](./prompt-style-complex-evidence.jsonl)。
