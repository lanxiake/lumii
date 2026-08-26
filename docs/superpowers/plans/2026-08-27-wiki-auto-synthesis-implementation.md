# Wiki 自动综述 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 定时（及手动）按分类自动生成/更新 `syntheses/` 页面，人只编辑与删除；去掉人手选题 + 接受/拒绝主流程。

**Architecture:** 在 `WikiSynthesizer` 上新增 `autoSynthesizeCategory` / `autoSynthesizeAll`：选页（遗忘排序 + 上限）→ 复用分块 LLM 管线 → **直接 savePage** 到稳定路径 `syntheses/overview-<category>`。IPC `wiki:synthesis:auto-run` 供 UI；cron 播种 `__wiki_auto_synthesis__` companion 指令触发同一入口。SynthesisView 改为列表 + 刷新。

**Tech Stack:** TypeScript、Vitest、现有 WikiSynthesizer / CronScheduler / companion 指令、Electron IPC。

**Spec:** `docs/superpowers/specs/2026-08-27-wiki-auto-synthesis-and-kg-design.md` §2（本 plan **不**实现 §3 知识图谱）

## Global Constraints

- 默认目标分类：`sources`、`media`；`inbox` 排除。
- 稳定路径：`syntheses/overview-sources`、`syntheses/overview-media`。
- 选页上限：最多 40 页或合计约 80k 字符（先到为准）；排除 `archived` / `outdated`。
- 直接成页，主流程不要求 accept/reject。
- 中文 UI；函数级注释；2 空格；Conventional Commits。
- 与 `WikiOrganizeQueue` 错峰：auto-run 串行分类，失败不阻断其他分类。
- 图谱相关改动禁止出现在本 plan 的 diff 中。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `packages/agent-runtime/src/wiki/wiki-auto-synthesis.ts` | 选页、路径常量、`autoSynthesizeCategory` 编排（或放在 synthesizer 内；优先独立文件保持 synthesizer 可读） |
| `packages/agent-runtime/src/wiki/wiki-synthesizer.ts` | 抽出可复用的「生成正文」API；或由 auto 模块调用 synthesizer 新方法 |
| `packages/agent-runtime/src/wiki/wiki-auto-synthesis.test.ts` | 选页与成页单测 |
| `packages/agent-runtime/src/wiki/index.ts` | 导出 |
| `apps/windows/src/shared/agent-runtime-commands.ts` | `wiki:synthesis:auto-run` |
| `apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts` | handler |
| `apps/windows/src/main/ipc/agent-runtime-ipc.ts` | switch |
| `apps/windows/src/main/app-ui-control/command-allowlist.ts` | allowlist |
| `apps/windows/src/main/seed-cron-jobs.ts` | 播种每日综述任务 |
| `apps/windows/src/main/agent-runtime/local-companion-handler.ts` | `__wiki_auto_synthesis__` |
| `apps/windows/src/main/agent-runtime/bridge.ts` | 注入 wiki auto runner 到 companion deps |
| `apps/windows/src/renderer/hooks/business/useWikiPage/useWikiPage.ts` | `autoRunSynthesis` |
| `apps/windows/src/renderer/pages/MemoriesPage/components/SynthesisView.tsx` | 列表 + 刷新 UI |
| `apps/windows/src/test/components/SynthesisView.test.tsx` | UI 测（新建） |

---

### Task 1: 选页助手 + autoSynthesizeCategory

**Files:**
- Create: `packages/agent-runtime/src/wiki/wiki-auto-synthesis.ts`
- Create: `packages/agent-runtime/src/wiki/wiki-auto-synthesis.test.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-synthesizer.ts`（抽出生成正文或新增 `synthesizeToPage`）
- Modify: `packages/agent-runtime/src/wiki/index.ts`

**Interfaces:**
- Produces:
  ```typescript
  export const AUTO_SYNTHESIS_CATEGORIES = ["sources", "media"] as const;
  export function autoSynthesisPath(category: string): string; // syntheses/overview-${category}
  export function selectPagesForAutoSynthesis(
    pages: readonly WikiPage[],
    options?: { maxPages?: number; maxChars?: number },
  ): readonly WikiPage[];
  // defaults maxPages=40, maxChars=80_000
  export class WikiAutoSynthesisRunner {
    constructor(synth: WikiSynthesizer, repo: WikiRepo, callLLM already inside synth);
    autoSynthesizeCategory(agentId, userId, category: "sources"|"media"): Promise<{ pageId: string; path: string; skipped?: boolean; error?: string }>;
  }
  ```

- [ ] **Step 1: 写失败单测（选页）**

```typescript
import { describe, expect, it } from "vitest";
import { selectPagesForAutoSynthesis, autoSynthesisPath } from "./wiki-auto-synthesis.js";
import type { WikiPage } from "./types.js";

function page(partial: Partial<WikiPage> & { id: string; title: string }): WikiPage {
  return {
    agent_id: "ag",
    user_id: "u",
    path: `sources/${partial.id}`,
    category: "sources",
    content_md: "x".repeat(100),
    version: 1,
    last_used: null,
    use_count: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    status: "active",
    ...partial,
  } as WikiPage;
}

describe("selectPagesForAutoSynthesis", () => {
  it("排除 archived/outdated，并按遗忘分数截断到 maxPages", () => {
    const pages = [
      page({ id: "a", title: "A", status: "active", use_count: 10 }),
      page({ id: "b", title: "B", status: "archived" }),
      page({ id: "c", title: "C", status: "outdated" }),
      page({ id: "d", title: "D", status: "active", use_count: 0 }),
    ];
    const selected = selectPagesForAutoSynthesis(pages, { maxPages: 1 });
    expect(selected).toHaveLength(1);
    expect(selected[0]!.id).toBe("a");
  });

  it("autoSynthesisPath 稳定", () => {
    expect(autoSynthesisPath("sources")).toBe("syntheses/overview-sources");
    expect(autoSynthesisPath("media")).toBe("syntheses/overview-media");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/agent-runtime && pnpm exec vitest run src/wiki/wiki-auto-synthesis.test.ts`

Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现选页与路径**

`wiki-auto-synthesis.ts`：

```typescript
import { rankByForgettingScore } from "./wiki-forgetting.js";
import type { WikiCategory, WikiPage } from "./types.js";
import type { WikiRepo } from "./wiki-repo.js";
import type { WikiSynthesizer } from "./wiki-synthesizer.js";
import { buildAcceptedSynthesisPageMd } from "./wiki-synthesizer.js";

export const AUTO_SYNTHESIS_CATEGORIES = ["sources", "media"] as const;
export type AutoSynthesisCategory = (typeof AUTO_SYNTHESIS_CATEGORIES)[number];

const DEFAULT_MAX_PAGES = 40;
const DEFAULT_MAX_CHARS = 80_000;

/** 稳定综述落点 */
export function autoSynthesisPath(category: string): string {
  return `syntheses/overview-${category}`;
}

/**
 * 过滤非活跃页，按遗忘分数降序，再按页数/字符上限截断。
 */
export function selectPagesForAutoSynthesis(
  pages: readonly WikiPage[],
  options: { readonly maxPages?: number; readonly maxChars?: number } = {},
): readonly WikiPage[] {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const eligible = pages.filter((p) => p.status !== "archived" && p.status !== "outdated");
  const ranked = rankByForgettingScore(
    eligible.map((p) => ({
      ...p,
      lastUsedAt: p.last_used,
      createdAt: p.created_at,
      useCount: p.use_count,
    })),
  );
  const out: WikiPage[] = [];
  let chars = 0;
  for (const item of ranked) {
    if (out.length >= maxPages) break;
    const bodyLen = item.content_md.length;
    if (out.length > 0 && chars + bodyLen > maxChars) break;
    out.push(item);
    chars += bodyLen;
  }
  return out;
}
```

（`rankByForgettingScore` 输入字段若与 WikiPage 展开冲突，改为显式 map 为 forgetting 输入再映射回 page。）

- [ ] **Step 4: 跑通选页测**

Run: `cd packages/agent-runtime && pnpm exec vitest run src/wiki/wiki-auto-synthesis.test.ts`

Expected: PASS for select/path tests

- [ ] **Step 5: 写失败单测（成页）**

```typescript
it("autoSynthesizeCategory 空分类 skipped；有页则直接 savePage 到稳定路径", async () => {
  const repo = new WikiRepo(createMigratedTestDb());
  // 建 2 个 sources 页…
  const synth = new WikiSynthesizer(repo, async () => "综合摘要正文", fsMocks);
  const runner = new WikiAutoSynthesisRunner(synth, repo);
  const empty = await runner.autoSynthesizeCategory("ag", "u", "media");
  expect(empty.skipped).toBe(true);

  // sources 有页
  const r = await runner.autoSynthesizeCategory("ag", "u", "sources");
  expect(r.path).toBe("syntheses/overview-sources");
  const page = repo.findPageByPath("ag", "u", r.path);
  expect(page?.content_md).toContain("综合摘要正文");
  expect(page?.content_md).toContain("AI"); // 页眉提示

  // 再跑一次仍同 path，version 递增
  const r2 = await runner.autoSynthesizeCategory("ag", "u", "sources");
  expect(r2.path).toBe(r.path);
  expect(repo.findPageByPath("ag", "u", r.path)!.version).toBeGreaterThan(page!.version);
});
```

（按现有 test helpers 调整 `findPageByPath` / fsMocks；若无 `findPageByPath` 用 `listPages` 过滤。）

- [ ] **Step 6: 实现 WikiAutoSynthesisRunner**

在 `WikiSynthesizer` 增加方法（推荐，复用 runPipeline）：

```typescript
/**
 * 自动成页：合成后直接写入 path（不经 accept 手势）。
 * 仍写 wiki_syntheses 记录便于审计，status 直接 accepted 或新增 finishAsAccepted。
 */
async synthesizeDirectToPath(
  agentId: string,
  userId: string,
  pageIds: readonly string[],
  path: string,
  options: WikiSynthesizeOptions & { readonly path: string } ,
): Promise<WikiPage>
```

实现要点：
1. 与 `synthesize` 相同取页、insertSynthesis、runPipeline。
2. 完成后用固定 `path` 调用类似 `acceptSynthesis` 的 savePage（`buildAcceptedSynthesisPageMd`，title 如 `资料综述` / `多媒体综述`）。
3. 将 synthesis 标为 `accepted` 并关联 pageId（复用 `repo.acceptSynthesis` 若 path 可传入；否则扩展 acceptSynthesis 支持 override path）。

检查 `acceptSynthesis`：若 path 写死为 title slug，**扩展**为可传 `path` 参数。

`WikiAutoSynthesisRunner.autoSynthesizeCategory`：

```typescript
async autoSynthesizeCategory(agentId: string, userId: string, category: AutoSynthesisCategory) {
  const pages = this.repo.listPages(agentId, userId, category);
  const selected = selectPagesForAutoSynthesis(pages);
  if (selected.length === 0) return { pageId: "", path: autoSynthesisPath(category), skipped: true };
  const title = category === "sources" ? "资料综述" : "多媒体综述";
  try {
    const page = await this.synth.synthesizeDirectToPath(
      agentId, userId, selected.map((p) => p.id),
      { title, path: autoSynthesisPath(category) },
    );
    return { pageId: page.id, path: page.path };
  } catch (err) {
    return { pageId: "", path: autoSynthesisPath(category), error: (err as Error).message };
  }
}
```

- [ ] **Step 7: 跑通 auto 单测并导出**

Run: `cd packages/agent-runtime && pnpm exec vitest run src/wiki/wiki-auto-synthesis.test.ts src/wiki/wiki-synthesizer.test.ts`

Expected: PASS

Export from `index.ts`。

- [ ] **Step 8: 提交**

```bash
git add packages/agent-runtime/src/wiki/wiki-auto-synthesis.ts \
  packages/agent-runtime/src/wiki/wiki-auto-synthesis.test.ts \
  packages/agent-runtime/src/wiki/wiki-synthesizer.ts \
  packages/agent-runtime/src/wiki/wiki-synthesizer.test.ts \
  packages/agent-runtime/src/wiki/wiki-repo.ts \
  packages/agent-runtime/src/wiki/index.ts
git commit -m "$(cat <<'EOF'
feat(wiki): 按分类自动综述并直接写入稳定路径

EOF
)"
```

---

### Task 2: autoSynthesizeAll + IPC + hook

**Files:**
- Modify: `packages/agent-runtime/src/wiki/wiki-auto-synthesis.ts`（`autoSynthesizeAll`）
- Modify: `apps/windows/src/shared/agent-runtime-commands.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime-ipc.ts`
- Modify: `apps/windows/src/main/app-ui-control/command-allowlist.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime/wiki-commands.test.ts`（若环境允许）
- Modify: `apps/windows/src/renderer/hooks/business/useWikiPage/useWikiPage.ts`
- Modify: bridge 侧构造 synthesizer 的位置（找到现有 synthesis create handler 复用同一依赖）

**Interfaces:**
- Consumes: Task 1 runner
- Produces:
  ```typescript
  autoSynthesizeAll(agentId, userId): Promise<{
    results: readonly { category: string; pageId: string; path: string; skipped?: boolean; error?: string }[];
  }>
  // IPC
  { type: 'wiki:synthesis:auto-run'; agentId?: string; sessionKey?: string }
  // → { results: [...] }
  ```

- [ ] **Step 1: 实现 autoSynthesizeAll（串行）**

```typescript
async autoSynthesizeAll(agentId: string, userId: string) {
  const results = [];
  for (const category of AUTO_SYNTHESIS_CATEGORIES) {
    results.push({ category, ...(await this.autoSynthesizeCategory(agentId, userId, category)) });
  }
  return { results };
}
```

单测：sources 成功 + media skipped 时 results 长度为 2 且 media.skipped。

- [ ] **Step 2: IPC 命令**

```typescript
export interface WikiSynthesisAutoRunCommand {
  readonly type: 'wiki:synthesis:auto-run'
  readonly sessionKey?: string
  readonly agentId?: string
}
```

加入联合类型与结果映射；allowlist 加入 `'wiki:synthesis:auto-run'`。

`handleWikiSynthesisAutoRun`：解析 agentId，用 bridge 已有 callLLM + wikiRepo + fs deps 构造 `WikiSynthesizer` + `WikiAutoSynthesisRunner`，调用 `autoSynthesizeAll`。**对照**现有 `handleWikiSynthesisCreate` 的依赖装配方式，保持一致。

- [ ] **Step 3: hook**

```typescript
const autoRunSynthesis = useCallback(async () => {
  const api = window.electronAPI?.agentRuntime
  if (!api?.sendCommand) return null
  return (await api.sendCommand({ type: 'wiki:synthesis:auto-run' })) as {
    results: readonly { category: string; pageId: string; path: string; skipped?: boolean; error?: string }[]
  }
}, [])
```

导出。

- [ ] **Step 4: 提交**

```bash
git commit -m "$(cat <<'EOF'
feat(wiki): 暴露 wiki:synthesis:auto-run IPC

EOF
)"
```

---

### Task 3: 每日 cron + companion 指令

**Files:**
- Modify: `apps/windows/src/main/seed-cron-jobs.ts`
- Modify: `apps/windows/src/main/agent-runtime/local-companion-handler.ts`
- Modify: `apps/windows/src/main/agent-runtime/local-companion-handler.test.ts`
- Modify: `apps/windows/src/main/agent-runtime/bridge.ts`（注入 runner）

**Interfaces:**
- Produces: seed job id `wiki-auto-synthesis`；指令 `__wiki_auto_synthesis__`；`agentId: null`；`scheduleExpr: '0 3 * * *'`（每天 03:00）；`notifyTargets: 'silent'`

- [ ] **Step 1: 扩展 companion 指令表与测试**

在 `LOCAL_COMPANION_INSTRUCTIONS` 增加 `'__wiki_auto_synthesis__'`。

deps 增加可选：

```typescript
runWikiAutoSynthesis?: () => Promise<string>
```

case：

```typescript
case '__wiki_auto_synthesis__': {
  if (!deps.runWikiAutoSynthesis) return 'wiki auto synthesis unavailable'
  return deps.runWikiAutoSynthesis()
}
```

单测：mock `runWikiAutoSynthesis` 返回摘要字符串，断言 handler 返回值。

- [ ] **Step 2: bridge 注入**

在 `handleCompanionInstruction` 的 deps 中：

```typescript
runWikiAutoSynthesis: async () => {
  // 构造 runner，调用 autoSynthesizeAll('assistant', LOCAL_USER_ID)
  // 返回如 `sources:ok media:skipped`
},
```

（`LOCAL_USER_ID` 与 wiki-commands 一致。）

- [ ] **Step 3: 播种 cron**

`SEED_JOBS` 追加：

```typescript
{
  id: 'wiki-auto-synthesis',
  name: 'Wiki 分类综述自动刷新',
  taskText: '__wiki_auto_synthesis__',
  agentId: null,
  scheduleType: 'cron',
  scheduleExpr: '0 3 * * *',
  notifyTargets: 'silent',
},
```

- [ ] **Step 4: 提交**

```bash
git commit -m "$(cat <<'EOF'
feat(wiki): 播种每日自动综述 cron

EOF
)"
```

---

### Task 4: SynthesisView 改为列表 + 刷新

**Files:**
- Modify: `apps/windows/src/renderer/pages/MemoriesPage/components/SynthesisView.tsx`
- Modify: `apps/windows/src/renderer/pages/MemoriesPage/components/WikiTab.tsx`（传入 `autoRunSynthesis`、`listPages`/`getPage`/`deletePage` 若需）
- Create: `apps/windows/src/test/components/SynthesisView.test.tsx`
- Modify: CSS 如需

**Interfaces:**
- Consumes: `autoRunSynthesis`；`listPages` 结果中 `category === 'syntheses'`；`onOpenPage`；可选 `deletePage`

- [ ] **Step 1: 写 UI 失败测**

```tsx
it('展示 syntheses 页列表，无多选发起区；点击刷新调用 autoRun', async () => {
  const autoRun = vi.fn(async () => ({ results: [] }))
  render(
    <SynthesisView
      pages={[{ id: 'p1', path: 'syntheses/overview-sources', category: 'syntheses', title: '资料综述', version: 1, updatedAt: 1 }]}
      autoRunSynthesis={autoRun}
      onOpenPage={vi.fn()}
      // 旧 props 可保留但 UI 不渲染发起区
      createSynthesis={vi.fn()}
      listSyntheses={vi.fn(async () => [])}
      getSynthesis={vi.fn()}
      acceptSynthesis={vi.fn()}
      rejectSynthesis={vi.fn()}
    />,
  )
  expect(screen.queryByText('发起综述合成')).toBeNull()
  expect(screen.getByText('资料综述')).toBeTruthy()
  await userEvent.click(screen.getByRole('button', { name: /立即刷新/ }))
  expect(autoRun).toHaveBeenCalled()
})
```

- [ ] **Step 2: 改写 SynthesisView**

主 UI：
- 标题「综述」+ 「立即刷新全部」按钮（loading 态）。
- 列表：`pages.filter(p => p.category === 'syntheses')`；点击 `onOpenPage(id)`。
- 刷新结果：简短状态行（成功/跳过/失败按分类）。
- **不渲染**多选发起、接受/拒绝主按钮（`listSyntheses` / accept / reject 可留 props 但不展示，或从 WikiTab 停止传入）。
- 空态：提示「定时任务会自动生成分类综述，也可点击立即刷新」。

WikiTab：传入 `autoRunSynthesis`；刷新后 `refreshPages()`。

- [ ] **Step 3: 跑 UI 测**

Run: `cd apps/windows && pnpm exec vitest run src/test/components/SynthesisView.test.tsx`

Expected: PASS

- [ ] **Step 4: 提交**

```bash
git commit -m "$(cat <<'EOF'
feat(wiki): 综述视图改为自动成页列表与刷新

EOF
)"
```

---

## Spec Coverage（综述轮次）

| Spec §2 | Task |
|---|---|
| 直接成页、人改删 | Task 1 + 4 |
| 定时每天 + 手动刷新 | Task 3 + 4 |
| sources/media 稳定路径 | Task 1 |
| 选页上限与排除 status | Task 1 |
| 失败不阻断 | Task 1–2 |
| 去掉发起/接受主流程 | Task 4 |
| §3 图谱 | **本 plan 不做** |

## Plan Self-Review

- 无 TBD；路径与上限与 spec 一致。
- `synthesizeDirectToPath` / `acceptSynthesis` path override 在 Task 1 明确。
- Cron 用 companion 空 agentId，与现有 tick/memory 模式一致。
