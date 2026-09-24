# 大文件与死代码

> 上位文档：[代码重构总报告](../README.md)

## 文档

| 文档 | 说明 |
| --- | --- |
| [`2026-08-21-大文件重构分析报告.md`](2026-08-21-大文件重构分析报告.md) | >400 行文件的分级统计与拆分建议（口径：排除纯空行，与[总报告](../2026-09-12-源码重构瘦身分析报告.md)的"含空行注释"口径不同，数值不可直接比较） |
| [`code-location-index.md`](code-location-index.md) | 逐文件代码定位索引（>400 行文件清单） |
| [`dead-code-cleanup-list.md`](dead-code-cleanup-list.md) | 死代码清理清单与**逐项复核证据**（A/B 级）。B 级复核推翻了原分析的三处结论 |
| [`2026-09-24-接线守卫与无消费者IPC清单.md`](2026-09-24-接线守卫与无消费者IPC清单.md) | **接线守卫**（AST 判定，六类断线）的设计说明 + 前三批已执行清理 + ⑥ 类报出的 **38 个无消费者 IPC（待决策）** |
| [`2026-08-20-Gateway遗留代码分析.md`](2026-08-20-Gateway遗留代码分析.md) | Gateway 时代遗留代码的识别与清理建议 |

## 命名陷阱（勿误删）

`apps/windows/src/main/coding-dev-backends-stub/` 名字含 "stub" 但**是真实实现**，被 6 处引用。
同理 `stubs/qrcode-terminal.ts`、`renderer/stubs/util.ts` 为构建必需。
