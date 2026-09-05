# Wiki 库级迁移（Library Migrate）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，按 Task 顺序实施。每个 Task 走「先写失败测试 → 跑失败 → 实现 → 跑通 → 提交」。Steps 用 checkbox（`- [ ]`）跟踪。  
> 规格：`docs/design/记忆设计/2026-09-05-wiki-library-migrate-design.md` **v1.1 已确认**  
> 前置：智能资料库 P1 树 v2 + `wiki-taxonomy-prompt`；P5 `LibraryInventory` / `buildLibraryImpression` 可复用；`WikiFolderImporter` + `organizeInboxIds` 现路径需替换默认行为

**Goal:** 把「文件夹 → wiki」从逐文件 `classifyBatch` 升级为目录级映射预览确认的库级迁移：盘点 → 规划 → 预览 → 落位，并支持停止 / 撤销本轮 / 重新规划，Wiki 页展示阶段进度与当前文件。

**Architecture:** 新建 `WikiLibraryMigrate` 状态机（meta JSON 持久化，对齐 `setReclassifyRun`）。盘点零 LLM；规划以**文件夹簇**为单元调 LLM（O(簇批次数)）；`wiki:folder:import` 默认只到 `review`，`apply` 才归档。Undo 用本 run 的 `appliedSourceIds` 精确回滚（删 source + 重开对应 inbox 为 pending）。TaskCenter 新增 `migrate` kind 与停止控件；预览 UI 独立面板。

**Tech Stack:** TypeScript、SQLite meta、`packages/agent-runtime`、Electron IPC、React、Vitest

## Global Constraints

- 不静默改写**非本 run 产出**的已归档 wiki 资料  
- ref-first：不移动 `outputs/` 原文件  
- `cancel` ≠ `undo` ≠ `discard`（语义见设计 §3.5）  
- apply 循环每条前检查 `cancelRequested`  
- 新小类须用户批准后才 `addSubtopic`  
- 函数级注释；中文 UI 文案；测试文件 `*.test.ts(x)` 就近放置  

---

## 0. 实施前必读

### 0.1 现状（将替换的默认路径）

`handleWikiFolderImport`（`wiki-commands.ts`）在 `autoClassify !== false` 时：

1. `importer.import` → inbox  
2. `buildFolderImportClassifyContext`  
3. `wikiOrganizer.organizeInboxIds` → **`classifyBatch` 静默归档**

本期默认改为：import → `WikiLibraryMigrate.plan(...)` → `review`；**不再**调用 `organizeInboxIds`。`autoClassify: false` 仍走 `intakeInboxIds`。

### 0.2 可复用积木

| 符号 | 路径 | 用途 |
|---|---|---|
| `buildDirectoryTreeText` / `buildTopicOccupancySummary` | `wiki-classify-context.ts` | 源树 + 占用 |
| `buildLibraryImpression` | `wiki-catalog-prompt.ts` | wiki 锚点印象（可抽公共段） |
| `buildTaxonomyGuide` | `wiki-taxonomy-prompt.ts` | 口诀 |
| `validateTopicAssignment` | `wiki-topic-tree.ts` | 校验 |
| `archiveInboxItem` / `clearSourceTopic` / `deleteSources` | `wiki-repo.ts` | 落位 / 回滚素材 |
| `setReclassifyRun` 模式 | `wiki-repo.ts` `get/setReclassifyRun` | migrate run 持久化照抄 |
| `planTopicMutation` `addSubtopic` | `wiki-topic-mutate.ts` | 批准新小类 |
| `WikiTaskCenter` | `useWikiTaskCenter.ts` | 进度 UI |

### 0.3 Undo 回滚约定（锁定）

`archiveInboxItem` 会 `markInboxOrganized(inboxId, sourceId)`。Undo **不得**只靠 `clearSourceTopic`（资料仍在、inbox 仍 organized，replan 拿不到 pending）。

本期实现 `WikiRepo.reopenInboxAfterUndo(agentId, userId, sourceIds)`：

1. `deleteSources(agentId, userId, sourceIds)`（已有：删 source + FTS；并把对应 inbox 标 `discarded`）  
2. 紧接着把这些 inbox 从 `discarded` **改回 `pending`**（清 `organized_source_id` / `organized_at` / `last_error`），以便同一批 `inboxIds` 可 replan  

若某 source 已被用户手动删掉，跳过并记 skip。

### 0.4 文件结构（本计划锁定）

| 文件 | 职责 |
|---|---|
| `packages/agent-runtime/src/wiki/wiki-migrate-types.ts` | phase / run / mapping / progress 类型 |
| `packages/agent-runtime/src/wiki/wiki-migrate-inventory.ts` | 源目录簇盘点（零 LLM） |
| `packages/agent-runtime/src/wiki/wiki-migrate-prompt.ts` | 目录映射 prompt + JSON 解析 |
| `packages/agent-runtime/src/wiki/wiki-library-migrate.ts` | 状态机：plan/apply/cancel/discard/undo/replan |
| `packages/agent-runtime/src/wiki/wiki-repo.ts` | `get/setMigrateRun` + `reopenInboxAfterUndo` |
| `apps/windows/.../wiki-commands.ts` 等 | IPC 接线；改 folder import 默认 |
| `useWikiTaskCenter.ts` / `WikiTaskCenter.tsx` | migrate 进度 + 停止 |
| `WikiMigrateReviewView.tsx` | 映射预览与确认 |

**本期不做（P2/P3）：** needContent 正文补救轮、AI 重命名、把进度接到 `WikiReclassifier` 内部算法改造。P0/P1 完成后另开计划。

---

## 1. 关键设计决定（实施锁定）

### D1：单飞行 run，meta JSON

键：`wiki_migrate_run:{agentId}:{userId}`，API 镜像 `getReclassifyRun` / `setReclassifyRun`。

### D2：文件夹导入默认进 review

`autoClassify !== false` → plan 到 review；真正归档只经 `wiki:migrate:apply`。  
CLI/高级：`applyWithoutPreview: true` 仅显式传入时 plan 完直接 apply（文档标明风险）；默认 UI 不暴露。

### D3：规划批次 30 簇

`MIGRATE_PLAN_BATCH_SIZE = 30`。confidence `< 0.6` 或 category 空 → `status: 'conflict'`，不进可一键 apply 集合（用户可在预览改完再 apply）。

### D4：与 reclassify / organizer 互斥

`WikiLibraryMigrate.isBusy(run)`：`inventorying|planning|applying` 为 busy。  
`WikiOrganizer` / `WikiReclassifier` 启动时若 migrate busy → 返回 null/抛错；migrate 启动时若 reclassify running → 拒绝。

---

## Task 1: 类型 + migrate run 持久化 + reopenInboxAfterUndo

**Files:**
- Create: `packages/agent-runtime/src/wiki/wiki-migrate-types.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-repo.ts`
- Modify: `packages/agent-runtime/src/wiki/index.ts`（导出类型）
- Test: `packages/agent-runtime/src/wiki/wiki-repo.test.ts`（追加）

**Interfaces:**
- Produces: `WikiMigrateRun`, `WikiMigratePhase`, `WikiMigrateProgress`, `MigrateFolderMapping`, `repo.getMigrateRun/setMigrateRun`, `repo.reopenInboxAfterUndo`

- [ ] **Step 1: 写失败测试** — `reopenInboxAfterUndo` 与 migrate run roundtrip

在 `wiki-repo.test.ts` 追加：

```ts
it("reopenInboxAfterUndo 删除 source 并把对应 inbox 重开为 pending", () => {
  const item = repo.ingestInbox({ /* 最小字段 */ agentId: "ag", userId: "u", itemType: "output", title: "a.md", sourcePath: "outputs/a/a.md" });
  const source = repo.archiveInboxItem(item, "工作", "项目");
  expect(repo.findInboxById(item.id)!.status).toBe("organized");
  const n = repo.reopenInboxAfterUndo("ag", "u", [source.id]);
  expect(n).toBe(1);
  expect(repo.findSourceById(source.id)).toBeNull();
  expect(repo.findInboxById(item.id)!.status).toBe("pending");
});

it("get/setMigrateRun 读写同一份 JSON", () => {
  repo.setMigrateRun("ag", "u", { id: "m1", phase: "review", /* ...最小字段 */ } as never);
  expect(repo.getMigrateRun("ag", "u")).toMatchObject({ id: "m1", phase: "review" });
  repo.setMigrateRun("ag", "u", null);
  expect(repo.getMigrateRun("ag", "u")).toBeNull();
});
```

（ingest 参数按现有测试 fixture 对齐，勿臆造字段名。）

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter ./packages/agent-runtime test -- wiki-repo.test.ts
```

Expected: FAIL（方法不存在）

- [ ] **Step 3: 实现类型与 repo 方法**

`wiki-migrate-types.ts` 核心：

```ts
export type WikiMigratePhase =
  | "inventorying" | "planning" | "review" | "applying"
  | "succeeded" | "partial" | "failed"
  | "cancelled" | "discarded" | "undone";

export interface WikiMigrateProgress {
  readonly runId: string;
  readonly phase: WikiMigratePhase;
  readonly phaseLabel: string;
  readonly done: number;
  readonly total: number;
  readonly currentItem: string | null;
  readonly message?: string;
  readonly appliedCount?: number;
  readonly cancelRequested?: boolean;
}

export interface MigrateFolderMapping {
  readonly folderRel: string;
  readonly category: string | null;
  readonly subtopic: string | null;
  readonly confidence: number;
  readonly reason: string;
  readonly proposedSubtopic?: string;
  readonly approvedProposedSubtopic?: boolean;
  readonly ignored?: boolean;
  readonly status: "ok" | "conflict" | "needContent";
  readonly exceptions?: readonly {
    readonly inboxId: string;
    readonly category: string | null;
    readonly subtopic: string | null;
    readonly reason: string;
  }[];
  readonly inboxIds: readonly string[];
}

export interface WikiMigrateRun {
  readonly id: string;
  readonly agentId: string;
  readonly userId: string;
  readonly importRoot: string;
  readonly phase: WikiMigratePhase;
  readonly inboxIds: readonly string[];
  readonly mappings: readonly MigrateFolderMapping[];
  readonly appliedSourceIds: readonly string[];
  readonly appliedInboxIds: readonly string[];
  readonly cancelRequested: boolean;
  readonly progress: WikiMigrateProgress;
  readonly error?: string;
  readonly createdAt: string;
  readonly finishedAt?: string;
}
```

`wiki-repo.ts`：

```ts
/** 读取当前库级迁移 run（无则 null） */
getMigrateRun(agentId: string, userId: string): WikiMigrateRun | null { /* 同 getReclassifyRun */ }

/** 写入或清除 migrate run */
setMigrateRun(agentId: string, userId: string, run: WikiMigrateRun | null): void { /* 同 setReclassifyRun */ }

/**
 * 撤销本轮迁移落位：删除 sources，并将对应 organized/discarded inbox 重开为 pending。
 * @returns 成功重开的 inbox 条数
 */
reopenInboxAfterUndo(agentId: string, userId: string, sourceIds: readonly string[]): number {
  // 1) 记下 organized_source_id IN sourceIds 的 inbox id
  // 2) deleteSources(...)
  // 3) UPDATE 这些 inbox → pending，清空 organized_* / last_error / attempt_count
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter ./packages/agent-runtime test -- wiki-repo.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agent-runtime/src/wiki/wiki-migrate-types.ts packages/agent-runtime/src/wiki/wiki-repo.ts packages/agent-runtime/src/wiki/wiki-repo.test.ts packages/agent-runtime/src/wiki/index.ts
git commit -m "$(cat <<'EOF'
feat(wiki): add migrate run persistence and undo reopen helper

EOF
)"
```

---

## Task 2: 源目录簇盘点（零 LLM）

**Files:**
- Create: `packages/agent-runtime/src/wiki/wiki-migrate-inventory.ts`
- Create: `packages/agent-runtime/src/wiki/wiki-migrate-inventory.test.ts`
- Modify: `packages/agent-runtime/src/wiki/index.ts`

**Interfaces:**
- Consumes: `WikiInboxItem`, `buildDirectoryTreeText`, `buildTopicOccupancySummary`, `buildLibraryImpression`（或内联锚点）
- Produces: `buildMigrateInventory(params): MigrateInventory`

- [ ] **Step 1: 写失败测试**

```ts
it("按相对父目录聚簇，同夹文件进同一 cluster", () => {
  const inv = buildMigrateInventory({
    importRoot: "E:/data/outputs",
    workspaceRoot: "E:/data",
    inboxItems: [
      fakeInbox({ id: "1", source_path: "E:/data/outputs/proj/a.md", title: "a.md" }),
      fakeInbox({ id: "2", source_path: "E:/data/outputs/proj/b.md", title: "b.md" }),
      fakeInbox({ id: "3", source_path: "E:/data/outputs/other/c.md", title: "c.md" }),
    ],
    repo, agentId: "ag", userId: "u", topicTree: DEFAULT_V2_TREE,
  });
  expect(inv.clusters).toHaveLength(2);
  const proj = inv.clusters.find((c) => c.folderRel.endsWith("proj") || c.folderRel === "proj");
  expect(proj?.inboxIds).toEqual(expect.arrayContaining(["1", "2"]));
  expect(inv.directoryTreeText).toMatch(/proj/);
});
```

- [ ] **Step 2: 跑测失败**

```bash
pnpm --filter ./packages/agent-runtime test -- wiki-migrate-inventory.test.ts
```

- [ ] **Step 3: 实现 `buildMigrateInventory`**

规则（设计 §3.1）：

- `folderRel` = `dirname(source_path)` 相对 `importRoot`（posix）；根下文件用 `""`  
- `sampleNames` ≤ 3  
- `wikiOccupancyText` / `wikiAnchorsText`：复用 occupancy + LibraryInventory 锚点（可对全库 `buildLibraryInventory` 取 impression 文本，避免重复造轮）  
- 不读正文  

- [ ] **Step 4: 跑测通过 + Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(wiki): add migrate source-folder inventory

EOF
)"
```

---

## Task 3: 目录映射 prompt + 解析

**Files:**
- Create: `packages/agent-runtime/src/wiki/wiki-migrate-prompt.ts`
- Create: `packages/agent-runtime/src/wiki/wiki-migrate-prompt.test.ts`

**Interfaces:**
- Consumes: `buildTaxonomyGuide`, `extractJsonPayload`, `validateTopicAssignment`, `MigrateInventory`
- Produces: `MIGRATE_PLAN_BATCH_SIZE`, `buildMigratePlanPrompt`, `parseMigratePlanResponse`

- [ ] **Step 1: 写失败测试**

```ts
it("parseMigratePlanResponse 校验越权大类为 conflict", () => {
  const mappings = parseMigratePlanResponse(
    JSON.stringify([{ folderRel: "proj", category: "火星", subtopic: null, confidence: 0.9, reason: "x" }]),
    tree,
    [{ folderRel: "proj", inboxIds: ["1"], fileCount: 1, sampleNames: ["a"] }],
  );
  expect(mappings[0]!.status).toBe("conflict");
  expect(mappings[0]!.category).toBeNull();
});

it("confidence < 0.6 → conflict", () => { /* ... */ });

it("buildMigratePlanPrompt 含源目录树与占用且不含正文预览长段", () => {
  const p = buildMigratePlanPrompt(tree, inventory, batchClusters);
  expect(p).toMatch(/口诀|工作/);
  expect(p).toMatch(/源目录|目录结构/);
  expect(p).not.toMatch(/内容预览:/);
});
```

- [ ] **Step 2–4: 实现并测通**

Prompt 强制规则写入正文（设计 §3.2）：同夹默认同落点；优先已有占用叶子；小类可空；`proposedSubtopic` 仅提案；低置信留 conflict。

输出 JSON 数组元素字段与 `MigrateFolderMapping` 对齐；解析时把 `inboxIds` 从输入簇补回（模型可不回传 ids）。

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(wiki): add folder-level migrate plan prompt

EOF
)"
```

---

## Task 4: WikiLibraryMigrate 状态机（plan / cancel / discard / replan）

**Files:**
- Create: `packages/agent-runtime/src/wiki/wiki-library-migrate.ts`
- Create: `packages/agent-runtime/src/wiki/wiki-library-migrate.test.ts`
- Modify: `packages/agent-runtime/src/wiki/index.ts`

**Interfaces:**
- Consumes: Task 1–3、`callLLM`、`WikiReclassifier.isRunning`
- Produces: `class WikiLibraryMigrate` — `plan`, `get`, `cancel`, `discard`, `replan`, `updateMapping`, `static isBusy`

- [ ] **Step 1: 写失败测试（假 LLM）**

```ts
it("plan 结束后 phase=review，同夹映射一致且未 archive", async () => {
  const llm = async () =>
    JSON.stringify([
      { folderRel: "proj", category: "工作", subtopic: "项目", confidence: 0.9, reason: "同项目" },
    ]);
  const mig = new WikiLibraryMigrate(repo, llm);
  const run = await mig.plan({
    agentId: "ag", userId: "u", importRoot: root,
    inboxIds: [id1, id2], // 同夹两个 pending
  });
  expect(run.phase).toBe("review");
  expect(run.mappings[0]!.inboxIds).toHaveLength(2);
  expect(repo.listSources("ag", "u").filter((s) => s.topic_category)).toHaveLength(0);
});

it("planning 中 cancel → cancelled，可 replan", async () => {
  // llm 内调用 mig.cancel 再 resolve
});

it("discard 清除 run，inbox 仍 pending", async () => { /* ... */ });
```

- [ ] **Step 2: 跑测失败**

```bash
pnpm --filter ./packages/agent-runtime test -- wiki-library-migrate.test.ts
```

- [ ] **Step 3: 实现状态机（先不含 apply/undo）**

```ts
export class WikiLibraryMigrate {
  constructor(
    private readonly repo: WikiRepo,
    private readonly callLLM: (prompt: string) => Promise<string>,
    private readonly newId: () => string = generateWikiId,
    private readonly onProgress?: (p: WikiMigrateProgress) => void,
  ) {}

  static isBusy(run: WikiMigrateRun | null): boolean {
    return !!run && (run.phase === "inventorying" || run.phase === "planning" || run.phase === "applying");
  }

  /** 盘点 + 分批规划 → review；若 reclassify running 则抛错 */
  async plan(opts: { agentId; userId; importRoot; inboxIds; workspaceRoot? }): Promise<WikiMigrateRun> { /* ... */ }

  get(agentId, userId): WikiMigrateRun | null { return this.repo.getMigrateRun(agentId, userId) as never; }

  /** 置 cancelRequested；busy 阶段循环内检查 */
  cancel(agentId, userId): WikiMigrateRun | null { /* ... */ }

  discard(agentId, userId): void { this.repo.setMigrateRun(agentId, userId, null); }

  /** 预览中改单簇映射 / 批准 proposedSubtopic / ignored */
  updateMapping(agentId, userId, folderRel, patch): WikiMigrateRun { /* ... */ }

  async replan(agentId, userId): Promise<WikiMigrateRun> {
    // 取 run.inboxIds 中仍 pending 的子集，再 plan
  }
}
```

`plan` 伪流程：检查互斥 → 写 run `inventorying` → `buildMigrateInventory` → `planning` 按 30 簇切批调 LLM → 合并 mappings → `review`。每批前后检查 `cancelRequested`。

- [ ] **Step 4: 测通 + Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(wiki): add library migrate plan/cancel/discard state machine

EOF
)"
```

---

## Task 5: apply + undo + 进度回调

**Files:**
- Modify: `packages/agent-runtime/src/wiki/wiki-library-migrate.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-library-migrate.test.ts`

**Interfaces:**
- Consumes: `archiveInboxItem`, `planTopicMutation`+`commit`（或 repo 现有 mutate API）、`reopenInboxAfterUndo`、`onSourceCreated` 钩子（可选注入）
- Produces: `apply`, `undo`

- [ ] **Step 1: 写失败测试**

```ts
it("apply 按映射 archive，写入 appliedSourceIds", async () => {
  // plan 到 review → apply
  expect(run.phase).toBe("succeeded");
  expect(run.appliedSourceIds.length).toBe(2);
  expect(repo.findSourceById(run.appliedSourceIds[0]!)!.topic_category).toBe("工作");
});

it("apply 中途 cancel：仅部分落位，phase=cancelled", async () => {
  // 在 onProgress 看到 appliedCount===1 时 cancel
  expect(run.appliedSourceIds).toHaveLength(1);
  expect(repo.findInboxById(remainingId)!.status).toBe("pending");
});

it("undo 后 source 消失且 inbox 回 pending，可再 plan", async () => {
  await mig.apply(...);
  const undone = await mig.undo("ag", "u");
  expect(undone.phase).toBe("undone");
  expect(repo.findInboxById(id1)!.status).toBe("pending");
});

it("不修改本 run 之外已归档资料的 topic", async () => {
  const preexisting = /* 已有 学习/参考 */;
  await mig.apply(...);
  expect(repo.findSourceById(preexisting.id)!.topic_category).toBe("学习");
});
```

- [ ] **Step 2–4: 实现**

`apply`：

1. phase 必须是 `review`  
2. 对 `approvedProposedSubtopic` 的 mapping 先 `addSubtopic`  
3. 跳过 `ignored` 与仍 `conflict` 且无用户改写的簇  
4. 逐 inbox：`if (run.cancelRequested) break`；`archiveInboxItem`；追加 `appliedSourceIds` / `appliedInboxIds`；`onProgress`  
5. 终态：`cancelled` | `partial`（有失败）| `succeeded`  

`undo`：

1. phase ∈ `cancelled|partial|succeeded` 且 `appliedSourceIds.length > 0`  
2. `reopenInboxAfterUndo`  
3. 清空 applied 列表，phase=`undone`  

注入可选 `hooks?: { onSourceCreated?: (s: WikiSource) => void }`，与 organizer 的 vault sync 对齐（bridge 接线时传入）。

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(wiki): implement migrate apply, cancel-during-apply, and undo

EOF
)"
```

---

## Task 6: IPC / 命令类型 / allowlist / 改 folder import 默认

**Files:**
- Modify: `apps/windows/src/shared/agent-runtime-commands.ts`
- Modify: `apps/windows/src/main/app-ui-control/command-allowlist.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime-ipc.ts`
- Modify: `apps/windows/src/main/agent-runtime/bridge.ts`（惰性创建 migrate + progress 广播）
- Modify: `apps/windows/resources/app-ui-cli/commands.mjs`（可选 CLI 子命令）
- Test: `apps/windows/src/main/ipc/agent-runtime/wiki-commands.test.ts`

**Interfaces:**
- Produces 命令：
  - `wiki:migrate:get|apply|cancel|discard|undo|replan|update-mapping`
  - `wiki:folder:import` 行为变更（默认 plan→review，返回 `migrateRun`）

- [ ] **Step 1: 写/改失败测试**

```ts
it("folder import 默认进入 migrate review 而非静默 archive", async () => {
  const r = await handleWikiFolderImport(bridge, {
    type: "wiki:folder:import",
    dir: tmpDirWithFiles,
    // autoClassify 默认 true
  });
  expect(r.migrateRun?.phase).toBe("review");
  expect(bridge.wikiRepo.listSources(...).filter(s => s.topic_category)).toHaveLength(0);
});

it("autoClassify:false 仍 intake only", async () => { /* 保持现断言 */ });
```

- [ ] **Step 2: 实现 handlers**

`handleWikiFolderImport` 关键路径：

```ts
if (!autoClassify) { /* 现有 intake */ }
// 新默认：
const migrate = bridge.wikiLibraryMigrate;
const run = await migrate.plan({ agentId, userId: LOCAL_USER_ID, importRoot: dir, inboxIds: importResult.inboxIds, workspaceRoot });
return { ...importResult, autoClassify: true, migrateRun: summarize(run) };
```

Progress：bridge 构造 migrate 时 `onProgress` → `BrowserWindow.webContents.send('wiki:migrate:progress', p)`（事件名与 preload 暴露在同 Task 或 Task 7 对齐）。

- [ ] **Step 3: allowlist + ipc switch 全开**

每个新 `wiki:migrate:*` 必须进 `command-allowlist.ts` 与 `agent-runtime-ipc.ts` switch。

- [ ] **Step 4: 测通 + Commit**

```bash
pnpm --filter ./apps/windows test -- wiki-commands.test.ts
git commit -m "$(cat <<'EOF'
feat(wiki): wire migrate IPC and folder-import preview default

EOF
)"
```

---

## Task 7: TaskCenter 进度 + 停止按钮（P0 UI）

**Files:**
- Modify: `apps/windows/src/renderer/pages/MemoriesPage/components/useWikiTaskCenter.ts`
- Modify: `apps/windows/src/renderer/pages/MemoriesPage/components/WikiTaskCenter.tsx`
- Modify: `apps/windows/src/renderer/hooks/business/useWikiPage/useWikiPage.ts`（或邻接 hook：订阅 progress）
- Modify: `apps/windows/src/renderer/pages/MemoriesPage/components/WikiTab.tsx`（接线停止）
- Test: 现有 `useWikiTaskCenter` 相关 test（若无则新建 `useWikiTaskCenter.test.ts`）

**Interfaces:**
- Consumes: `WikiMigrateProgress` 事件
- Produces: `WikiTaskKind = 'migrate'`，pill「整理入库中」/「正在停止…」，任务项「停止」

- [ ] **Step 1: 写失败测试**

```ts
it("migrate running 显示 done/total 与 currentItem", () => {
  const store = createWikiTaskCenterStore();
  const id = store.startTask({
    kind: "migrate",
    title: "整理入库",
    phase: "running",
    progress: { done: 3, total: 10 },
    currentItem: "a.md",
    detail: "落位中 · a.md",
  });
  const snap = store.getSnapshot();
  expect(snap.pillText).toMatch(/整理入库中.*3\/10/);
});
```

扩展 `WikiLocalTask`：

```ts
readonly currentItem?: string
readonly migratePhase?: WikiMigratePhase
readonly appliedCount?: number
readonly cancelRequested?: boolean
readonly onCancel?: () => Promise<unknown>
```

- [ ] **Step 2–4: 实现 UI**

- `TASK_PROGRESS_PREFIX.migrate = '整理入库中'`  
- running + `cancelRequested` → pill `正在停止…`  
- `WikiTaskItem`：显示「当前：{currentItem}」；running 时显示「停止」按钮调用 `onCancel` / `wiki:migrate:cancel`  
- `useWikiPage`：folder import 成功后 `startTask(kind:migrate)`，监听 progress `updateTask`  

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(wiki): show migrate progress and stop in task center

EOF
)"
```

---

## Task 8: 映射预览面板 + 撤销并重新规划（P1 UI）

**Files:**
- Create: `apps/windows/src/renderer/pages/MemoriesPage/components/WikiMigrateReviewView.tsx`
- Create: `apps/windows/src/renderer/pages/MemoriesPage/components/WikiMigrateReviewView.test.tsx`（可选 RTL）
- Modify: `WikiLeftNav.tsx` / `WikiTab.tsx` / `WikiNav` 类型（增加 `migrate` 视图或从任务中心打开抽屉）
- Modify: `useWikiPage.ts` — `migrateApply/Discard/Undo/Replan/UpdateMapping`

**Interfaces:**
- Consumes: `wiki:migrate:get` 的 mappings  
- Produces: 用户可改落点、批准小类、确认执行、丢弃、撤销并重新规划

- [ ] **Step 1: 实现 Review 列表 UI（对照 WikiReclassifyView 布局）**

展示列：源文件夹 | 文件数 | 目标大类/小类 | 置信 | 理由 | 状态(ok/conflict)  

操作：

- 行内改 category/subtopic → `update-mapping`  
- 勾选批准 `proposedSubtopic`  
- 「忽略此夹」→ `ignored: true`  
- 主按钮「确认整理」→ `apply`（conflict 未处理完时禁用或二次确认）  
- 「丢弃方案」→ `discard`  
- 「重新规划」→ `replan`  

- [ ] **Step 2: 停止后确认流**

当 task `phase` 变为 cancelled/succeeded/partial 且 `appliedCount > 0`：

- 「撤销本次整理」→ confirm(`将撤销已整理的 N 项并退回收件箱`) → `undo`  
- 「撤销并重新规划」→ `undo` then `replan` → 打开 Review  

- [ ] **Step 3: 手动/组件测 + Commit**

```bash
pnpm --filter ./apps/windows test -- WikiMigrateReviewView
pnpm --filter ./apps/windows lint
git commit -m "$(cat <<'EOF'
feat(wiki): add migrate mapping review and undo-replan UI

EOF
)"
```

---

## Task 9: Organizer / Reclassifier 互斥 + 导出清理

**Files:**
- Modify: `packages/agent-runtime/src/wiki/wiki-organizer.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-reclassifier.ts`（或仅在 bridge/commands 层互斥）
- Modify: `packages/agent-runtime/src/wiki/wiki-organizer.test.ts`
- Modify: `apps/windows/resources/user-guides/wiki-user-guide.md`（短说明：导入先预览）

- [ ] **Step 1: 测试** — migrate busy 时 `organizeBatch` 返回 null  

- [ ] **Step 2: 实现** — `takeAndEnrich` / reclassify `run` 开头检查 `WikiLibraryMigrate.isBusy(repo.getMigrateRun(...))`  

- [ ] **Step 3: 用户指南改一句 + Commit**

```bash
git commit -m "$(cat <<'EOF'
fix(wiki): mutex migrate with organize/reclassify; document preview import

EOF
)"
```

---

## Task 10: 回归与类型检查

- [ ] **Step 1: 跑相关包测试**

```bash
pnpm --filter ./packages/agent-runtime test -- wiki-migrate
pnpm --filter ./packages/agent-runtime test -- wiki-repo.test.ts
pnpm --filter ./packages/agent-runtime test -- wiki-organizer.test.ts
pnpm --filter ./apps/windows test -- wiki-commands.test.ts
pnpm --filter ./apps/windows test -- useWikiTaskCenter
```

Expected: 全绿

- [ ] **Step 2: 类型检查**

```bash
pnpm --filter ./packages/agent-runtime exec tsc --noEmit
pnpm --filter ./apps/windows exec tsc --noEmit
```

- [ ] **Step 3: 对照设计 §7 验收清单手工勾选**（同夹同落点、不打乱已归档、预览门闩、中断、undo、replan、autoClassify false）

- [ ] **Step 4: 若有文档路径更新** — 设计文头「实施计划」链到本文件

---

## 后续（不在本计划强制交付）

| 阶段 | 内容 |
|---|---|
| P2 | `needContent` 簇正文补救轮；挂接 P6 重命名建议 |
| P3 | 共享 `WikiJobProgress` 接到 `WikiReclassifier` running 的 currentItem |

---

## Spec 覆盖自检

| 设计要求 | Task |
|---|---|
| 盘点零 LLM / 目录簇 | T2 |
| 映射规划少量 LLM | T3–T4 |
| 预览确认 | T4 updateMapping + T8 |
| apply 整簇落位 | T5 |
| 不改已有归档 | T5 测试 |
| cancel / discard / undo / replan | T4–T5、T8 |
| 进度 + 当前文件 + 停止 | T7 |
| folder import 默认预览 | T6 |
| 互斥 | T9 |
| ref-first | 全程不搬文件 |

**占位符扫描：** 无 TBD；P2/P3 显式标为后续。  
**类型一致性：** `WikiMigrateRun` / `MigrateFolderMapping` / `WikiMigrateProgress` 以 Task 1 为准，后文不得另造字段名。
