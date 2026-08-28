# Wiki 用途目录一期 CLI 测试用例

- 日期：2026-08-28
- 设计：`docs/design/记忆设计/2026-08-27-wiki-topic-hierarchy-redesign.md` §0–§7
- 计划：`docs/plans/记忆重构/2026-08-27-wiki-topic-hierarchy-p1-implementation.md`
- CLI：`node apps/windows/resources/app-ui-cli/lumii-ui.mjs`
- 探针前缀：`wiki-cli-p1i-*`

> 本文件与既有 `wiki-p1-test-cases.md`（双链/修订回滚/清理导出，旧阶段编号）不是同一批功能。本文件覆盖「记忆重构一期」：Schema V22 用途两列、默认用途树、口诀分类器、归档不写摘要页、切断聊天摄入、资料层检索、主题树/资料 IPC 全链路。命名带 `-implementation-` 后缀以区分。

## 0. 约定

| 项 | 约定 |
|---|---|
| 状态 | PASS / FAIL / SKIP / GAP |
| Schema | 当前 `SCHEMA_VERSION = 24`；一期引入的 V22 列（`topic_category`/`topic_subtopic`/`last_used`/`use_count`/`wiki_sources_fts`）已长期存在于当前库，用例直接对存量库断言，不需要单独迁移验证 |
| 归属 | `resolveAgentIdForWiki` 兜底为 `'assistant'`；`userId` 固定 `'local-user'`（单机应用） |

### 已核实的实现细节（写测试前必读）

1. **`wiki inbox organize` CLI 子命令与实际 handler 参数已经脱节**：CLI 子命令（`commands.mjs`）仍按最早的「页面路径」签名构造 `{type:'wiki:inbox:organize', inboxId, path, title?, contentMd?}`，但 `WikiInboxOrganizeCommand` 类型与 handler 早已改为 `{type, inboxId, category, subtopic, title?}`（用途二元组，一期改造）。**实测验证**：执行 `wiki inbox organize <id> --path sources/x --title y` 会返回 `{"ok":false,"error":"command_failed","message":"大类不存在：undefined"}`（`category` 字段是 `undefined`，因为 CLI 从未传它）。**因此本文件所有 organize 用例都必须走 `command wiki:inbox:organize --data '{"inboxId":"...","category":"...","subtopic":"..."}'`，不能用 CLI 子命令**。这也意味着旧 `wiki-p0-test-cases.md` 里 P0-I01/I02 用例（用 `--path`）在当前代码下会全部失败，应视为已过时，一并在本文件订正。
2. `wiki:inbox:organize` 显式拒绝 `category === '临时存放'`：错误信息「整理入口不允许归到临时存放，请在文件列表中操作」。
3. `wiki:source:list` 的 `agentId` 是必填字段（无默认兜底），且该命令组的 `userId` 参数即使传了在部分 handler 里也会被忽略（如 `update-topic`/`move-to-parking`/`open` 固定用 `LOCAL_USER_ID`，不读 `command.userId`）。

---

## S 主题树基础（Schema V22 遗留能力）

### P1I-S01 tree:get 返回默认六大类且不含临时存放
- `command wiki:topic:tree:get --data '{"agentId":"assistant"}'`
- 断言：`tree.version===1`；`categories.length===6`（默认树未被用户改动的前提下；若已被二期用例改过，改为断言 `>=6` 且不含「临时存放」）

### P1I-S02 wiki_sources 表已具备用途两列与索引
- 无专用 IPC；用 DB 探针（只读连接）验证 `PRAGMA table_info(wiki_sources)` 含 `topic_category,topic_subtopic,last_used,use_count`，且 `sqlite_master` 含 `wiki_sources_fts`
- 断言：全部存在（当前 SCHEMA_VERSION=24，早已包含）

---

## C 分类器（用途口诀，仅可读行为观察）

分类器本身不是 IPC 命令，无法直接单测调用；只能通过「摄入 → 自动整理」的端到端效果间接验证。真实环境依赖 30 秒轮询与模型调用，时序不可控，多数用例标注 SKIP 条件。

### P1I-C01 待整理条目最终归入用途树节点，不出现「其他/未分类」
- 播种一条 pending upload（DB 探针，标题带业务语义，如「wiki-cli-p1i-会议纪要样例」）
- 等待 ≥30 秒自动整理轮询，或直接走手动路径（见 P1I-O01）跳过等待
- 断言（若自动整理生效）：`wiki:source:list` 能查到该资料，`topicCategory` 是当前树六大类之一，不是「其他」「未分类」「临时存放」
- 自动轮询耗时不可控时，本用例 SKIP 并改用 P1I-O01 验证确定性路径

### P1I-C02 模型判定 skip 的条目留在待整理，不写主题
- 需要能控制模型返回 skip（真实环境不可控），SKIP 并注明「需要 mock LLM，真实环境无法稳定触发」

---

## O 手动归档路径（确定性，路径②，无需等待模型）

全部走 `command wiki:inbox:organize --data '{...}'`（CLI 子命令已知失效，见上）。

### P1I-O01 organize 正常写入用途两列
- 播种 pending 条目（DB 探针）
- `command wiki:inbox:organize --data '{"inboxId":"<id>","category":"做事记录","subtopic":"会议聊天记录","title":"wiki-cli-p1i-归档样例"}'`
- 断言：返回 `{sourceId,category,subtopic}`；`wiki:source:list --category 做事记录 --subtopic 会议聊天记录` 能查到该条；`wiki inbox list --status organized` 该条目变为 organized

### P1I-O02 organize 拒绝归到临时存放
- 播种 pending 条目
- `category:"临时存放"`
- 断言：失败含「整理入口不允许归到临时存放」

### P1I-O03 organize 非法大类/小类
- `category` 为不存在的大类名 → 失败（`大类不存在`）
- `category` 合法但 `subtopic` 不在该大类下 → 失败（`小类不存在`）

### P1I-O04 organize 幽灵 inboxId
- `command wiki:inbox:organize --data '{"inboxId":"ghost-id","category":"做事记录","subtopic":"会议聊天记录"}'`
- 断言：失败含「收件箱条目不存在」

### P1I-O05 organize 不传 title 时用原标题
- 播种时指定一个特定 title，organize 时不传 `title`
- 断言：`wiki:source:list` 中新条目标题与收件箱原标题一致

---

## D 归档不写摘要页（一期核心断言）

### P1I-D01 手动归档后不新增 wiki_pages
- 记录 `wiki page list` 总条数 N
- 执行 P1I-O01
- 断言：再次 `wiki page list` 条数仍为 N（新归档只产生 `wiki_sources` 行，不产生页面）

### P1I-D02 归档资料的 mediaType 与内容摘要字段合理
- P1I-O01 产出的资料用 `command wiki:source:get --data '{"sourceId":"<id>"}'`（旧 P0 命令）查看
- 断言：`mediaType==='document'`（若播种时未指定 mime，`ingestToInbox` 默认走 `mediaTypeFromPath` 判断，纯标题无扩展名场景兜底为 document）

---

## X 切断聊天摄入

### P1I-X01 chat 类型历史条目仍可被分类器处理但不新增
- 由于 `ingestChat`/`wiki_capture` 早已切断新增聊天摄入（P0 一期改造），本用例只验证「不会新增」，不验证存量 chat 条目的处理结果
- 手段：记录当前 `wiki inbox list --status pending` 中 `itemType==='chat'` 的条数，尝试通过 Agent 对话产生新对话后重新统计
- 断言：`itemType==='chat'` 的 pending 条数不增加（若环境无法方便触发 Agent 对话，SKIP 并改为静态代码审查结论：`wiki_capture` 工具与 `ingestChat` 钩子在当前代码中确认已切断，见 `wiki-ingest-hook.ts`/`wiki-tools.ts`）

---

## R 资料层检索（一期主检索入口）

### P1I-R01 wiki:search 命中真实归档资料
- 对 P1I-O01 产出的资料标题关键词（如「归档样例」）执行 `command wiki:search --data '{"agentId":"assistant","keyword":"归档样例"}'`
- 断言：`hits` 含该 `sourceId`；`category/subtopic` 字段与归档时一致

### P1I-R02 wiki:search 稀有词返回空
- 关键词为完全不存在的稀有中文词组合
- 断言：`hits:[]`，不报错

### P1I-R03 index:rebuild 后检索仍生效且幂等
- `wiki index rebuild` 连续两次
- 断言：两次 `rebuiltCount` 相等或数值合理（幂等，不因重复调用而报错或数量暴涨）
- 重建后重跑 P1I-R01：仍能命中

---

## L 主题写入 IPC 全链路（一期落地，二期后仍在用的基础能力）

### P1I-L01 source:list 按大类/小类/parking/unfiled 四种过滤
- `category` 单独 → 全部同大类
- `category+subtopic` → 精确叶子
- `parking:true` → 全部临时存放
- `unfiled:true` → 全部两列皆空（存量未归档资料）

### P1I-L02 update-topic 与 move-to-parking 基础往返
- 对 P1I-O01 产出资料 `update-topic` 到另一合法节点 → 成功
- 再 `move-to-parking` → `topicCategory==='临时存放', topicSubtopic===null`
- 断言：全程无报错，`source:list --parking=true` 能看到最终态

### P1I-L03 source:open 成功路径（真实文件）
- 若 P1I-O01 播种时给了一个真实存在的 `source_path`（可用 DB 探针在插入 inbox 前指向磁盘真实小文件），organize 后 `wiki:source:open`
- 断言：`{success:true}`（无头环境下 `shell.openPath` 拉起系统程序，CI 环境可能有副作用，谨慎执行或 SKIP 并注明）

---

## Spec coverage

| Spec | 用例 |
|---|---|
| §2.1 Schema V22 用途两列 + FTS | S02 |
| §0.4 默认用途树 | S01 |
| §3 口诀分类器、封闭小类、skip 留待整理 | C01–C02（多数 SKIP，端到端时序不可控） |
| §3.5 目录选择器确定性写入（路径②） | O01–O05 |
| §4.1 归档不写摘要页 | D01–D02 |
| §4.1 切断 chat 摄入 | X01 |
| §5.1 资料层检索 | R01–R03 |
| §5.2/§15 主题 IPC 全链路 | L01–L03 |

## 已知问题（写测试前必读，已通过真实调用验证）

**`wiki inbox organize` CLI 子命令已与后端脱节**：`apps/windows/resources/app-ui-cli/commands.mjs` 中该子命令仍构造 `{inboxId, path, title?, contentMd?}`，但实际命令类型 `WikiInboxOrganizeCommand` 与 handler（`handleWikiInboxOrganize`）要求 `{inboxId, category, subtopic, title?}`。用 CLI 子命令调用会因缺少 `category` 字段而失败，报错 `"大类不存在：undefined"`（已实测复现）。旧 `wiki-p0-test-cases.md` 的 P0-I01/P0-I02 用例基于已废弃的 `--path` 签名，在当前代码库下会失败，应视为过时用例；本文件的 O01–O05 已改用 `command wiki:inbox:organize --data '{...category,subtopic...}'` 作为唯一可行路径。这是一处需要工程修复的 CLI/后端签名不同步问题，建议同步反馈给开发者更新 `commands.mjs`。
