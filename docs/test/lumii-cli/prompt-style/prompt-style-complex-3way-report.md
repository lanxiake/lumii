# 提示词风格实验 复杂任务实测 测试报告

- **生成时间**: 2026-09-15T15:05:54.949Z（开始 2026-09-15T15:01:12.261Z）
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
| 通过 | 0 |
| 失败 | 3 |
| 跳过 | 6 |
| 通过率 | 0.0% |

## 逐条结果

| ID | 状态 | 说明 | 耗时 |
|---|---|---|---|
| PC-C1-MINIMAL | ⏭️ | 工作区 outputs 不存在（C:\Users\Administrator\.lumii\outputs） | 0.2s |
| PC-C1-TERSE | ⏭️ | 工作区 outputs 不存在（C:\Users\Administrator\.lumii\outputs） | 0.2s |
| PC-C1-DETAILED | ⏭️ | 工作区 outputs 不存在（C:\Users\Administrator\.lumii\outputs） | 0.2s |
| PC-C2-MINIMAL | ⏭️ | 工作区 outputs 不存在 | 0.2s |
| PC-C2-TERSE | ⏭️ | 工作区 outputs 不存在 | 0.2s |
| PC-C2-DETAILED | ⏭️ | 工作区 outputs 不存在 | 0.2s |
| PC-C3-MINIMAL | ❌ | 未观察到技能检索/加载或执行动作（技能命中异常） | 29.7s |
| PC-C3-TERSE | ❌ | 回复未包含温度信息（任务未完成） | 110.9s |
| PC-C3-DETAILED | ❌ | 未观察到技能检索/加载或执行动作（技能命中异常） | 29.6s |

## 失败与跳过明细

- **PC-C1-MINIMAL** SKIP: 工作区 outputs 不存在（C:\Users\Administrator\.lumii\outputs）
- **PC-C1-TERSE** SKIP: 工作区 outputs 不存在（C:\Users\Administrator\.lumii\outputs）
- **PC-C1-DETAILED** SKIP: 工作区 outputs 不存在（C:\Users\Administrator\.lumii\outputs）
- **PC-C2-MINIMAL** SKIP: 工作区 outputs 不存在
- **PC-C2-TERSE** SKIP: 工作区 outputs 不存在
- **PC-C2-DETAILED** SKIP: 工作区 outputs 不存在
- **PC-C3-MINIMAL** FAIL: 未观察到技能检索/加载或执行动作（技能命中异常）
  ```
  Error: 未观察到技能检索/加载或执行动作（技能命中异常）
    at assert (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:110:20)
    at file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/prompt-style/run-prompt-style-complex.mjs:392:5
    at runCase (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:518:18)
    at maybe (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/prompt-style/run-prompt-style-complex.mjs:75:10)
    at runSkillCase (fi
  ```
- **PC-C3-TERSE** FAIL: 回复未包含温度信息（任务未完成）
  ```
  Error: 回复未包含温度信息（任务未完成）
    at assert (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:110:20)
    at file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/prompt-style/run-prompt-style-complex.mjs:391:5
    at runCase (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:518:18)
    at maybe (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/prompt-style/run-prompt-style-complex.mjs:75:10)
    at runSkillCase (file:///E:
  ```
- **PC-C3-DETAILED** FAIL: 未观察到技能检索/加载或执行动作（技能命中异常）
  ```
  Error: 未观察到技能检索/加载或执行动作（技能命中异常）
    at assert (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:110:20)
    at file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/prompt-style/run-prompt-style-complex.mjs:392:5
    at runCase (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:518:18)
    at maybe (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/prompt-style/run-prompt-style-complex.mjs:75:10)
    at runSkillCase (fi
  ```
## 复杂任务多档对照

| 用例 | 档位 | 提示词 chars | 工具定义 token | MCP token | 回合耗时 | 工具序列 | 备注 |
|---|---|---|---|---|---|---|---|
| PC-C3-MINIMAL | minimal | 13399 | 12226 | 86 | 28.1s | web_search>web_fetch>web_fetch | skill检索=false；skill加载=false；bash=false；回复含温度=true |
| PC-C3-TERSE | terse | 19498 | 16253 | 162 | 109.5s | web_search>web_fetch>bash>bash>bash>web_fetch | skill检索=false；skill加载=false；bash=true；回复含温度=false |
| PC-C3-DETAILED | detailed | 35499 | 16811 | 182 | 28.1s | web_fetch>web_search>web_fetch | skill检索=false；skill加载=false；bash=false；回复含温度=true |


## 证据

逐条原始证据见 [prompt-style-complex-3way-evidence.jsonl](./prompt-style-complex-3way-evidence.jsonl)。
