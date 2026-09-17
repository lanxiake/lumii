# geronimo-iia/llm-wiki 源码参考

- 上游：<https://github.com/geronimo-iia/llm-wiki>
- 本地检出：`C:\myself\projects\open-source\geronimo-iia-llm-wiki`
- 调研提交：`b4e224f34470d7034887703b2dda90b58ab3b50b`
- 许可证：MIT OR Apache-2.0（见上游 `LICENSE-MIT`、`LICENSE-APACHE`）
- 调研方式：只阅读上游源码、设计说明和测试；本目录不复制第三方源码。

关键证据：

- `src/{engine,index_manager,index_schema,ingest,search,graph,watch}.rs`
- `docs/invariants.md`、`docs/specifications/engine/{index-management,ingest-pipeline,graph}.md`
- `tests/{ingest,search,index_manager,graph}.rs` 与 `tests-integration/engine/`
