# erickmbugua/llm-wiki 源码参考

- 上游：<https://github.com/erickmbugua/llm-wiki>
- 本地检出：`C:\myself\projects\open-source\erickmbugua-llm-wiki`
- 调研提交：`bf4e075dd1c81342f9fd4cd6ae939e315eb3fb0b`
- 许可证：仓库根目录未发现 `LICENSE`，且 README/`pyproject.toml` 未声明许可证；使用前必须向上游确认。
- 调研方式：只阅读上游源码、设计资料和测试；本目录不复制第三方源码。

关键证据：

- `core/{ingest,query,watcher,chunking,embeddings}.py`
- `core/db/{connection,pages,search,reconcile,queue,jobs}.py`
- `tests/test_database.py`、`tests/test_query.py`、`tests/integration/test_ingest_pipeline.py`
