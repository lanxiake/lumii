# 分析与反思

本目录存放**方案分析、批判性反思**类文档 —— 回答"为什么选这个方案 / 这个方案哪里会塌"。

与 [`../design/`](../design/) 的区别：设计文档给结论与方案，本目录给**推导过程与反面论证**。

| 文档 | 说明 |
| --- | --- |
| [`2026-09-07-multi-device-data-sync-strategy.md`](2026-09-07-multi-device-data-sync-strategy.md) | 多设备数据同步策略分析：数据分类矩阵、同步/不同步的物理二分、体积估算 |
| [`2026-09-07-sync-strategy-reflection.md`](2026-09-07-sync-strategy-reflection.md) | 对上一稿的批判性审视：JSONL 六大复杂度被低估、Git Squash 在多设备场景的破坏性、事件溯源与向量时钟路线 |

> 这两篇的结论已影响后续实现：同步层因此硬拦截 `--squash` 与 `--force`。云同步方案全貌见 [`../plans/数据同步功能/README.md`](../plans/数据同步功能/README.md)。
