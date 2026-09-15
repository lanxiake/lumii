# 提示词风格实验 复杂任务实测 测试报告

- **生成时间**: 2026-09-15T15:26:13.029Z（开始 2026-09-15T15:10:20.048Z）
- **驱动方式**: 全部经 lumii-ui CLI 真实调用（conversation/send/context 等），真实客户端 + 真实 LLM，无 SQL 播种
- **数据库**: C:\Users\Administrator\.lumii\data\agent-runtime.db
- **风格切换**: app-ui CLI `settings set promptStyle.style`（结束恢复原值）
- **探针会话前缀**: [pc-suite]
- **被测档位**: minimal / terse / detailed
- **说明**: 复杂任务（多工具调用）多档对照；工具序列来自助手消息 JSON 解析；工具定义 token 来自 contextUsage 日志

## 概要

| 指标 | 值 |
|---|---|
| 总数 | 9 |
| 通过 | 6 |
| 失败 | 3 |
| 跳过 | 0 |
| 通过率 | 66.7% |

## 逐条结果

| ID | 状态 | 说明 | 耗时 |
|---|---|---|---|
| PC-C1-MINIMAL | ✅ | file-stats\stats.py + report.md 落地；工具序列=[todo_write>todo_write>file_mkdir>file_write>file_write>file_write>file_write>file_write>file_write>todo_write>bash>file_write>glob>todo_write>task_complete>task_complete]；36275ms；prompt=17275；含 todo；file_write=true；bash=true；脚本含统计逻辑=是 | 38.2s |
| PC-C1-TERSE | ✅ | file-stats\stats.py + report.md 落地；工具序列=[todo_write>file_mkdir>file_write>file_write>file_write>file_write>todo_write>file_write>bash>todo_write>file_write>glob>todo_write>task_complete>task_complete]；51925ms；prompt=19498；含 todo；file_write=true；bash=true；脚本含统计逻辑=是 | 53.9s |
| PC-C1-DETAILED | ✅ | file-stats\stats.py + report.md 落地；工具序列=[todo_write>todo_write>file_write>file_write>file_write>file_write>todo_write>file_write>todo_write>bash>todo_write>file_write>glob>todo_write>task_complete>task_complete]；44231ms；prompt=35499；含 todo；file_write=true；bash=true；脚本含统计逻辑=是 | 46.2s |
| PC-C2-MINIMAL | ✅ | 简报 ai-coding-tools-brief\AI编程工具简报-2026-09-15.md（2009 字符）；工具序列=[spawn_agent>glob>file_read>web_fetch>web_fetch>web_fetch>web_search>web_search>web_search>web_search>web_search>web_fetch>web_search>web_search>web_search>web_search>web_search>web_search>file_write>task_complete>bash>task_complete]；web_search=true；file_write=true；3条=true；命名合规=true；187997ms；prompt=14751 | 190.0s |
| PC-C2-TERSE | ❌ | 未使用 web_search（动态事实任务却无检索，准确性异常） | 80.5s |
| PC-C2-DETAILED | ✅ | 简报 ai-coding-tools-brief\AI编程工具简报-2026-09-15.md（1718 字符）；工具序列=[spawn_agent>web_fetch>web_fetch>web_search>web_fetch>web_search>file_write>bash>memory_manage>task_complete>task_complete>bash>task_complete>task_complete>bash>task_complete>task_complete>bash>task_complete>task_complete>bash>task_complete>task_complete>bash>task_complete>task_complete>bash>task_complete>task_complete>task_complete>bash>task_complete>bash>task_complete>task_complete>bash>task_complete>task_complete>bash>task_complete>task_complete>task_complete>task_complete>bash>task_complete>task_complete>bash>task_complete>task_complete>bash>task_complete>task_complete>bash>task_complete>task_complete>bash>task_complete>task_complete>task_complete>task_complete>bash>task_complete>task_complete>bash>task_complete>task_complete>bash]；web_search=true；file_write=true；3条=true；命名合规=true；328134ms；prompt=31496 | 330.3s |
| PC-C3-MINIMAL | ✅ | 工具序列=[web_search>web_fetch>bash>web_fetch]；回复含温度=true；45264ms；prompt=17274 | 47.3s |
| PC-C3-TERSE | ❌ | 未观察到技能检索/加载或执行动作（技能命中异常） | 32.8s |
| PC-C3-DETAILED | ❌ | 未观察到技能检索/加载或执行动作（技能命中异常） | 22.1s |

## 失败与跳过明细

- **PC-C2-TERSE** FAIL: 未使用 web_search（动态事实任务却无检索，准确性异常）
  ```
  Error: 未使用 web_search（动态事实任务却无检索，准确性异常）
    at assert (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:110:20)
    at file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/prompt-style/run-prompt-style-complex.mjs:367:7
    at runCase (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:518:18)
    at maybe (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/prompt-style/run-prompt-style-complex.mjs:106:10)
    at runRese
  ```
- **PC-C3-TERSE** FAIL: 未观察到技能检索/加载或执行动作（技能命中异常）
  ```
  Error: 未观察到技能检索/加载或执行动作（技能命中异常）
    at assert (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:110:20)
    at file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/prompt-style/run-prompt-style-complex.mjs:423:5
    at runCase (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:518:18)
    at maybe (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/prompt-style/run-prompt-style-complex.mjs:106:10)
    at runSkillCase (f
  ```
- **PC-C3-DETAILED** FAIL: 未观察到技能检索/加载或执行动作（技能命中异常）
  ```
  Error: 未观察到技能检索/加载或执行动作（技能命中异常）
    at assert (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:110:20)
    at file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/prompt-style/run-prompt-style-complex.mjs:423:5
    at runCase (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:518:18)
    at maybe (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/prompt-style/run-prompt-style-complex.mjs:106:10)
    at runSkillCase (f
  ```
## 复杂任务多档对照

| 用例 | 档位 | 提示词 chars | 工具定义 token | MCP token | 回合耗时 | 工具序列 | 备注 |
|---|---|---|---|---|---|---|---|
| PC-C1-MINIMAL | minimal | 17275 | 12122 | 90 | 36.3s | todo_write>todo_write>file_mkdir>file_write>file_write>file_write>file_write>file_write>file_write>todo_write>bash>file_write>glob>todo_write>task_complete>task_complete | 报告含统计=否；bash=true |
| PC-C1-TERSE | terse | 19498 | 16265 | 195 | 51.9s | todo_write>file_mkdir>file_write>file_write>file_write>file_write>todo_write>file_write>bash>todo_write>file_write>glob>todo_write>task_complete>task_complete | 报告含统计=是；bash=true |
| PC-C1-DETAILED | detailed | 35499 | 17050 | 184 | 44.2s | todo_write>todo_write>file_write>file_write>file_write>file_write>todo_write>file_write>todo_write>bash>todo_write>file_write>glob>todo_write>task_complete>task_complete | 报告含统计=是；bash=true |
| PC-C2-MINIMAL | minimal | 14751 | 11190 | 78 | 188.0s | spawn_agent>glob>file_read>web_fetch>web_fetch>web_fetch>web_search>web_search>web_search>web_search>web_search>web_fetch>web_search>web_search>web_search>web_search>web_search>web_search>file_write>task_complete>bash>task_complete | ai-coding-tools-brief\AI编程工具简报-2026-09-15.md；web_search=true；3条=true；命名=true |
| PC-C2-TERSE | terse | 18869 | 16316 | 163 | 78.5s | spawn_agent>file_read>task_complete>task_complete | ai-coding-tools-brief\ai编程工具简报-20260915.md；web_search=false；3条=true；命名=true |
| PC-C2-DETAILED | detailed | 31496 | - | - | 328.1s | spawn_agent>web_fetch>web_fetch>web_search>web_fetch>web_search>file_write>bash>memory_manage>task_complete>task_complete>bash>task_complete>task_complete>bash>task_complete>task_complete>bash>task_complete>task_complete>bash>task_complete>task_complete>bash>task_complete>task_complete>bash>task_complete>task_complete>task_complete>bash>task_complete>bash>task_complete>task_complete>bash>task_complete>task_complete>bash>task_complete>task_complete>task_complete>task_complete>bash>task_complete>task_complete>bash>task_complete>task_complete>bash>task_complete>task_complete>bash>task_complete>task_complete>bash>task_complete>task_complete>task_complete>task_complete>bash>task_complete>task_complete>bash>task_complete>task_complete>bash | ai-coding-tools-brief\AI编程工具简报-2026-09-15.md；web_search=true；3条=true；命名=true |
| PC-C3-MINIMAL | minimal | 17274 | 12237 | 91 | 45.3s | web_search>web_fetch>bash>web_fetch | skill检索=false；skill加载=false；bash=true；回复含温度=true |
| PC-C3-TERSE | terse | 19498 | 16643 | 200 | 31.0s | web_fetch>web_fetch>web_search>web_fetch | skill检索=false；skill加载=false；bash=false；回复含温度=true |
| PC-C3-DETAILED | detailed | 35499 | 16843 | 182 | 20.3s | web_search>web_fetch | skill检索=false；skill加载=false；bash=false；回复含温度=true |


## 证据

逐条原始证据见 [prompt-style-complex-3way-evidence.jsonl](./prompt-style-complex-3way-evidence.jsonl)。
