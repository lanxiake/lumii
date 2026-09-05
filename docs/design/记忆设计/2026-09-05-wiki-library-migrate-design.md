# Wiki 库级迁移设计：结构优先整理 outputs → wiki

> 日期：2026-09-05  
> 状态：**已确认（v1.1）**  
> v1.1 变更：补强「中断 / 撤销本轮 / 重新规划」（§3.5、状态机、命令面、进度 UI）  
> 前置：[2026-08-31-wiki-intelligent-vault-design.md](./2026-08-31-wiki-intelligent-vault-design.md)（v1.1，结构优先全库编目）  
> 再前置：[2026-08-29-wiki-vault-ref-first-design.md](./2026-08-29-wiki-vault-ref-first-design.md)  
> 实施计划：`docs/plans/记忆重构/2026-09-05-wiki-library-migrate-implementation.md`（P0+P1）

---

## 0. 问题与目标

### 0.1 用户反馈的缺陷

当用户要求把 `outputs/`（等外部已整理目录）整理进 wiki 时，现有路径是：

`wiki:folder:import` → 写入收件箱 → `organizeInboxIds` → `classifyBatch`（约 10 条一批、带正文预览）

缺陷：

1. **按文件批量重判**，不以「源目录簇」为决策单元，已有文件夹语义被打散。
2. **虽附带源目录树与库内占用摘要**，但只是 prompt 提示，不是必须遵守的映射契约。
3. **与 wiki 已归档类目联系弱**，易另起碎片化落点，造成与用户意图割裂。
4. **模型调用偏多**（按文件数线性），且缺少「先理解再动手」的规划阶段。
5. **Wiki 页进度不足**：难以看到阶段、done/total、正在处理的文件。

### 0.2 目标

把「文件夹 → wiki」从「逐文件自动分类」升级为**库级迁移（Library Migrate）**：

1. 先理解 **源目录组织逻辑** 与 **wiki 既有分类体系**；
2. 以文件夹为粒度出 **映射方案预览**，用户确认后再执行；
3. 执行时像整体重构/重命名入库，而不是盲人摸象式重分类；
4. 减少不必要 LLM 调用，避免过度碎片化；
5. 在 Wiki 页实时展示处理进度与当前文件；
6. 任意进行中阶段可中断；误确认后可停止、撤销本轮已落位并重新规划。

### 0.3 本期范围（YAGNI）

| 做 | 不做（后续） |
|---|---|
| 文件夹导入 / 整理 outputs → wiki 的库级迁移流水线 | 把全库重新编目算法本身重写完（已有 P5；本期只预留进度 UI 复用） |
| 映射预览确认 + 冲突标出 | 静默改写已归档 wiki 资料的分类 |
| 任务中心进度：阶段 / done/total / 当前文件 | 物理搬移 `outputs/` 文件（继续 ref-first） |
| 任意阶段可中断；误确认可停 apply + 撤销本次已落位 + 重新规划 | 跨多次历史 run 的全局时光机回滚 |
| 复用 P5 盘点/锚点/聚簇积木 | 自动扩展大类树（新大类需人明确批准；默认可提议新小类） |

成功标准：

- 同一源文件夹下的文件，确认后默认落入同一 wiki 落点（除非用户在预览里拆分）。
- 已在 wiki 归档的资料**不被本流水线重判**。
- 500 个文件、约 30 个有意义文件夹时，映射规划 LLM 调用为 **O(文件夹批次数)**，不是 O(文件数)。
- Wiki 页 running 任务可见：阶段文案、`done/total`、当前文件名（或当前文件夹）。
- 误点确认后：可在条间停止 apply；`undo` 仅回滚本 run 的 `appliedSourceIds`；随后可 `replan` 回到预览。

---

## 1. 产品决策（已确认）

| # | 决策 | 选择 |
|---|---|---|
| D1 | 参考系 | **两边都要**：先读懂源目录，再对齐/合并进 wiki 现有体系 |
| D2 | 冲突处理 | **先出映射预览**；冲突项标出，用户确认后再执行 |
| D3 | 落地范围 | **先做文件夹迁移**；进度/预览 UI 可复用；全库编目后接 |
| D4 | 已归档资料 | **本期不重判**；只处理新导入 / 仍在收件箱的条目 |
| D5 | 存储 | **ref-first**：不移动源文件，只写 topic + vault 引用 |
| D6 | 默认导入行为 | `wiki:folder:import` 默认走本流水线到预览；真正落位需确认（或 CLI 显式 `--apply`） |
| D7 | 中断与重来 | 任意进行中阶段可 **取消**；`applying` 为协作式中断（条间停）；误确认后可 **撤销本次已落位** 并 **重新规划** |

---

## 2. 流水线总览

新增能力名：**WikiLibraryMigrate**（模块建议 `wiki-library-migrate.ts`）。

```
[Scan/Import] → [Inventory] → [MapPlan LLM] → [Preview/Review] → [Apply]
     │               │              │                │              │
   摄入 inbox    零 LLM 盘点     目录级映射        用户确认      整簇归档
                      ↑_______________|__ cancel / discard / undo+replan __|
```

状态机（单次 migrate run）：

```
idle → inventorying → planning → review → applying → succeeded
         │              │          │         │           └→ partial / failed
         │              │          │         └→ cancelled（条间停止；已落位可 undo）
         │              │          └→ discarded（仅丢规划，inbox 仍 pending）
         └──────────────┴──→ cancelled（未落位，可立即 replan）
```

**取消 ≠ 撤销**：`cancel` 只停止尚未执行的工作；`undo` 把**本 run 已成功归档**的条目退回收件箱，以便改映射后重来。

与现有组件关系：

- **复用** `WikiFolderImporter`（扫描/摄入）、`buildDirectoryTreeText`、`LibraryInventory` 锚点思路、`validateTopicAssignment`、`WikiOrganizer.finalizeCreatedSource`、vault sync 钩子。
- **替换** 文件夹导入路径上的默认 `organizeInboxIds` + `classifyBatch`（保留函数供增量/兼容）。
- **不替代** `WikiReclassifier`（全库编目）；本期只共享进度模型与部分 prompt 积木。

---

## 3. 阶段设计

### 3.1 阶段 1 — 盘点（Inventory，零 LLM）

输入：`importRoot`、本次 `inboxIds`（或待导入候选）、`agentId/userId`。

输出 `MigrateInventory`：

```ts
interface MigrateFolderCluster {
  /** 相对 importRoot 的文件夹路径；根文件用 "" */
  readonly folderRel: string;
  readonly fileCount: number;
  readonly sampleNames: readonly string[]; // ≤3
  readonly inboxIds: readonly string[];
}

interface MigrateInventory {
  readonly importRoot: string;
  readonly directoryTreeText: string;
  readonly clusters: readonly MigrateFolderCluster[];
  readonly wikiOccupancyText: string;      // 复用/扩展 buildTopicOccupancySummary
  readonly wikiAnchorsText: string;        // 每叶 ≤3 锚点（对齐 P5）
  readonly alreadyInWikiCount: number;     // 扫描时跳过的已存在数
  readonly pendingCount: number;
}
```

规则：

- 聚簇键 = `dirname(source_path)` 相对 `importRoot`。
- 跳过 `alreadyInWiki` / ingest filter 已跳过项（与现 importer 一致）。
- **不读全文**；最多取文件名与相对路径。

### 3.2 阶段 2 — 映射规划（MapPlan，少量 LLM）

决策单元是 **文件夹簇**，不是单个文件。

Prompt 组成：

1. `buildTaxonomyGuide(topicTree)`（现有口诀，含「路径优先」）
2. wiki 占用 + 锚点样例（「归到已有类，避免另起碎片」）
3. 源目录树 + 每簇：`folderRel`、fileCount、sampleNames
4. 输出 schema（仅 JSON）

每簇输出：

```ts
interface MigrateFolderMapping {
  readonly folderRel: string;
  readonly category: string | null;
  readonly subtopic: string | null;
  readonly confidence: number;
  readonly reason: string;
  /** 建议新建小类（须用户批准才进树） */
  readonly proposedSubtopic?: string;
  /** 该簇内少数例外文件（默认空；模型应极少使用） */
  readonly exceptions?: readonly {
    readonly inboxId: string;
    readonly category: string | null;
    readonly subtopic: string | null;
    readonly reason: string;
  }[];
  /** 路径语义不足，整簇需要正文轮（尽量少） */
  readonly needContent?: boolean;
}
```

切批：按簇数量，建议 **20～40 簇/批**（只含短文本）。同父目录的子簇尽量同批。

保守规则（写入 prompt 与校验）：

- 优先映射到 **已有占用非零** 的叶子；空库才自由选择。
- 同父路径下的子文件夹，若语义同属一项目，可映射到同一落点（允许 subtopic 留空）。
- `confidence < 0.6` 或 `category` 空 → 标 **冲突/待定**，预览里必须人工处理或「留收件箱」。
- `proposedSubtopic` 不得静默写入主题树；仅进入预览的「待批准新小类」列表。
- **禁止**为填满小类而把同簇拆到多个落点（exceptions 需强 reason；UI 高亮）。

正文补救轮（可选，仅 `needContent` 簇）：

- 每簇抽 ≤3 个样例文件摘要（`getOrBuildSummary`，`allowLlm` 按需）。
- 复判该簇映射；仍不行 → 待定。

### 3.3 阶段 3 — 预览确认（Review）

持久化为 migrate run（见 §5），状态 `review`。UI 展示：

1. **映射表**：源文件夹 → wiki 落点 · 文件数 · 置信度 · 理由  
2. **冲突/待定**：低置信、越权名、空映射  
3. **新小类提案**：勾选批准后，apply 前写入 topic tree  
4. **例外文件**列表（若有）  
5. **重命名建议**（可选，P6 能力若已就绪则挂上；否则本期可只做「标题无信息时提议」，未就绪则跳过）

用户操作：

- 改某一夹的目标大类/小类  
- 忽略某夹（留收件箱）  
- 批准/拒绝新小类  
- **确认执行** / **丢弃整次规划** / **重新规划**（保留 inbox，重跑 inventory+plan）

CLI：`wiki folder migrate plan` → `… review/apply/discard/cancel/undo/replan`（命名在实施计划定稿）。

### 3.4 阶段 4 — 执行落位（Apply）

按确认后的映射：

1. 若有批准的 `proposedSubtopic`，先 `addSubtopic`（或等价 API）。  
2. 按簇遍历 inboxIds：`archiveInboxItem(item, category, subtopic)` + `finalizeCreatedSource`。  
3. 例外文件覆盖簇默认映射。  
4. 失败隔离：单条失败记入明细，不中断整次（终态 `partial`）。  
5. **每条落位前**检查取消标志；若已取消 → 停止后续，phase=`cancelled`，已成功条目写入 `appliedSourceIds` 供 undo。  
6. 全程更新进度事件（§4）。

**明确不做**：对已有 `wiki_sources` 且**非本 run 产出**的条目调用 updateTopic。

### 3.5 中断、撤销与重新来过（v1.1）

用户误点「确认执行」后必须能及时停住并重来。三类操作分开，避免语义糊成一团：

| 操作 | 何时可用 | 行为 | 之后状态 |
|---|---|---|---|
| **取消 `cancel`** | `inventorying` / `planning` / `applying` | 置协作式取消标志；盘点/规划尽快停；apply **在下一条之前**停下，不再归档新文件 | `cancelled`；未处理 inbox 仍 `pending` |
| **丢弃规划 `discard`** | `review`（及 `cancelled` 且尚未 undo 完也可） | 删除本 run 映射草案；**不**动已归档资料 | run 清空或 `discarded`；可重新点整理 |
| **撤销本次 `undo`** | `cancelled` / `partial` / `succeeded`（本 run 仍在）且存在 `appliedSourceIds` | 仅撤销**本 run 已成功落位**的 source：退回收件箱（或等价「取消分类」），vault 引用按既有删除/回收件箱路径处理 | 相关 inbox 回 `pending`；run 记 `undone`；可 `replan` |
| **重新规划 `replan`** | 无 applying 进行中；通常在 discard/undo 之后 | 对同一批 `inboxIds`（或仍 pending 的子集）重跑 inventory+plan → `review` | 新 run（或同 run 重置映射） |

实现要点：

1. **协作式中断**：apply 循环不可卡死在单次超长 LLM；落位本身是同步归档，取消检查放在「下一条之前」即可。planning 批与批之间检查。  
2. **`appliedSourceIds` 必记**：apply 每成功一条就追加；undo 只认这个列表，**绝不**扫全库猜测。  
3. **本 run 新建的小类**：若 undo 后该小类下已无资料，可选提示「删除空小类」；默认不自动删树，避免误伤用户后来手动放的文件。  
4. **成功结束后的 Undo 窗口**：TaskCenter / 预览面板在终态保留「撤销本次整理」直到用户 dismiss run 或开始下一次 migrate（建议 UI 保留最近 1 次可 undo run）。  
5. **一键「停并重来」**：UI 主按钮组合为「停止」→（若有已落位）确认「撤销已整理的 N 项并重新规划」；后端可做成 `cancel` 后链式 `undo`+`replan`，但必须弹确认（因 undo 会改库）。

---

## 4. 进度 UI 与任务状态

### 4.1 进度模型（主进程真源）

```ts
type MigratePhase =
  | 'inventorying'
  | 'planning'
  | 'review'
  | 'applying'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'discarded'
  | 'undone';

interface WikiMigrateProgress {
  readonly runId: string;
  readonly phase: MigratePhase;
  readonly phaseLabel: string;       // 如「正在规划目录映射」
  readonly done: number;
  readonly total: number;
  /** 当前处理的文件名或文件夹相对路径 */
  readonly currentItem: string | null;
  readonly message?: string;         // 短状态说明
  /** applying 时已成功落位数；供「停止」文案：已整理 N 项 */
  readonly appliedCount?: number;
  /** 是否已请求取消（UI 显示「正在停止…」） */
  readonly cancelRequested?: boolean;
}
```

更新频率：

- inventory / planning：按簇或批更新 `done/total`，`currentItem` 为当前文件夹。  
- applying：按文件更新，`currentItem` 为文件名。  
- review：`done/total` 表示「待确认映射条数」，`currentItem` 可空。

推送：IPC 事件（建议 `wiki:migrate:progress`）或复用现有 run 轮询字段；**渲染进程不得自己估进度**。

### 4.2 Wiki 页展示

扩展现有 `WikiTaskCenter` / `useWikiTaskCenter`：

1. 新增 `WikiTaskKind`: `'migrate'`（或复用 `'archive'` 但必须带 phase/currentItem）。**推荐新 kind**，pill 文案：`整理入库中`。  
2. `WikiLocalTask` 扩展：
   - `progress: { done, total }`
   - `detail`：阶段文案 + 当前项，例如 `规划中 · outputs/k8s-xhs-series`
   - 可选 `currentItem` 字段便于样式单独强调  
3. **顶栏 pill**：`整理入库中 12/48`；多任务时仍用「N 个任务进行中」；`cancelRequested` 时改为 `正在停止…`。  
4. **任务中心展开项**：进度条或分数 + 「当前：{currentItem}」+ 阶段标签。  
5. **review 态**：任务不显示为「失败」；pill/卡片引导「有映射方案待确认」，点击打开预览面板。  
6. **中断控件（必做）**：
   - `inventorying` / `planning` / `applying`：主操作旁常驻 **「停止」**（调用 `cancel`）。  
   - `applying` 停止后：若 `appliedCount > 0`，展示「已整理 N 项」+ **「撤销并重新规划」** / **「保留已整理，仅结束」**。  
   - `review`：**「丢弃方案」**、**「重新规划」**（不 apply）。  
   - `succeeded` / `partial` / `cancelled`（仍有 applied）：**「撤销本次整理」**（`undo`），确认文案写明条数。  

预览面板可放在 Wiki 主区抽屉/全页（类似 `WikiReclassifyView`），与任务中心联动：任务中心负责进度与停止，预览面板负责改映射与确认。

### 4.3 后续复用（全库编目）

`WikiReclassifyView` 已有 `processed/total`；迁移进度类型抽成共享 `WikiJobProgress`，编目 running 时同样写入 TaskCenter 的 `currentItem`（当前批的代表文件名）。**本期只定义接口与 migrate 接入，不强制改完编目内部算法。**

---

## 5. 数据与命令面

### 5.1 持久化

新建 migrate run 存储（二选一，实施时取更小改动）：

- **A（推荐）**：`wiki_index_meta` JSON，键 `wiki_migrate_run:{agentId}`（单飞行 run，对齐 reclassify run 模式）；或  
- **B**：新表 `wiki_migrate_runs`（若 JSON 过大再升级）。

Run 内容至少包括：`id, status/phase, importRoot, inventory 摘要, mappings[], userEdits, progress, detailItems[], appliedSourceIds[], cancelRequested, createdAt, finishedAt`。

### 5.2 IPC / CLI（草案）

| 命令 | 作用 |
|---|---|
| `wiki:folder:import` | 默认改为：摄入 + **自动跑 inventory+plan 进入 review**（不再直接 classifyBatch 静默归档） |
| `wiki:migrate:get` | 取当前 run + progress |
| `wiki:migrate:apply` | 用户确认后执行 |
| `wiki:migrate:cancel` | 请求停止当前 inventory/planning/applying |
| `wiki:migrate:discard` | 丢弃规划；inbox 保留 pending；不撤销已归档 |
| `wiki:migrate:undo` | 撤销本 run `appliedSourceIds` 的落位，退回收件箱 |
| `wiki:migrate:replan` | 对仍 pending 的本批 inbox 重跑盘点+映射 → review |
| `wiki:migrate:update-mapping` | 预览中改单条簇映射 / 批准小类 |

兼容：

- `autoClassify: false`：仅摄入 + `intakeBatch`（直入收件箱），与现行为一致。  
- CLI `--apply-without-preview`：**不作为默认**；仅高级/自动化场景，且仍按目录映射执行（不是旧 classifyBatch）。文档标明风险。

### 5.3 与自动分类开关关系

- 轮询 `startWikiOrganizePolling`：**不**对任意 pending 跑库级迁移。  
- 库级迁移仅由「文件夹导入」或用户显式「整理该目录」触发。  
- 增量单文件自动落位（intelligent vault §5.6）保持独立；与 migrate run `planning|applying` 互斥（同 reclassify 互斥模式）。

---

## 6. 错误处理与边界

| 场景 | 行为 |
|---|---|
| 规划 LLM 失败 | run → `failed`；inbox 保持 pending；可重试 plan / replan |
| 部分簇越权名称 | 校验剥离，该簇变待定 |
| apply 中单文件失败 | 记 failed 明细，继续；终态 `partial` |
| 用户 `cancel`（planning） | 尽快结束 LLM 批循环；无落位；可 replan |
| 用户 `cancel`（applying） | 下一条前停止；已落位进 `appliedSourceIds`；未处理留 pending；UI 提供 undo |
| 用户 `undo` | 仅回滚本 run 列表；缺文件/已手动改类的条目标记 skip+原因，其余成功则 `undone` |
| 用户 `discard` | 清映射；不动 source；与 undo 不同 |
| 误确认后「停并重来」 | `cancel` → 确认框 → `undo` → `replan` |
| 导入根下无新文件 | 不创建 run；提示「无新文件」 |
| 与 reclassify 同时 | 拒绝启动 migrate（或拒绝 reclassify），返回明确错误 |
| apply 中再点 apply | 拒绝；返回「已在执行」 |
| undo 后用户已手动改过某条 topic | 该条跳过，不强制覆盖用户事后修改（比较 source 仍属于本 run 落点或仍在 applied 集合且未被手改——实施时用「sourceId ∈ appliedSourceIds」即可简单撤销分类，若产品要更严可加 topic 快照） |

---

## 7. 测试要点

1. **同夹同落点**：`outputs/proj-a/{a,b,c}.md` 规划后三份同一 category/subtopic。  
2. **不打乱已归档**：库内已有分类源在 migrate 前后 topic 不变。  
3. **预览门闩**：未 apply 前 `wiki_sources` 不新增已分类项（可有 inbox）。  
4. **进度事件**：applying 时至少收到多次 progress，且 `currentItem` 非空。  
5. **新小类**：未批准不进树；批准后 apply 成功落在新叶。  
6. **低置信**：不进自动映射成功集，必须出现在冲突列表。  
7. **回归**：`autoClassify: false` 仍只 intake。  
8. **中断 apply**：模拟 N 条中第 k 条前 cancel → 仅 k-1 条归档，其余仍 pending，phase=`cancelled`。  
9. **undo**：cancel/成功后 undo → `appliedSourceIds` 对应条目回收件箱；库内无关 source 不变。  
10. **replan**：undo 或 discard 后 replan → 再次进入 review，且不重复创建已归档的无关文件。

---

## 8. 架构落点（文件级）

| 区域 | 建议 |
|---|---|
| `packages/agent-runtime/src/wiki/wiki-library-migrate.ts` | 新：状态机 + plan/apply |
| `packages/agent-runtime/src/wiki/wiki-migrate-prompt.ts` | 新：目录映射 prompt |
| `wiki-classify-context.ts` / `wiki-library-inventory.ts` | 复用并扩展「源目录簇盘点」 |
| `wiki-commands.ts` / `agent-runtime-commands.ts` / allowlist | 新命令 + 改 folder import 默认 |
| `useWikiTaskCenter.ts` / `WikiTaskCenter.tsx` | kind=migrate、currentItem、阶段文案、停止/撤销按钮 |
| 新 `WikiMigrateReviewView.tsx`（或扩 ReclassifyView 模式） | 映射预览确认 + 停并重来确认流 |
| `WikiTab.tsx` / `useWikiPage` | 接线导入 → 预览 → 进度 |

---

## 9. 与「智能全库编目」的边界

| | 库级迁移（本期） | 全库编目（已有设计） |
|---|---|---|
| 触发 | 文件夹导入 / 整理指定目录 | 用户点「全库重新编目」 |
| 对象 | 新 inbox（来自外部目录） | 已有 wiki_sources ± inbox |
| 风险 | 不应改已归档 | 允许提议移动已归档（须 preview apply） |
| 算法重心 | **源目录 → wiki 映射表** | wiki 内结构轮 + 内容轮 |
| UI | 映射预览 + TaskCenter 进度 | 候选列表 + 可复用进度 |

二者共享：taxonomy guide、锚点占用、聚簇思想、进度结构；**不合并成一个按钮**，避免再次「整理目录却重洗全库」。

---

## 10. 实施分期建议

1. **P0**：盘点 + 目录映射 plan + review/apply/cancel/undo/replan 后端 + folder import 改默认走预览；TaskCenter 进度（阶段/done/total/currentItem）+ **停止**按钮。  
2. **P1**：映射预览 UI（改映射、批准小类、冲突处理）+ 「撤销并重新规划」确认流。  
3. **P2**：needContent 正文补救轮；重命名建议（若 P6 已就绪则挂接）。  
4. **P3**：将同一进度模型接到 `WikiReclassifier` running 展示。

---

## 11. 确认记录

- 参考系：源目录 + wiki 既有体系（C）  
- 冲突：映射预览确认（C）  
- 范围：先迁移、UI 可复用到编目（C）  
- 方案：独立库级迁移流水线（方案 2）  
- 进度：Wiki 页显示处理进度与正在处理的文件  
- 中断：可停止；误确认可撤销本次已落位并重新规划（v1.1）  

