# 提示词风格实验（PS）CLI 场景化验收 测试报告

- **生成时间**: 2026-09-13T09:09:26.526Z（开始 2026-09-13T09:04:13.583Z）
- **驱动方式**: 全部经 lumii-ui CLI 真实调用（conversation/send/context 等），真实客户端 + 真实 LLM，无 SQL 播种
- **数据库**: C:\Users\Administrator\.lumii\data\agent-runtime.db
- **风格切换方式**: app-ui CLI `settings set promptStyle.style`（真实设置写入；结束恢复原值）
- **探针会话前缀**: [ps-suite]

## 概要

| 指标 | 值 |
|---|---|
| 总数 | 8 |
| 通过 | 8 |
| 失败 | 0 |
| 跳过 | 0 |
| 通过率 | 100.0% |

## 逐条结果

| ID | 状态 | 说明 | 耗时 |
|---|---|---|---|
| PS-LOG-01 | ✅ | detailed 档转储形态正确（chars=33079，10945ms） | 13.0s |
| PS-LOG-02 | ✅ | terse 档转储形态正确（chars=28809，10902ms） | 13.1s |
| PS-TASK-01-DETAILED | ✅ | 已创建提醒 at=1789376400000；guideHit=false；16208ms | 18.3s |
| PS-TASK-01-TERSE | ✅ | 已创建提醒 at=1789347600000；guideHit=false；13558ms | 15.5s |
| PS-TASK-02-DETAILED | ✅ | 产物 print_today.py（轮1 13615ms / 轮2 17375ms；chars=33079） | 33.9s |
| PS-TASK-02-TERSE | ✅ | 产物 print_today.py（轮1 16280ms / 轮2 13603ms；chars=28810） | 32.4s |
| PS-TASK-03-DETAILED | ✅ | 连续性命中（轮1 18955ms / 轮2 16266ms） | 48.6s |
| PS-TASK-03-TERSE | ✅ | 连续性命中（轮1 10883ms / 轮2 13741ms） | 26.8s |

## 失败与跳过明细

无。
## 双档对照（任务实施差别）

| 用例 | 档位 | 提示词 chars | 展开引导命中 | 回合耗时 | 备注 |
|---|---|---|---|---|---|
| PS-TASK-01-DETAILED | detailed | 33079 | — | 16.2s | 提醒行=at:1789376400000；回复语义=命中 |
| PS-TASK-01-TERSE | terse | 28810 | — | 13.6s | 提醒行=at:1789347600000；回复语义=命中 |
| PS-TASK-02-DETAILED | detailed | 33929 | ✓ | 31.0s | 产物=print_today.py；轮2文件含星期逻辑 |
| PS-TASK-02-TERSE | terse | 29660 | ✓ | 29.9s | 产物=print_today.py；轮2文件含星期逻辑 |
| PS-TASK-03-DETAILED | detailed | 36187 | - | 35.2s | 连续性=命中 |
| PS-TASK-03-TERSE | terse | 29304 | - | 24.6s | 连续性=命中 |

> 硬断言：任务落地（cron 行 / outputs 产物 / 连续性回复）；软信号（回复语义 / 引导命中）供引导句迭代参考，详见各用例 note。
> 微信渠道两场景（cron_guide / weixin_send_guide）需真实微信会话，见用例文档「人工验证补充」。

## 证据

逐条原始证据见 [prompt-style-suite-evidence.jsonl](./prompt-style-suite-evidence.jsonl)。
