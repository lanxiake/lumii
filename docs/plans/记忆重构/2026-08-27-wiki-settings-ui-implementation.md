# Wiki 设置页 UI 重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将「设置 → 记忆 → Wiki」从扁平多视图互斥切换，改造成浏览优先的双栏 + 详情侧滑 + 任务进度可观测界面。

**Architecture:** 纯前端壳层重构。`useWikiPage` 现有 IPC 命令不变；新增轻量 `useWikiTaskCenter` 在渲染层跟踪本地发起的长任务，并用 `wiki:runs:list` 填充历史。把 `WikiTab.tsx` 拆成导航 / 顶栏 / 列表 / 侧滑 / 任务中心等小组件，避免单文件继续膨胀。

**Tech Stack:** React + TypeScript、现有 CSS 变量（`--color-*` / `--mt-*`）、Vitest + Testing Library、既有 `@uiw/react-md-editor`

**Spec:** `docs/design/记忆设计/2026-08-27-wiki-settings-ui-redesign.md`  
**Figma:** https://www.figma.com/design/523PyRIkBEyIT4Zb09DbN0

## Global Constraints

- 不改其他记忆 Tab、记忆注入开关、Wiki 后端算法
- 不新增 IPC 进度推送（本阶段用本地 task + `listRuns` 轮询/刷新；YAGNI）
- 用户可见状态必须中文，禁止直接渲染 `pending` / `succeeded` 等枚举
- 「⋯ 更多」是清理 / 综述 / 重建的唯一入口；图谱留左栏一级；运行日志并入任务中心
- 打开页面用侧滑，列表不消失；待整理 / 图谱 / 清理 / 合成走主区
- 提交信息用 Conventional Commit，如 `feat(wiki-ui): ...`
- 验证：`pnpm --filter ./apps/windows test` 中与 Wiki 相关用例 + 手动点一遍主路径

---

## File Map

| 文件 | 职责 |
|---|---|
| `apps/windows/src/renderer/pages/MemoriesPage/components/wikiStatusLabels.ts` | inbox/run/outcome 中文映射 + 相对时间 |
| `apps/windows/src/renderer/pages/MemoriesPage/components/useWikiTaskCenter.ts` | 本地任务模型、pill 文案、与 runs 合并 |
| `apps/windows/src/renderer/pages/MemoriesPage/components/WikiLeftNav.tsx` | 左栏分区 + 图谱 + 更多入口 |
| `apps/windows/src/renderer/pages/MemoriesPage/components/WikiTopBar.tsx` | 搜索、分区标题、任务 pill |
| `apps/windows/src/renderer/pages/MemoriesPage/components/WikiPageList.tsx` | 资料/多媒体/搜索结果列表行 |
| `apps/windows/src/renderer/pages/MemoriesPage/components/WikiInboxPanel.tsx` | 待整理列表（中文状态） |
| `apps/windows/src/renderer/pages/MemoriesPage/components/WikiDetailDrawer.tsx` | 详情侧滑（编辑/删除/反链折叠） |
| `apps/windows/src/renderer/pages/MemoriesPage/components/WikiMoreMenu.tsx` | ⋯ 更多弹出菜单 |
| `apps/windows/src/renderer/pages/MemoriesPage/components/WikiTaskCenter.tsx` | 任务中心抽屉 |
| `apps/windows/src/renderer/pages/MemoriesPage/components/WikiTab.tsx` | 组装壳 + 状态机 |
| `apps/windows/src/renderer/pages/MemoriesPage/components/WikiTab.css` | 新布局样式 |
| `apps/windows/src/test/components/WikiTab.test.tsx` | 更新/新增交互测试 |
| `apps/windows/src/test/components/wikiStatusLabels.test.ts` | 标签映射单测 |
| `apps/windows/src/test/components/useWikiTaskCenter.test.ts` | 任务中心逻辑单测 |

保留并嵌入：`PageSidebar.tsx`、`CleanupView.tsx`、`SynthesisView.tsx`、`WikiGraphView.tsx`、`LinkAutocomplete.tsx`。

---

### Task 1: 中文状态映射与相对时间

**Files:**
- Create: `apps/windows/src/renderer/pages/MemoriesPage/components/wikiStatusLabels.ts`
- Test: `apps/windows/src/test/components/wikiStatusLabels.test.ts`

**Interfaces:**
- Produces:
  - `inboxStatusLabel(status: string): string`
  - `runStatusLabel(status: string): string`
  - `outcomeLabel(outcome: string): string`
  - `extractLabel(extract: string): string`
  - `formatRelativeTime(ts: number | null, now?: number): string`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import {
  inboxStatusLabel,
  runStatusLabel,
  outcomeLabel,
  extractLabel,
  formatRelativeTime,
} from '../../renderer/pages/MemoriesPage/components/wikiStatusLabels'

describe('wikiStatusLabels', () => {
  it('maps inbox statuses to Chinese', () => {
    expect(inboxStatusLabel('pending')).toBe('待处理')
    expect(inboxStatusLabel('processing')).toBe('处理中')
    expect(inboxStatusLabel('failed')).toBe('失败')
    expect(inboxStatusLabel('unknown_x')).toBe('unknown_x')
  })

  it('maps run/outcome/extract labels', () => {
    expect(runStatusLabel('succeeded')).toBe('已完成')
    expect(outcomeLabel('archived')).toBe('已归档')
    expect(extractLabel('preview')).toBe('已有预览')
  })

  it('formats relative time in zh', () => {
    const now = Date.parse('2026-08-27T12:00:00+08:00')
    expect(formatRelativeTime(now - 2 * 3600_000, now)).toBe('2 小时前')
    expect(formatRelativeTime(null, now)).toBe('')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ./apps/windows exec vitest run src/test/components/wikiStatusLabels.test.ts`  
Expected: FAIL（模块不存在）

- [ ] **Step 3: Write minimal implementation**

实现上述五个导出函数；未知枚举回退原字符串；相对时间覆盖：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 上周 / 本地短日期。

- [ ] **Step 4: Run test to verify it passes**

Run: 同上  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/windows/src/renderer/pages/MemoriesPage/components/wikiStatusLabels.ts apps/windows/src/test/components/wikiStatusLabels.test.ts
git commit -m "$(cat <<'EOF'
feat(wiki-ui): add Chinese status labels and relative time helpers

EOF
)"
```

---

### Task 2: useWikiTaskCenter（本地任务 + runs 历史）

**Files:**
- Create: `apps/windows/src/renderer/pages/MemoriesPage/components/useWikiTaskCenter.ts`
- Test: `apps/windows/src/test/components/useWikiTaskCenter.test.ts`

**Interfaces:**
- Consumes: `WikiRunItem` from `useWikiPage`
- Produces:

```ts
export type WikiTaskKind = 'archive' | 'cleanup' | 'synthesis' | 'rebuild' | 'graph'
export type WikiTaskPhase = 'running' | 'succeeded' | 'failed'

export interface WikiLocalTask {
  readonly id: string
  readonly kind: WikiTaskKind
  readonly title: string
  readonly phase: WikiTaskPhase
  readonly progress?: { readonly done: number; readonly total: number }
  readonly detail?: string
  readonly error?: string
  readonly createdAt: number
  readonly finishedAt?: number
  readonly retryable?: boolean
}

export interface WikiTaskCenterApi {
  readonly tasks: readonly WikiLocalTask[]
  readonly pillText: string | null // null = 隐藏
  readonly pillTone: 'running' | 'success' | 'error' | 'idle'
  readonly hasUnseenFailure: boolean
  startTask: (input: Omit<WikiLocalTask, 'id' | 'phase' | 'createdAt'> & { phase?: WikiTaskPhase }) => string
  updateTask: (id: string, patch: Partial<WikiLocalTask>) => void
  completeTask: (id: string, patch?: Partial<WikiLocalTask>) => void
  failTask: (id: string, error: string, retryable?: boolean) => void
  dismissTask: (id: string) => void
  markFailuresSeen: () => void
  mergeRuns: (runs: readonly WikiRunItem[]) => void
  wrapAsync: <T>(kind: WikiTaskKind, title: string, fn: () => Promise<T>) => Promise<T>
}
```

规则（与 spec §5.4 对齐）：
- 无 running 且无未查看失败 → `pillText = null`
- 1 个 running 且有 `progress` → `归档中 3/12` 类文案（按 kind 前缀）
- 多个 running → `N 个任务进行中`
- 刚成功：`pillTone = success` 约 3s（用假时钟在测试里推进）
- 失败未看：`pillTone = error`，红点逻辑靠 `hasUnseenFailure`

- [ ] **Step 1: Write the failing test**

用 `@testing-library/react` 的 `renderHook`（若项目已有）或直接导出纯 reducer 测：

```ts
import { describe, it, expect, vi } from 'vitest'
import { createWikiTaskCenterStore } from '../../renderer/pages/MemoriesPage/components/useWikiTaskCenter'

describe('wiki task center store', () => {
  it('hides pill when idle', () => {
    const store = createWikiTaskCenterStore()
    expect(store.getSnapshot().pillText).toBeNull()
  })

  it('shows determinate progress for running archive', () => {
    const store = createWikiTaskCenterStore()
    const id = store.startTask({
      kind: 'archive',
      title: '处理待整理',
      progress: { done: 3, total: 12 },
    })
    expect(store.getSnapshot().pillText).toBe('归档中 3/12')
    store.completeTask(id)
  })

  it('wrapAsync records failure', async () => {
    const store = createWikiTaskCenterStore()
    await expect(
      store.wrapAsync('rebuild', '重建索引', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(store.getSnapshot().hasUnseenFailure).toBe(true)
    expect(store.getSnapshot().pillTone).toBe('error')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ./apps/windows exec vitest run src/test/components/useWikiTaskCenter.test.ts`  
Expected: FAIL

- [ ] **Step 3: Implement store + `useWikiTaskCenter` hook**

- 导出可测的 `createWikiTaskCenterStore`
- React hook 订阅 store；`mergeRuns` 把 `status !== 'running'` 的 run 映射为「最近完成/失败」展示项（不重复本地 task id）
- kind 文案前缀：`archive→归档中`、`cleanup→清理中`、`synthesis→综述合成中`、`rebuild→重建索引…`、`graph→图谱任务中`

- [ ] **Step 4: Run tests PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/windows/src/renderer/pages/MemoriesPage/components/useWikiTaskCenter.ts apps/windows/src/test/components/useWikiTaskCenter.test.ts
git commit -m "$(cat <<'EOF'
feat(wiki-ui): add local wiki task center store for progress pill

EOF
)"
```

---

### Task 3: 左栏 + 顶栏壳（信息架构）

**Files:**
- Create: `WikiLeftNav.tsx`, `WikiTopBar.tsx`
- Modify: `WikiTab.tsx`, `WikiTab.css`
- Test: `WikiTab.test.tsx`

**Interfaces:**
- Consumes: task center pill props；`pendingCount`
- Produces: 导航回调

```ts
type WikiPrimaryNav = 'sources' | 'media' | 'inbox' | 'graph'
type WikiToolView = 'cleanup' | 'synthesis' | null

// WikiLeftNav props
{
  active: WikiPrimaryNav | 'more'
  pendingCount: number
  pageCounts: Record<string, number>
  onSelect: (nav: WikiPrimaryNav) => void
  onOpenMore: () => void
}

// WikiTopBar props
{
  title: string
  subtitle: string
  query: string
  onQueryChange: (q: string) => void
  onSearch: () => void
  onClearSearch?: () => void
  pillText: string | null
  pillTone: 'running' | 'success' | 'error' | 'idle'
  onOpenTasks: () => void
}
```

- [ ] **Step 1: Update failing WikiTab tests for new IA**

把现有「运行日志」入口断言改为：
- 左栏有「知识图谱」「⋯ 更多」
- 左栏**没有**「运行日志」「清理」「综述合成」「重建索引」独立一级项
- 搜索 placeholder 可改为 `搜索 Wiki…`（与 Figma 一致），同步改测试

```ts
it('左栏一级含图谱与更多，不含运行日志', async () => {
  render(<WikiTab />)
  await screen.findByText(/暂无页面|暂无资料/)
  expect(screen.getByText('知识图谱')).toBeInTheDocument()
  expect(screen.getByText('⋯ 更多')).toBeInTheDocument()
  expect(screen.queryByText('运行日志')).not.toBeInTheDocument()
})
```

- [ ] **Step 2: Run to verify fail / outdated assertions**

Run: `pnpm --filter ./apps/windows exec vitest run src/test/components/WikiTab.test.tsx`

- [ ] **Step 3: Implement LeftNav + TopBar；WikiTab 改用新壳**

状态机最小集：
- `primaryNav: WikiPrimaryNav`（默认 `sources`）
- `toolView: WikiToolView`（清理/合成时非 null，覆盖主区）
- `searchResults` 仍可保留
- 删除左栏 runs/cleanup/synthesis/graph/rebuild 旧按钮；graph 改 `primaryNav`
- 顶栏组装搜索 + 标题 + pill（本 Task pill 可先 `onOpenTasks` no-op，Task 6 接上）

- [ ] **Step 4: Tests PASS；手动确认布局不崩**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(wiki-ui): restructure wiki left nav and top bar

EOF
)"
```

---

### Task 4: 列表行 + 待整理中文态 + 空状态

**Files:**
- Create: `WikiPageList.tsx`, `WikiInboxPanel.tsx`
- Modify: `WikiTab.tsx`, `WikiTab.css`
- Test: `WikiTab.test.tsx`

**Interfaces:**
- `WikiPageList` 接收 `pages | searchHits`、`selectedPageId`、`onOpen`
- `WikiInboxPanel` 接收 inbox items + retry/discard

- [ ] **Step 1: Tests**

```ts
it('待整理失败项显示中文状态与重试', async () => {
  ;(window as any).electronAPI.agentRuntime.sendCommand = mockSendCommand({
    'wiki:inbox:list': [{
      id: 'i1', itemType: 'file', title: '导出报告', contentPreview: 'x',
      mediaType: 'document', status: 'failed', attemptCount: 2,
      lastError: '超时', createdAt: Date.now(),
    }],
    'wiki:inbox:count': { total: 1 },
  })
  render(<WikiTab />)
  fireEvent.click(await screen.findByText('待整理'))
  expect(await screen.findByText('失败')).toBeInTheDocument()
  expect(screen.getByText('重试')).toBeInTheDocument()
  expect(screen.queryByText(/^failed$/)).not.toBeInTheDocument()
})
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement list/inbox panels**

- 列表行：标题、`资料`/`多媒体` 标签、可选 snippet（搜索有；列表无则省略）、`path · 相对时间`
- 选中行 `wiki-page-list-item--selected` 左侧 3px accent
- 空状态文案对齐 spec（不堆按钮）
- inbox 用 `inboxStatusLabel`

- [ ] **Step 4: PASS + Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(wiki-ui): polish wiki page list and Chinese inbox statuses

EOF
)"
```

---

### Task 5: 详情侧滑（列表保留）

**Files:**
- Create: `WikiDetailDrawer.tsx`
- Modify: `WikiTab.tsx`, `WikiTab.css`, `PageSidebar.tsx`（可选：默认折叠反链摘要）
- Test: `WikiTab.test.tsx`

**Interfaces:**

```ts
{
  open: boolean
  page: WikiPageDetail | null
  isEditing: boolean
  // ...现有编辑 draft / handlers
  onClose: () => void
}
```

行为：
- `open` 时主区列表仍渲染；drawer `position: absolute; right: 0; width: min(70%, 100%)`；遮罩点击 / Esc / 关闭按钮 → `onClose` 且 `selectedPage` 可清空或保留选中（保留选中高亮，按 Figma）
- 内嵌现有 MDEditor + `LinkAutocomplete` + 拖拽上传逻辑（从 WikiTab 挪入 drawer）
- `PageSidebar` 放 drawer 底部折叠区：默认只显示「反链 · N」一行 +「展开」；展开后显示完整反链与修订

- [ ] **Step 1: Test**

```ts
it('打开页面后仍可见列表，并出现关闭', async () => {
  ;(window as any).electronAPI.agentRuntime.sendCommand = mockSendCommand({
    'wiki:page:list': [{
      id: 'p1', path: 'sources/a', category: 'sources', title: '架构', version: 1, updatedAt: Date.now(),
    }],
    'wiki:page:get': {
      id: 'p1', path: 'sources/a', category: 'sources', title: '架构',
      contentMd: '# hi', version: 1, updatedAt: Date.now(),
    },
    'wiki:link:backlinks': [],
    'wiki:page:revisions': [],
  })
  render(<WikiTab />)
  fireEvent.click(await screen.findByText('架构'))
  expect(await screen.findByRole('button', { name: '关闭' })).toBeInTheDocument()
  expect(screen.getByText('架构')).toBeInTheDocument() // 列表项仍在
})
```

- [ ] **Step 2: FAIL → Step 3 Implement → Step 4 PASS → Step 5 Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(wiki-ui): open wiki pages in a detail drawer over the list

EOF
)"
```

---

### Task 6: 任务 pill + 任务中心抽屉

**Files:**
- Create: `WikiTaskCenter.tsx`
- Modify: `WikiTopBar.tsx`, `WikiTab.tsx`, `WikiTab.css`, `useWikiTaskCenter.ts`
- Test: `WikiTab.test.tsx`, `useWikiTaskCenter.test.ts`

**Interfaces:**
- WikiTab 挂载 `useWikiTaskCenter`；mount 时 `listRuns()` → `mergeRuns`
- `rebuildIndex` / `autoRunSynthesis` / cleanup 批量操作 / graph bootstrap·extract 用 `wrapAsync`
- 归档：若暂无流式进度，inbox 有 pending 且最近有 running run 时显示不确定「归档中…」；有本地 `progress` 则显示分数（后续 IPC 增强再补，不在本计划强依赖）

任务中心 UI：
- 分段：进行中 / 最近完成 / 失败
- 打开时 `markFailuresSeen()`
- 失败可重试：调用原操作（重建再 `wrapAsync`；inbox 失败走现有 retry）
- 删除左栏「运行日志」相关旧视图与 `RunLogItem`（逻辑迁入 TaskCenter 展开明细）

- [ ] **Step 1: Tests**

```ts
it('点击更多重建索引后顶栏出现任务 pill', async () => {
  const send = mockSendCommand({
    'wiki:index:rebuild': { rebuiltCount: 3 },
  })
  // 让 rebuild 挂起以便看到 running pill
  let resolve!: (v: unknown) => void
  send.mockImplementation(async (cmd: { type: string }) => {
    if (cmd.type === 'wiki:index:rebuild') {
      return new Promise((r) => { resolve = r })
    }
    return mockSendCommand()(cmd)
  })
  ;(window as any).electronAPI.agentRuntime.sendCommand = send
  render(<WikiTab />)
  fireEvent.click(await screen.findByText('⋯ 更多'))
  fireEvent.click(screen.getByText('重建索引'))
  expect(await screen.findByText(/重建索引/)).toBeInTheDocument()
  resolve({ rebuiltCount: 3 })
})
```

（「更多」菜单若在 Task 7，本 Task 可先在测试里直接暴露临时按钮，或与 Task 7 合并提交——**推荐本 Task 先接 pill/drawer，重建入口暂留 TopBar 隐藏调试按钮，Task 7 再接到更多菜单并删调试入口**。）

更干净做法：**Task 6 与 Task 7 连续做完再测重建 pill**，本 Task 单测聚焦 TaskCenter 渲染 props：

```ts
it('任务中心按失败优先展示分段', () => {
  render(
    <WikiTaskCenter
      open
      tasks={[/* running + failed */]}
      onClose={() => {}}
      onRetry={() => {}}
      onDismiss={() => {}}
    />,
  )
  expect(screen.getByText('失败')).toBeInTheDocument()
  expect(screen.getByText('进行中')).toBeInTheDocument()
})
```

- [ ] **Step 2–5: 实现、PASS、Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(wiki-ui): add task progress pill and task center drawer

EOF
)"
```

---

### Task 7: ⋯ 更多菜单 + 工具全页接入

**Files:**
- Create: `WikiMoreMenu.tsx`
- Modify: `WikiTab.tsx`, `WikiTab.css`
- Test: `WikiTab.test.tsx`

**Interfaces:**

```ts
{
  open: boolean
  anchorRef?: React.RefObject<HTMLElement>
  onClose: () => void
  onCleanup: () => void
  onSynthesis: () => void
  onRebuild: () => void
}
```

- 菜单项旁短说明对齐 Figma
- `onCleanup` → `toolView = 'cleanup'`
- `onSynthesis` → `toolView = 'synthesis'`
- `onRebuild` → `taskCenter.wrapAsync('rebuild', '重建索引', rebuildIndex)`，不切全页
- 点击菜单外关闭

- [ ] **Step 1: Test 打开更多可见三项；点清理出现清理视图标题/控件**

- [ ] **Step 2–5: 实现、PASS、Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(wiki-ui): move cleanup synthesis rebuild behind more menu

EOF
)"
```

---

### Task 8: 图谱主区 + 节点开侧滑 + 长任务进任务中心

**Files:**
- Modify: `WikiGraphView.tsx`, `WikiTab.tsx`
- Test: `WikiGraphView.test.tsx` / `WikiTab.test.tsx`

**Interfaces:**
- `primaryNav === 'graph'` 时主区渲染 `WikiGraphView`
- `onOpenPage` → 打开 `WikiDetailDrawer`（底层保持图谱）
- `bootstrapEro` / `extractEro` 经 `wrapAsync('graph', ...)`
- 图谱页顶加轻量条：若有 kind=graph 的 running task，显示「运行中…」

- [ ] **Step 1: 扩展现有 WikiGraphView 测试或新增：触发 extract 时调用 onTaskStart（若通过 props 注入 wrap）**

更简单：WikiTab 包一层 props：

```ts
<WikiGraphView
  ...
  runLongTask={(title, fn) => taskCenter.wrapAsync('graph', title, fn)}
/>
```

- [ ] **Step 2–5: 实现、PASS、Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(wiki-ui): keep graph as primary nav and route long jobs to task center

EOF
)"
```

---

### Task 9: 样式对齐 Figma + 回归测试

**Files:**
- Modify: `WikiTab.css`（及各新组件若用 module/同文件）
- Modify: `WikiTab.test.tsx`（删掉所有「运行日志」旧用例，补齐主路径）
- Optional: 更新 `docs/design/记忆设计/2026-08-27-wiki-settings-ui-redesign.md` §9 标记「实现中/已完成」

样式清单：
- 列表行高 ~56–72px；摘要 `--color-text-tertiary`
- pill：`accent-soft` 底 + 主色字；error 红点
- drawer：左侧 1px border + 轻阴影；遮罩 `rgba(15,23,42,.28)`
- 窄宽：drawer 全宽（沿用现有 720px 断点约定）

- [ ] **Step 1: 跑全量相关测试**

```bash
pnpm --filter ./apps/windows exec vitest run src/test/components/WikiTab.test.tsx src/test/components/WikiGraphView.test.tsx src/test/components/wikiStatusLabels.test.ts src/test/components/useWikiTaskCenter.test.ts
pnpm --filter ./apps/windows lint
```

- [ ] **Step 2: 手动 checklist（对照成功标准）**

1. 左栏选资料 → 列表 → 点开侧滑 → 关闭仍在列表  
2. 待整理中文状态  
3. 更多 → 清理 / 综述进主区；重建出 pill  
4. 点 pill 开任务中心，失败段可见  
5. 图谱一级入口，点节点开侧滑  
6. 无英文 `pending`/`failed` 裸露  

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
style(wiki-ui): align wiki settings layout with redesign tokens

EOF
)"
```

---

## Spec Coverage Self-Check

| Spec 要求 | Task |
|---|---|
| 浏览优先分层 / 左栏 IA | 3, 7 |
| 详情侧滑、列表保留 | 5 |
| 顶栏 pill + 任务中心 | 2, 6 |
| 运行日志并入任务中心 | 6 |
| 更多菜单唯一工具入口 | 7 |
| 图谱一级 + 节点侧滑 | 8 |
| 中文状态 | 1, 4 |
| 空状态 | 4 |
| 同体系视觉 | 9 |
| 不改后端算法 / 其他 Tab | 全局约束 |

**刻意不做（YAGNI）：** 新 IPC 流式进度、批量待整理、清理/合成内部重做、暗色单独稿。

---

## Execution Handoff

Plan complete and saved to `docs/plans/记忆重构/2026-08-27-wiki-settings-ui-implementation.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — 每个 Task 派生子代理，Task 间复查  
2. **Inline Execution** — 本会话按 executing-plans 连续做，设检查点  

Which approach?
