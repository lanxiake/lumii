# 工具面治理验证（TC）CLI 场景化验收 测试报告

- **生成时间**: 2026-09-18T06:33:03.326Z（开始 2026-09-18T06:30:20.318Z）
- **驱动方式**: 全部经 lumii-ui CLI 真实调用（conversation/send/context 等），真实客户端 + 真实 LLM，无 SQL 播种
- **数据库**: C:\Users\75791\.lumii\data\agent-runtime.db
- **探针会话前缀**: [tc-suite]
- **探针文件目录**: C:\Users\75791\.lumii\workspace\temp
- **验证范围**: 改动 ①（失效引用修复）行为面 + 改动 ②（duration_ms 回填）数据面；TC-04/05 为 0.3 基线

## 概要

| 指标 | 值 |
|---|---|
| 总数 | 4 |
| 通过 | 4 |
| 失败 | 0 |
| 跳过 | 0 |
| 通过率 | 100.0% |

## 逐条结果

| ID | 状态 | 说明 | 耗时 |
|---|---|---|---|
| TC-CONTRACT-01 | ✅ | 新增 1 条工具失败审计，duration_ms 全部有值（样例 118ms） | 14.6s |
| TC-CONTRACT-02 | ✅ | 未出现 read_file；file_read 调用 1 次（序列：memory_read>memory_read>file_read>memory_search） | 16.4s |
| TC-CONTRACT-03 | ✅ | file_edit 成功 1 次，无参数校验失败，文件内容已按预期替换 | 21.0s |
| TC-CONTRACT-05 | ✅ | 本次请求工具面 116/116（含 MCP）；非 MCP 工具 94 个，守卫射程 68 → 覆盖 72.3%（缺口 26 个，0.3 待补） | 0.1s |

## 失败与跳过明细

无。
## 指标对照

| 用例 | 工具序列 | 审计行数 | duration 为空 | Other Tools | 守卫覆盖率 |
|---|---|---|---|---|---|
| TC-01 | - | 1 | 0 | - | - |
| TC-02 | memory_read>memory_read>file_read>memory_search | - | - | - | - |
| TC-03 | file_read>file_edit>file_read | - | - | - | - |
| TC-04 | - | - | - | 9 | - |
| TC-05 | - | - | - | - | 72.3 |

> **TC-CONTRACT-04 是 INFO 而非 PASS**：0.3「扩守卫射程」尚未实施，`Other Tools` 非零是已知待办，
> 把它算成失败会掩盖"本套件验证的两项改动其实都通过了"这个事实。它的作用是提供施工前后对照。

## 静态面的对应守卫

本套件只覆盖**行为面与数据面**。文本本身（schema 描述 / 错误文案里的工具名引用）
由单测 `packages/agent-runtime/src/tools/__tests__/tool-name-references.test.ts` 守——
它能精确到"哪个文件的哪段文本引用了谁"，且已做变红验证（注入失效名即失败）。
两层分工：**单测守文本，CLI 守行为**。

## 证据

逐条原始证据见 [tool-contract-suite-evidence.jsonl](./tool-contract-suite-evidence.jsonl)。
