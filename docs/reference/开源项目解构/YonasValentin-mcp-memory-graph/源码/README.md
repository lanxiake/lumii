# YonasValentin/mcp-memory-graph 源码参考

本目录不复制第三方源码；源码工作副本统一位于：

```text
C:\myself\projects\open-source\mcp-memory-graph
```

## 快照

| 项目 | 值 |
| --- | --- |
| 仓库 | `https://github.com/YonasValentin/mcp-memory-graph.git` |
| 分支 | `main` |
| 提交 | `6dd8aea43a022f380b9764cf5e468171360802f1` |
| 提交日期 | `2026-07-06T15:40:00+02:00` |
| 许可证 | PolyForm Noncommercial 1.0.0（商用须另行取得许可） |
| 调研日期 | 2026-08-24 |

## 阅读入口

- `README.md`：能力、部署边界和公开基准。
- `src/db/schema.ts`：SQLite 物理模型、FTS5、sqlite-vec 与迁移版本。
- `src/tools/store.ts`：写入总编排和冲突处理时序。
- `src/search/hybrid.ts`：向量、FTS5、图谱三路 RRF 融合。
- `src/graph/write-gate.ts`、`conflict-resolver.ts`、`contradiction.ts`：写入门控与 NLI 矛盾检测。
- `src/graph/memory-links.ts`、`graph-query.ts`、`pagerank.ts`：链接、有限图遍历与 Personalized PageRank。
- `src/tools/consolidate.ts`、`src/search/tiers.ts`：整理、衰减和分层能力。
- `docs/adr/0001-sqlite-with-sqlite-vec.md`、`docs/adr/0003-conflict-detection-ordering.md`：关键决策记录。
- `docs/BENCHMARKS.md`：测量方法、数据规模和已知性能边界。

## 使用边界

此处的 `设计解构.md` 仅记录可验证的设计参考与对 Lumii 的适配建议，不复制实现代码，也不将该仓库作为 Lumii 的运行时依赖。任何后续采用都必须重新评估许可证、依赖体积、Windows 运行方式、现有 SQLite 迁移机制和用户数据兼容性。
