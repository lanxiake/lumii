# 提示词风格三档复杂任务实测分析（P3 极简档）

> 执行器：[run-prompt-style-complex.mjs](./run-prompt-style-complex.mjs)（`PC_STYLES=minimal,terse,detailed`，CLI 驱动真实客户端 + 真实 LLM，无 SQL 播种）
> 原始数据：[prompt-style-complex-3way-traces.json](./prompt-style-complex-3way-traces.json) · [evidence.jsonl](./prompt-style-complex-3way-evidence.jsonl) · [report.md](./prompt-style-complex-3way-report.md)
> 时间：2026-09-15 23:10–23:25（客户端已加载 P3 极简档 bundle）· 会话前缀 `[pc-suite]`
> 环境修正：套件的工作区探测此前读渲染层设置（为空）导致 C1/C2 整体 SKIP；本轮已改为三级回退（设置 → 主进程 `app.workspaceDirectory` → 日志实测 cwd）。

## 一、完成度（硬断言）

| 用例 | minimal | terse | detailed |
|---|---|---|---|
| PC-C1 文件工具链（多步：目录/示例文件/脚本/运行/报告） | ✅ 16 调用 / 36.3s | ✅ 15 调用 / 51.9s | ✅ 16 调用 / 44.2s |
| PC-C2 调研简报（检索 → 3 条 → 落盘） | ✅ 22 调用 / 188s | ❌ 断言误伤（见下）/ 4 调用 | ✅ 67 调用 / 328s |
| PC-C3 天气技能（技能/执行动作 + 回复含温度） | ✅ 4 调用 / 45.3s | ❌ 断言局限 / 4 调用 | ❌ 断言局限 / 2 调用 |
| **通过** | **3/3** | 1/3 | 2/3 |

- **极简档 3/3 全过**：多步文件链（todo×4、file_mkdir、file_write×7、bash、glob、task_complete×2）产出 stats.py + report.md 且脚本含统计逻辑；调研简报落盘 2009 字符、3 条、命名合规；天气回复含温度。
- PC-C2-TERSE 的 FAIL 属**断言误伤**（日志实证）：主 Agent 把调研委派给 `spawn_agent(agentType="info-curator")`，子代理在该轮窗口内 `web_fetch` 20+ 次并 `file_write` 落盘 `outputs/ai-coding-tools-brief/ai编程工具简报-20260915.md`（23:17:47–23:18:44）——任务实际完成；断言只读主会话轨迹、看不到子代理检索，故误判。
- PC-C3 的 terse/detailed FAIL 为 P2 已记录的**断言局限**（模型 `web_fetch` 直连天气源，断言只认 skill/bash）；minimal 恰好走了 bash 而通过。
- PC-C2-DETAILED 出现 **completion 重试风暴**：窗口内 task_complete ×62、bash ×27，verification gate 以「本轮未检测到验证步骤」拒绝 ×31，模型陷入「补验证 → 再完成」循环（本轮 328s）。基线档（detailed）行为，与极简无关；minimal 同场景 22 次调用干净通过。建议另查门禁的放弃/提示策略。

## 二、用量差异（同一用例跨档对照）

| 用例 | 指标 | minimal | terse | detailed | minimal vs 简要 | minimal vs 详细 |
|---|---|---|---|---|---|---|
| PC-C1 | 提示词 chars | 17,275 | 19,498 | 35,499 | −11.4% | −51.3% |
| | 工具定义 token | 12,122 | 16,265 | 17,050 | **−25.5%** | −28.9% |
| | MCP token | 90 | 195 | 184 | −54% | −51% |
| PC-C2 | 提示词 chars | 14,751 | 18,869 | 31,496 | −21.8% | −53.2% |
| | 工具定义 token | 11,190 | 16,316 | （未采到） | **−31.4%** | — |
| PC-C3 | 提示词 chars | 17,274 | 19,498 | 35,499 | −11.4% | −51.3% |
| | 工具定义 token | 12,237 | 16,643 | 16,843 | **−26.5%** | −27.3% |

- 工具定义类目一致 **−25~31%**（与静态实测 −24.3%、真机 A/B −27.2% 同口径互证）；
- 提示词整份 −11~22%（静态差 = MCP 章节去描述；动态差 = Workspace 紧凑版 + Runtime 一行版）；
- 详细档 static（26,117）≈ 简要（10,223）+ Tooling 全量索引 + Skills 全量描述 —— 三档结构性差异与设计一致。

## 三、结论

1. **极简档可正常执行复杂任务**：三类场景（多步文件工具链 / 委派式调研落盘 / 时效查询）全部完成，工具选择无退化（minimal 在 C1 使用了 file_mkdir 组织目录，优于另两档的直写路径；C2 过程比 detailed 干净得多）。
2. **复杂度未引入额外轮次或失败**：minimal 三例耗时 36–188s，均无断言风暴、无产物缺失。
3. 现存的 3 个 FAIL 全部归因于**断言口径**（子代理轨迹不可见 / 只认 skill/bash），非风格回归；建议后续把 C2 断言改为「主会话或子代理任一 web_search」、C3 断言纳入 web_fetch。
