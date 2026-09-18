# 工程基建 · 设计

工程/构建/自动化相关设计。实施计划见 [`../../plans/工程基建/`](../../plans/工程基建/)。

| 文档 | 说明 |
| --- | --- |
| [`2026-08-10-项目级Git集成设计.md`](2026-08-10-项目级Git集成设计.md) | `workspace/projects/<name>` 下用户项目的 Git 状态展示（分支/远程/文件改动标记） |
| [`2026-08-21-Typecheck基线与Cron设计.md`](2026-08-21-Typecheck基线与Cron设计.md) | typecheck 基线与 cron 定时任务 |
| [`2026-09-18-原生ONNX运行时加载顺序闸.md`](2026-09-18-原生ONNX运行时加载顺序闸.md) | 两份同名 `onnxruntime.dll`（sherpa 1.27 / onnxruntime-node 1.14）导致启动崩溃；用进程级顺序闸强制 VAD 先于 E5 |
