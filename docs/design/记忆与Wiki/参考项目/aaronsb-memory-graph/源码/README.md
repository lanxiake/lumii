# 源码参考：aaronsb/memory-graph

- 上游仓库：https://github.com/aaronsb/memory-graph
- 本地快照：`C:\myself\projects\open-source\memory-graph`
- 核对提交：`5cfd2382778837b9f6399080956eee670d00452c`（2025-12-19）
- 许可证：存在不一致：`package.json` 标为 ISC，而 `README.md` 标为 MIT，仓库根目录未见 LICENSE；不能在未澄清前复制源码或依赖。

| 主题 | 源码证据 |
| --- | --- |
| 图模型和查询 | `src/graph/MemoryGraph.ts`、`src/graph/MemoryGraph.test.ts` |
| 存储抽象 | `src/storage/MemoryStorage.ts`、`StorageFactory.ts`、`DatabaseStorage.ts` |
| SQLite 数据与 FTS | `src/storage/SqliteMemoryStorage.ts`、`docs/reference/database-schemas.md` |
| 工具和资源 | `src/tools/memoryTools.ts`、`src/resources/memoryResources.ts`、`src/index.ts` |
| 图渲染与测试 | `src/graph/MermaidGenerator.ts`、`MermaidGenerator.test.ts`、`memoryTools.test.ts` |
