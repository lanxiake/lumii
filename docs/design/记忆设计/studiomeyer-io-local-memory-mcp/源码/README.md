# studiomeyer-io/local-memory-mcp 源码参考

本目录只保存调研索引，不复制第三方源码。源码工作副本：

```text
C:\myself\projects\open-source\local-memory-mcp
```

## 快照

| 项目 | 值 |
| --- | --- |
| 仓库 | `https://github.com/studiomeyer-io/local-memory-mcp.git` |
| 分支 | `main` |
| 提交 | `2d3600634c0f95b13fd956013d9794c4187af014` |
| 提交日期 | `2026-08-21T22:11:11+02:00` |
| 许可证 | MIT |
| 调研日期 | 2026-08-24 |

## 阅读入口

- `README.md`：能力范围、运行时回退、工具分类与限制。
- `WHITEPAPER.md`：设计原则和公开声明；须与源码交叉验证。
- `src/db/schema.sql`：实体、观察、关系、统一 FTS5 索引和触发器。
- `src/db/migrations/002_vector.sql`、`src/db/vector.ts`、`src/lib/embed.ts`：sqlite-vec 与本地 multilingual-e5-small 嵌入层。
- `src/tools/search.ts`：FTS5/BM25、向量余弦、RRF 与时效/使用/重要度重排。
- `src/tools/entity.ts`：实体观察、`asOf` 查询和 tombstone supersede。
- `src/tools/contradictions.ts`：无 LLM 的矛盾候选扫描。
- `src/tools/learn.ts`、`reflect.ts`：学习记录生命周期和基于 SQL 的反思汇总。
- `src/tools/*.test.ts`：时间窗口、supersede、向量回退与排名边界测试。

## 使用边界

本调研只吸收设计思想和经源码验证的技术模式。Lumii 不将该 MCP server 作为依赖；后续实施必须按 Lumii 的 `agent-runtime -> main -> preload -> renderer` 边界重新设计，并独立验证 Windows、中文检索、包体和用户数据行为。
