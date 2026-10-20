# 工程基建 · 设计

工程/构建/自动化相关设计。实施计划见 [`../../plans/工程基建/`](../../plans/工程基建/)。

| 文档 | 说明 |
| --- | --- |
| [`2026-08-10-项目级Git集成设计.md`](2026-08-10-项目级Git集成设计.md) | `workspace/projects/<name>` 下用户项目的 Git 状态展示（分支/远程/文件改动标记） |
| [`2026-08-21-Typecheck基线与Cron设计.md`](2026-08-21-Typecheck基线与Cron设计.md) | typecheck 基线与 cron 定时任务 |
| [`2026-09-18-原生ONNX运行时加载顺序闸.md`](2026-09-18-原生ONNX运行时加载顺序闸.md) | 两份同名 `onnxruntime.dll`（sherpa 1.27 / onnxruntime-node 1.14）导致启动崩溃；用进程级顺序闸强制 VAD 先于 E5 |
| [`2026-09-21-打包体积治理.md`](2026-09-21-打包体积治理.md) | 安装包 253.9 → 156.2 MiB（−38.5%）：排掉 13 类「运行时用不到」的东西；含 electron-builder 三条反直觉配置真相与可复跑的产物判据 |
| [`2026-09-23-pi框架0.87.1技术研究报告.md`](2026-09-23-pi框架0.87.1技术研究报告.md) | harness/durable 源码深潜：13 态 durable 状态机、意图先写+memo、钩子与压缩机制；两套内核栈并存（pico3 experimental）；分级给出对本仓的采纳建议与 `/compat` 到期风险 |
| [`2026-10-09-wechat-mcp-npm社区分发.md`](2026-10-09-wechat-mcp-npm社区分发.md) | ⛔ **已废弃**（2026-10-13）——npm 分发整条撤掉，改走「双击 exe 一键安装」；只作决策留档，现行手册见 `apps/windows/resources/wechat-mcp/PUBLISHING.md` |
| [`2026-10-11-可选组件插件化设计.md`](2026-10-11-可选组件插件化设计.md) | 装包 156→298 MiB 的复盘 + 把 ≥25MB 大件（pet-models/ffmpeg/wechat-mcp）做成插件、**统一在插件中心安装**：复用 `PluginCenterPage`（需泛化硬编码的 `plugin-ipc.ts`）、逐插件设计、分期 P0-P3、待拍板 |
| [`2026-10-19-Lumii插件化整体规划与分阶段设计索引.md`](2026-10-19-Lumii插件化整体规划与分阶段设计索引.md) | **插件化总索引**：P0–P5 分阶段、量化目标（`index.ts` ≤200 行 / `bridge.ts` 门面 ≤25 / IPC 0 无归属）、风险与依赖 |
| [`2026-10-19-Lumii插件化架构设计方案.md`](2026-10-19-Lumii插件化架构设计方案.md) | **契约与框架**：Context/Service/Effect/Event 四大契约、manifest v1、主进程与渲染层 PluginHost、Slot 与 CardRegistry |
| [`2026-10-19-Lumii功能插件化盘点与重构方案.md`](2026-10-19-Lumii功能插件化盘点与重构方案.md) | **存量盘点**：六条判据分四档（内核/核心服务/内建插件/资产）；11 万行中仅 2.7 万行（25%）值得插件化；211 IPC 归属治理、两个上帝对象的拆法 |
| [`2026-10-19-Lumii插件化关键决策记录.md`](2026-10-19-Lumii插件化关键决策记录.md) | **D1–D5 决策**：自用客户端定位下选激进方案——P0 即支持代码插件、同一上下文不隔离、分散代码位置、统一「扩展」文案、秒级热更新 |
| [`2026-10-19-P0插件内核设计.md`](2026-10-19-P0插件内核设计.md) | **P0 详细设计**：ServiceKey/Context/PluginScope LIFO 清理/EventBus 五种模式/Loader 拓扑排序/Manifest 校验，含实现与单测用例 |
