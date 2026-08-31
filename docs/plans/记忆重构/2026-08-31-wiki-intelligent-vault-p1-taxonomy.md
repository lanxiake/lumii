# Wiki 智能资料库 P1（分类体系切换）Implementation Plan

> **For agentic workers:** 按 Task 顺序实施，每个 Task 走「先写失败测试 → 跑失败 → 实现 → 跑通 → 提交」。
> 规格：`docs/design/记忆设计/2026-08-31-wiki-intelligent-vault-design.md` v1.1 已确认
> 前置：P0 ref-first 已落地（`SCHEMA_VERSION=25`，`origin_url`/`storage_mode` 已有）

**Goal:** 用单一、干净的分类体系替换现有六大类：树 v2（4×10、用途轴、小类可选）→ V26 迁移（大类改写、小类置空待编目重填）→ 提示词统一真源 → 拆除两份映射层 → 前端直显主题列 + 「未细分」分组 → 去掉磁盘目录序号前缀。

**Architecture:** 一次性数据迁移 + 模块重构。三条线：**(1) 数据迁移线**——V26 SQL 只机械改写大类（6 条规则），小类整体置空 + 存 `legacy_subtopic` 备查，`整合长文` 与 `计划与复盘` 回收件箱；JS 主题树 JSON 替换（v2 树 + 用户自建大类追加），一次性、防重跑。**(2) 提示词统一线**——新建 `wiki-taxonomy-prompt.ts` 作为唯一真源，`buildClassifyPrompt` / `buildReclassifyPrompt` 删除各自硬编码口诀、改调本模块。**(3) 目录映射拆除线**——删 `wiki-nav-map.ts` / `wikiNavMapping.ts` 及其 200+ 引用处，`vaultDirSegmentsForSource` 直取主题列值，`ensureWikiVaultLayout` 去序号前缀，前端全线支持 `subtopic = null` 与「未细分」分组。

**Tech Stack:** TypeScript、SQLite（`MIGRATIONS` 数组 V26）、`packages/agent-runtime`、Electron 单通道 IPC、React + `apps/windows` renderer、Vitest

---

## 0. 实施前必读：前置状态

以下为 P0 交付后的基线（**假定 P0 已落地 V25**），P1 在此之上继续。

### 0.1 版本

- `SCHEMA_VERSION = 25`（V25: `origin_url` + `storage_mode`）
- V26 是本计划新增的
- `wiki_sources` 现有列：V16 建表基础列 + V22 `topic_category`/`topic_subtopic`/`last_used`/`use_count` + V25 `origin_url`/`storage_mode`

### 0.2 主题树与校验

- `DEFAULT_TOPIC_TREE` 是六大类 v1（做事记录/学习资料/计划与复盘/证件凭据/模板参考/随笔创作），每个大类含若干小类，其中**「整合长文」小类同时存在于全部六个大类**（是综述产物专属落点）
- `validateTopicAssignment(tree, category, subtopic, opts)` 当前**不接受 subtopic 为 null/空**（见 Task 1 要核查的实际逻辑）
- `PARKING_CATEGORY = "临时存放"` 系统常量，不进树，AI 不可写

### 0.3 映射层现状

**两份独立维护、彼此同步但与已确认设计不一致的映射表：**

| 文件 | 用途 | 主要符号 |
|---|---|---|
| `packages/agent-runtime/src/wiki-nav-map.ts` | agent-runtime 侧，vault-layout/vault-sync/commands 路由用 | `WIKI_NAV_SECTIONS`、`navIdFromLegacyCategory`、`legacyCategoriesForNav`、`vaultDirSegmentsForSource` 里查此表 |
| `apps/windows/src/renderer/pages/MemoriesPage/components/wikiNavMapping.ts` | renderer 侧，左栏计数、面包屑、主题选择器用 | `navSectionFromLegacyCategory`、`legacyCategoriesForSection`、`formatTopicDisplay`、`isSubtopicAmbiguousInSection` |

引用面：见 Task 核查（待 facts-taxonomy agent 回报）。

### 0.4 提示词现状

硬编码口诀在两处逐字重复：
- `packages/agent-runtime/src/wiki/wiki-classifier.ts` 的 `buildClassifyPrompt`
- `packages/agent-runtime/src/wiki/wiki-reclassifier.ts` 的 `buildReclassifyPrompt`

口诀正文是写死的六句话，**不会**随主题树更换而变；可选目录部分是动态渲染树的。

### 0.5 磁盘目录

`ensureWikiVaultLayout` 生成 `wiki/` 树，分区目录名形如 `00-收件箱`、`01-工作`…`05-归档`、`_parking`（序号 = 树序）。V26 后改为无序号前缀（`收件箱/`、`工作/`…），避免一重排树就让 `.lumii-ref` 侧车路径全失配。

---

## 1. 迁移报告与回滚预案（先读）

### 1.1 迁移不可逆性

- V26 改写 `topic_category` 与 `topic_subtopic`，回滚只能靠备份恢复（SQLite 不支持跨版本 DOWN 迁移）
- 旧小类值写入 `legacy_subtopic` 可追溯，但 V26 执行后 DB 中主题两列已变，UI 展示会变（大类名变了、小类空了）

### 1.2 备份预案

P1 入口（`wiki:topic:tree:set` 触发迁移）在**执行 V26 SQL 前**先调 `storage:listBackups` 取最近备份时间，若 > 24h 则弹窗提示用户手动备份（已有 `storage:backup:create` IPC）。备份完成后再执行迁移。

### 1.3 迁移报告

JS 一次性迁移（主题树 JSON 替换）产出 `outputs/wiki-migration-v26-{timestamp}.md`，内容：
- 每条大类规则命中数（做事记录→工作 N 条、学习资料→学习 M 条…）
- 回收件箱条数（计划与复盘 + 整合长文）
- `legacy_subtopic` 分布 Top20（降序，便于用户判断迁移是否符合预期）
- 用户自建大类清单（追加到树末尾的非六大类）
- 迁移用时

### 1.4 UI 引导

迁移完成后，UI 自动弹出「全库编目 v2」引导卡片（P5 提供的能力）：「已切换到新分类，小类暂时未细分，建议跑一次『全库重新编目』补充小类并安置收件箱资料。」（一键跳 P5 的 `wiki:reclassify:run`）。

---

## Task 1: V26 SQL 迁移 + 新列

**Owner:** backend
**Files:** `packages/agent-runtime/src/storage/schema.ts`

### 1.1 前置核查（等 facts-taxonomy agent 回报）

[ ] 确认当前 `SCHEMA_VERSION` 值与最后占用的版本号（应为 25）
[ ] 确认 `wiki_sources` 建表行号与 V22 追加 topic 列的行号
[ ] 确认 `MIGRATIONS` 数组声明行号

### 1.2 实现

在 `MIGRATIONS` 数组追加 V26：

```sql
-- V26: 分类体系 v2。大类机械改写、小类整体置空待编目重填
ALTER TABLE wiki_sources ADD COLUMN legacy_subtopic TEXT;
ALTER TABLE wiki_sources ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wiki_sources ADD COLUMN summary TEXT;
ALTER TABLE wiki_sources ADD COLUMN summary_hash TEXT;
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
  WHERE topic_category='计划与复盘' OR topic_subtopic='整合长文';
```

### 1.3 测试

`packages/agent-runtime/src/storage/schema.test.ts`（已有 migration 测试套件）：

```ts
test('V26: 分类体系 v2 迁移', () => {
  const db = createTestDatabase();
  // 构造 V25 fixture：各旧大类 + 整合长文 + 计划与复盘
  db.exec("INSERT INTO wiki_sources (..., topic_category, topic_subtopic) VALUES ('s1', '做事记录', '项目/任务资料'), ...");
  
  runMigration(db, 26);
  
  const rows = db.prepare("SELECT id, topic_category, topic_subtopic, legacy_subtopic FROM wiki_sources").all();
  expect(rows.find(r => r.id === 's1')).toEqual({ topic_category: '工作', topic_subtopic: null, legacy_subtopic: '项目/任务资料' });
  // 整合长文 → 收件箱
  // 计划与复盘 → 收件箱
  // 新列存在且默认值正确
});
```

---

## Task 2: 树 v2 定义 + 小类可选校验

**Owner:** backend
**Files:** `packages/agent-runtime/src/wiki/wiki-topic-tree.ts`

### 2.1 已核实事实（facts-taxonomy 核查，行号可直接使用）

- `wiki-topic-tree.ts` 全文 121 行。`PARKING_CATEGORY`(L10)、`TOPIC_CATEGORIES_META_KEY`(L13)、`WikiTopicTree`(L15-18，当前 `version: 1`)、`DEFAULT_TOPIC_TREE`(L20-30，六大类各 6-7 小类，末尾均含「整合长文」)。
- `isValidName`(L33，模块私有非导出)、`parseTopicTree`(L41)、`validateTopicTree`(L55)、`treeHasOrphans`(L112-121)。
- **`validateTopicAssignment` 实际签名与实现（L86-106，原样）：**
  ```ts
  export function validateTopicAssignment(
    tree: WikiTopicTree,
    category: string,
    subtopic: string | null,
    opts?: { readonly allowParking?: boolean },
  ): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    if (opts?.allowParking && category === PARKING_CATEGORY) {
      if (subtopic !== null) return { ok: false, reason: "临时存放不允许指定小类" };
      return { ok: true };
    }
    const cat = tree.categories.find((c) => c.name === category);
    if (!cat) return { ok: false, reason: `大类不存在：${category}` };
    if (subtopic === null || !cat.subtopics.includes(subtopic)) {
      return { ok: false, reason: `小类不存在：${category} / ${subtopic ?? "(空)"}` };
    }
    return { ok: true };
  }
  ```
  **关键事实**：`category` 当前类型是 `string`（非 `string | null`）——不接受大类为空，与设计 §2.1.1「小类可选」不是同一件事，不要在改造时把两者混在一起。唯一允许 `subtopic === null` 通过的路径是 `allowParking && category === PARKING_CATEGORY`；正式大类下 L102 把「null」与「不在列表里」合并成同一条拒绝分支——这是本 Task 要动的唯一分支。
- **`treeHasOrphans` 的 `occupied` 参数 `subtopic` 类型是非空 `string`**，内部调 `validateTopicAssignment` 时**不传 `allowParking`**——沿用不改，因为它检查树自身合法性，不受本次「小类可选」影响（占用记录本身若来自旧数据可能已无 subtopic，Task 7 全量验证时留意）。
- **⚠ repo 层两处会因「小类可选」直接产生「资料消失」的 bug，必须在本 Task 一并修**（不是 Task 5 拆映射层的范围，是数据可见性问题）：
  - `wiki-repo.ts:638-682` `listSourcesByTopic` 的「仅按大类查」分支**强制 `topic_subtopic IS NOT NULL`**——`subtopic=null` 的资料点开大类分区会查不出来。
  - `wiki-repo.ts:574` `countSourcesByTopic()` 的 WHERE 要求**两列都 `IS NOT NULL`**——小类为空的资料不计入左栏数字。
  - `wiki-repo.ts:690-707` `updateSourceTopic(category: string, subtopic: string | null)` 当前受 L698 `validateTopicAssignment(..., {allowParking:true})` 约束，即目前只有 `category===PARKING_CATEGORY` 时 `subtopic=null` 才能写入成功——本 Task 放宽 `validateTopicAssignment` 后这里会自动跟着放开，但要补一条测试确认「正式大类 + subtopic=null」能写入不报错。

### 2.2 实现

**A) 替换 `DEFAULT_TOPIC_TREE`：**

```ts
export const DEFAULT_TOPIC_TREE: WikiTopicTree = {
  version: 2,
  categories: [
    { name: "工作", subtopics: ["项目", "例行", "对外"] },
    { name: "学习", subtopics: ["在学", "参考"] },
    { name: "生活", subtopics: ["凭据", "家事", "自留"] },
    { name: "收藏", subtopics: ["待读", "可复用"] },
  ],
};
```

**B) 放宽 `validateTopicAssignment`，支持小类可选：**

```ts
// 当前签名（待核查确认）：
export function validateTopicAssignment(
  tree: WikiTopicTree,
  category: string | null,
  subtopic: string | null,
  opts: { allowParking?: boolean } = {}
): { ok: true } | { ok: false; reason: string }

// 改写逻辑：
//  1. category 为 null → 收件箱，ok（除非 opts 明确不允许）
//  2. category = PARKING_CATEGORY → 需 opts.allowParking
//  3. category 必须在树内
//  4. **subtopic 为 null/空 → ok**（小类可选，新增）
//  5. subtopic 非空 → 必须属于该 category
```

**C) `treeHasOrphans` 沿用（它检查树自身合法性，与 assignment 无关）**

### 2.3 测试

`wiki-topic-tree.test.ts`（已有 validation 测试）：

```ts
test('小类可选：category 非空、subtopic 为 null 应通过', () => {
  const tree = DEFAULT_TOPIC_TREE;
  expect(validateTopicAssignment(tree, '工作', null).ok).toBe(true);
  expect(validateTopicAssignment(tree, '学习', '').ok).toBe(true);
});

test('小类非法：category 合法、subtopic 不属于该 category 应拒绝', () => {
  expect(validateTopicAssignment(tree, '工作', '在学').ok).toBe(false);
});
```

---

## Task 3: 一次性主题树 JSON 迁移 + 迁移报告

**Owner:** backend
**Files:** `packages/agent-runtime/src/wiki/wiki-index.ts`（或新建 `wiki-v26-migration.ts`）、`packages/agent-runtime/src/wiki/types.ts`

### 3.1 设计

在 `WikiIndex` / `WikiRepo` 添加：

```ts
migrateTopicTreeToV2(): MigrationReport {
  // 1) 防重跑：检查 meta 键 `topic_tree_migrated_v2`
  if (this.getMeta('topic_tree_migrated_v2')) return { alreadyMigrated: true };
  
  // 2) 读当前树，识别用户自建大类（不在六大类内的 name）
  const oldTree = this.getTopicTree();
  const sixLegacy = ['做事记录', '学习资料', '计划与复盘', '证件凭据', '模板参考', '随笔创作'];
  const userCategories = oldTree.categories.filter(c => !sixLegacy.includes(c.name));
  
  // 3) 构造新树：DEFAULT_TOPIC_TREE v2 + 追加用户自建
  const newTree: WikiTopicTree = {
    version: 2,
    categories: [...DEFAULT_TOPIC_TREE.categories, ...userCategories],
  };
  
  // 4) 写回
  this.setMeta('topic_categories', JSON.stringify(newTree));
  this.setMeta('topic_tree_migrated_v2', 'true');
  
  // 5) 统计迁移报告（见 §1.3）
  const stats = this.buildMigrationStats();
  this.writeMigrationReport(stats);
  
  return stats;
}
```

迁移触发时机：在 `wiki:topic:tree:set` handler 里，检测到当前树 version < 2 时**先自动跑本迁移**（用户点「编辑主题树」进入编辑器就会触发 tree:get → 若 version < 2 则先迁移），或在启动时 `WikiIndex` 构造时一次性跑（推荐后者）。

### 3.2 实现

`buildMigrationStats()` 遍历 `wiki_sources` 统计：

```ts
interface MigrationReport {
  alreadyMigrated?: boolean;
  categoryRules: Array<{ from: string; to: string; count: number }>;  // 6 条
  inboxCount: number;  // 计划与复盘 + 整合长文
  legacySubtopicTop20: Array<{ subtopic: string; count: number }>;
  userCategories: string[];
  elapsedMs: number;
}
```

`writeMigrationReport(stats)` 落 `outputs/wiki-migration-v26-{timestamp}.md`。

### 3.3 测试

`wiki-v26-migration.test.ts`：

```ts
test('迁移：六大类 → v2 树 + 用户自建大类保留', () => {
  // fixture: 旧树含六大类 + 一个用户自建「项目」
  // 跑 migrateTopicTreeToV2()
  const newTree = index.getTopicTree();
  expect(newTree.version).toBe(2);
  expect(newTree.categories.map(c => c.name)).toContain('项目');  // 用户自建保留
});

test('防重跑', () => {
  migrateTopicTreeToV2();
  const report2 = migrateTopicTreeToV2();
  expect(report2.alreadyMigrated).toBe(true);
});
```

---

## Task 4: 分类提示词统一真源

**Owner:** backend
**Files:** 新建 `packages/agent-runtime/src/wiki/wiki-taxonomy-prompt.ts`；改 `wiki-classifier.ts`、`wiki-reclassifier.ts`

### 4.1 现状（已核实，非待查）

- `wiki-classifier.ts` `buildClassifyPrompt`（约 80-104 行）硬编码六句口诀（"事情做完留下的结果 → 做事记录"…），与旧六大类绑定。
- `wiki-reclassifier.ts` `buildReclassifyPrompt`（约 64-95 行）几乎逐字重复同一段口诀，额外加"当前目录"字段。
- 两处"可选目录"渲染树的逻辑各自实现一遍（`tree.categories.map(c => \`- ${c.name}：${c.subtopics.join("、")}\`)`）。
- `wiki-classify-context.ts` 已有 `buildDirectoryTreeText` / `buildTopicOccupancySummary` / `buildNavSectionGuide`，但只接入文件夹导入路径。

### 4.2 实现

新建模块导出：
```ts
export function buildTaxonomyGuide(tree: WikiTopicTree): string
export function buildTopicTreeLines(tree: WikiTopicTree): string
```
`buildTaxonomyGuide` 内容 = 设计文档 §4.2 新口诀全文（四句口诀 + 6 条易混 + 动态可选目录 + 规则），`buildTopicTreeLines` 是被内部调用、也单独导出供 reclassifier 追加「当前目录」字段时复用的树渲染函数。

`wiki-classifier.ts::buildClassifyPrompt` 删除硬编码口诀段，改为拼 `buildTaxonomyGuide(tree)` + 待分类资料列表。

`wiki-reclassifier.ts::buildReclassifyPrompt` 同理，在 `buildTaxonomyGuide(tree)` 之后追加「当前目录」字段与保守规则（「只有当前目录确实不合适才改，拿不准保持原目录」）。

### 4.4 待拍板：reclassify 易混规则不对称（已核实，非猜测）

facts-taxonomy 核查发现两处口诀不是简单的重复关系：

- `buildClassifyPrompt`（分类）易混共 6 条；`buildReclassifyPrompt`（重编目）易混只有 3 条——少了「会议纪要/聊天导出归类」「对话消息 skip」「同项目文件夹归同小类」这 3 条。
- `buildClassifyPrompt` 有 `skip` 语义（拿不准可留空不写分类）；`buildReclassifyPrompt` **完全没有** skip——重编目场景目前假设每条都必须给出目标分类。

统一真源时这两处差异不能被「合并成一份就完事」掩盖过去，需要显式决定：

1. 统一后的 `buildTaxonomyGuide` 是否对 classify/reclassify 场景输出同一份易混规则（即给 reclassify 补全那 3 条），还是保留场景差异、用一个参数区分？
2. reclassify 场景要不要引入 skip 语义？——这与 P5 §5.3「校验：confidence < 0.6 或目标=当前 → 不产候选」的既有兜底逻辑是否重复，需要先看 P5 的 unchanged 语义是否已经覆盖了 skip 的诉求，避免语义重复。

本 Task 实现前先拍板这两点，写入下方 4.2 的实现基础上，不要在写代码时临时决定。

### 4.3 单测

新增 `wiki-taxonomy-prompt.test.ts`：断言 `buildTaxonomyGuide(DEFAULT_TOPIC_TREE)` 包含树中全部大类名。`wiki-classifier.test.ts` / `wiki-reclassifier.test.ts` 现有断言旧口诀关键词（"事情做完留下的结果"等）的用例删除，改断言新口诀关键句。

---

## Task 5: 拆除两份映射层

**Owner:** backend + frontend
**Files:** 删 `packages/agent-runtime/src/wiki-nav-map.ts`、`apps/windows/src/renderer/pages/MemoriesPage/components/wikiNavMapping.ts`；改所有引用处

### 5.1 现状（已核实，非待查）

两份文件各自维护一套「旧六大类 → 新六个导航分区」的映射，且彼此一致但与已确认设计 §3.4 不一致（这正是本次要拆除映射层的直接证据）：

| 文件 | 导出符号 |
|---|---|
| `packages/agent-runtime/src/wiki/wiki-nav-map.ts`（**注：在 `wiki/` 子目录下，非包根**，133 行） | `WikiNavId`(L8)、`WikiNavSectionDef`(L10)、`WIKI_NAV_SECTIONS`(L21)、`WIKI_PARKING_DIR`(L66)、`WIKI_META_DIR`(L67)、`navIdFromLegacyCategory`(L72)、`legacyCategoriesForNav`(L83)、`primaryLegacyCategoryForNav`(L91)、`navLabel`(L99)、`folderSlugForNavId`(L106)、`vaultDirSegmentsForSource`(L113) |
| `apps/windows/.../wikiNavMapping.ts`（renderer） | `WikiNavSection`(L10)、`WikiTopicTreeLike`(L13)、`navSectionFromLegacyCategory`(L34)、`navSectionLabel`(L58)、`legacyCategoriesForSection`(L81)、`isSubtopicAmbiguousInSection`(L103)、`formatTopicDisplay`(L121) |

**修正：`topicCountKey` 不在 `wikiNavMapping.ts` 里**——renderer 侧 `topicCountKey` 单独定义在 `wikiNavMapping.ts:26`（确实在本文件，前次记录有误已更正），但 agent-runtime 侧对应的同名概念实际在 `wiki-topic-mutate.ts`（非 `wiki-nav-map.ts`），由 `wiki-repo.ts`、`wiki-classify-context.ts:9` 导入。拆映射层时不要去 `wiki-nav-map.ts` 找它。

引用面（renderer 侧，已核实 import 该模块的组件，共 11 处）：`CleanupView.tsx:15`、`wikiBreadcrumbs.ts:10`、`WikiFileList.tsx:8`、`WikiGraphView.tsx:31`、`WikiLeftNav.tsx:4`、`WikiReclassifyView.tsx:5`、`WikiSubtopicPanel.tsx:12`、`WikiTab.tsx:32`、`wikiTooltips.ts:5`（仅 type-only 引用 `WikiNavSection`）、`WikiTopicPicker.tsx:10`、`test/components/wikiNavMapping.test.ts:12`。

agent-runtime 侧引用面（已核实）：`wiki/index.ts:186,187`（barrel 再导出）、`wiki-classify-context.ts:8`、`wiki-vault-layout.ts:12`、`wiki-vault-sync.ts:6`（`vaultDirSegmentsForSource`）、`wiki-nav-map.test.ts:9`。**`vaultDirSegmentsForSource`（L113）已核实支持 `subtopic=null`**（有大类无小类时只返回大类段），落盘层本身没有 §Task 2 描述的那个「小类可选查不出来」的 bug——bug 只在 `wiki-repo.ts` 的 DB 查询层（见 Task 2 §2.4），拆映射层时不需要额外修 vault 落盘逻辑的 null 处理。

### 5.2 实现

**A) agent-runtime 侧：** `vaultDirSegmentsForSource` 改为直取 `source.topic_category`/`topic_subtopic` 拼路径（v2 树下大类=树顶层名，小类可为空则只用大类段），不再查 `navIdFromLegacyCategory`。`ensureWikiVaultLayout` 改为遍历 v2 树直接生成目录（见 Task 6，同时去掉序号前缀）。确认改动后无地方仍 import `wiki-nav-map.ts`，删除该文件。

**B) renderer 侧：** 各引用组件里 `navSectionFromLegacyCategory(topic_category)` 之类的调用，替换为直接使用 `topic_category`/`topic_subtopic` 的值（v2 树下大类名本身就是显示名，不需要二次映射）。`formatTopicDisplay` 的职责（大类/小类拼接展示文案、小类为空时的兜底文案「未细分」）保留但迁移为一个不依赖旧类名的小函数（建议就近放在 `wikiBreadcrumbs.ts` 或新建 `wikiTopicDisplay.ts`）。`isSubtopicAmbiguousInSection` 是旧映射特有的歧义提示，v2 树下小类不再歧义（一对一），直接删除、调用处一并去掉相关 UI 提示。确认全部替换后删除 `wikiNavMapping.ts`。

**C) 逐组件替换顺序建议：** 先改 `WikiTopicPicker.tsx`（树选择器，改动面最集中）→ `WikiFileList.tsx`/`WikiSubtopicPanel.tsx`（展示大类小类文案）→ `wikiBreadcrumbs.ts`（面包屑）→ `WikiTab.tsx`/`CleanupView.tsx`/`WikiGraphView.tsx`/`WikiReclassifyView.tsx`（消费上述文案的容器组件）。每改一个组件跑一次该组件已有的测试。

### 5.3 测试

- agent-runtime：`wiki-vault-sync.test.ts`、`wiki-vault-layout.test.ts` 现有断言目录路径的用例，路径从 `01-工作/项目/任务资料` 形式改为 v2 树的 `工作/项目`（或大类=小类为空时仅 `工作/`）。
- renderer：各组件现有测试中 mock/断言 `navSectionFromLegacyCategory` 返回值的地方，改为直接传入/断言 v2 大类名字符串。
- 全局 grep 确认：`grep -r "wiki-nav-map\|wikiNavMapping\|navSectionFromLegacyCategory\|navIdFromLegacyCategory"` 无命中。

---

## Task 6: 磁盘目录去序号前缀

**Owner:** backend
**Files:** `packages/agent-runtime/src/wiki/wiki-vault-layout.ts`

### 6.1 现状（已核实）

`ensureWikiVaultLayout` 依据 `WIKI_NAV_SECTIONS`（Task 5 删除对象）生成形如 `00-收件箱/`、`01-工作/`…`05-归档/`、`_parking/` 的目录，序号即树中位置。

### 6.2 实现

改为直接遍历 v2 树生成目录，不带序号前缀：

```
wiki/
├── 收件箱/
├── 工作/项目 例行 对外/
├── 学习/在学 参考/
├── 生活/凭据 家事 自留/
├── 收藏/待读 可复用/
├── 归档/
├── _parking/
└── .lumii/
```

用户自建大类（Task 3 迁移时追加到树末尾的）同样按名生成目录，不需要序号。UI 侧的分区排序（收件箱在最前、归档在最后）由 UI 层按固定顺序渲染，不依赖磁盘目录名前缀。

### 6.3 测试

`wiki-vault-layout.test.ts`：断言生成的目录名不含数字前缀；断言用户自建大类目录也被创建。

### 6.4 待知晓：改名去重逻辑现在分散在三处（已核实，非猜测）

facts-taxonomy 核查发现文件名 sanitize/去重不是一套统一实现：

- `sanitizeFilenameSegment`/`ILLEGAL_FILENAME_CHARS` 定义在 `wiki-exporter.ts:39,42`；
- `resolveUniqueFilename` 定义在 `wiki-synthesizer.ts:117`（P2 要删除的文件！）；
- 但实际落盘调用方 `wiki-commands.ts:636-647` 是**手写的** `-${i}` 去重循环，根本没调用 `resolveUniqueFilename`；
- `wiki-ref-store.ts:119`、`wiki-clip-saver.ts:53` 又各自独立调 `sanitizeFilenameSegment(...).slice(0, 80)`。

本 Task 改磁盘目录生成时不需要处理这个问题（目录名生成走的是 `vaultDirSegmentsForSource` + `ensureWikiVaultLayout`，与上述文件名去重无关），但**P6（AI 重命名）落盘时会直接撞上这个分散现状**——`resolveUniqueFilename` 所在文件即将被 P2 删除，P6 不能假设它还在，需要先决定去重逻辑放哪里再实现（见 P6 文档对应章节）。此处仅记录事实，不在本 Task 内处理。

---

## Task 7: 全量验证

- `pnpm --filter agent-runtime test` 全绿。
- `pnpm --filter windows typecheck` 无 `wiki-nav-map`/`wikiNavMapping` 悬挂引用。
- 手动跑一次迁移（本地测试库）：确认迁移报告文件生成、内容符合 §1.3 字段；确认 UI 迁移后弹出「建议跑全库编目」引导卡片；确认磁盘 `wiki/` 目录结构无序号前缀。

---

## 风险

| 项 | 处理 |
|---|---|
| V26 迁移不可逆 | §1.2 备份预案；迁移报告可追溯（`legacy_subtopic` 列 + 报告文件） |
| 拆映射层改动面大（renderer 8 个组件） | Task 5.2C 给出逐组件替换顺序，每步跑测试，避免一次性大改动难以定位问题 |
| 小类置空后 UI 短期显得"变粗" | §1.4 迁移完成后自动引导用户跑 P5 全库编目补充小类 |
| `vaultDirSegmentsForSource` 调用方遗漏 | Task 5.1 已知至少 vault-sync/vault-layout 两处，实施前再跑一次 grep 兜底 |
