# Wiki P1 CLI 测试用例（补强版）

- 日期：2026-08-27
- 计划：`docs/plans/记忆重构/2026-08-26-wiki-p1-implementation.md`

## CLI 覆盖

| 子命令 | 用例 |
|---|---|
| `wiki backlinks` | P1-L* |
| `wiki unresolved` | P1-G01 |
| `wiki revisions` / `rollback` | P1-V* |
| `wiki cleanup scan` | P1-C* |
| `wiki source archive [--restore]` | P1-C03/C04 |
| `wiki export` | P1-E* |

---

## L 双链 / 反链

### P1-L01 既有反链可读
- 对「架构设计文档」`wiki backlinks`
- 断言：数组；有则含 `sourcePageId,anchorText,isResolved`

### P1-L02 写 `[[标题]]` 后反链出现
- update 页 `sources/wiki-cli-p1-wikilink` 内容含 `[[架构设计文档]]`
- backlinks 目标页出现 sourceTitle/path 含探针名

### P1-L03 未解析链接不破坏正文
- update 含 `[[不存在的页面标题xyz]]`
- get 页正文仍含原文双链；`command wiki:link:unresolved` 应能看到该锚（GAP 命令）

### P1-L04 空反链
- 新建无链页 → backlinks `[]`

---

## V 修订 / 回滚

### P1-V01 revisions 列表
- 多版本页：version 降序，含 contentMd

### P1-V02 rollback 增版且旧版不可变
- 探针 path 写 v1/v2 → rollback 1 → 新 version=max+1；get 正文=v1；version=1 行仍在

### P1-V03 rollback 非法版本
- version 99999 → 失败

### P1-V04 rollback 幽灵页
- 不存在 pageId → 失败

---

## C 清理 / 归档副作用

### P1-C01 cleanup scan
- 返回数组，元素含 `sourceId,title,reason`

### P1-C02 stale-days
- `--stale-days 30` exit 0

### P1-C03 archive + restore 往返
- archive sourceId → restore → 两步 success

### P1-C04 archive 后检索排除（若产品设计如此）
- archive 后 search 该标题：命中数下降或带归档标记；restore 后恢复
- 若产品不排除归档源对应页，记观察不 FAIL（以实际设计为准：P1 计划写「归档后检索排除」）

---

## E 导出

### P1-E01 基础导出
- 临时目录；至少 1 个 `.md`；路径大致 mirror page path

### P1-E02 `--include-sources`
- exit 0

### P1-E03 `--include-attachments`
- exit 0

### P1-E04 非法目标（可选）
- 若实现拒绝危险路径则断言失败；否则 SKIP

---

## GAP（`command`）

| IPC | 用例 | 断言 |
|---|---|---|
| `wiki:link:unresolved` | P1-G01 | 已有 CLI `wiki unresolved` |
| `wiki:concept:scan` | P1-G02 | 成功或空候选 |
| `wiki:concept:confirm/reject` | P1-G03 | 无候选则 SKIP |
| `wiki:attach:list` | P1-G04 | 对某 pageId 返回数组 |
| `wiki:attach:add/remove` | P1-G05 | 有文件则测；无则 SKIP |
| `wiki:source:delete` | P1-G06 | **仅对套件自建 source**；默认 SKIP 除非显式 `WIKI_CLI_ALLOW_DELETE=1` |
| `wiki:page:delete` | P1-G07 | 删除 `wiki-cli-*` 探针页 |
