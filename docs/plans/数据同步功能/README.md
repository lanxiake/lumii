# 数据同步功能 · 文档索引

Lumii 云同步（多设备数据同步）的完整文档入口。功能代码位于 `apps/windows/src/main/cloud-sync/`，CLI 工具为 `apps/windows/resources/app-ui-cli/lumii-sync.mjs`。

> 2026-09-17：原散在 `implementation/` 的 2 篇实施总结、`analysis/` 的 2 篇策略分析已按主题归位到这里与 [`../../design/数据同步功能/`](../../design/数据同步功能/)，云同步的文档从 6 个目录收敛到 3 个。

## 一、当前方案（v3 · 轻量同步）

> 这是**正在服役**的方案：按表导出 JSONL + `deleted_at` 软删除 + 每表 hash 校验。Schema V38。

| 角色 | 文档 |
| --- | --- |
| 设计 | [`../../design/数据同步功能/2026-09-09-轻量云同步设计.md`](../../design/数据同步功能/2026-09-09-轻量云同步设计.md) |
| 实施计划 | [`2026-09-09-云同步V3实施计划.md`](2026-09-09-云同步V3实施计划.md) |
| 实施进度 | [`2026-09-09-云同步V3实施进度.md`](2026-09-09-云同步V3实施进度.md) |
| 测试计划 | [`2026-09-09-云同步V3测试计划.md`](2026-09-09-云同步V3测试计划.md) |
| 测试套件 | [`../../test/lumii-cli/cloud-sync/`](../../test/lumii-cli/cloud-sync/) — `run-cloud-sync-suite.mjs`、`run-sync-e2e.mjs`、[GitCode 真实同步用例](../../test/lumii-cli/cloud-sync/gitcode-sync-test-cases.md) |

## 二、历史方案（存档，不代表当前实现）

同步方案经过三次迭代，前两代文档保留作为决策史：

| 代 | 时间 | 思路 | 文档 |
| --- | --- | --- | --- |
| v1 | 2026-09-05 | 工作空间云同步（依赖 workspace git） | 设计 [`2026-09-05-工作空间云同步设计.md`](../../design/数据同步功能/2026-09-05-工作空间云同步设计.md) · 计划 [`2026-09-05-工作空间云同步开发计划.md`](2026-09-05-工作空间云同步开发计划.md) |
| v2 | 2026-09-07 | 精简多设备同步（聚焦同步范围） | 设计 [`2026-09-07-精简多设备同步方案.md`](../../design/数据同步功能/2026-09-07-精简多设备同步方案.md) · 实施总结 [`2026-09-07-精简云同步实施总结.md`](2026-09-07-精简云同步实施总结.md) · 整体总结 [`2026-09-07-云同步完整实施总结.md`](2026-09-07-云同步完整实施总结.md) |
| v3 | 2026-09-09 | 轻量 JSONL + 软删除（当前） | 见上表 |

## 三、分析与反思（决策推导）

| 文档 | 说明 |
| --- | --- |
| [`../../design/数据同步功能/2026-09-07-多设备数据同步策略分析.md`](../../design/数据同步功能/2026-09-07-多设备数据同步策略分析.md) | 数据分类矩阵、同步/不同步的物理二分、体积估算 |
| [`../../design/数据同步功能/2026-09-07-同步策略反思.md`](../../design/数据同步功能/2026-09-07-同步策略反思.md) | 批判性审视：JSONL 六大复杂度被低估、Git Squash 在多设备场景的破坏性、事件溯源与向量时钟路线 |

**重要教训（v2 反思结论，v3 亦沿用）**：Git Squash 在多设备场景是毁灭性的——squash 丢弃原 commit ID，两设备各自 squash 后互相 non-ff，再 force push 会令对方全量冲突。**同步层由此硬拦截 `--squash` 与 `--force`。**

## 四、修复记录

| 问题 | 文档 |
| --- | --- |
| 符号链接与冲突检测误触发 Agent | [`../../fix/2026-09-07-云同步冲突检测修复.md`](../../fix/2026-09-07-云同步冲突检测修复.md) |

## 五、同步范围（用户需求基线）

**同步**：Wiki 知识库 · 记忆数据（`agent_memories`）· 用户配置（`soul.md`、`user-memory.md`）· 自主进化数据（goals、diaries）· 用户自定义技能

**不同步**：聊天记录与历史对话 · 工具结果缓存 · 临时文件

理由：对话历史体积大且隐私敏感，Agent 记忆已提取其中的关键信息。

## 六、常用命令

```bash
# 导出
node apps/windows/resources/app-ui-cli/lumii-sync.mjs export

# 查看同步状态
node apps/windows/resources/app-ui-cli/lumii-sync.mjs status

# 运行测试套件
node docs/test/lumii-cli/cloud-sync/run-cloud-sync-suite.mjs
```

## 七、设计决策速查

| 决策 | 理由 |
| --- | --- |
| 不同步对话历史 | 用户明确要求；体积可能 GB 级；隐私敏感；记忆已提取关键信息 |
| 用 JSONL 而非 SQL dump | 可读、易调试、Git 友好（可 diff）、支持增量追加 |
| 独立 CLI 工具 | 不依赖应用运行，便于测试与自动化 |
| 快照体积 | 从 615MB 优化到 2.86MB（-99.5%） |

## 相关代码

```
apps/windows/src/main/cloud-sync/
├── sync-exporter.ts    # 导出（每表独立 .jsonl）
├── sync-importer.ts    # 导入
└── sync-manager.ts     # 集成与冲突处理

packages/agent-runtime/src/storage/schema.ts   # V38：deleted_at 软删除
```
