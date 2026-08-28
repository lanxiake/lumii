# Wiki 用途目录二期 CLI 测试用例

- 日期：2026-08-28
- 设计：`docs/design/记忆设计/2026-08-27-wiki-topic-hierarchy-redesign.md` §8–§12
- 计划：`docs/plans/记忆重构/2026-08-27-wiki-topic-hierarchy-p2-implementation.md`
- CLI：`node apps/windows/resources/app-ui-cli/lumii-ui.mjs`
- 探针前缀：`wiki-cli-p2-*`（可识别、可清理）

> 与既有 `wiki-p0/p1/p2-test-cases.md`（P0/P1/P2 阶段，综述/图谱/hybrid 旧命令）不是同一批功能——本文件覆盖「记忆重构二期」新增的主题树编辑、重新编目、新建笔记、综述改产资料、清理对齐、资料层向量与检索。避免与旧文件混淆，文件名带 `-implementation-` 后缀。

## 0. 约定

| 项 | 约定 |
|---|---|
| 状态 | PASS / FAIL / SKIP（环境缺条件）/ GAP（能力存在但无专用 CLI 子命令，走 `command <type> --data '<json>'`） |
| `agentId` | 二期命令普遍要求显式 `agentId`（不像 P0/P1 可省），套件固定用 `assistant` |
| `userId` | 多数命令省略即 `local-user`；`wiki:source:list/update-topic` 等的 `userId` 字段即使传了也可能被忽略，以实际返回为准 |
| 主题树 | 全局单棵树，不按 agentId 隔离；`wiki:topic:mutate` 忽略 `agentId`/`userId` 字段，任何调用者的变更立即对全体可见 |
| 清理探针 | 新建的大类/小类、笔记、综述资料均需在用例末尾用 `wiki:topic:mutate` deleteCategory/deleteSubtopic（配 disposition）或 `wiki:source:delete` 清理 |

### CLI 覆盖清单（二期相关）

以下命令**均无专用 CLI 子命令**，全部走 `command`：

| IPC | 用例 |
|---|---|
| `wiki:topic:tree:get` / `wiki:topic:tree:set` | P2I-T* |
| `wiki:topic:mutate` | P2I-M* |
| `wiki:reclassify:run/get/apply/ignore/discard` | P2I-R* |
| `wiki:source:create-note` / `wiki:source:rename` | P2I-N* |
| `wiki:source:list` / `update-topic` / `move-to-parking` / `open` | P2I-S* |
| `wiki:synthesis:create`（sourceIds/topicCategory 路径）/ `accept-as-source` | P2I-Y* |
| `wiki:cleanup:scan`（suggestedAction） | P2I-C* |
| `wiki:search`（资料层）/ `wiki:vector:rebuild` | P2I-V* |

---

## T 主题树读写

### P2I-T01 tree:get 返回默认六大类
- 命令：`command wiki:topic:tree:get --data '{"agentId":"assistant"}'`
- 断言：`tree.version===1`；`tree.categories.length>=6`；不含「临时存放」

### P2I-T02 tree:set 正常整树替换
- 取 T01 结果，追加一个新大类（含至少一个小类）后 `tree:set`
- 断言：`{success:true}`；再次 `tree:get` 能看到新大类

### P2I-T03 tree:set 产生孤儿被拒绝
- 前置：确保「做事记录/会议聊天记录」下至少有 1 份资料（可用 P2I-N01 建笔记后 update-topic 进去，或用现有存量资料）
- 命令：`tree:set` 一棵删除了该小类的树
- 断言：失败，错误信息含「孤儿」；`tree:get` 显示树未变

### P2I-T04 tree:set 大类名为「临时存放」被拒绝
- 命令：`tree:set` 一棵含大类名为 `临时存放` 的树
- 断言：失败（校验层拒绝，具体文案以实现为准，不强求逐字匹配）

---

## M 主题树 mutate（九种操作）

统一走 `command wiki:topic:mutate --data '{"agentId":"assistant","mutation":{...}}'`。

### P2I-M01 addCategory 成功且自动带默认小类
- `mutation: {"op":"addCategory","name":"wiki-cli-p2-测试大类"}`
- 断言：`tree.categories` 含新大类；**新大类的 `subtopics` 恰好为 `["待归类"]`**（`DEFAULT_NEW_SUBTOPIC`，不是空数组——这是与设计文档字面描述的已知偏离，必须验证）

### P2I-M02 addCategory 重名拒绝
- 对已存在大类名（如「做事记录」）重复 addCategory
- 断言：失败，错误含 `已存在`

### P2I-M03 addCategory 名称非法
- 空字符串名称 / 首尾带空格 / 超过 20 字 / 含控制字符
- 断言：分别失败，错误依次含「名称不能为空」「名称首尾不能有空格」「最长 20 个字」「非法字符」

### P2I-M04 addCategory 拒绝临时存放同名
- `name: "临时存放"`
- 断言：失败，含「保留名称」

### P2I-M05 renameCategory 成功级联
- 对 M01 建的大类 renameCategory 为 `wiki-cli-p2-改名大类`
- 断言：`tree` 中旧名消失、新名出现；`movedCount` 与该大类下文件数一致（新建大类通常为 0）

### P2I-M06 renameCategory 新旧同名 / 目标已存在
- from=to 相同名称 → 失败含「新旧名称相同」
- to 为已存在大类名 → 失败含「已存在」

### P2I-M07 renameCategory 源不存在
- from 为幽灵大类名
- 断言：失败含「不存在」

### P2I-M08 addSubtopic / renameSubtopic 正常与异常
- addSubtopic 到 M05 改名后的大类，成功；同大类下重复添加同名小类 → 失败含「已有小类」
- renameSubtopic 成功；from 不存在 → 失败含「不存在」；new==old → 失败含「新旧名称相同」

### P2I-M09 deleteCategory 无文件直接删除
- 删除 M05/M08 建立的测试大类（此时应无实际归档文件）
- 断言：不带 disposition 也能成功（因为 `countSourcesByTopic` 下该类文件数为 0）

### P2I-M10 deleteCategory 有文件需要 disposition
- 前置：找一个已有归档资料的正式大类/小类（或用 P2I-N01 建笔记后挂上）
- 不带 disposition 直接 `deleteCategory`
- 断言：失败，错误含 `个文件` 与「去向」（`该目录下还有 N 个文件，请先选择去向`）
- 带 `disposition:{"type":"parking"}` 重试
- 断言：成功；`wiki:source:list --parking=true` 能看到该文件；随后**务必**用 `wiki:source:move-to-parking` 逆操作或恢复到原大类，避免污染其他用例（若原大类已被删无法恢复，改用套件自建的临时大类做本测试，不要动真实存量大类）

### P2I-M11 deleteCategory 最后一个大类不可删
- 构造一棵只有 1 个大类的临时树场景较难在真实库直接测（会影响全局树）——**改为读代码断言 + 单测覆盖，CLI 层 SKIP 并注明理由**（除非套件愿意临时把真实树砍到 1 个大类再还原，风险高，不建议）

### P2I-M12 deleteSubtopic 同理（大类至少留 1 个小类）
- 对只剩 1 个小类的大类 deleteSubtopic → 失败含「至少要保留一个小类」
- 若默认树各大类小类数 >1，用 M01 建的测试大类（只有「待归类」一个小类）来触发此分支

### P2I-M13 moveSubtopic 成功与冲突
- 将 M08 建的小类 moveSubtopic 到另一大类
- 断言成功，文件级联（若有）只改 `topic_category`，小类名不变
- 目标大类下已有同名小类 → 失败含「已有小类」
- fromCategory === toCategory → 失败含「来源与目标大类相同」

### P2I-M14 mergeSubtopic 成功与「不能合并到自己」
- 同大类内 fromName===toName（同名合并）→ 失败含「不能合并到自己」
- 跨大类但 toName 与 fromName 同名 → **应当成功**（这是代码里的边界：只有 fromCategory===toCategory && fromName===toName 才拒绝），验证这一点不要断言失败
- 目标小类不存在 → 失败含「目标小类不存在」

### P2I-M15 reorderCategories 成功与非法
- names 与现有大类集合相同顺序打乱 → 成功
- names 数量不一致 → 失败含「数量不一致」
- names 含重复项 → 失败含「重复大类」
- names 含未知大类名 → 失败含「不存在」

### P2I-M16 disposition.move 目标非法
- deleteSubtopic 带 `disposition:{"type":"move","category":"X","subtopic":"Y"}`，其中 X/Y 是变更后树里不存在的节点（含"目标恰好是被删节点自身"这种典型误用）
- 断言：失败含「去向无效」

### P2I-M17 缺少 mutation 参数
- `command wiki:topic:mutate --data '{"agentId":"assistant"}'`（不带 mutation）
- 断言：失败含「缺少 mutation 参数」

---

## R 重新编目状态机

### P2I-R01 scope=source 缺 sourceId
- `command wiki:reclassify:run --data '{"agentId":"assistant","scope":"source"}'`
- 断言：失败含「需要 sourceId」

### P2I-R02 scope=subtopic 缺 category/subtopic
- `scope:"subtopic"`，只给 category 不给 subtopic（或都不给）
- 断言：失败含「需要大类与小类」

### P2I-R03 未知 scope
- `scope:"bogus"`
- 断言：失败含「未知的重新编目范围」

### P2I-R04 scope=all 正常启动与轮询
- `command wiki:reclassify:run --data '{"agentId":"assistant","scope":"all"}'`
- 断言：返回 `runId`
- 轮询 `command wiki:reclassify:get --data '{"agentId":"assistant"}'` 直到 `status` 变为 `review`/`failed`（非 `running`）
- 若无可扫描资料（total=0），`status` 应直接为 `review` 且 `candidates:[]`，非错误

### P2I-R05 running 期间重复 run 被拒绝
- 若环境允许在 R04 处于 `running` 时立刻发第二次 `run`
- 断言：失败含「已有正在进行的重新编目」
- 若模型响应太快难以捕捉 running 窗口，SKIP 并注明（真实环境时序不可控）

### P2I-R06 已有 review 批次时不带 force 重开
- R04 结束后（status=review），不带 force 再次 run 同/不同 scope
- 断言：失败含「已有待审阅的重新编目结果」
- 带 `force:true` 重试
- 断言：成功，返回新 runId，旧批次被丢弃

### P2I-R07 apply 部分接受
- 对 review 批次的 `candidates` 取前 1–2 条 id，`apply --data '{"agentId":"assistant","candidateIds":["..."]}'`
- 断言：返回 `{applied,failed}`，与传入条数一致（若候选本身合法）
- 再次 `get`：已 applied 的候选从列表消失；若全部候选都处理完，`run` 变为 `null`

### P2I-R08 apply 空/幽灵/无 run
- 无当前 run 时 apply 任意 id → `{applied:0,failed:0}`（不报错）
- 有 run 但 candidateIds 传空数组 → 同上 `{0,0}`
- candidateIds 含不在当前候选列表中的幽灵 id → 不计入 applied/failed（静默跳过）

### P2I-R09 ignore 单条
- 对某候选 `ignore --data '{"agentId":"assistant","candidateId":"..."}'`
- 断言：`{success:true}`；再次 `get` 该条从候选列表消失
- 幽灵 candidateId → 依然 `{success:true}`（no-op，不报错）

### P2I-R10 discard 整批
- 有 run 时 discard → `{success:true}`；`get` 变为 `null`
- 无 run 时 discard → 依然 `{success:true}`（不报错）

### P2I-R11 目标小类被删后 apply 失败但不阻塞其余
- 制造一批候选后，先用 `wiki:topic:mutate` 删除某候选的目标小类（带 parking disposition）
- 对该候选 apply → 计入 `failed`，`get` 中该候选 `applyError` 含「目录」，`decision` 仍为 `pending`（不会被移出列表）
- 对同批次其余候选 apply → 正常 `applied`

---

## N 新建笔记 / 重命名

### P2I-N01 create-note 正常
- `command wiki:source:create-note --data '{"agentId":"assistant","category":"随笔创作","subtopic":"灵感随手记录","title":"wiki-cli-p2-笔记"}'`
- 断言：返回 `{sourceId,sourcePath,title}`；`sourcePath` 指向磁盘真实存在的 `.md` 文件；`wiki:source:list --category 随笔创作 --subtopic 灵感随手记录` 能看到该条

### P2I-N02 create-note 不传 title 用默认标题
- 不传 `title`
- 断言：`title === '未命名笔记'`

### P2I-N03 create-note 拒绝临时存放
- `category:"临时存放"`
- 断言：失败（`validateTopicAssignment` 不允许 parking，报「大类不存在」类错误）

### P2I-N04 create-note 非法大类/小类
- category 为不存在的大类名 → 失败含「大类不存在」
- category 合法但 subtopic 不存在 → 失败含「小类不存在」

### P2I-N05 create-note 同名文件不冲突
- 用相同 title 在同一秒内连续 create-note 两次（若时间戳精度到秒可能撞名）
- 断言：两次都成功，磁盘文件名不同（第二个带 `-2` 后缀），`sourceId` 不同

### P2I-N06 rename 正常
- `command wiki:source:rename --data '{"agentId":"assistant","sourceId":"<N01的id>","title":"wiki-cli-p2-笔记-改名"}'`
- 断言：返回 `{id,title}`；`wiki:source:get`（旧 P0 命令）或 `source:list` 里标题已更新；磁盘文件路径不变

### P2I-N07 rename 空标题拒绝
- `title:"   "`（空白）
- 断言：失败含「标题不能为空」

### P2I-N08 rename 幽灵 sourceId
- 断言：失败含「资料不存在」

### 清理
- 用 `wiki:source:delete`（P1 GAP 命令，需 `WIKI_CLI_ALLOW_DELETE=1`）删除 N01 建的笔记资料，或保留作为后续用例输入后统一清理

---

## S 资料列表 / 主题写入 / 打开

### P2I-S01 source:list 按大类/小类过滤
- `command wiki:source:list --data '{"agentId":"assistant","category":"做事记录"}'`
- 断言：全部返回项 `topicCategory==="做事记录"`
- 加 `subtopic` 后进一步过滤为单一叶子

### P2I-S02 source:list parking / unfiled
- `parking:true` → 全部 `topicCategory==="临时存放"`
- `unfiled:true` → 全部 `topicCategory===null`

### P2I-S03 update-topic 成功
- 对 N01 的笔记 `update-topic` 到另一小类
- 断言：返回新的 `topicCategory/topicSubtopic`；`source:list` 验证已挪动

### P2I-S04 update-topic 非法目标 / 幽灵 id
- 目标大类/小类不存在 → 失败（validateTopicAssignment 错误）
- sourceId 幽灵 → 失败含「资料不存在」

### P2I-S05 move-to-parking 成功且幂等
- 对某资料 move-to-parking → `topicCategory==="临时存放", topicSubtopic===null`
- 再次 move-to-parking（已在临时存放）→ 依然成功，无报错

### P2I-S06 source:open 正常 / 文件丢失 / 幽灵 id
- 对磁盘文件真实存在的资料 open → `{success:true}`（真实环境会拉起系统程序，CI/无头环境可 SKIP 并记录）
- 手动将某资料的 `source_path` 改到不存在路径（需 DB 探针）后 open → 失败含「文件已丢失或被移动」
- 幽灵 sourceId → 失败含「资料不存在」

---

## Y 综述改产资料

### P2I-Y01 create 走 sourceIds 路径
- 取 2 个真实存在的资料 id（如 N01 与另一份存量资料）
- `command wiki:synthesis:create --data '{"agentId":"assistant","sourceIds":["id1","id2"],"title":"wiki-cli-p2-综述"}'`
- 断言：返回 `{synthesisId}`；模型不可用时 SKIP（同旧 P2-Y02 惯例）

### P2I-Y02 create 走 topicCategory 路径
- `topicCategory:"随笔创作","topicSubtopic":"灵感随手记录"`（确保该目录下有资料，如 N01 笔记还在此处）
- 断言：成功返回 `synthesisId`；若该目录下无资料 → 失败含「没有可合成的文件」

### P2I-Y03 create 目录为空
- 指向一个刚建的、尚无任何文件的测试小类
- 断言：失败含「这个目录下没有可合成的文件」

### P2I-Y04 create 超过 40 个文件需要二次确认
- 若能构造 >40 个 sourceIds（真实环境资料量不足则 SKIP 并注明）
- 不带 `confirmed` → 失败，错误信息**前缀**含 `WIKI_SYNTHESIS_CONFIRM_REQUIRED`（断言时匹配这个 code 前缀，不要依赖中文文案）
- 带 `confirmed:true` 重试 → 正常进入合成

### P2I-Y05 accept-as-source 正常
- 对 Y01/Y02 产出的 candidate（需先 `wiki:synthesis:get` 确认 `candidateMd` 非空、非「（生成中…）」占位）
- `command wiki:synthesis:accept-as-source --data '{"agentId":"assistant","synthesisId":"...","category":"做事记录","subtopic":"汇报总结文稿"}'`
- 断言：返回 `{sourceId,category,subtopic}`；`wiki:source:list --category 做事记录 --subtopic 汇报总结文稿` 能看到新条目，`mediaType`/mime 为文档类；用旧命令 `wiki page list` 确认**没有**新增页面（不写 wiki_pages）

### P2I-Y06 accept-as-source 非 candidate 状态拒绝
- 对 Y05 已 accept 过的 synthesisId 再次 accept-as-source
- 断言：失败含「只能接受 candidate 状态的合成，当前为 accepted」

### P2I-Y07 accept-as-source 目标为临时存放拒绝
- 对一个新 candidate，`category:"临时存放"`
- 断言：失败（不允许 parking）

### P2I-Y08 accept-as-source 幽灵 synthesisId
- 断言：失败含「合成记录不存在」

### 清理
- Y05 产出的新资料与磁盘 `outputs/wiki-syntheses/*.md` 文件按需保留审计或用 `wiki:source:delete` 清理（遵守 `WIKI_CLI_ALLOW_DELETE` 约定）

---

## C 清理对齐

### P2I-C01 cleanup:scan 返回 suggestedAction
- `command wiki:cleanup:scan --data '{"agentId":"assistant"}'`
- 断言：数组，每项含 `sourceId,title,reason,topicCategory,topicSubtopic`；多数项应带 `suggestedAction`（`'delete'|'parking'`）

### P2I-C02 reason=broken_source → suggestedAction=delete
- 找一条来源文件已丢失的资料（或 DB 探针把某资料 `source_path` 改到不存在路径）
- 断言：该条 `reason==='broken_source'`，`suggestedAction==='delete'`

### P2I-C03 已在临时存放且 stale → delete；正式目录 stale → parking
- 若有天然满足条件的存量数据可直接断言；否则 SKIP 并注明「需要长期未用样本」
- 断言（若可测）：`topicCategory==='临时存放'` 的 stale 项 `suggestedAction==='delete'`；正式目录下的 stale 项 `suggestedAction==='parking'`

### P2I-C04 duplicate_content 恒为 parking
- 若能构造两份内容相同的资料触发 duplicate_content
- 断言：`suggestedAction==='parking'`（不会是 delete，即便直觉上重复应删除——这是代码现状，非文档要求，测试应按代码断言）

### P2I-C05 move-to-parking 批量清理动作生效
- 对 scan 出的若干 `suggestedAction==='parking'` 条目逐条调用 `wiki:source:move-to-parking`
- 断言：全部成功；再次 scan 这些条目 `topicCategory` 已变为「临时存放」

---

## V 资料层向量与检索降级

### P2I-V01 search 默认（向量开启）
- `command wiki:search --data '{"agentId":"assistant","keyword":"笔记"}'`（用真实存在关键词）
- 断言：`{hits,mode,degradeReason}`；`mode` 为 `'fts'|'vector'|'hybrid'` 之一；命中 `hits[].snippet` 非空字符串（可为空但字段必须存在）

### P2I-V02 search 显式关闭向量
- `enableVector:false`
- 断言：`degradeReason==='向量检索已关闭，仅全文检索'`

### P2I-V03 search 空关键词 / 稀有词
- 关键词为完全不存在的稀有词 → `hits:[]`，`mode` 仍应为合法值（不报错）
- 空字符串关键词：CLI 层面无专用子命令，直接走 command 不受 CLI usage 校验限制，需确认 handler 是否显式拒绝；若未显式拒绝且返回空结果也算通过，记录为观察项而非 FAIL

### P2I-V04 wiki:search 与旧 wiki:search:hybrid 是两套系统
- 对同一关键词分别调 `wiki:search`（资料层，本次二期改造）与 `wiki:search:hybrid`（P2 旧命令，页面层）
- 断言：两者返回结构不同（`wiki:search` 无 `backend` 字段，`wiki:search:hybrid` 有）；不要把二者结果混用做同一断言

### P2I-V05 vector:rebuild 合并计数
- `command wiki:vector:rebuild --data '{"agentId":"assistant"}'`
- 断言：返回 `{rebuiltCount,backend,notice}`；`rebuiltCount` 是页面向量与资料向量之和（不能单独拆分二者，若需验证资料向量确实重建，改为前后各跑一次 `wiki:search` 观察 `mode` 是否包含 `vector`/`hybrid` 作为间接证据）
- 连续两次 rebuild：`rebuiltCount` 应保持稳定（幂等，值相等或至少不递增到明显异常）

### P2I-V06 embedder 不可用时的降级文案
- 若环境本身缺少可用 embedder（如无网络/无模型），直接观察真实返回的 `degradeReason`
- 断言：非 null 且为非空字符串，**不强求逐字匹配**「向量模型不可用，已退回全文检索」——`bigram-hash` 兜底路径返回的是 `host.notice`，文案不固定

---

## Spec coverage

| Spec | 用例 |
|---|---|
| §8.1/§8.2 九种 mutation + 规则表 | M01–M17 |
| §8.1 单事务 + 孤儿校验 | T03、M10 |
| §9.1–§9.2 三种 scope + 状态机 | R01–R11 |
| §7 running 暂停自动 organize | 需长跑环境观察，CLI 层难以稳定构造，建议单测覆盖，本文档 SKIP 并注明 |
| §10 新建笔记 | N01–N08 |
| §11 综述改产资料 + 40 条确认 | Y01–Y08 |
| §12 清理三规则 + 移到临时存放 | C01–C05 |
| §5.1 资料向量 RRF + 显式降级 | V01–V06 |

## 已知实现偏离（写测试前必读）

1. `addCategory` 会自动带一个默认小类「待归类」，不是空数组（M01 断言的关键点）。
2. `wiki:topic:mutate` 的 `agentId`/`userId` 参数被忽略，主题树是全局单例，不按 agent 隔离。
3. `mergeSubtopic` 只有 `fromCategory===toCategory && fromName===toName` 才拒绝「合并到自己」；跨大类同名合并是允许的（M14）。
4. 清理扫描的 `duplicate_content` 恒定建议 `'parking'`，从不建议 `'delete'`（C04）。
5. 综述超量确认走错误消息**前缀** `WIKI_SYNTHESIS_CONFIRM_REQUIRED` 判定，不要断言中文文案（Y04）。
6. 本文档所有二期命令目前均无专属 CLI 子命令，一律通过 `command <type> --data '<json>'` 调用。
