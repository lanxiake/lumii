# siyuan-note/siyuan 源码参考

本目录不复制思源笔记源码；本地 checkout 位于：

```text
C:\myself\projects\open-source\siyuan
```

| 项目 | 值 |
| --- | --- |
| 仓库 | `https://github.com/siyuan-note/siyuan.git` |
| 分支 | 当前 checkout HEAD |
| 提交 | `afa823b6b4e4f183511e0bc0a3be93caa94c7c97` |
| 提交时间 | `2026-08-18T17:55:58+08:00` |
| 许可证 | GNU AGPLv3（`LICENSE`、README 徽章） |
| 调研日期 | 2026-08-24 |

## 证据入口

- `README.md`：块级引用、双链、搜索与 CLI/API 产品能力。
- `docs/WORKSPACE.md`：工作区真相源、可重建索引、目录层级和加密边界。
- `docs/SY-FORMAT.md`：`.sy` JSON 树格式与直接读写边界。
- `kernel/filesys/tree.go`：树写入、缓存与加密文档的落盘校验。
- `kernel/sql/index_queue.go`、`kernel/sql/block_ref.go`：索引队列和块引用数据层。
- `kernel/search/find.go`：搜索实现入口；相关 `*_test.go` 覆盖索引、引用和搜索部分行为。

思源是产品与交互参考，不应作为 Lumii 的依赖或复制对象；AGPLv3 使代码级复用需先进行法务评估。
