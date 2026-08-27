# Wiki P0 CLI 测试用例（补强版）

- 日期：2026-08-27
- 计划：`docs/plans/记忆重构/2026-08-25-wiki-p0-implementation.md`
- CLI：`node apps/windows/resources/app-ui-cli/lumii-ui.mjs`
- 探针前缀：`wiki-cli-*`（可识别、可清理）

## 0. 约定

| 项 | 约定 |
|---|---|
| 状态 | PASS / FAIL / SKIP（环境缺条件）/ GAP（能力存在但 CLI 未暴露，改走 `command`） |
| `page get` | 参数为 **pageId** |
| 收件箱写路径 | organize/discard/retry 需 **pending** 条目；套件用 DB 探针或 `wiki_capture` 播种 |
| 金标检索 | 记录 top-3 标题 + 是否误配，写入 evidence |

### CLI 覆盖清单（P0 相关）

| 子命令 | 用例 |
|---|---|
| `wiki inbox list` | P0-A01/A02 |
| `wiki inbox count` | P0-G01（与 list 计数一致） |
| `wiki inbox organize` | P0-I01 Happy / P0-I02 路径逃逸 |
| `wiki inbox discard` | P0-I03 |
| `wiki inbox retry` | P0-I04 pending / P0-I05 非 pending 拒绝 |
| `wiki page list/get/update` | P0-P* |
| `wiki search` | P0-S* 金标 |
| `wiki runs list` | P0-R01 |
| `wiki index rebuild` | P0-X* |

---

## A 冒烟

### P0-A01 inbox list
- 命令：`wiki inbox list`
- 断言：数组；元素含 `id,status,itemType`

### P0-A02 status 过滤
- 命令：`wiki inbox list --status organized|pending|discarded` 各一次
- 断言：返回项 status 与过滤一致

### P0-A03 page list + category
- 命令：`wiki page list` / `--category sources`
- 断言：结构正确；category 过滤生效

### P0-A04 runs list
- 命令：`wiki runs list --limit 10`
- 断言：元素含 `id,status,inboxIds`；若存在 `inboxIds.length>1` 记批量合并证据

---

## S 检索金标（真实中文）

| ID | 查询 | 期望目标（title 含子串） | 已知易误配 |
|---|---|---|---|
| P0-S01 | `架构设计` | `架构设计文档` 在 top-3 | `构建设施说明` |
| P0-S02 | `上传` | `文件上传功能` 在 top-5 | — |
| P0-S03 | `Wiki 功能` | `Wiki 功能说明` 在 top-5 | — |
| P0-S04 | `"引号测试"` 或特殊字符 | 不崩溃，exit 0 | — |
| P0-S05 | `完全不存在的词xyzzywiki999` | 空数组（AND：稀有拉丁 token 必须命中） | 旧 OR 会因「存在」等 bigram 误召回 |
| P0-S06 | 空串 `""` | exit 2 usage | — |

通过标准：S01–S03 命中率 ≥ 2/3；S01 允许误配出现但目标须 top-3。

---

## I 收件箱闭环（可逆探针）

### P0-I01 organize Happy
- 前置：播种 pending 条目 `wiki-cli-inbox-org`
- 命令：`wiki inbox organize <id> --path sources/wiki-cli-organized --title wiki-cli-organized --content "手动归档正文"`
- 断言：返回 `pageId`；`page list` 可见 path；inbox 该条变为 organized

### P0-I02 organize 路径逃逸
- 前置：另一 pending
- 命令：`--path ../escape` 或 `notallowed/x`
- 断言：失败（exit≠0 或明确错误）；不产生逃逸路径页面

### P0-I03 discard
- 前置：pending `wiki-cli-inbox-disc`
- 命令：`wiki inbox discard <id>`
- 断言：success；`inbox list --status discarded` 可见

### P0-I04 retry pending
- 前置：pending（可先用 SQL 设 `attempt_count>0,last_error=probe`）
- 命令：`wiki inbox retry <id>`
- 断言：success；再 list 该条 `attemptCount=0` 且 `lastError` 空

### P0-I05 retry 非 pending
- 前置：已 discarded 或 organized id
- 命令：`wiki inbox retry <id>`
- 断言：失败，文案含 pending/状态

### P0-I06 幽灵 id
- 命令：`wiki inbox discard ghost-id` / `retry ghost-id`
- 断言：失败，含「不存在」

---

## P 页面读写

### P0-P01 update 新建
- `wiki page update --path sources/wiki-cli-p0-page --title ... --content ...`
- 断言：返回 pageId/version；list 可见

### P0-P02 get 存在 / 不存在
- get 真 id → contentMd；get `nonexistent-id` → exit≠0

### P0-P03 update 再保存升版本
- 同 path 再 update → version 递增；revisions（P1）可见多版

---

## X 索引

### P0-X01/X02 rebuild + 幂等
- 连续两次 rebuild，`rebuiltCount` 相等

### P0-X03 重建后金标仍命中
- rebuild 后再跑 S01

---

## R 追溯

### P0-R01 runs 成功记录
- 至少一条 `status=succeeded` 且 `inboxIds` 非空（无则 SKIP）

---

## 手工 / Agent（套件尽力）

### P0-M01 tools list 含 wiki_*
- `tools list` 含 `wiki_overview|wiki_search|wiki_read|wiki_capture`

### P0-M02 Agent wiki_search 最小调用
- 建会话 + send 强制只调 `wiki_search`「架构设计」
- 断言：消息中出现 tool 结果；超时 → SKIP（非 FAIL）

### P0-M03 四路摄入 UI
- SKIP 手工（上传/产物/搜索/沉淀）

---

## GAP（走 `command`）

| IPC | 用例 |
|---|---|
| `wiki:page:delete` | P0-G02 删探针页 |
| `wiki:source:get` | P0-G03 |

> `wiki:inbox:count` 已补 CLI 子命令 `wiki inbox count`（P0-G01）。
