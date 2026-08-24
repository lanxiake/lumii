# spences10/wiki0 源码参考

本目录只保存调研索引，第三方源码 checkout 位于：

```text
C:\myself\projects\open-source\wiki0
```

| 项目 | 值 |
| --- | --- |
| 仓库 | `https://github.com/spences10/wiki0.git` |
| 分支 | 当前 checkout HEAD |
| 提交 | `872d0da2910a147f6990b20d3926a243aa59e6ba` |
| 提交时间 | `2026-08-18T08:45:52+02:00` |
| 许可证 | MIT（根 `package.json` 与 `packages/core/package.json`） |
| 调研日期 | 2026-08-24 |

## 证据入口

- `wiki/decisions/local-first-storage.md`：Markdown 真相源与 SQLite 可重建索引决策。
- `packages/core/src/schema.sql`：页面、链接、分块、事实、事件与 FTS5 schema。
- `packages/core/src/indexer.ts`：全量事务索引、链接解析和索引陈旧判断。
- `packages/core/src/search.ts`：BM25、chunk 召回、反链和查询降级。
- `packages/core/src/sync.ts`：资料同步为待人工审核页面的工作流。
- `packages/core/src/*.test.ts`：索引、搜索和同步行为测试。

本参考不将 Node 24、MCP、CLI 或 Svelte web app 作为 Lumii 依赖。
