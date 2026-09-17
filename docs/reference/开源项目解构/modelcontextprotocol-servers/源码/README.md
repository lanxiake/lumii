# 源码参考：modelcontextprotocol/servers

- 上游仓库：https://github.com/modelcontextprotocol/servers
- 本地快照：`C:\myself\projects\open-source\servers`
- 核对提交：`599dafc1054550a6eeb87a6545c1e1b03b3ca827`（2026-08-18）
- 许可证：仓库处于 MIT 到 Apache-2.0 的迁移期；根 `LICENSE` 明确新代码/规范与原代码的适用许可不同，文档为 CC-BY-4.0。只提取设计，不复制源码。

| 主题 | 源码证据 |
| --- | --- |
| 极简知识图 | `src/memory/index.ts`、`src/memory/README.md` |
| memory server 行为测试 | `src/memory/__tests__/knowledge-graph.test.ts`、`resource.test.ts`、`file-path.test.ts` |
| 文件系统安全边界 | `src/filesystem/path-validation.ts`、`roots-utils.ts`、`__tests__/path-validation.test.ts` |
| 多 transport 参考架构 | `src/everything/server/index.ts`、`transports/*`、`docs/architecture.md` |
