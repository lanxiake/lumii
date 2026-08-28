# Wiki 知识图谱三期 CLI 测试用例

- 日期：2026-08-28
- 设计：`docs/design/记忆设计/2026-08-27-wiki-topic-hierarchy-redesign.md` §13
- 计划：`docs/plans/记忆重构/2026-08-28-wiki-graph-phase3-implementation.md`
- CLI：`node apps/windows/resources/app-ui-cli/lumii-ui.mjs`
- 探针前缀：`wiki-cli-p3-*`

> 本文件覆盖「记忆重构三期」：新图模型（`category`/`subtopic`/`source`/`entity` 节点，`belongs_to`/`sibling`/`relation`/`mentioned_in`/`wikilink` 边）、按资料抽取实体（`wiki:ero:extract` 的 `target=sources` 路径）、实体反查资料（`wiki:ero:entity-sources`）。与旧 `wiki-p2-test-cases.md` 里的 `wiki graph`/`wiki ero bootstrap` CLI 子命令是同一批底层命令的**扩展参数**，但新参数（`subtopic`/`radius`/`layers`/`category` for extract/`sourceIds`）在现有 CLI 子命令里不存在，必须走 `command` 总线。

## 0. 约定

| 项 | 约定 |
|---|---|
| 状态 | PASS / FAIL / SKIP / GAP |
| Schema | 当前 `SCHEMA_VERSION = 24`；三期未新增迁移，ERO `source_id` 列在二期（V22）已建好 |
| 前置数据 | 建图/抽取用例依赖「做事记录」等大类下已有归档资料；若存量数据不足，先用 `wiki:source:create-note` + `wiki:source:update-topic` 补几条 |

### 关键实现偏离（写测试前必读，直接影响用例设计）

1. **没有 `centerSourceId` 参数**：设计文档 §13.3 描述的「以某份资料为中心」实际未实现。`WikiGraphBuildOptions` 只有 `centerPageId`（历史页，走旧双链子图）或 `category`/`subtopic`（三期路径）。任何「以资料为中心建图」的用例都不可用真实实现验证，只能改用 `category`+`subtopic` 定位到该资料所在小类。
2. **`centerPageId` 路径不会返回实体节点**：走这条路径时 handler 没有把 `eroEntities`/`eroRelations` 传给图构建器，实际返回的 `entities` 恒为空，即便该资料关联的实体客观存在。
3. **`wiki:ero:extract` 的失败信息不保证中文化**：单份资料抽取失败时 `errors[].message` 直接用底层 `Error.message`（可能是 LLM 调用错误或 JSON 解析错误的原始英文/技术文案），不是设计文档 Task 5 所说的「须是中文可读文案」。
4. **`wiki graph` / `wiki ero bootstrap` CLI 子命令是旧版**：`wiki graph` 只支持 `--center/--category/--limit/--session`，无 `--subtopic/--radius/--layers`；`wiki ero bootstrap` 是完全独立的旧路径（页面双链引导实体，写 `page_id` 不写 `source_id`），与三期 `wiki:ero:extract` 无关，不要混用断言。

---

## G 图谱数据模型（`wiki:graph:data`）

全部走 `command wiki:graph:data --data '{...}'`。

### P3-G01 无中心参数时缺省到主题树第一个大类
- `command wiki:graph:data --data '{"agentId":"assistant"}'`（不传 centerPageId/category/subtopic）
- 断言：不报错；返回节点中含 `kind==='category'` 且 `title` 等于 `wiki:topic:tree:get` 结果的 `categories[0].name`

### P3-G02 按大类返回结构层
- `command wiki:graph:data --data '{"agentId":"assistant","category":"做事记录","layers":["structure"]}'`
- 断言：`nodes` 含 `kind` 为 `category`/`subtopic`/`source` 三类；`edges` 全部为 `kind==='belongs_to'`；每个 source 节点都有一条 `belongs_to` 边指向其所属 subtopic 节点，subtopic 节点有一条指向 category 节点

### P3-G03 subtopic 节点 id 与 topicCountKey 语义一致
- 取 G02 返回的某个 subtopic 节点 `id`
- 断言：该 id 是 `JSON.stringify([category, subtopic])` 形式（两元素数组序列化），不是 `${category}/${subtopic}` 拼接字符串——尤其验证含 `/` 的小类名（如「项目/任务资料」）时 id 没有被错误拆分

### P3-G04 sibling 边：同小类资料 ≤8 时画完全图，>8 时不画
- 找一个资料数 ≤8 的小类（或用 `wiki:source:create-note` 临时补到某数量）：断言该小类下 `sibling` 边数等于 `n*(n-1)/2`
- 若能构造 >8 份资料的小类：断言该小类下 `sibling` 边数为 0（不是「减少」，是恰好 0）
- 数据不足以自然满足任一条件时，可用 `wiki:source:create-note` 批量建 9 份笔记到同一小类临时验证 >8 分支，用后清理

### P3-G05 limit 只约束 source+entity，不约束容器节点
- 选一个资料数很多的大类，`limit:5`
- 断言：返回结果中 `category`/`subtopic` 节点数不受影响（仍是该大类全部小类），但 `source` 节点数被截断到 ≤5；`truncated===true`

### P3-G06 实体层：entities 存在时含 entity 节点与 mentioned_in 边
- 前置：已通过 `wiki:ero:extract` 对某小类抽取过实体（见 P3-E 部分）
- `layers:["entities"]`，`category`/`subtopic` 指向该小类
- 断言：`nodes` 含 `kind==='entity'`；`edges` 含 `kind==='mentioned_in'`，`source` 形如 `entity:<id>`，`target` 为具体 sourceId

### P3-G07 不再自动 bootstrap 实体
- 在一个从未手动抽取过实体、也从未 `ero:bootstrap` 过的全新小类上调用 `wiki:graph:data`
- 断言：即使 `layers` 含 `entities`，返回的 entity 节点数为 0（因为 handler 不会自动触发抽取），且调用前后 `wiki:ero:list` 的实体总数不变

### P3-G08 centerPageId 路径不返回实体（已知偏离，需断言当前行为而非设计期望）
- 取一个存在双链关系的历史页面 id，`command wiki:graph:data --data '{"agentId":"assistant","centerPageId":"<pageId>"}'`
- 断言：正常返回节点（page 类型），但**不含**任何 `kind==='entity'` 节点，即使该 pageId 关联的实体在库中确实存在（这是当前实现的真实行为，不是 bug 复测——如果后续代码修复了这个 gap，本用例应改为断言实体存在）

### P3-G09 history 层可与其他层共存
- `layers:["structure","history"]`
- 断言：返回结果里 `structure` 与 `history` 两层节点都出现，互不覆盖

### P3-G10 CLI `wiki graph` 旧子命令仍可用但不支持新参数
- `wiki graph --category 做事记录 --limit 10`
- 断言：命令成功执行（走的是同一个 `wiki:graph:data`，只是 CLI flag 集合有限）；确认没有 `--subtopic`/`--layers` 选项可用（阅读 `--help`/usage 输出验证，而非尝试传入未知 flag）

---

## E 按资料抽取实体（`wiki:ero:extract`，`target=sources`）

全部走 `command wiki:ero:extract --data '{...}'`。`target` 省略时默认即 `sources`。

### P3-E01 缺 scope 时拒绝
- `command wiki:ero:extract --data '{"agentId":"assistant"}'`（不传 category/subtopic/sourceIds）
- 断言：失败含「请先选择要抽取的目录或文件」

### P3-E02 按小类抽取，返回统计
- `command wiki:ero:extract --data '{"agentId":"assistant","category":"做事记录","subtopic":"会议聊天记录"}'`
- 断言：返回 `{sourcesScanned,sourcesSkipped,sourcesFailed,entitiesUpserted,observationsAdded,relationsUpserted,errors}`；`sourcesScanned` 等于该小类下资料数（首次抽取，无缓存跳过）
- 模型不可用（无 API key/离线）时整体 SKIP 并注明

### P3-E03 按 sourceIds 抽取
- 传 `sourceIds:["<id1>","<id2>"]`，忽略 category/subtopic
- 断言：`sourcesScanned<=2`（幽灵 id 会被 `findSourceById` 静默丢弃，不计入也不报错）

### P3-E04 增量跳过：正文未变第二次抽取
- 对 E02 同一小类立刻再抽取一次
- 断言：第二次 `sourcesScanned===0`，`sourcesSkipped` 等于该小类资料数（`content_hash`/内容指纹未变，直接跳过，不再调用模型）

### P3-E05 正文变化后重新抽取
- 对 E02 涉及的某份资料改动 `extracted_text`（可通过重新 `wiki:source:rename` 或需要 DB 探针改内容——若无直接 IPC 可改动正文，SKIP 并注明「需要 DB 层修改 extracted_text，暂无 CLI 路径」）
- 若可构造：断言该资料下次抽取 `sourcesScanned` 重新计入 1，不再被跳过

### P3-E06 单份资料失败不影响其余，也不阻塳游标
- 较难在真实环境人为触发单份失败（除非该资料内容导致模型返回非 JSON）；若环境允许 mock/构造异常输入，验证：
  - `errors` 数组含该资料的 `{sourceId,title,message}`
  - 其余资料仍正常产出实体（`entitiesUpserted>0`）
  - 再次抽取同一批次：失败的那条 `sourcesScanned` 重新计入（未进游标，会重试），成功的那条被跳过
- 无法构造时 SKIP 并注明

### P3-E07 无正文的媒体资料兜底
- 找一份 `mediaType` 为音视频、`extracted_text` 为空的资料（若存量库没有，SKIP 并注明「缺音视频类资料样本」）
- 对其抽取：断言不抛错（用 title + media_meta 兜底生成 prompt），`sourcesFailed` 不因「无正文」而计入

### P3-E08 target=pages 走旧路径
- `command wiki:ero:extract --data '{"agentId":"assistant","target":"pages"}'`
- 断言：返回结构与 sources 路径不同（旧 `extractRecent` 的返回形状，通常是页面维度统计，不含 `sourcesScanned` 字段名），确认这条路径与三期新逻辑互不干扰

### P3-E09 抽取结果反映到实体列表
- E02 之后调用旧 GAP 命令 `command wiki:ero:list --data '{"agentId":"assistant"}'`
- 断言：`entities`/`relations` 数组非空（若模型确实抽出内容）

---

## X 实体反查资料（`wiki:ero:entity-sources`）

### P3-X01 正常反查
- 取 E02/E09 产出的某个 `entityId`
- `command wiki:ero:entity-sources --data '{"agentId":"assistant","entityId":"<id>"}'`
- 断言：`{sources:[{id,title,sourcePath,topicCategory,topicSubtopic,mediaType}]}`；至少包含该实体来源的那份资料

### P3-X02 幽灵 entityId
- `entityId:"ghost-entity-id"`
- 断言：**不报错**，返回 `{sources:[]}`（静默空结果，不是失败）

### P3-X03 实体来源资料已被删除时静默过滤
- 若能找到一个实体，其某条观察的来源资料已被归档/删除（真实环境较难构造，可选 SKIP）
- 断言（若可测）：`sources` 数组里不含已删除资料对应项，且不报错、不提示「部分结果缺失」

---

## B 旧版 bootstrap（回归对照，确认未被三期改动影响）

### P3-B01 ero:bootstrap 仍只处理页面双链
- `wiki ero bootstrap`（CLI 子命令）或 `command wiki:ero:bootstrap --data '{"agentId":"assistant"}'`
- 断言：返回 `{entities,relations}` 计数；执行前后用 `wiki:ero:list` 确认新增实体的来源（`source_page_id`）指向页面而非资料，与三期 `wiki:ero:extract` 产出的实体（`source_id` 指向资料）应能共存不冲突

---

## GAP 说明（CLI 覆盖缺口）

| IPC | 是否有专用 CLI 子命令 | 说明 |
|---|---|---|
| `wiki:graph:data`（新参数 `subtopic`/`radius`/`layers`） | 否 | 只有旧 `wiki graph`（`--center/--category/--limit`），新参数必须走 `command` |
| `wiki:ero:extract`（`target=sources`，`category`/`subtopic`/`sourceIds`） | 否 | 无任何 CLI 子命令，纯 GAP |
| `wiki:ero:entity-sources` | 否 | 纯 GAP |
| `wiki:ero:bootstrap` | 是 | `wiki ero bootstrap`，但与三期抽取无关 |

---

## Spec coverage

| Spec | 用例 |
|---|---|
| §13.2/13.3 新图模型 4 节点 5 边、子图构建 | G01–G09 |
| §13.3 中心缺省、limit 截断只算 source+entity | G01、G05 |
| sibling ≤8 画全图规则 | G04 |
| §13.4 ERO 按资料抽取、增量游标、失败隔离、媒体兜底 | E01–E09 |
| 实体反查资料（实体侧栏数据源） | X01–X03 |
| 旧双链引导路径保持独立 | B01 |
| 设计与实现偏离（centerSourceId 缺失、centerPageId 不含实体、错误信息未中文化） | G08、G02 对照说明段 |
