# 源码参考：vndee/memex

- 上游仓库：https://github.com/vndee/memex
- 本地快照：`C:\myself\projects\open-source\memex`
- 核对提交：`a3bda8beac51ef590aaf15b4cf81502925889abd`（2026-04-06）
- 许可证：仓库 `LICENSE` 为 MIT。
- 调研范围：不复制第三方实现；下列文件是本解构结论的可复查证据。

| 主题 | 源码证据 |
| --- | --- |
| 领域模型、知识库隔离 | `internal/domain/models.go`、`migrations/001_initial.sql` |
| 摄取降级和重试 | `internal/ingestion/pipeline.go`、`internal/storage/ingestion_jobs.go`、`internal/ingestion/pipeline_test.go` |
| FTS、向量、混合检索 | `internal/storage/search.go`、`internal/search/hybrid.go`、`internal/search/rrf.go`、`internal/search/hybrid_test.go` |
| 时态图和子图 | `internal/graph/graph.go`、`internal/storage/subgraph_hydration.go`、`internal/graph/graph_test.go` |
| 向量索引演进 | `internal/vecstore/engine.go`、`internal/vecstore/hnsw.go`、`internal/vecstore/*_test.go` |
| 生命周期与合并 | `internal/lifecycle/manager.go`、`internal/lifecycle/consolidation.go`、`internal/lifecycle/lifecycle_test.go` |
| MCP/HTTP 外层 | `internal/server/mcp.go`、`internal/server/http.go` |
