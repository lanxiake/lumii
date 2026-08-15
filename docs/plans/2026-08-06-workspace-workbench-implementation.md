# Workspace Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Chat 页文件抽屉与版本面板收成共享 `WorkspaceWorkbench`，版本 Tab 改为 Cursor 式堆叠 Diff，并用 OID tree-walk + 按文件懒加载 hunks 消除 10s+「加载差异中…」。

**Architecture:** 先修 Main `WorkspaceVcs.diffCommits`（`git.walk` + TREE OID 剪枝）与 `diffFile` IPC；再扩 `useWorkspaceVcs`；最后用薄壳 `WorkspaceWorkbench` 挂载文件内容 + 新版版本 UI（`DiffFileCard` / `ChangedFilesRail`）。不动系统 git CLI。

**Tech Stack:** Electron IPC、isomorphic-git `walk`/`TREE`、`diff` 库、React 18、CSS Modules、lucide-react、vitest

**Spec:** `docs/plans/2026-08-06-workspace-workbench-design.md`

## Global Constraints

- 浅色主题保持暖奶油 `--mt-*`，不抄冷灰 IDE 底色
- 图标只用 lucide-react；新样式写 `--mt-*`
- 列表/打开更改/选历史：**禁止**一次 `withHunks: true` 全量 diff
- 不引入系统 `git` CLI；不做 staging checkbox / Push / blame
- `tsc --noEmit` 不新增 error（基线以改造前为准）
- 函数级中文注释；PowerShell 环境用 PowerShell 语法跑命令

## File Map

| 路径 | 职责 |
|------|------|
| `apps/windows/src/main/workspace-vcs/vcs-repo.ts` | OID walk `diffCommits`；新增 `diffFile` |
| `apps/windows/src/main/workspace-vcs/vcs-diff.ts` | 大文件截断常量与 `computeFileDiff` 上限 |
| `apps/windows/src/main/workspace-vcs/types.ts` | `truncated?` / `skipReason?` 可选字段 |
| `apps/windows/src/main/workspace-vcs/vcs-repo.test.ts` | 性能与 API 回归 |
| `apps/windows/src/main/index.ts` | `vcs:diffFile` handler |
| `apps/windows/src/preload/index.ts` | `ElectronAPI.vcs.diffFile` |
| `apps/windows/src/renderer/hooks/business/useWorkspaceVcs/*` | `diffList` / `diffFile`；废弃 UI 层全量 `diffWithHunks` |
| `apps/windows/src/renderer/styles/design-system.css` | `--mt-diff-add-bg` / `--mt-diff-del-bg` |
| `.../WorkspaceWorkbench/*` | 壳、tabs、宽度、Esc、快捷键 |
| `.../WorkspaceVersionPanel/*` | 更改/历史 + 堆叠 Diff |
| `.../DiffFileCard/*`、`ChangedFilesRail/*` | 可抽子组件 |
| `.../WorkspaceFilePanel/*` | 密度/搜索/键盘；可被壳嵌入 |
| `ChatPage.tsx` | `workbench: { open, tab }` 状态 |

---

### Task 1: OID-walk `diffCommits`（去掉全量 readBlob）

**Files:**
- Modify: `apps/windows/src/main/workspace-vcs/vcs-repo.ts`
- Modify: `apps/windows/src/main/workspace-vcs/vcs-repo.test.ts`
- Test: `npx vitest run src/main/workspace-vcs/vcs-repo.test.ts`（在 `apps/windows`）

**Interfaces:**
- Consumes: `git.walk`, `git.TREE`, existing `computeDiffStats` / `computeFileDiff`
- Produces: `diffCommits(fromOid, toOid, { withHunks?: boolean })` — 默认不带 hunks；仅对 OID 不同的 blob 读内容

- [ ] **Step 1: 写失败测试 — 大量未改文件时仍能快速列出单文件变更，且 `withHunks:false` 无 hunks**

在 `vcs-repo.test.ts` 追加：

```ts
it('diffCommits: OID 相同的未改文件不进入结果；默认无 hunks', async () => {
  await vcs.ensureInitialized()
  // 种 80 个稳定文件
  for (let i = 0; i < 80; i++) writeFile(`bulk/f-${i}.txt`, `stable-${i}\n`)
  const c1 = await vcs.commit({ author: 'user', message: 'bulk' })

  writeFile('only-change.md', 'v1\n')
  const c2 = await vcs.commit({ author: 'user', message: 'one file' })
  writeFile('only-change.md', 'v2\n')
  const c3 = await vcs.commit({ author: 'user', message: 'edit one' })

  const t0 = Date.now()
  const list = await vcs.diffCommits(c2!.oid, c3!.oid, { withHunks: false })
  const ms = Date.now() - t0

  expect(list).toHaveLength(1)
  expect(list[0].filepath).toBe('only-change.md')
  expect(list[0].hunks).toBeUndefined()
  expect(ms).toBeLessThan(2000) // 本地 CI 宽松上限；改造前会远超
})

it('diffCommits: withHunks true 时仅变更文件带 hunks', async () => {
  await vcs.ensureInitialized()
  writeFile('a.md', '1\n')
  const c1 = await vcs.commit({ author: 'user', message: 'a' })
  writeFile('a.md', '1\n2\n')
  writeFile('b.md', 'new\n')
  const c2 = await vcs.commit({ author: 'user', message: 'ab' })

  const diff = await vcs.diffCommits(c1!.oid, c2!.oid, { withHunks: true })
  expect(diff.length).toBe(2)
  for (const e of diff) {
    expect(e.hunks?.length).toBeGreaterThan(0)
  }
})
```

- [ ] **Step 2: 跑测试确认旧实现过慢或行为不符**

```powershell
cd apps/windows
npx vitest run src/main/workspace-vcs/vcs-repo.test.ts -t "OID 相同"
```

Expected: 时间断言 FAIL，或至少暴露全量扫描成本。

- [ ] **Step 3: 用 `git.walk` + TREE OID 剪枝重写 `diffCommits`**

替换 `diffCommits` 主体（保留方法签名）。关键逻辑：

```ts
async diffCommits(
  fromOid: string,
  toOid: string,
  opts?: { withHunks?: boolean },
): Promise<VcsDiffEntry[]> {
  const withHunks = opts?.withHunks === true
  const entries: VcsDiffEntry[] = []

  await git.walk({
    ...this.base,
    trees: [git.TREE({ ref: fromOid }), git.TREE({ ref: toOid })],
    map: async (filepath, [a, b]) => {
      if (filepath === '.') return
      const aType = a ? await a.type() : null
      const bType = b ? await b.type() : null
      // 两侧都是 tree 且 OID 相同 → 剪枝整棵子树
      if (aType === 'tree' || bType === 'tree') {
        if (a && b && (await a.oid()) === (await b.oid())) return null
        return undefined // 继续往下走
      }
      // blob（或一侧缺失）
      const aOid = a ? await a.oid() : null
      const bOid = b ? await b.oid() : null
      if (aOid === bOid) return undefined

      const status: VcsFileStatus = !a ? 'added' : !b ? 'deleted' : 'modified'
      const oldContent = a
        ? new TextDecoder().decode((await a.content()) ?? new Uint8Array())
        : ''
      const newContent = b
        ? new TextDecoder().decode((await b.content()) ?? new Uint8Array())
        : ''

      if (withHunks) {
        const d = computeFileDiff(filepath, oldContent, newContent)
        entries.push({
          filepath,
          status,
          insertions: d.insertions,
          deletions: d.deletions,
          hunks: d.hunks,
        })
      } else {
        const stats = computeDiffStats(oldContent, newContent)
        entries.push({ filepath, status, ...stats })
      }
      return undefined
    },
  })

  return entries
}
```

注意：`git` 默认导入若无命名导出 `TREE`/`walk`，改用：

```ts
import git, { TREE, walk } from 'isomorphic-git'
// walk({ ...this.base, trees: [TREE({ ref: fromOid }), TREE({ ref: toOid })], map: ... })
```

- [ ] **Step 4: 跑全文件测试通过**

```powershell
cd apps/windows
npx vitest run src/main/workspace-vcs/vcs-repo.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add apps/windows/src/main/workspace-vcs/vcs-repo.ts apps/windows/src/main/workspace-vcs/vcs-repo.test.ts
git commit -m "perf(vcs): diff commits via tree OID walk instead of full blob scan"
```

---

### Task 2: `diffFile` + 大文件防护

**Files:**
- Modify: `apps/windows/src/main/workspace-vcs/vcs-diff.ts`
- Modify: `apps/windows/src/main/workspace-vcs/types.ts`
- Modify: `apps/windows/src/main/workspace-vcs/vcs-repo.ts`
- Modify: `apps/windows/src/main/workspace-vcs/vcs-repo.test.ts`

**Interfaces:**
- Consumes: `readFileAt`, `computeFileDiff`
- Produces:
  - `MAX_DIFF_BYTES = 512_000`（约 512KB）
  - `diffFile(fromOid, toOid, filepath): Promise<VcsDiffEntry>`
  - `VcsDiffEntry.truncated?: boolean`；`skipReason?: string`

- [ ] **Step 1: 扩展类型**

```ts
// types.ts — VcsDiffEntry 追加
readonly truncated?: boolean
readonly skipReason?: string
```

- [ ] **Step 2: 写失败测试**

```ts
it('diffFile: 返回单文件 hunks', async () => {
  await vcs.ensureInitialized()
  writeFile('x.md', 'a\n')
  const c1 = await vcs.commit({ author: 'user', message: '1' })
  writeFile('x.md', 'a\nb\n')
  const c2 = await vcs.commit({ author: 'user', message: '2' })
  const one = await vcs.diffFile(c1!.oid, c2!.oid, 'x.md')
  expect(one.filepath).toBe('x.md')
  expect(one.hunks!.length).toBeGreaterThan(0)
})

it('diffFile: 超大文件标记 truncated 且不抛错', async () => {
  await vcs.ensureInitialized()
  const big = 'x'.repeat(600_000) + '\n'
  writeFile('big.txt', big)
  const c1 = await vcs.commit({ author: 'user', message: 'big1' })
  writeFile('big.txt', big + 'y\n')
  const c2 = await vcs.commit({ author: 'user', message: 'big2' })
  const one = await vcs.diffFile(c1!.oid, c2!.oid, 'big.txt')
  expect(one.truncated).toBe(true)
  expect(one.hunks ?? []).toEqual([])
})
```

- [ ] **Step 3: 实现 `diffFile` 与上限**

在 `vcs-diff.ts`：

```ts
/** 单文件参与行级 diff 的最大字节数（任一侧） */
export const MAX_DIFF_BYTES = 512_000
```

在 `vcs-repo.ts`：

```ts
/**
 * 单文件逐行 diff。任一侧超过 MAX_DIFF_BYTES 则返回 truncated，不跑 Myers。
 * fromOid/toOid 可为 commit oid；一侧不存在视为空内容。
 */
async diffFile(fromOid: string, toOid: string, filepath: string): Promise<VcsDiffEntry> {
  const oldContent = (await this.readFileAt(fromOid, filepath)) ?? ''
  const newContent = (await this.readFileAt(toOid, filepath)) ?? ''
  const status: VcsFileStatus =
    oldContent === '' && newContent !== ''
      ? 'added'
      : newContent === '' && oldContent !== ''
        ? 'deleted'
        : 'modified'

  if (
    Buffer.byteLength(oldContent, 'utf8') > MAX_DIFF_BYTES ||
    Buffer.byteLength(newContent, 'utf8') > MAX_DIFF_BYTES
  ) {
    return {
      filepath,
      status,
      insertions: 0,
      deletions: 0,
      hunks: [],
      truncated: true,
      skipReason: '文件过大，已跳过逐行差异',
    }
  }

  const d = computeFileDiff(filepath, oldContent, newContent)
  return {
    filepath,
    status,
    insertions: d.insertions,
    deletions: d.deletions,
    hunks: d.hunks,
  }
}
```

- [ ] **Step 4: 跑测试**

```powershell
cd apps/windows
npx vitest run src/main/workspace-vcs/vcs-repo.test.ts -t "diffFile"
```

Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add apps/windows/src/main/workspace-vcs/
git commit -m "feat(vcs): add per-file diffFile with size guard"
```

---

### Task 3: IPC + preload + `useWorkspaceVcs`

**Files:**
- Modify: `apps/windows/src/main/index.ts`（`vcs:diff` 旁新增 `vcs:diffFile`）
- Modify: `apps/windows/src/preload/index.ts`（类型 + `invoke`）
- Modify: `apps/windows/src/renderer/hooks/business/useWorkspaceVcs/useWorkspaceVcs.ts`

**Interfaces:**
- Produces（preload）:
  - `vcs.diffFile(opts: { fromOid: string; toOid: string; filepath: string })`
- Produces（hook）:
  - `diffList(fromOid, toOid)` → `diff({ withHunks: false })`
  - `diffFile(fromOid, toOid, filepath)`
  - 保留 `diffWithHunks` 但实现改为：先 `diffList`，再对每个文件 `diffFile`（**仅测试兼容**；UI 不得再调用它拉历史）

- [ ] **Step 1: Main handler**

```ts
ipcMain.handle(
  'vcs:diffFile',
  async (_event, opts: { fromOid: string; toOid: string; filepath: string }) => {
    try {
      const repo = getWorkspaceVcs(getWorkspaceDir())
      const entry = await repo.diffFile(opts.fromOid, opts.toOid, opts.filepath)
      return { success: true, data: entry }
    } catch (err) {
      vcsWarn(`diffFile 失败: ${err instanceof Error ? err.message : String(err)}`)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
)
```

- [ ] **Step 2: Preload — `ElectronAPI.vcs` 类型与实现同步加 `diffFile`**

```ts
diffFile: (opts: { fromOid: string; toOid: string; filepath: string }) =>
  ipcRenderer.invoke('vcs:diffFile', opts),
```

- [ ] **Step 3: Hook 扩展**

```ts
const diffList = useCallback(async (fromOid: string, toOid: string) => {
  if (!VCS) return []
  const res = await VCS.diff({ fromOid, toOid, withHunks: false })
  if (res.success && res.data) return res.data as VcsDiffItem[]
  return []
}, [])

const diffFile = useCallback(async (fromOid: string, toOid: string, filepath: string) => {
  if (!VCS) return null
  const res = await (VCS as any).diffFile({ fromOid, toOid, filepath })
  if (res.success && res.data) return res.data as VcsDiffItem
  return null
}, [])
```

把 `diffList` / `diffFile` 加入 return；`VCS` 类型声明同步加 `diffFile`。

- [ ] **Step 4: 手动冒烟（dev）** — 可选；至少保证 preload 类型无红线

- [ ] **Step 5: Commit**

```powershell
git add apps/windows/src/main/index.ts apps/windows/src/preload/index.ts apps/windows/src/renderer/hooks/business/useWorkspaceVcs/
git commit -m "feat(vcs): expose diffFile IPC and hook helpers for lazy hunks"
```

---

### Task 4: Diff 语义 token

**Files:**
- Modify: `apps/windows/src/renderer/styles/design-system.css`

- [ ] **Step 1: 深色块追加**

```css
--mt-diff-add-bg: color-mix(in srgb, var(--mt-success) 18%, transparent);
--mt-diff-del-bg: color-mix(in srgb, var(--mt-error) 16%, transparent);
```

- [ ] **Step 2: 浅色块（`[data-theme="light"]`）追加同名，可略降透明度（如 14% / 12%）**

- [ ] **Step 3: Commit**

```powershell
git add apps/windows/src/renderer/styles/design-system.css
git commit -m "style: add mt-diff-add/del background tokens"
```

---

### Task 5: `DiffFileCard` + `ChangedFilesRail`

**Files:**
- Create: `apps/windows/src/renderer/pages/ChatPage/components/WorkspaceVersionPanel/DiffFileCard.tsx`
- Create: `apps/windows/src/renderer/pages/ChatPage/components/WorkspaceVersionPanel/DiffFileCard.module.css`
- Create: `apps/windows/src/renderer/pages/ChatPage/components/WorkspaceVersionPanel/ChangedFilesRail.tsx`
- Create: `apps/windows/src/renderer/pages/ChatPage/components/WorkspaceVersionPanel/ChangedFilesRail.module.css`

**Interfaces:**
- `DiffFileCardProps`: `{ entry: VcsDiffItem; hunks?: VcsDiffHunk[]; loading?: boolean; truncated?: boolean; skipReason?: string; onRevert?: () => void; onRevealInFiles?: () => void; id?: string }`
- `ChangedFilesRailProps`: `{ files: VcsDiffItem[]; activePath?: string; onSelect: (filepath: string) => void }`

- [ ] **Step 1: 实现 `ChangedFilesRail`** — 200px 宽，行 28px，`+n −m`，激活左边 2px accent；纯展示

- [ ] **Step 2: 实现 `DiffFileCard`**
  - 头：路径 truncate、状态、`+n −m`、Undo（lucide `Undo2`）、可选「在文件中显示」（`FolderOpen`）
  - 体：`loading` → skeleton；`truncated` → 提示文案；否则渲染 hunks
  - 连续 context 行（前缀空格）可折叠为 `N unmodified lines`（客户端折叠即可）
  - 行样式：`background: var(--mt-diff-add-bg)` / `var(--mt-diff-del-bg)`

- [ ] **Step 3: Commit**

```powershell
git add apps/windows/src/renderer/pages/ChatPage/components/WorkspaceVersionPanel/
git commit -m "feat(ui): add DiffFileCard and ChangedFilesRail for stacked diffs"
```

---

### Task 6: `WorkspaceWorkbench` 壳 + ChatPage 状态

**Files:**
- Create: `apps/windows/src/renderer/pages/ChatPage/components/WorkspaceWorkbench/index.tsx`
- Create: `apps/windows/src/renderer/pages/ChatPage/components/WorkspaceWorkbench/WorkspaceWorkbench.module.css`
- Modify: `apps/windows/src/renderer/pages/ChatPage/ChatPage.tsx`

**Interfaces:**
- `WorkbenchTab = 'files' | 'vcs'`
- `WorkspaceWorkbenchProps`: `{ open: boolean; tab: WorkbenchTab; onTabChange: (t: WorkbenchTab) => void; onClose: () => void; uncommittedCount: number; locateTarget?: ...; childrenFiles: ReactNode; childrenVcs: ReactNode }`
- ChatPage: `workbench: { open: boolean; tab: WorkbenchTab }` 替代双 boolean

- [ ] **Step 1: 壳 UI**
  - 无全屏遮罩；玻璃底；header tabs「文件|版本」；角标；刷新/关闭
  - 宽度：`files` 280px / `vcs` 760px，`transition: width, transform`
  - `Esc` → `onClose`（`useEffect` keydown，忽略输入框聚焦）
  - `1`/`2` 切 tab（同样忽略 INPUT/TEXTAREA/contentEditable）

- [ ] **Step 2: 重构 ChatPage 工具栏**

```ts
const [workbench, setWorkbench] = useState<{ open: boolean; tab: 'files' | 'vcs' }>({
  open: false,
  tab: 'files',
})

const toggleFiles = () =>
  setWorkbench((w) =>
    w.open && w.tab === 'files' ? { ...w, open: false } : { open: true, tab: 'files' },
  )
const toggleVcs = () =>
  setWorkbench((w) =>
    w.open && w.tab === 'vcs' ? { ...w, open: false } : { open: true, tab: 'vcs' },
  )
```

`@` 定位：`setWorkbench({ open: true, tab: 'files' })` + 现有 `locateFileTarget`。

- [ ] **Step 3: 先把现有 FilePanel / VersionPanel 作为 children 塞进壳（功能不回退）**，VersionPanel 去掉自己的 overlay

- [ ] **Step 4: Commit**

```powershell
git add apps/windows/src/renderer/pages/ChatPage/
git commit -m "feat(ui): add WorkspaceWorkbench shell and unify Chat panel state"
```

---

### Task 7: 版本 Tab — 更改/历史堆叠 Diff + 懒加载 hunks

**Files:**
- Rewrite: `WorkspaceVersionPanel.tsx` + `.module.css`（作为壳内 vcs 内容，无 portal overlay）
- Modify: `useWorkspaceVcs` 使用处

**Interfaces:**
- Subnav: `'changes' | 'history'`
- 更改：`statusDiff` 列表 → 卡片；对视口内路径并发 `diffFile('HEAD' 等价, WORKTREE?)`
  - 未提交：`fromOid='HEAD'`，内容侧用现有 `readFileAt('HEAD')` + 工作区——若 `diffFile` 只支持两 commit，则：
    - **方案 A（推荐）:** 扩展 `diffFile` 支持 `toOid: 'WORKTREE'`（`readWorktreeFile`）
    - 在 Task 2 未做则本 Task 补上并加测试
- 历史：点选 commit → `diffList(parentOid, oid)` 秒开列表 → 懒加载 `diffFile(parent, oid, path)`
- 禁止调用旧的一次 `diffWithHunks(parent, oid)` 填整页

- [ ] **Step 1: 扩展 `diffFile` 支持 `toOid === 'WORKTREE'`（若尚未）**

```ts
const newContent =
  toOid === 'WORKTREE'
    ? this.readWorktreeFile(filepath)
    : (await this.readFileAt(toOid, filepath)) ?? ''
```

- [ ] **Step 2: 重写 Version 面板布局**（对齐规格 §2.2 / §3）
  - Subnav + 汇总 `+N −M` +「保存版本」
  - 主区堆叠 `DiffFileCard` + 右栏 `ChangedFilesRail`
  - 历史时间线（无 emoji）+ 回滚 ConfirmModal
  - hunks：`IntersectionObserver` 或挂载时对前 5 个文件 `diffFile`，其余进入视口再拉；concurrency ≤ 4
  - 缓存：`Map<`${from}:${to}:${path}`, VcsDiffItem>`

- [ ] **Step 3: 「在文件中显示」回调到 ChatPage → `workbench.tab='files'` + locate**

- [ ] **Step 4: 手动验收**
  - 选历史版本：列表 <1s 可见，无整页「加载差异中…」
  - 单卡 hunks 随后出现
  - 保存 / 撤销 / 回滚仍可用

- [ ] **Step 5: Commit**

```powershell
git add apps/windows/src/main/workspace-vcs/ apps/windows/src/renderer/pages/ChatPage/components/WorkspaceVersionPanel/ apps/windows/src/renderer/hooks/business/useWorkspaceVcs/
git commit -m "feat(ui): stacked lazy diffs for workspace version tab"
```

---

### Task 8: 文件 Tab 密度与键盘 + 收尾

**Files:**
- Modify: `WorkspaceFilePanel/*`、`FileTree.module.css`、`FileSearchBar`
- Modify: `WorkspaceWorkbench` 若需把刷新接到 FilePanel

- [ ] **Step 1: 搜索置顶 sticky；树行高 ~26px；hover 才出操作钮；lucide 替换内联 SVG**

- [ ] **Step 2: 树键盘** — 容器 `tabIndex={0}`：`ArrowUp/Down`、`Enter`、`/` 聚焦搜索（在 FileTree 或 FilePanel 内实现最小可用）

- [ ] **Step 3: 定位高亮 1.2s（若已有则对齐 token）**

- [ ] **Step 4: 全量手测清单（规格 §5）+ `npx vitest run src/main/workspace-vcs/vcs-repo.test.ts`

- [ ] **Step 5: Commit**

```powershell
git add apps/windows/src/renderer/pages/ChatPage/components/WorkspaceFilePanel/ apps/windows/src/renderer/pages/ChatPage/components/WorkspaceWorkbench/
git commit -m "feat(ui): densify file tab and add tree keyboard shortcuts"
```

---

## Spec Coverage Checklist

| 规格项 | Task |
|--------|------|
| 共享壳 / 互斥 / 宽度 / 无遮罩 / Esc | 6 |
| 文件密度 / 搜索 / 键盘 / `@` 定位 | 6, 8 |
| 更改堆叠 Diff + 右栏 | 5, 7 |
| 历史时间线 + 回滚 | 7 |
| 懒加载 hunks / 禁全量 withHunks | 1–3, 7 |
| OID walk 性能 | 1 |
| diffFile + 大文件截断 | 2, 7 |
| `--mt-diff-*` token | 4 |
| 在文件中显示 | 7 |
| `1`/`2`/`Ctrl+S` | 6, 7 |
| 不做 staging/Push/blame/角标 | 全局遵守 |

## Self-Review Notes

- 无 TBD；未提交 Diff 依赖 Task 7 的 `WORKTREE` 扩展（写明在 Task 7 Step 1）
- `diffWithHunks` 保留但 UI 禁用全量路径，避免其它调用方骤断
- 组件名与规格一致：`WorkspaceWorkbench` / `DiffFileCard` / `ChangedFilesRail`
