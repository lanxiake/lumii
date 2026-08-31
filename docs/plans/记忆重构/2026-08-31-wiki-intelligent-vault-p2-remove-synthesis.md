# Wiki P2：移除综述合成 Implementation Plan

> **For agentic workers:** 按 Task 顺序实施，每个 Task 走「先写失败测试 → 跑失败 → 实现/删除 → 跑通 → 提交」。
> 规格：`docs/design/记忆设计/2026-08-31-wiki-intelligent-vault-design.md`（v1.1）§7
> 与 P1（分类体系切换）、P3（移除历史页面）可并行；不依赖 P1 结果。

**Goal:** 彻底删除综述合成（wiki_syntheses 全链路），DROP 表，不留审计。已 accept 的产物文件保留在磁盘。

**状态标记说明**：以下事实已在 P1 编写期间用 grep + 直接读文件核实（非转述），行号可直接使用；施工时若代码已变动以实际内容为准。

---

## Task 0：已核实的现状（无需重新核查，供后续 Task 直接引用）

- **`wiki_syntheses` 表**（`packages/agent-runtime/src/storage/schema.ts:611-629`，V19 引入）：列为 `id, agent_id, user_id, page_id, source_page_ids, source_ids, title, output_path, candidate_md, status(candidate/accepted/rejected), error, created_at, finished_at`，索引 `idx_wiki_syntheses_agent_user`（628 行）。`page_id`/`source_page_ids` 是历史列，`source_ids` 是后补列——三者共存，印证设计文档描述准确。
- **合成器文件独立存在**：`wiki-synthesizer.ts`（+`.test.ts`）与 `wiki-auto-synthesis.ts`（+`.test.ts`）是两个独立文件，均已通过 grep 确认存在于 `packages/agent-runtime/src/wiki/`。
- **IPC handlers 实际是 7 个，不是 6 个**（`apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts`）：`handleWikiSynthesisCreate`(1214) / `AcceptAsSource`(1263) / `AutoRun`(1284) / `List`(1301) / `Get`(1310) / `Accept`(1328) / `Reject`(1337)。设计文档 §7.1 写「6 条」是漏了一个，本计划以实测 7 个为准。
- **白名单同样是 7 条**（`command-allowlist.ts:55-56`）：`'wiki:synthesis:create', 'wiki:synthesis:list', 'wiki:synthesis:get', 'wiki:synthesis:accept', 'wiki:synthesis:accept-as-source', 'wiki:synthesis:reject', 'wiki:synthesis:auto-run'`——两行共 7 个字符串。
- **cron 任务确认**：`apps/windows/src/main/seed-cron-jobs.ts:154` 有 `id: 'wiki-auto-synthesis'`（注意实际文件名是 `seed-cron-jobs.ts`，不是 `sed-cron-jobs.ts`）。同文件 163 行另有 `id: 'wiki-ero-extract'`，与本次删除无关，不要误删。
- **`outputs/wiki-syntheses/*.md` 引用面**：Task 1 里的 SQL 核查仍需在实施时跑一次（这是运行时数据状态，非静态代码事实，无法靠 grep 提前确认）。
- **`bridge.ts:407-430` 惰性构造**、**`local-companion-handler.ts` synthesis handler**：未在本次核查范围内重新验证，实施前先 grep 一次 `synthesizer` 确认具体行号。

## Task 1：删除后端合成器与自动任务

- [ ] 删除 `packages/agent-runtime/src/wiki/wiki-synthesizer.ts` 及 `wiki-synthesizer.test.ts`。
- [ ] 删除 `packages/agent-runtime/src/wiki/wiki-auto-synthesis.ts` 及 `wiki-auto-synthesis.test.ts`（已确认为独立文件）。
- [ ] 删除 `apps/windows/src/main/seed-cron-jobs.ts:154` 的 `id: 'wiki-auto-synthesis'` cron 定义（已核实行号；注意勿动 163 行的 `wiki-ero-extract`），同步更新 `seed-cron-jobs.test.ts`。
- [ ] 删除 `bridge.ts` 中综述器的惰性构造代码（原记录行号 407-430，实施前先 grep `synthesizer` 复核）。
- [ ] 删除 `local-companion-handler.ts` 中 synthesis 相关 handler（若存在，先 grep 确认）。
- [ ] `packages/agent-runtime/src/wiki/index.ts` 与顶层 `packages/agent-runtime/src/index.ts` 中若有 re-export synthesizer 相关符号，一并删除（参考 `bootstrapEroFromWikilinks` 在 `index.ts:77` 的 re-export 模式排查）。

## Task 2：删除 IPC handlers 与命令类型

- [ ] 删除 `wiki-commands.ts` 中 7 个 handler（已核实行号）：`handleWikiSynthesisCreate`(1214) / `AcceptAsSource`(1263) / `AutoRun`(1284) / `List`(1301) / `Get`(1310) / `Accept`(1328) / `Reject`(1337)。
- [ ] 删除对应的 IPC dispatch 分支（command 类型枚举/switch）。
- [ ] 删除 `command-allowlist.ts:55-56` 中 7 条 `wiki:synthesis:*` 白名单条目（已核实为 7 条，非设计文档写的 6 条）。
- [ ] 全代码库搜索 `wiki:synthesis:` 字符串，确认无遗留引用（类型定义、CLI 分发、测试 mock）。

## Task 3：删除 CLI 子命令

- [ ] 删除 `commands.mjs` 中 `wiki synthesis create/list/get/accept/reject` 子命令（`[待核实]` 原记录行号 787-870）。
- [ ] 更新 `docs/test/lumii-cli/` 下涉及 `wiki synthesis` 的测试用例文档，标记为已移除。
- [ ] 更新 CLI 帮助文本/README 中的子命令列表。

## Task 4：删除前端 UI

- [ ] 删除 `WikiSynthesisCandidates.tsx`。
- [ ] 删除 `wikiConsolidate.ts`（含 `WIKI_CONSOLIDATE_TITLE_PREFIX`、`WIKI_CONSOLIDATE_SUBTOPIC='整合长文'` 等常量与 `isConsolidateSynthesis`/`displaySynthesisTitle`/`resolveConsolidateTarget`/`isShortSource`/`countShortSources`/`waitForSynthesisReady` 等函数）。
- [ ] `WikiMoreMenu.tsx` 的 `MENU_ITEMS` 数组删除「综述合成」项（Sparkles 图标那条）。
- [ ] `WikiTab.tsx` 删除综述视图接线（tab 切换分支、相关 state）。
- [ ] grep 前端全部组件确认无残留 `import.*wikiConsolidate` / `import.*WikiSynthesisCandidates`。

## Task 5：DROP 表（V27，与 P3 合并成一个 schema 版本）

- [ ] 在 `schema.ts` 的 `MIGRATIONS` 数组追加：
  ```sql
  -- V27（与 P3 历史页面 DROP 合并为一个版本）
  DROP TABLE IF EXISTS wiki_syntheses;
  ```
- [ ] 执行前 UI 提示：调用 `storage:listBackups` 展示可用备份，用户确认后才继续迁移（复用现有备份能力，不新增机制）。
- [ ] 迁移测试：造一条 `wiki_syntheses` 存量行 → 跑迁移 → 断言表不存在、`wiki_sources` 中该产物文件对应行不受影响。

## Task 6：整合长文小类退场（与 P1 §3 迁移联动）

- [ ] 确认 P1 迁移 SQL（`docs/plans/记忆重构/2026-08-31-wiki-intelligent-vault-p1-taxonomy.md`）已把 `legacy_subtopic='整合长文'` 的存量行路由到收件箱——本 Task 只需回归测试确认，不重复实现。
- [ ] 若 P2 先于 P1 落地：`整合长文` 小类暂时保留在旧树中即可（它只是失去了产出者，不影响现有资料读取），待 P1 执行迁移时一并清理。不阻塞本期。

## 验证

- [ ] `wiki:synthesis:*` 系列命令全部从 allowlist 消失后，调用会被拒绝（补一条集成测试：直连 dispatch 传入 `wiki:synthesis:create`，断言收到「未授权命令」错误）。
- [ ] 全量单测/集成测试通过。
- [ ] 手动跑一次 CLI `wiki --help`，确认 synthesis 子命令不再出现。

## 风险

| 项 | 处理 |
|---|---|
| DROP 表不可逆 | 迁移前提示备份；用户已在设计 §14 确认接受 |
| 产物文件悬空引用 | Task 0 已核实 `wiki_sources.source_path` 独立于 `wiki_syntheses` 表存在，DROP 表不影响文件访问 |
| 与 P3 的 V27 合并 | 两个 Task 5 若并行开发需协调成同一条迁移 SQL，避免版本号冲突（约定：P3 先落地则 P2 在其基础上追加 DROP 语句，反之亦然） |
