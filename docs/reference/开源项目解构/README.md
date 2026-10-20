# 开源项目解构

12 个外部开源项目的解构分析，每个项目一个目录：

```
<项目名>/
├── 设计解构.md      架构、核心机制、可借鉴点与不可借鉴点
└── 源码/README.md   源码导读
```

| 项目 | 方向 |
| --- | --- |
| `deepseek-harness` | **Everything-is-a-plugin 的 Agent Harness**：Cordis 内核、Profile/Bundle/Patch 组合、客户端模块系统与 Slot、会话节点装配、插件管理器与热更新 |
| `aaronsb-memory-graph` | 记忆图谱 |
| `chenly255-llm-wiki` | LLM Wiki |
| `erickmbugua-llm-wiki` | LLM Wiki |
| `geronimo-iia-llm-wiki` | LLM Wiki |
| `modelcontextprotocol-servers` | MCP 官方 servers |
| `nvk-llm-wiki` | LLM Wiki |
| `siyuan-note-siyuan` | 思源笔记（本地优先知识管理） |
| `spences10-wiki0` | LLM Wiki |
| `studiomeyer-io-local-memory-mcp` | 本地记忆 MCP |
| `vndee-memex` | Memex 记忆库 |
| `YonasValentin-mcp-memory-graph` | 记忆图谱 MCP |

> 这批解构原在 `design/记忆与Wiki/参考项目/`，2026-09-17 移出——它们是**别人的项目**，不属于 Lumii 的设计，且占了原目录 65% 的篇幅。
>
> 调研这批项目的方法论结论（非项目解构本身）见 [`../../design/Wiki知识库/2026-08-23-记忆与Wiki知识库技术设计.md`](../../design/Wiki知识库/2026-08-23-记忆与Wiki知识库技术设计.md)。
