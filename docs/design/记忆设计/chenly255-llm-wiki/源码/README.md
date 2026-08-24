# chenly255/llm-wiki 源码参考

本目录不复制第三方源码；本地 checkout 位于：

```text
C:\myself\projects\open-source\chenly255-llm-wiki
```

| 项目 | 值 |
| --- | --- |
| 仓库 | `https://github.com/chenly255/llm-wiki.git` |
| 分支 | 当前 checkout HEAD |
| 提交 | `a37ff8cfce4112d1a2f66d3b75d460983d3ffe48` |
| 提交时间 | `2026-05-31T09:06:21Z` |
| 许可证 | README 声明 MIT；checkout 根目录未见单独 `LICENSE` 文件，应在采用前复核上游发布物 |
| 调研日期 | 2026-08-24 |

## 证据入口

- `README.md`：目录约定、工作流和许可声明。
- `llm-wiki/SKILL.md`：Agent 命令契约、显式入库和 `trusted/` 审核边界。
- `llm-wiki/references/wiki-conventions.md`：页面与链接书写约定。
- `llm-wiki/scripts/index.py`：全量扫描 Markdown、反链、断链和 Mermaid 图生成。
- `llm-wiki/scripts/search.py`：进程内 BM25 搜索实现。

这里只记录设计启发，不把该 Claude Code Skill 或其脚本作为 Lumii 的运行时依赖。
