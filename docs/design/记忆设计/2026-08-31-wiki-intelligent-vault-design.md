# Wiki 资料库深化设计：单一分类体系 + 智能全库编目 + 精简功能面

> 日期：2026-08-31
> 状态：**已确认（v1.1）**
> v1.1 变更：小类统一用途轴且可选（§2）；V26 只改写大类、小类置空待编目重填（§3）；全库编目改两轮制「结构优先、正文按需」（§5）；增量自动落位与批量预览确认分离（§5.6）；新增摘要派生列（§5.7）与向量语料收缩（§5.8）；重命名降级为可选开关、布尔锁替代三态、ref 默认不提案（§6）；新增无正文资料策略（§6.4）
> 前置：[2026-08-29-wiki-vault-ref-first-design.md](./2026-08-29-wiki-vault-ref-first-design.md)（v1.1 已确认，P0 已落地）
> 再前置：[2026-08-27-wiki-topic-hierarchy-redesign.md](./2026-08-27-wiki-topic-hierarchy-redesign.md)（v4.1，一/二/三期已实现）
> 实施计划（后续编写）：`docs/plans/记忆重构/2026-08-31-wiki-intelligent-vault-*.md`

---

## 0. 目标（本次深化三条主线）

1. **单一分类体系**：移除旧六大类（做事记录/学习资料/计划与复盘/证件凭据/模板参考/随笔创作）的全部映射层，DB、磁盘 `wiki/`、UI、AI 提示词四端统一用新分类（工作/学习/生活/收藏 + 收件箱 + 归档 + 稍后处理）。旧类名只存在于「一次性迁移」里，不留任何运行时映射代码。
2. **智能自动化整理**：Agent 整理 wiki 时拥有**全库视野**——盘点整个 wiki 目录结构与全部文件后再做分类规划，能对现有目录和文件做**全库重新编目**（像把整个文件夹树重新整理命名一遍）；文件名可按内容重命名；准确性靠「全局盘点 → 分批规划 + 跨批记忆 + 预览确认」保证。
3. **精简功能面**：移除**综述合成**（wiki_syntheses 全链路）与**历史页面**（wiki_pages 全链路）。

---

## 1. 现状事实（写设计前已核实的代码现状）

以下均为此前对照代码核实的**事实**，是本设计的出发点：

### 1.1 ref-first P0 已落地

- `SCHEMA_VERSION = 25`；`wiki_sources` 已有 `origin_url`、`storage_mode`（`ref/materialized/native`）。
- `wiki-nav-map.ts`（agent-runtime）、`wiki-vault-layout.ts`、`wiki-ref-store.ts`、`wiki-clip-saver.ts`、`wiki-vault-sync.ts` 均已存在并有测试。

### 1.2 映射层已开始漂移（本次要拆掉的对象）

「映射共存」在**两份文件**里各维护一份，且与已确认设计不一致：

| 来源 | 工作 | 生活 | 收藏 |
|---|---|---|---|
| **设计文档 §3.4（已确认权威）** | 做事记录 + 计划与复盘 | 证件凭据 + 随笔创作 | 模板参考 |
| `wiki-nav-map.ts`（agent-runtime） | 做事记录 | 计划与复盘 + 证件凭据 | 模板参考 + 随笔创作 |
| `wikiNavMapping.ts`（renderer，`navSectionFromLegacyCategory`） | 做事记录 | 计划与复盘 + 证件凭据 | 模板参考 + 随笔创作 |

代码两份彼此一致、但与**已确认的设计 §3.4 不一致**（计划与复盘 被放进了「生活」、随笔创作 被放进了「收藏」）。这就是「DB 存旧名 + 两处查表映射」的固有债务：任何一处改都会漂移。**结论：映射层必须整体拆除，改为一次性数据迁移。**

### 1.3 分类提示词现状

- 口诀硬编码在**两处**、几乎逐字重复：`wiki-classifier.ts:80-104`（`buildClassifyPrompt`）与 `wiki-reclassifier.ts:64-95`（`buildReclassifyPrompt`）。
- 口诀正文是写死的六句话（「事情做完留下的结果 → 做事记录」……），**不会**随主题树更换而变；「可选目录」部分是动态渲染树的。
- `wiki-classify-context.ts` 已有 `buildDirectoryTreeText` / `buildTopicOccupancySummary` / `buildNavSectionGuide` 三个全库视野积木，但**只接入了文件夹导入路径**，`WikiReclassifier` 完全没用它们。

### 1.4 重新编目现状（`wiki-reclassifier.ts`）

- 8 条一批（`RECLASSIFY_BATCH_SIZE = 8`），每批独立调一次 LLM。
- 每批 prompt 只含：本批 8 条的 id/标题/当前目录/正文预览（截 300 字）+ 完整主题树名称列表。
- **批次之间互相不可见**：没有全库目录树、没有占用统计、没有跨批记忆；「全库重新编目」目前只是名义上的，模型看不到全库。
- 已有「重编目 running 时自动归档暂停」的互斥（`WikiOrganizer` 三处检查 `WikiReclassifier.isRunning`）。

### 1.5 文件重命名现状

- `wiki:source:rename` 只接受用户显式传入的标题（`wiki-commands.ts:675-688`）。
- 全代码库搜「AI 根据内容生成标题」**零命中**——是全新能力。

### 1.6 综述合成全链路（本次删除）

| 层 | 位置 |
|---|---|
| 合成器 | `wiki-synthesizer.ts`、`wiki-auto-synthesis.ts`（+ 各自 `.test.ts`） |
| DB 表 | `wiki_syntheses`（schema.ts:611，含 `page_id`/`source_page_ids` 历史字段） |
| IPC handlers | `handleWikiSynthesisCreate/AcceptAsSource/AutoRun/List/Get/Accept/Reject`（wiki-commands.ts:1214-1340） |
| CLI 子命令 | `wiki synthesis create/list/get/accept/reject`（commands.mjs:787-870） |
| 定时任务 | `seed-cron-jobs.ts:154` `wiki-auto-synthesis` cron |
| 桥接 | `bridge.ts:407-430` 惰性合成器；`local-companion-handler.ts` synthesis handlers |
| UI | `WikiSynthesisCandidates.tsx`、`wikiConsolidate.ts`（含 `整合长文` 常量）、`WikiMoreMenu` 「综述合成」项 |
| 白名单 | `command-allowlist.ts:55-56` 共 6 条 `wiki:synthesis:*` |
| 磁盘产物 | `outputs/wiki-syntheses/*.md`（已被 accept 的产物文件**保留**） |

**关键连锁**：`整合长文` 小类**同时存在于旧树全部六个大类**，它是综述/短文整合的专属落点（AI 分类器被禁止写入）。综述移除后 `整合长文` 失去产出者，必须一并从新树移除——这是「移除综述」对分类体系的直接冲击。

### 1.7 历史页面全链路（本次删除）及依赖

**表**：`wiki_pages`（含 `status` 列）、`wiki_page_revisions`、`wiki_pages_fts`、`wiki_links`、`wiki_page_attachments`、`wiki_page_embeddings`。

**IPC/CLI**：`wiki:page:list/get/update/delete`、`wiki:link:backlinks/unresolved`、`wiki:page:revisions/rollback`、`wiki:concept:scan/confirm/reject`（概念候选=页面双链）、`wiki:status:scan/confirm`（页面状态）、`wiki:attach:list/add/remove`（附件挂页面）、`wiki:export`（导出**页面**，`handleWikiExport` 里 `listPages`）、`wiki:search:hybrid`（页面层混合检索）、`wiki:vector:rebuild` 的页面向量部分、CLI `wiki page list/get/update`。

**依赖页面才能活的功能（删除后的连带处理）**：

1. **图谱三期 history 层**：`WikiGraphLayer` 含 `'history'`、`centerPageId` 路径（`buildFromCenter`）、`page` 节点、`wikilink` 边——删除。三期测试文档已知偏离「centerPageId 路径不返回实体」随之消失；「以资料为中心建图」改用既有 `category`/`subtopic` 路径。
2. **`wiki:ero:bootstrap`**：完全基于 `wiki_links` 引导实体（`bootstrapEroFromWikilinks`），与三期 `wiki:ero:extract`（走 `source_id`）平行——删除 bootstrap；ERO 三表的 `page_id`/`source_page_id` 列保留但停写。
3. **综述**：`wiki_syntheses.page_id/source_page_ids`——随综述一起删除，无残留。
4. **`wiki-page-status.ts`**：整个模块依赖 `wiki_pages`——删除。
5. **概念候选（`wiki-concept-candidate.ts`）**：confirm 落页面——删除；「实体/概念抽取」已由三期 ERO 按资料抽取承担。
6. **附件**：挂页面——删除；资料层附件不在本期范围。

### 1.8 其他既有约束（沿用）

- 主题树全局单例，`topic_categories` 存 `wiki_index_meta`；`PARKING_CATEGORY = "临时存放"` 是系统常量、不进树、AI 不可写。
- `validateTopicAssignment` 校验 category/subtopic 必须在树内；organize 拒绝 `临时存放`。
- 白名单默认拒绝语义，删除功能时同步摘条目。
- `wiki/` 物理目录由 `ensureWikiVaultLayout` 生成，分区目录名来自 `WIKI_NAV_SECTIONS.folderSlug`（`00-收件箱`…`05-归档`、`_parking`），小类目录由 `navIdFromLegacyCategory` 定位分区——映射拆除后这段逻辑大幅简化。

---

## 2. 分类体系 v2（单一真源）

### 2.1 主题树 v2

```json
{
  "version": 2,
  "categories": [
    { "name": "工作", "subtopics": ["项目", "例行", "对外"] },
    { "name": "学习", "subtopics": ["在学", "参考"] },
    { "name": "生活", "subtopics": ["凭据", "家事", "自留"] },
    { "name": "收藏", "subtopics": ["待读", "可复用"] }
  ]
}
```

| 大类 | 小类 | 一句话边界（写入 AI 提示词） |
|---|---|---|
| 工作 | 项目 · 例行 · 对外 | 跟上班、项目、赚钱有关 |
| 学习 | 在学 · 参考 | 主动在学、在读、在备考 |
| 生活 | 凭据 · 家事 · 自留 | 私人、家庭、证件、账单、日记 |
| 收藏 | 待读 · 可复用 | 网上留着以后看、可套用的模板素材 |

**为什么改小类（v1.1 修订，这是本次深化最关键的一处）：**

v1.0 的 4×12 小类**混了三种维度**——工作/文档·会议·汇报是「文件类型轴」，生活/证件·家庭·随笔是「主题轴」，收藏/链接·模板·媒体是「来源+类型轴」。同一层混维度是分类系统的典型缺陷，直接后果就是 §3.2 里那 4 条 ⚠ 歧义映射与 §4.2 里 6 条易混规则：「会议纪要算会议还是文档」「工作用的模板算 收藏/模板 还是 工作/文档」——这类犹豫**不是提示词能补掉的**，AI 和用户都会卡住。

v1.1 把小类统一收到**用途轴**（这份东西我拿来干什么），类型信息由已有的 `media_type` 列承担，来源信息由 `origin_url`/`source_path` 承担，都不占分类轴：

| 小类 | 含义 |
|---|---|
| 工作/项目 | 属于某个具体项目、有起止的 |
| 工作/例行 | 周期性重复产出（周报、月度数据、例会） |
| 工作/对外 | 给外部看的（合同、对客材料、汇报稿） |
| 学习/在学 | 当前在读在学在备考的 |
| 学习/参考 | 学过/查过、留着以后翻的 |
| 生活/凭据 | 证件、票据、保险、履历（要能找回来的） |
| 生活/家事 | 家庭事务、账单、日程 |
| 生活/自留 | 随笔、日记、创作、爱好 |
| 收藏/待读 | 先存着以后看 |
| 收藏/可复用 | 模板、范例、素材（拿来就能套） |

12 个叶子降到 10 个，且每个叶子的判据是单一问句，不再需要跨轴仲裁。

### 2.1.1 小类可选（v1.1 新增）

`topic_subtopic` 允许为 NULL：资料可以只有大类，合法落在磁盘 `大类/` 根目录下。

理由：几百份文件面对 10 个叶子，分布必然极不均；强制填满小类会让 AI **为了填字段而硬塞**，制造出比「不分小类」更糟的错位。允许留空后，模型只在真有把握时才细分，收件箱压力也小得多。

- `validateTopicAssignment` 放宽：`subtopic` 为空时只校验 `category` 在树内；`subtopic` 非空时仍必须属于该 `category`。
- 大类仍必填（否则等于收件箱）。
- UI：`大类` 与 `大类 / 小类` 都是合法展示形态，左栏大类节点下多一个「（未细分）」分组。

这一条对「易用、易懂」的收益高于任何提示词优化。

**非树语义（沿用 ref-first 已确认决策）：**

- **收件箱** = `topic_category IS NULL`，不是树节点；
- **归档** = `archived_at IS NOT NULL`，不是树节点；
- **稍后处理** = `PARKING_CATEGORY`（临时存放），不是树节点，仅用户可写。

### 2.2 `整合长文` 移除

- 新树不含 `整合长文`；AI 分类器「不得写整合长文」的规则随之消失（没有这个节点了）。
- 存量 `整合长文` 文件迁移为**收件箱**（见 §3.2），由全库编目 v2 重新安置——整合产物的主题任意，机械地猜一个目的地不如让全库编目按内容判。

### 2.3 左栏与目录一一对应（映射拆除后自然成立）

```
wiki/
├── 收件箱/            ← topic_category IS NULL
├── 工作/              ← 允许文件直接躺在这一层（小类可选）
│   ├── 项目/ 例行/ 对外/
├── 学习/
│   ├── 在学/ 参考/
├── 生活/
│   ├── 凭据/ 家事/ 自留/
├── 收藏/
│   ├── 待读/ 可复用/
├── 归档/              ← archived_at IS NOT NULL
├── _parking/          ← 临时存放（用户手动搁置）
└── .lumii/
```

**v1.1 去掉目录序号前缀**（原 `00-收件箱`/`01-工作`…）：序号绑定树中位置，用户一增删/重排大类就要在磁盘上批量改名，`.lumii-ref` 侧车路径随之全部失配。排序是展示问题，交给 UI 按树序渲染即可，不该写进磁盘路径。

`vaultDirSegmentsForSource` 简化为：`[大类名]` 或 `[大类名, 小类名]`，纯字符串直取，不再查任何映射表。两份 nav-map 文件（`wiki-nav-map.ts`、`wikiNavMapping.ts`）删除。`folderSlug` 概念一并消失。

---

## 3. 旧六大类 → 新分类的一次性迁移

### 3.1 原则（v1.1 重大修订：不固化主观映射）

- **运行时零映射**：V26 之后代码里不再存在任何「旧大类名」字符串（除迁移 SQL 与测试固件）。
- 迁移在 **SQL 内完成**（单事务、可回滚）。
- **只机械改写有客观答案的部分，主观部分交给编目 v2**：
  - **大类**：6 → 4 的改写只有 6 条规则，其中 4 条基本无歧义 → SQL 直接改写。
  - **小类**：36 个旧小类 → 10 个新小类**没有客观对应关系**，全部置 NULL（合法，因为 §2.1.1 小类可选），原值保留到新列 `legacy_subtopic` 备查，由全库编目 v2 一次性重填。
- **用户自建大类不映射**：不在六大类之内的 `topic_category` 原样保留（不吞文件），其大类随用户自定义内容一起保留在树中（见 §3.4）。

**为什么放弃 v1.0 的 33 条小类映射表：** v1.0 一边执行 33 条机械映射、一边在 §3.2 建议「迁移后立即跑一次全库编目 v2 做精修」——这等于**自己承认迁移结果不可信，却又把它写成了数据**。一旦写入，错位的小类和用户真实意图混在一起再也分不开；而留 NULL 时「没分小类」是诚实且无害的状态，编目 v2 面对的是干净的空位而不是需要辨伪的既存值。顺带消掉了那 4 条 ⚠ 歧义（对外沟通材料、日程待办清单、收支预算测算、工具使用参考）——它们不再需要答案。

### 3.2 映射表（v1.1：6 条大类规则，小类全部置空）

| 旧大类 | 新大类 | 新小类 | 说明 |
|---|---|---|---|
| 做事记录 | 工作 | NULL | 无歧义 |
| 学习资料 | 学习 | NULL | 无歧义 |
| 证件凭据 | 生活 | NULL | 主体是个人证件票据；少量工作合同由编目 v2 挪走 |
| 模板参考 | 收藏 | NULL | 无歧义 |
| 随笔创作 | 生活 | NULL | 无歧义 |
| 计划与复盘 | **NULL（收件箱）** | NULL | ⚠ **唯一真歧义**：工作规划与个人生活规划混在一处，无法按大类机械二分 → 整类回收件箱，由编目 v2 按内容判 |
| 任意六大类 / 小类=`整合长文` | **NULL（收件箱）** | NULL | 综述产物，主题任意（用户已确认） |

旧小类原值统一写入 `legacy_subtopic` 列（仅备查与迁移报告统计，不参与任何运行时逻辑；编目 v2 完成后可在后续版本 DROP）。

**`计划与复盘` 为何整类回收件箱**：旧树里它同时装着「项目目标规划/风险预案/复盘总结」（→工作）与「个人日程/收支预算」（→生活），比例因人而异。v1.0 把它整体塞进 工作/汇报 是拍脑袋，会把用户的私人预算表混进工作区——这类错位比「留在收件箱等分类」刺眼得多。数量上它通常只占全库一小部分，回收件箱的复核成本可接受。

### 3.3 V26 SQL 形态

```sql
-- V26: 分类体系 v2。大类机械改写、小类整体置空待编目重填
ALTER TABLE wiki_sources ADD COLUMN legacy_subtopic TEXT;          -- 旧小类备查
ALTER TABLE wiki_sources ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0;  -- §6.1 用户改名锁
ALTER TABLE wiki_sources ADD COLUMN summary TEXT;                  -- §5.7 派生摘要
ALTER TABLE wiki_sources ADD COLUMN summary_hash TEXT;             -- 生成摘要时的 content_hash
ALTER TABLE wiki_sources ADD COLUMN summary_level TEXT
  CHECK (summary_level IN ('heuristic','extractive','llm'));

-- 1) 旧小类留档
UPDATE wiki_sources SET legacy_subtopic = topic_subtopic WHERE topic_subtopic IS NOT NULL;

-- 2) 大类改写（5 条无歧义），小类一律置空
UPDATE wiki_sources SET topic_category='工作', topic_subtopic=NULL WHERE topic_category='做事记录';
UPDATE wiki_sources SET topic_category='学习', topic_subtopic=NULL WHERE topic_category='学习资料';
UPDATE wiki_sources SET topic_category='生活', topic_subtopic=NULL WHERE topic_category='证件凭据';
UPDATE wiki_sources SET topic_category='收藏', topic_subtopic=NULL WHERE topic_category='模板参考';
UPDATE wiki_sources SET topic_category='生活', topic_subtopic=NULL WHERE topic_category='随笔创作';

-- 3) 计划与复盘 整类 + 整合长文 → 收件箱
UPDATE wiki_sources SET topic_category=NULL, topic_subtopic=NULL
  WHERE topic_category='计划与复盘' OR legacy_subtopic='整合长文';
```

对比 v1.0：**约 12 个含 33 条 `IN` 元组的 UPDATE → 8 个平铺 UPDATE，无一条主观判断**，迁移可读、可验、可复现。`title_locked` 存量回填 `0`（存量标题都是原始文件名或系统默认，无用户手动痕迹可辨）。

### 3.4 主题树 JSON 替换（一次性 JS 迁移）

- `wiki_index_meta.topic_categories` 整体替换为 §2.1 的 v2 树；**用户自建大类**（不在六大类内的 `name`）追加到 v2 树末尾，其资料不动。
- 迁移以 meta 键 `topic_tree_migrated_v2` 防重跑。
- 产出「迁移报告」（每条大类规则命中数 / 回收件箱条数 / `legacy_subtopic` 分布 Top20 / 自建大类清单），落 `outputs/wiki-migration-*.md` 供用户查阅。
- 迁移完成后 UI 引导一次全库编目 v2（§5）：此时全库处于「大类已定、小类全空 + 一批回收件箱」状态，正是编目 v2 的最佳输入形态——它只需补小类和安置收件箱，而不是辨别既存值真伪。

---

## 4. 分类提示词重构（单一真源 + 新口诀）

### 4.1 结构

新建 `packages/agent-runtime/src/wiki/wiki-taxonomy-prompt.ts`，作为**唯一**提示词真源：

```ts
/** 口诀 + 易混 + 分类树渲染。classifier / reclassifier / 全库编目共用一份。 */
export function buildTaxonomyGuide(tree: WikiTopicTree): string
export function buildTopicTreeLines(tree: WikiTopicTree): string  // 现有动态树渲染逻辑迁入
```

- `wiki-classifier.ts` 与 `wiki-reclassifier.ts` 删除各自的硬编码口诀段，改调本模块。
- **口诀正文不再依赖树**：只描述四个大类的边界（与 v2 树同名同步维护，模块内单测断言口诀含树中全部大类名）。
- 旧的「可选目录（只能从这里选…）」动态树渲染保持不变——模型永远只能选当前树内节点。

### 4.2 新口诀全文（本设计的提示词正文）

```
你是个人资料归档助手。按「这份资料和我的哪个生活域有关」分类，不要按学科领域分类。

## 口诀
- 跟上班、项目、赚钱有关 → 工作
- 主动在学、在读、在备考 → 学习
- 私人、家庭、证件、账单、日记 → 生活
- 网上看到先留着、可套用的模板素材 → 收藏
- 拿不准 → 不分类（留收件箱）

## 易混
- 为了完成工作任务用的资料 → 工作；为了个人提升在学的 → 学习（同一学科内容可进不同大类）
- 个人证件/票据/保险/履历 → 生活；跟工作签约的合同、给客户的材料 → 工作
- 空白可套用的模板、范例、素材 → 收藏，即使内容关于工作
- 网页链接默认 → 收藏，除非明显属于某个具体工作项目

## 可选目录（只能从这里选，禁止自造名称）
- 工作：项目（某个具体项目的）、例行（周期性重复产出的）、对外（给外部看的）
- 学习：在学（当前在读在学在备考）、参考（学过查过、留着以后翻）
- 生活：凭据（证件票据保险履历）、家事（家庭事务账单日程）、自留（随笔日记创作爱好）
- 收藏：待读（先存以后看）、可复用（模板范例素材）

## 规则
- **大类必填，小类可以留空**：能确定大类但拿不准小类时，只给 category，subtopic 留空——这是正常结果，不要为了填满而硬猜
- 大类都拿不准时 category、subtopic 都留空，skip=true，reason 说明
- 只能使用上方列出的名称，不要发明新名称或使用「其他」「未分类」等占位词
- 综合文件名、所在文件夹路径、内容摘要判断；**文件夹路径往往已经表达了用户的意图，优先采信**
- 临时存放仅用户可写，AI 不得选用
```

`buildReclassifyPrompt` 在此之上追加：当前目录字段、「只有当前目录确实不合适才改、拿不准保持原目录」的保守规则、以及 §5.4 的全库印象段。

### 4.3 易混规则收敛的说明（v1.1 更新）

旧版 7 条易混里有 3 条是给六大类边界打补丁。v1.0 降到 6 条，但其中 2 条（「会议纪要 → 工作/会议」「网页链接 → 收藏/链接」）本质是在**指定小类**——因为 v1.0 小类混了类型轴，模型不被明确告知就会在 文档/会议 之间摇摆。

v1.1 小类统一到用途轴后，这两条补丁**不再需要**：会议纪要按用途自然落 工作/项目 或 工作/例行；链接按用途落 收藏/待读。易混规则降到 4 条，且全部是跨大类歧义，无一条在替模型选小类。

配合「小类可选」，提示词首次做到**不需要威胁模型必须给出答案**——留空是一等公民，这是误判率下降的主要来源。

---

## 5. 全库编目 v2（智能化的核心）

> 复用现有 `wiki:reclassify:run/get/apply/ignore/discard` 状态机与「预览确认」安全网，**升级其视野与产出**，不新增第二套流程。

### 5.1 目标语义

「像把整个 wiki 文件夹树重新分类整理一遍」：

- 模型能看到**整个 wiki 的目录结构与全部文件**（分批看内容、全局看结构）；
- 能**移动**任意资料到新树任意节点（含把收件箱资料归类、把归档前的资料重排）；
- 能**提议重命名**低信息标题（§6）；
- **绝不静默写入**：全部候选进 review，用户预览后统一 apply。

### 5.2 范围

| scope | 含义（v2 修订） |
|---|---|
| `all` | 全库：**含收件箱（未分类）资料**，不含 临时存放 与 归档 |
| `subtopic` | 指定小类（原语义保留） |
| `source` | 单份资料（原语义保留；可附重命名提案） |

`all` 纳入收件箱是 v2 的关键变化——「整理收件箱」和「重新编目」合并为同一能力。

### 5.3 两轮制算法（v1.1 重大修订：结构优先、正文按需）

**v1.0 的成本押错了地方**：它把全部文件的正文前缀（200/300 字）塞进 prompt，却几乎没用「用户已有的目录结构与文件名」。而后者恰恰是**用户亲手表达过的分类意图**，纯 DB/文件系统可得、零成本、零幻觉、信息密度极高——一个躺在 `项目/2026Q3-XX/会议纪要-0812.md` 的文件，路径已经把答案说完了；此时再花 200 字正文去问模型是纯浪费。而且「前缀」不等于「摘要」：PDF/扫描件开头往往是信头、页码、表头，正是信噪比最低的一段。

因此 v1.1 改为两轮，正文只对真正需要的少数文件才拉：

**Pass A 全局盘点（纯 DB + 文件系统，零 LLM）**

1. `listSources` 全量（不含 parking/archived）。
2. 构造 `LibraryInventory`：
   - 树 v2 + 每叶子文件计数（`countSourcesByTopic` 已有）+ 大类根「未细分」计数；
   - 每文件一行：`[id, 文件名, 相对路径, 当前大类/小类, mediaType]`——**不含正文**；
   - 按 `source_path` 目录做**聚簇**（见 §5.5）。

**Pass B 轮 1 · 结构轮（LLM，批次 40–60，不带正文）**

- prompt = `buildTaxonomyGuide` + 全局印象（§5.4）+ 本批 40–60 行「文件名 + 相对路径 + 当前目录」+ 输出 schema。
- 每条输出 `{id, category?, subtopic?, confidence, reason}`，或 `{id, needContent: true}`——模型自己声明「光看名字和路径判不了」。
- 每条只占一行短文本，所以批次能放到 v1.0 的 4–5 倍。

**Pass C 轮 2 · 内容轮（LLM，批次 12，仅 `needContent` 集合）**

- 仅对轮 1 标记 `needContent` 的文件补 §5.7 的摘要，12 条一批复判。
- 无正文资料（图片/音视频）走 §6.4 的专用判据，不进本轮 LLM。

**成本对比（500 份资料）**

| 方案 | LLM 调用 | 说明 |
|---|---|---|
| v1.0 单轮 ×12 | 42 次，每次带 12×200 字正文 | 8 条一批的盲人摸象（v1.0 前身甚至是 8） |
| **v1.1 两轮** | 轮 1 `⌈500/50⌉`=10 次（无正文）+ 轮 2 约 9 次（按经验 20% 需正文）≈ **19 次** | 调用数减半，且轮 1 拿到全局结构视野 |

**更准而不只是更省**：轮 1 一次看 50 条同簇文件，能看出「这一批都是同一项目的」；v1.0 一次 12 条看不出簇。

**Pass D 校验与预览（复用现有 review 状态机）**

- 校验：`validateTopicAssignment`（放宽小类可空，§2.1.1）；`confidence < 0.6` 或 目标=当前 → 不产候选（unchanged）；`renameTitle` 仅在 §6 资格内接受。
- `candidates` 扩展字段：`{fromCategory, fromSubtopic, toCategory, toSubtopic, renameTitle?, decidedBy: 'structure'|'content'}`。
- `apply` 逐条：`updateSourceTopic` +（有 renameTitle 时）`renameSource` → vault sync（§6.3）；失败隔离沿用 `applyError`。
- `ignore` 单条 / `discard` 整批沿用。

### 5.4 全局印象 prompt 段（草案）

```
## 全库现状（本次编目的完整视野）
### 目录结构（数字为该目录现有文件数）
- 工作：项目(12)、例行(5)、对外(3)、未细分(7)
- 学习：在学(4)、参考(11)、未细分(8)
- 生活：凭据(6)、家事(2)、自留(4)
- 收藏：待读(9)、可复用(7)
- 收件箱（未分类）(21)
### 各目录已有样例（每个目录 3 条代表，据此保持一致）
- 工作/例行：前端周报-0812.md、月度数据汇总.xlsx、双周同步会纪要.md
- 生活/凭据：身份证正反面.pdf、2026车险保单.pdf、体检报告.pdf
- ……
### 本批规则
- 优先把同一文件夹下的文件归到同一处
- 光看文件名和路径判不了的，输出 needContent: true，不要硬猜
```

**v1.1 用「各目录已有样例」替换 v1.0 的「最近 60 条决策账本」：**

v1.0 的 ledger 是线性时间序回放，两个问题：每批都重发 60 条，批次一多前缀成本可观且**随进度线性增长**；而「上一批把某文件放哪了」对当前批的一致性帮助有限。

改为**聚合锚点**：每个叶子挑 3 条代表性样例（已决策的优先，存量的次之），规模恒定 `O(叶子数)` ≈ 10×3 行，**不随批次增长**，而且直接表达「这类东西放这里」——比时间序更贴合模型需要回答的问题。已应用的决策自然进入下一批的样例池，一致性传导仍然成立。

### 5.5 按目录聚簇切批（零成本的准确性提升）

现状 `wiki-reclassifier.ts` 按 id 顺序切批。改为**先按 `source_path` 的父目录分组、组内保持原序、再按组拼批**（同一目录尽量不跨批；单目录超过批容量时才切分）。

收益：同一文件夹的文件天然属于同一场景，同批出现时模型给出一致答案的概率显著上升，且 reason 可以互相印证。这是纯排序改动，**零额外成本**，却直接降低对锚点样例的依赖。

### 5.6 增量分类 vs 批量编目（v1.1 新增：拆成两个产品）

v1.0 把两者都塞进 review 队列——**新入库一份文件也要人工确认，与「尽量自动化」自相矛盾**。二者的目标函数完全不同：

| | 增量（单份新入库） | 批量（全库编目） |
|---|---|---|
| 触发 | 自动，摄入即分类 | 用户显式点「全库重新编目」 |
| 目标 | **零打扰** | 可控、可预览 |
| 上下文 | 树 + 每叶子计数 + 各目录样例 + 该文件（先看名字路径，需要才拉摘要） | §5.3 两轮全库视野 |
| 调用 | 1 次 | `⌈N/50⌉ + ⌈M/12⌉` |
| 高置信 | **直接落位**，UI 显示「AI 归到 工作/项目 · 撤销」 | 进 review 等 apply |
| 低置信 | 留收件箱，不打扰 | 进 review 标注低置信 |
| 一致性机制 | 复用同一份锚点样例 | 锚点样例 + 聚簇 |

**为什么增量用「自动落位 + 撤销」而不是「预览确认」**：撤销的成本远低于预览——预览要求用户在信息不足时先做判断，撤销只在用户恰好不同意时才付出一次点击，且分类错误本身是**完全可逆**的（改 topic 两列 + 一次 vault sync）。对高频低风险操作，事后撤销是正确的交互形态。

- 增量置信阈值 `>= 0.75` 才自动落位（高于批量的 0.6，因为无人复核）。
- 撤销窗口：UI 保留最近 20 条自动分类记录，可单条回退到收件箱。
- 与 §1.4 互斥沿用：批量 run 期间增量自动分类暂停。

### 5.7 摘要：按 content_hash 失效的持久派生列（v1.1 新增）

v1.0 在 Pass A 现算「`extracted_text` 前 200 字」当摘要，**每次 run 重算、只服务编目一处**——这个成本不划算。摘要值得做的前提是**一次生成、多处复用**：编目轮 2、AI 重命名、向量语料（§5.8）、UI 列表副标题与悬浮预览，四个消费者共享。

存储：§3.3 已加 `summary` / `summary_hash` / `summary_level` 三列。`summary_hash != content_hash` 时视为失效并重算，否则永久复用——**第二次跑全库编目的摘要成本为 0**。

**分层提取，绝大多数文件不碰 LLM：**

| 层 | 触发条件 | 方法 | 成本 |
|---|---|---|---|
| `heuristic` | 正文 < 800 字，或有明确结构 | 首个 Markdown 标题 + 去样板后前若干非空行；正文本身够短时即摘要 | 0 |
| `extractive` | 800–2000 字 | bigram/TF-IDF 选 3 个关键句；**复用已有 `wikiBigramJoin`**（`wiki-index.ts:109`，对中文可用） | 0 |
| `llm` | 正文 > 2000 字 **且** 确实要用（进编目轮 2 / 要改名 / 要编码） **且** 无有效摘要 | 输入截断为首 3000 字 + 尾 500 字，输出 ≤120 字 | 1 次小调用 |

`llm` 层是**惰性**的：不在摄入时批量生成，只在有消费者索取时生成。按经验 500 份里真正落到 `llm` 的不超过三成，且是一次性的。

摘要统一走 `getOrBuildSummary(source, { allowLlm })` 单入口，`allowLlm=false` 时最多降级到 `extractive`，不静默调用 LLM。

### 5.8 向量语料收缩（v1.1 新增）

**现状问题**（`wiki-source-vector.ts:37`）：语料 = `title + 全量 extracted_text`，单个向量、无分块、无截断策略。三个缺陷叠加：

1. 长文压成一个向量，语义被平均掉；embedder 面对超长输入要么报错要么静默截断，**实际等于只编码了开头**——和「前缀不是摘要」同源；
2. 编进噪声：证件 OCR 残字、票据数字、代码块、页眉页脚，污染全库余弦相似度；
3. 高信噪比字段（标题、主题路径）被长正文淹没，权重反而最低。

**改为短语料**：`title + summary + 大类/小类`，硬上限 300 字。

长正文交给 FTS——BM25 对长文关键词命中本就强于单向量。这正落回既有 RRF 分工（`mergeSourceHybridRanks`）：**向量管语义改写查询，FTS 管精确匹配与长文**。收益：编码成本降一个数量级、语义质量上升、增量重建变便宜（`summary_hash` 未变即跳过，`upsertSource` 现有的 hash 短路机制天然适配）。

「向量是否有必要」：个人库几百到几千份，bigram FTS 已经很强，向量的真实增益集中在「找那个讲报销流程的文件」这类同义改写查询——**保留，但只有语料变短之后它才划算**。V27 删掉页面向量后只剩一套 `wiki_source_embeddings`，正好一并改，并要求 `wiki:vector:rebuild` 走新语料重建一次。

### 5.9 成本与防护

- 全库 N 份 ≈ `⌈N/50⌉`（结构轮）+ `⌈M/12⌉`（内容轮，M 为 needContent 数）+ 惰性摘要；500 份 ≈ 19 次 LLM 调用。UI 在 run 前显示预估调用数与确认。
- 沿用既有互斥：running 期间自动归档与增量自动分类暂停（§1.4、§5.6）。
- run 中途失败：已产候选保留在 review（现有 `failed` 语义升级为「保留 candidates + 支持断点续跑」；续跑时锚点样例从当前库状态重建，**天然幂等**，不需要像 ledger 那样重放历史）。

---

## 6. AI 文件名重命名

> **v1.1 定位下调**：重命名是**可选附加项，默认关闭**，排在摘要（§5.7）与目录规划（§2/§5）之后。它的价值集中在相机/扫描/微信导出/下载这几类文件名，占比因库而异；而它是本设计里唯一「用户可见、容易触怒」的写操作。分类错了改回来无感，名字被改乱会让用户对整个自动化失去信任。

### 6.1 资格判定（v1.1 简化：布尔锁 + 信息量打分）

**改动一：`title_source` 三态 → `title_locked` 布尔。** v1.0 的 `auto` 与 `ai` 在规则上完全等价（都允许再提案），第三态只增加迁移、CHECK 约束与测试面，不产生任何行为差异。改为 `title_locked INTEGER`（§3.3）：用户执行过 `wiki:source:rename` 即置 1，永久锁定，AI 再不提案。

**改动二：模式白名单 → 信息量打分。** v1.0 的 `IMG_*`/`DSC*`/`扫描*` 白名单会永远追加、永远漏，还会误伤正常中文命名（如真名就叫「扫描版合同」）。改为 `titleInfoScore(title, summary)` 综合打分，模式表退化为其中**一项特征**而非唯一判据：

| 特征 | 方向 |
|---|---|
| 标题与摘要的实义词重合度 | 重合度低 → 标题没在描述内容 → 分低 |
| 标题中实义词占比（去掉数字、下划线、扩展名后还剩多少） | 占比低 → 分低 |
| 纯数字 / 纯 ASCII 前缀+数字 / 纯时间戳 / 纯哈希 | → 分低 |
| 长度 ≤2 字符、扩展名即标题 | → 分低 |
| 命中已知低信息模式表（`IMG_`/`DSC`/`微信图片_`/`Screenshot`/`未命名`/`Untitled`/`新建文档`…） | → 分低（一票不否决，只加权） |

**提案产出需同时满足：** `title_locked = 0` **且** `titleInfoScore` 低于阈值 **且** 模型置信度 ≥ 0.7 **且** 用户已打开重命名开关。

### 6.2 提案与确认

- 改名提案并入 reclassify 候选（`renameTitle` 字段），**与分类移动一起预览一起确认**；`scope='source'` 可单独对一份文件「建议标题」（复用同管线，只返回一条候选）。
- 预览 UI 显示 `原标题 → 新标题` 与 reason。
- 开关位置：`WikiMoreMenu` 的「全库重新编目」确认弹窗内一个复选框「同时建议重命名低信息文件名」，默认不勾。

### 6.3 改名落盘（安全边界，v1.1 收紧）

| storage_mode | 默认行为 | 磁盘 |
|---|---|---|
| **`ref`（引用原文件）** | **默认不提案改名** | 不触碰任何文件 |
| `materialized` / `native` | 可提案 | 改 `title` + 重建 FTS + 改名 wiki/ 内文件 + vault sync |
| 标题含路径分隔符/非法字符 | — | 过 `sanitizeFilenameSegment` + `resolveUniqueFilename`（已有） |

**`ref` 为何默认排除**（v1.1 修订 v1.0 的「改库内标题但不动磁盘文件名」）：那样会造出**双名现象**——库里叫 A、资源管理器里叫 B。这对 ref-first 设计辛苦立起来的「文件即真相、库只是索引」心智模型是净伤害，用户回到文件系统会找不到东西。

- `ref` 资料的标题在 UI 上明确标为「显示名」，并展示真实文件名。
- 若用户确有需求，后续版本可加「同时改磁盘原文件名」的显式高危选项——不在本期范围。

**硬约束：任何情况下不触碰 wiki/ 外的用户原文件。**

### 6.4 无正文资料的分类与命名（v1.1 新增：补缺口）

v1.0 的摘要、向量、重命名、编目全部建立在 `extracted_text` 上，但 `media_type` 含 `image`/`audio`/`video`，这些行的 `extracted_text` 大概率为 NULL。按 v1.0 规则，AI 对图片只能一律 `skip` → **收件箱会永久堆积图片，而图片恰恰是最需要重命名的那类**（`IMG_20260812_153012.jpg`）。

无正文资料改用以下判据，全部在结构轮（§5.3 Pass B）内解决，不进内容轮：

| 信号 | 用途 |
|---|---|
| `source_path` 父目录语义 | 主力判据（`扫描件/身份证/` → 生活/凭据） |
| 文件名残留信息（`微信图片`/`截图`/设备前缀） | 弱信号，主要用于判定低信息标题 |
| `media_meta`（EXIF 拍摄时间、尺寸、时长） | 区分「截图」与「拍摄照片」；长音视频倾向 学习/在学 或 收藏/待读 |
| **同目录邻居的已定分类** | 强信号：同一文件夹里已有文件归了 生活/凭据，新图片大概率同属 |
| `origin_url`（下载/剪藏来源） | → 收藏 |

- 仍判不了时留收件箱，但会写明 reason（「无正文、路径无语义」），不再是静默 skip。
- **图片重命名不在本期做**：可靠命名需要 OCR 或视觉模型，成本与准确性都不满足「保证准确性」的前提。本期只做到「能正确分类图片」，命名留待后续引入 OCR 时再开。这一条明确写入 §13「本期不做」。

---

## 7. 移除综述合成

### 7.1 删除清单（§1.6 全部）

- 删文件：`wiki-synthesizer.ts`、`wiki-auto-synthesis.ts`（+ tests）
- 删 handlers 7 个、command 类型、IPC dispatch 分支
- 删 CLI `wiki synthesis *` 子命令
- 删 cron `wiki-auto-synthesis`（`seed-cron-jobs.ts:154`）
- 删 bridge 惰性合成器（`bridge.ts:407-430`）、`local-companion-handler.ts` 相关
- 删 UI：`WikiSynthesisCandidates.tsx`、`wikiConsolidate.ts`、`WikiMoreMenu` 「综述合成」项、WikiTab 综述视图接线
- 白名单摘除 6 条 `wiki:synthesis:*`

### 7.2 数据处置（用户确认）

- **`wiki_syntheses` 表直接 DROP**（用户确认：不留审计，随功能一并删除）。
- `outputs/wiki-syntheses/*.md` 磁盘文件**保留**——已 accept 的产物已物化为 `wiki_sources`（`source_path` 指向这些文件），删文件会造成「资料引用了不存在的文件」。
- `整合长文` 小类随新树移除（§2.2）。

---

## 8. 移除历史页面

### 8.1 数据处置（用户确认：直接 DROP）

历史页面存量内容（早期自动归档生成的摘要页、用户/AI 在页面上的书写）**直接随表删除，不做迁移补偿**。用户已确认接受该数据损失，换取彻底干净的功能面与无残留 schema。V27 单独成版本，执行前 UI 提示备份（`storage:listBackups` 既有能力）。

### 8.2 删除清单

| 层 | 项 |
|---|---|
| 表 | `wiki_pages`、`wiki_page_revisions`、`wiki_pages_fts`、`wiki_links`、`wiki_page_attachments`、`wiki_page_embeddings`（DROP） |
| 模块 | `wiki-page-status.ts`、`wiki-concept-candidate.ts`（+ tests） |
| IPC handlers | page list/get/update/delete、link backlinks/unresolved、page revisions/rollback、concept scan/confirm/reject、status scan/confirm、attach list/add/remove、search:hybrid |
| 图谱 | `WikiGraphLayer` 删 `'history'`；`WikiGraphBuildOptions.centerPageId` 与 `buildFromCenter` 删除；`page` 节点 / `wikilink` 边删除；`layers` 缺省变 `['structure','entities']` |
| ERO | `bootstrapEroFromWikilinks` 删除；`wiki:ero:bootstrap` IPC 与 CLI `wiki ero bootstrap` 删除；ERO 表 `page_id`/`source_page_id` 列保留（停写） |
| CLI | `wiki page list/get/update`、`wiki search hybrid`（页面层检索） |
| UI | `WikiPageList.tsx`、历史页视图、「历史页面」菜单项、页面状态 UI、概念候选 UI |
| 白名单 | `wiki:page:*`、`wiki:link:backlinks/unresolved`、`wiki:page:revisions/rollback`、`wiki:concept:*`、`wiki:status:*`、`wiki:attach:*`、`wiki:search:hybrid`、`wiki:ero:bootstrap` |

### 8.3 保留并改造

- **`wiki:export`**：改为导出**资料**（`listSources`），页面导出路径删除。
- **`wiki:vector:rebuild`**：去掉页面向量分支，只重建资料向量。
- **`wiki:graph:data`**：只剩 structure + entities 两层；三期已知偏离（centerPageId 无实体）随之消失。
- **`wiki:search`**（资料层主检索）不变。

---

## 9. Schema 变更

| 版本 | 内容 |
|---|---|
| **V26** | 新列 `legacy_subtopic`、`title_locked`、`summary`、`summary_hash`、`summary_level`；§3.3 的大类改写 SQL（6 条规则，小类整体置空，计划与复盘/整合长文归收件箱） |
| **V27** | 纯删除：DROP `wiki_pages`/`wiki_page_revisions`/`wiki_pages_fts`/`wiki_links`/`wiki_page_attachments`/`wiki_page_embeddings`（§8.1）+ DROP `wiki_syntheses`（§7.2）。无数据迁移 |

主题树 JSON 替换（§3.4）为启动时一次性 JS 迁移（meta 键防重跑），不占 schema 版本。

---

## 10. IPC / CLI / 白名单变更总表

| 命令 | 变更 |
|---|---|
| `wiki:reclassify:run` | `all` 含收件箱；两轮制（§5.3）；入参加 `allowRename`（默认 false）；候选加 `renameTitle`/`decidedBy`；断点续跑 |
| `wiki:reclassify:get/apply/ignore/discard` | 语义沿用，候选/apply 处理 renameTitle 与空 subtopic |
| `wiki:source:rename` | 成功后置 `title_locked=1` |
| `wiki:source:classify:undo`（新增） | 撤销一条增量自动分类，回退到收件箱（§5.6） |
| `wiki:source:summary`（新增，内部） | `getOrBuildSummary` 单入口，参数 `allowLlm`（§5.7） |
| `wiki:topic:*` / organize / vault sync | 全线支持 `subtopic` 为空（§2.1.1） |
| `wiki:topic:tree:get/set/mutate` | 不变（v2 树是普通树） |
| `wiki:vault:ensure-layout` / vault sync | 目录映射从「nav-map 查表」改为「大类名直拼」 |
| 删除 | §7.1、§8.2 清单内全部条目（synthesis/page/concept/status/attach/hybrid/ero:bootstrap） |
| 保留改造 | `wiki:export`（资料导出）、`wiki:vector:rebuild`（仅资料向量）、`wiki:graph:data`（两层） |

CLI `commands.mjs` 同步删除：`wiki page *`、`wiki synthesis *`、`wiki ero bootstrap`、`wiki search hybrid`。

---

## 11. 前端变更

| 组件 | 变更 |
|---|---|
| `WikiLeftNav` | 四个大类 + 收件箱 + 归档，直接按主题列计数（不再查 nav 映射）；每个大类下多一个「（未细分）」分组 |
| `WikiTopicPicker` | 渲染树 v2（4 大类 / 10 小类），小类可留空（「暂不细分」选项），删除 legacy 映射逻辑 |
| `WikiMoreMenu` | 删除「综述合成」「历史页面」；「全库重新编目」升级为 v2，确认弹窗含预估调用数 + 「同时建议重命名」复选框（默认不勾，§6.2） |
| `WikiReclassifyView` | 候选行加 `标题 from → to` 预览列、低置信标记、`decidedBy` 来源标记；整批/单条接受沿用 |
| `WikiFileList` | 列表副标题显示 `summary`（§5.7 复用）；`ref` 资料标题旁标「显示名」并展示真实文件名（§6.3） |
| 增量分类提示条（新增） | 「AI 归到 工作/项目 · 撤销」，保留最近 20 条（§5.6） |
| `WikiTab` / `WikiSubtopicPanel` / `wikiBreadcrumbs` / `WikiFileList` / `CleanupView` / `WikiGraphView` | 删除 `wikiNavMapping.ts` 引用，直接显示主题列值 |
| 删除 | `WikiSynthesisCandidates.tsx`、`WikiPageList.tsx`、`wikiConsolidate.ts`、`wikiNavMapping.ts`、页面状态/概念候选 UI |
| `wiki-vault-host.ts` / vault sync | 目录推导简化（§2.3） |

---

## 12. 分期

| 阶段 | 内容 | 依赖 |
|---|---|---|
| **P1 分类体系切换** | V26 迁移（大类改写+小类置空+5 个新列）+ 树 v2（用途轴、小类可选）+ `wiki-taxonomy-prompt.ts` 重构 + 拆两份 nav-map + 去目录序号前缀 + 前端直显与「未细分」分组 + CLI 测试文档更新 | — |
| **P2 移除综述** | §7 全清单 | —（可与 P1 并行） |
| **P3 移除历史页面** | §8 全清单（V27 纯 DROP；图谱/ERO/导出/向量改造） | 与 P1/P2 无强依赖，可并行 |
| **P4 摘要与向量语料** | §5.7 `getOrBuildSummary` 三层 + §5.8 向量语料改短 + 一次 `wiki:vector:rebuild` | 依赖 P1（新列）、P3（页面向量已删） |
| **P5 智能全库编目** | §5.3 两轮制 + §5.4 锚点样例 + §5.5 聚簇切批 + 断点续跑 + 预览 UI + §6.4 无正文资料判据 | 依赖 P1、P4 |
| **P6 增量自动分类** | §5.6 自动落位 + 撤销窗口 + `classify:undo` | 依赖 P5（共用管线与锚点） |
| **P7 AI 重命名（可选开关）** | §6.1–6.3 `titleInfoScore` + `title_locked` + renameTitle 并入候选 | 依赖 P4（打分要摘要）、P5 |

**v1.1 分期理由**：v1.0 把智能化压成单个 P4，实际含四件独立可交付的事，粒度过粗。v1.1 拆开后每期都能单独验证与上线，且顺序反映真实依赖——**摘要是编目和重命名的共同前置**（P4 提前到编目之前，这是 v1.1 最重要的排序修正）；重命名排到最后且默认关闭，因为它风险最高、收益最局部。

---

## 13. 风险与不做

| 项 | 处理 |
|---|---|
| 迁移改写不可逆 | V26/V27 各为单事务；迁移前 `storage:listBackups` 提示备份；迁移报告落盘；**旧小类留在 `legacy_subtopic` 可追溯** |
| 页面/综述表 DROP 不可逆 | 用户已确认直接删除；V27 单独成版本，执行前提示备份（`storage:listBackups`） |
| 小类置空后用户觉得"变乱了" | 迁移后 UI 直接引导跑一次编目 v2 补小类；`legacy_subtopic` 保留可回溯 |
| 全库编目 LLM 成本 | 两轮制（结构轮无正文）+ 惰性摘要 + 聚簇切批 + 预估调用数确认；500 份 ≈19 次 |
| 乱改名 | 默认关闭 + `title_locked` 锁 + `titleInfoScore` 阈值 + 置信度阈值 + 预览确认 + `ref`/图片默认排除 |
| ref 文件被误动 | §6.3 硬约束：wiki/ 外的原文件永不触碰；`ref` 默认不提案改名 |
| 增量自动落位放错 | 阈值 0.75（高于批量）+ 撤销窗口 20 条 + 分类完全可逆 |
| 摘要幻觉污染下游 | `heuristic`/`extractive` 两层零幻觉且覆盖多数文件；`llm` 层摘要仅用于分类判断与列表展示，**不写回正文** |
| 本期不做 | 图片/音视频的 AI 重命名（需 OCR 或视觉模型，§6.4）；`ref` 文件改磁盘原名；实体自动抽取自动化（ERO 保持手动触发）；「记住这类放这里」用户纠错学习；批量编目的置信度自动执行（批量仍须预览确认——增量除外，见 §5.6）；向量分块检索 |

---

## 14. 确认记录

| 项 | 结论 |
|---|---|
| 整合长文存量 | **收件箱（未分类），待全库编目 v2 安置** |
| 合同协议文件 | v1.0 定为 工作/文档；**v1.1 作废**——小类不再机械映射，随 `证件凭据 → 生活` 迁移后由编目 v2 按内容判（工作合同 → 工作/对外，个人保单 → 生活/凭据） |
| wiki_syntheses 表 | **直接 DROP**（不留审计） |
| 历史页面存量 | **直接 DROP 表**（不迁移） |

### 14.1 v1.1 反思结论（本轮系统性复盘）

| 议题 | 结论 |
|---|---|
| 是否需要提取摘要 | **需要**，但必须是四方共用的持久派生列、分层提取、LLM 层惰性触发；只服务编目一处则不划算（§5.7） |
| 向量编了什么 / 是否必要 | 现状编了 `title + 全量正文`，等于只编码开头且吸入噪声；**改为 `title + 摘要 + 主题路径` 短语料**，长文交 FTS。保留向量，但仅在语料变短后才划算（§5.8） |
| 重命名是否必要 / 是否过复杂 | 必要但价值局部、风险最高：**降级为默认关闭的可选项**，排到最后一期；三态列 → 布尔锁，模式白名单 → 信息量打分，`ref` 与图片默认排除（§6） |
| 目录规划是否合理 | v1.0 小类混三种维度，是易混规则与歧义映射的真正根源；**统一到用途轴，12→10 小类，且小类可选**（§2.1） |
| 批量 vs 增量如何设计 | **拆成两个产品**：增量自动落位+撤销（零打扰），批量预览确认（§5.6） |
| 「现有目录+文件名+新增待分类」是否更好 | **是，且已替换原 Pass A**：路径与文件名是用户已表达的意图，零成本零幻觉；改两轮制后调用数减半且更准（§5.3） |
| v1.0 未覆盖的缺口 | 无正文资料（图片/音视频）无策略 → 补 §6.4；33 条主观映射会固化错数据 → 改为只改写大类（§3.1） |

---

*下一步：编写实施计划（`docs/plans/记忆重构/2026-08-31-wiki-intelligent-vault-*.md`），并同步更新 `docs/test/lumii-cli/` 测试用例与 `docs/guide/wiki-user-guide.md`。*
