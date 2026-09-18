# 工具面治理验证（TC）CLI 场景化验收 测试报告

- **生成时间**: 2026-09-18T06:55:42.889Z（开始 2026-09-18T06:52:41.255Z）
- **驱动方式**: 全部经 lumii-ui CLI 真实调用（conversation/send/context 等），真实客户端 + 真实 LLM，无 SQL 播种
- **数据库**: C:\Users\75791\.lumii\data\agent-runtime.db
- **探针会话前缀**: [tc-suite]
- **探针文件目录**: C:\Users\75791\.lumii\workspace\temp
- **验证范围**: 改动 ①（失效引用修复）行为面 + 改动 ②（duration_ms 回填）数据面 + 0.3 扩守卫射程

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
| TC-CONTRACT-01 | ✅ | 新增 1 条工具失败审计，duration_ms 全部有值（样例 2ms） | 20.7s |
| TC-CONTRACT-02 | ✅ | 未出现 read_file；file_read 调用 1 次（序列：file_read） | 22.7s |
| TC-CONTRACT-03 | ✅ | file_edit 成功 1 次，无参数校验失败，文件内容已按预期替换 | 27.4s |
| TC-CONTRACT-05 | ✅ | 本次请求工具面 116/116（含 MCP）；非 MCP 工具 94 个，静态守卫射程 91 → 覆盖 96.8%；运行时告警兜底 3 个动态注册工具（file-term-replace, node-read-file-script, replace-js-terms） | 0.1s |

## 失败与跳过明细

无。
## 指标对照

| 用例 | 工具序列 | 审计行数 | duration 为空 | Other Tools | 守卫覆盖率 | 运行时告警（动态注册） |
|---|---|---|---|---|---|---|
| TC-01 | - | 1 | 0 | - | - | - |
| TC-02 | file_read | - | - | - | - | - |
| TC-03 | file_read>file_edit>file_read>task_complete | - | - | - | - | - |
| TC-04 | - | - | - | 3 | - | - |
| TC-05 | - | - | - | - | 96.8 | 3（file-term-replace, node-read-file-script, replace-js-terms） |

## 两层守卫的分工（2026-09-18 扩射程后）

| 层 | 位置 | 覆盖 | 触发时机 |
|---|---|---|---|
| 静态 | `packages/.../tooling-section.test.ts` | 54 内置 + 13 客户端名 + execute_skill | CI（批次 0.4 已接入） |
| 静态 | `apps/windows/.../host-tool-prompt-coverage.test.ts` | 源码扫宿主注册器，37 个 | 本地 `pnpm verify`（apps/windows 套件有摆动用例，刻意不进 CI） |
| **运行时** | `tooling-section.ts` 的 `partitionToolNames` | **动态注册的工具**（工具进化产物） | 每次渲染系统提示词 |

**为什么第三层不可省**：实测这道告警抓到了 3 个静态守卫永远扫不到的工具——
`file-term-replace` / `node-read-file-script` / `replace-js-terms`。
它们是 `bridge.ts` 的 `registerEvolvedTool` 在运行时注册的（bash-evolution 挖掘产物，
名字编译期不可知，所以**只能靠运行时兜底**）。

> TC-CONTRACT-04 是 INFO 而非 PASS：0.3 实施后 `Other Tools` 从 9 降到 3，
> 剩下 3 个是**已知的动态注册工具**而非漏配。把它算成失败会掩盖这个区别。

## 文本面的对应守卫

本套件只覆盖**行为面与数据面**。schema 描述与错误文案里的工具名引用由
`packages/agent-runtime/src/tools/__tests__/tool-name-references.test.ts` 守——
它能精确到"哪个文件的哪段文本引用了谁"，且做过变红验证（注入失效名即 2 条失败）。
**单测守文本，CLI 守行为与数据。**

## 证据

逐条原始证据见 [tool-contract-suite-evidence.jsonl](./tool-contract-suite-evidence.jsonl)。
