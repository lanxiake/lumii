# 项目级 Git 集成 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为挂载到 `workspace/projects/` 的用户项目提供只读 Git 状态展示：分支/ahead-behind/远程内联于项目列表，文件树标记 U/M 徽标与文件夹聚合圆点；同时用显式规则替代隐式的 junction 跳过行为，保证工作空间 VCS 与项目 Git 完全隔离。

**Architecture:** Task 1 修 `vcs-ignore.ts` + `vcs-repo.ts` 加显式隔离规则；Task 2 新建 `apps/windows/src/main/project-git/` 服务目录（`types.ts` / `git-cli.ts` / `project-git-status.ts`）；Task 3 接 IPC（main handler + preload）；Task 4 写 renderer hook；Task 5 改 `ProjectsSection.tsx`；Task 6 改 `FileTree.tsx`。

**Tech Stack:** Electron IPC、Node.js `execFile`（无 shell）、React 18、CSS Modules、CSS Variables（`--color-success/warning/error`）、vitest

**Spec:** `docs/plans/2026-08-10-project-git-integration-design.md`

## Global Constraints

- 所有 `execFile('git', ...)` 的 `cwd` 必须传 `project.realPath`，禁止传 junction 路径
- git 输出路径统一转 POSIX 分隔后再与文件树路径比对
- 不做任何写操作（切换/提交/push/pull）—— 本期只读
- 不引入新的 npm 依赖（Node.js `execFile` 已够用）
- `tsc --noEmit` 不新增 error
- 新 IPC 通道需同步三处：main handler、preload 类型+实现、renderer 调用点
- 代码注释以中文为主，沿用项目风格

## File Map

| 路径 | 职责 |
|------|------|
| `apps/windows/src/main/workspace-vcs/vcs-ignore.ts` | 显式加入 `projects/` 忽略规则 |
| `apps/windows/src/main/workspace-vcs/vcs-repo.ts` | `walkWorktreeFiles` 根层显式跳过 `projects` |
| `apps/windows/src/main/project-git/types.ts` | `ProjectGitStatus` 接口定义 |
| `apps/windows/src/main/project-git/git-cli.ts` | `execFile` 包装，`isGitAvailable()` + `runGit()` |
| `apps/windows/src/main/project-git/project-git-status.ts` | `getProjectGitStatus(realPath)` 实现 |
| `apps/windows/src/main/project-git/project-git-status.test.ts` | 单元测试（用真实 git CLI）|
| `apps/windows/src/main/index.ts` | `app:getProjectGitStatus` IPC handler |
| `apps/windows/src/preload/index.ts` | `ElectronAPI.projectGit.status` 类型+实现 |
| `apps/windows/src/renderer/hooks/business/useProjectGitStatus/useProjectGitStatus.ts` | renderer hook |
| `apps/windows/src/renderer/hooks/business/useProjectGitStatus/index.ts` | 导出 |
| `apps/windows/src/renderer/pages/ChatPage/components/WorkspaceFilePanel/ProjectsSection.tsx` | 分支/远程内联展示 |
| `apps/windows/src/renderer/pages/ChatPage/components/WorkspaceFilePanel/ProjectsSection.module.css` | 徽标样式 |
| `apps/windows/src/renderer/pages/ChatPage/components/WorkspaceFilePanel/FileTree.tsx` | `gitStatus` prop + 徽标渲染 |
| `apps/windows/src/renderer/pages/ChatPage/components/WorkspaceFilePanel/FileTree.module.css` | 状态徽标样式 |

---

### Task 1: 工作空间 VCS 显式隔离 `projects/`

**Files:**
- Modify: `apps/windows/src/main/workspace-vcs/vcs-ignore.ts`
- Modify: `apps/windows/src/main/workspace-vcs/vcs-repo.ts`

**Interfaces:**
- Consumes: 现有 `DEFAULT_VCS_IGNORE_RULES`、`walkWorktreeFiles()`
- Produces: `projects/` 目录在任何工作区路径下都被跳过，无论是 junction 还是真实目录

- [ ] **Step 1: 在 `vcs-ignore.ts` 的 `DEFAULT_VCS_IGNORE_RULES` 末尾加入 `projects/`**

打开 `apps/windows/src/main/workspace-vcs/vcs-ignore.ts`，在 `DEFAULT_VCS_IGNORE_RULES` 数组末尾追加：

```ts
'projects/',   // 挂载的用户项目，由项目自身 .git 管理，不纳入工作空间快照
```

- [ ] **Step 2: 在 `vcs-repo.ts` 的 `walkWorktreeFiles()` 根层显式跳过 `projects`**

在 `vcs-repo.ts:133-156` 的 `walkWorktreeFiles` 中，遍历根目录条目时，于现有类型判断之前加一道根层守卫：

```ts
// 根层跳过挂载项目目录，不依赖 junction Dirent 类型的隐式行为
if (depth === 0 && entry.name === 'projects') continue
```

`depth` 参数需在递归调用时从 `0` 起传入（若函数当前没有 depth 参数则新增，默认 `0`，递归调用时 `depth + 1`，只有 `depth === 0` 时才做这个剪枝）。

- [ ] **Step 3: 验证**

```bash
# 在 apps/windows 目录
npx vitest run src/main/workspace-vcs
```

确认现有测试全部通过，无回归。

---

### Task 2: 新建 `project-git` 服务

**Files:**
- Create: `apps/windows/src/main/project-git/types.ts`
- Create: `apps/windows/src/main/project-git/git-cli.ts`
- Create: `apps/windows/src/main/project-git/project-git-status.ts`
- Create: `apps/windows/src/main/project-git/project-git-status.test.ts`

**Interfaces:**
- Produces: `getProjectGitStatus(realPath: string): Promise<ProjectGitStatus>`

- [ ] **Step 1: 新建 `types.ts`**

```ts
export interface ProjectGitStatusFile {
  /** 相对项目根的路径，POSIX 分隔符 */
  path: string
  /** 索引状态：' '|'M'|'A'|'D'|'R'|'C'|'U'|'?' */
  index: string
  /** 工作区状态，同上 */
  worktree: string
}

export interface ProjectGitStatus {
  /** 系统是否安装了 git */
  available: boolean
  /** realPath 下是否有 .git */
  isRepo: boolean
  branch?: string
  ahead?: number
  behind?: number
  remoteUrl?: string
  files: ProjectGitStatusFile[]
}
```

- [ ] **Step 2: 新建 `git-cli.ts`**

使用 `execFile`（不经过 shell），`cwd` 必须为 `realPath`：

```ts
import { execFile } from 'child_process'

let _gitAvailable: boolean | undefined

export async function isGitAvailable(): Promise<boolean> {
  if (_gitAvailable !== undefined) return _gitAvailable
  return new Promise((resolve) => {
    execFile('git', ['--version'], (err) => {
      _gitAvailable = !err
      resolve(_gitAvailable)
    })
  })
}

export function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (err, stdout) => {
      if (err) { reject(err); return }
      resolve(stdout as string)
    })
  })
}
```

- [ ] **Step 3: 新建 `project-git-status.ts`**

实现 `getProjectGitStatus(realPath)`，调用两条 git 命令：

1. `git status --porcelain=v1 -z --branch -unormal` —— 一次性获取分支/ahead/behind/文件状态
2. `git remote get-url origin` —— 获取远程 URL（失败则 `remoteUrl` 留 `undefined`，不抛错）

解析逻辑要点：
- `-z` 分隔符是 `\0`，用 `output.split('\0')` 分割
- 第一行格式：`## branch...remote [ahead N] [behind N]` 或 `## HEAD (no branch)` 或 `## No commits yet on main`
- 文件行：前两字符为 `index`/`worktree` 状态，第三字符为空格，其后为路径
- 路径统一 `.replace(/\\/g, '/')` 转 POSIX

错误处理：
- `git` 命令因「不是 git 仓库」返回非零退出码 → `isRepo: false`，`files: []`
- `git` 未安装 → `available: false`，`isRepo: false`，`files: []`

- [ ] **Step 4: 写测试 `project-git-status.test.ts`**

使用真实 git CLI（`execFile`），在 `tmp` 目录下初始化一个真实 git 仓库：

```ts
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getProjectGitStatus } from './project-git-status'

describe('getProjectGitStatus', () => {
  let repoDir: string

  beforeAll(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lumii-git-test-'))
    execFileSync('git', ['init'], { cwd: repoDir })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir })
    writeFileSync(join(repoDir, 'a.ts'), 'const a = 1\n')
    execFileSync('git', ['add', '.'], { cwd: repoDir })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir })
  })

  afterAll(() => { rmSync(repoDir, { recursive: true, force: true }) })

  it('能识别 git 仓库并返回分支名', async () => {
    const status = await getProjectGitStatus(repoDir)
    expect(status.available).toBe(true)
    expect(status.isRepo).toBe(true)
    expect(status.branch).toBeTruthy()
    expect(status.files).toEqual([])
  })

  it('修改文件后 files 含 M 条目', async () => {
    writeFileSync(join(repoDir, 'a.ts'), 'const a = 2\n')
    const status = await getProjectGitStatus(repoDir)
    const modified = status.files.find(f => f.path === 'a.ts')
    expect(modified).toBeTruthy()
    expect(modified!.worktree).toBe('M')
    // 恢复
    writeFileSync(join(repoDir, 'a.ts'), 'const a = 1\n')
  })

  it('非 git 目录返回 isRepo false', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'not-git-'))
    try {
      const status = await getProjectGitStatus(tmp)
      expect(status.isRepo).toBe(false)
      expect(status.files).toEqual([])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 5: 运行测试，确保全部通过**

```bash
# 在 apps/windows 目录（或 repo 根目录）
npx vitest run src/main/project-git/project-git-status.test.ts
```

---

### Task 3: IPC 接入

**Files:**
- Modify: `apps/windows/src/main/index.ts`
- Modify: `apps/windows/src/preload/index.ts`

**Interfaces:**
- 通道名：`app:getProjectGitStatus`
- 入参：`projectName: string`
- 返参：`ProjectGitStatus`

- [ ] **Step 1: 在 `main/index.ts` 注册 handler**

在现有 `ipcMain.handle('app:...')` 区域附近追加（通过 `configManager.getAppConfig().codingDevProjects` 查 `realPath`）：

```ts
ipcMain.handle('app:getProjectGitStatus', async (_event, projectName: string) => {
  const projects = configManager.getAppConfig().codingDevProjects ?? []
  const project = projects.find(p => p.name === projectName)
  if (!project) return { available: false, isRepo: false, files: [] }
  return getProjectGitStatus(project.realPath)
})
```

在文件顶部加对应 import：
```ts
import { getProjectGitStatus } from './project-git/project-git-status'
```

- [ ] **Step 2: 在 `preload/index.ts` 的 `ElectronAPI` 中添加 `projectGit` 命名空间**

在 `ElectronAPI` 类型定义中添加：

```ts
projectGit: {
  status(projectName: string): Promise<ProjectGitStatus>
}
```

在 contextBridge 暴露的对象中添加实现：

```ts
projectGit: {
  status: (projectName: string) => ipcRenderer.invoke('app:getProjectGitStatus', projectName),
},
```

同时在 preload 顶部补充 import（或 inline type，视现有 preload 风格而定）：

```ts
import type { ProjectGitStatus } from '../main/project-git/types'
```

- [ ] **Step 3: 类型检查**

```bash
pnpm typecheck
```

确认 `tsc --noEmit` 无新增 error。

---

### Task 4: Renderer hook `useProjectGitStatus`

**Files:**
- Create: `apps/windows/src/renderer/hooks/business/useProjectGitStatus/useProjectGitStatus.ts`
- Create: `apps/windows/src/renderer/hooks/business/useProjectGitStatus/index.ts`

**Interfaces:**
- Consumes: `window.electronAPI.projectGit.status(projectName)`
- Produces: `{ status: ProjectGitStatus | null; loading: boolean; refresh(): void }`

- [ ] **Step 1: 新建 hook**

参照项目中 `useCodingDevProjects` 的 hook 风格（`useState` + `useEffect` + `useCallback`）：

```ts
import { useState, useEffect, useCallback } from 'react'
import type { ProjectGitStatus } from '@main/project-git/types'

export function useProjectGitStatus(projectName: string | null) {
  const [status, setStatus] = useState<ProjectGitStatus | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!projectName) { setStatus(null); return }
    setLoading(true)
    try {
      const result = await window.electronAPI.projectGit.status(projectName)
      setStatus(result)
    } finally {
      setLoading(false)
    }
  }, [projectName])

  useEffect(() => { refresh() }, [refresh])

  return { status, loading, refresh }
}
```

- [ ] **Step 2: 新建 `index.ts` 导出**

```ts
export { useProjectGitStatus } from './useProjectGitStatus'
```

---

### Task 5: `ProjectsSection.tsx` — 分支/远程内联展示

**Files:**
- Modify: `apps/windows/src/renderer/pages/ChatPage/components/WorkspaceFilePanel/ProjectsSection.tsx`
- Modify: `apps/windows/src/renderer/pages/ChatPage/components/WorkspaceFilePanel/ProjectsSection.module.css`

**Interfaces:**
- Consumes: `useProjectGitStatus(project.name)`
- Produces: 每个项目行末显示 `main ↑2 ↓1 · origin`，或「无 Git」弱化文字

**目标效果：**
```
lumii   链接  活动   main ↑2      github.com/...
Clawith 链接        dev
lumo    链接        无 Git
```

- [ ] **Step 1: 新增子组件 `ProjectGitInfo`（在 `ProjectsSection.tsx` 文件内）**

```tsx
function ProjectGitInfo({ projectName }: { projectName: string }) {
  const { status } = useProjectGitStatus(projectName)
  if (!status || !status.available || !status.isRepo) {
    return <span className={styles.gitNone}>无 Git</span>
  }
  return (
    <span className={styles.gitInfo}>
      <span className={styles.gitBranch}>{status.branch}</span>
      {!!status.ahead && <span className={styles.gitAhead}>↑{status.ahead}</span>}
      {!!status.behind && <span className={styles.gitBehind}>↓{status.behind}</span>}
      {status.remoteUrl && (
        <span className={styles.gitRemote} title={status.remoteUrl}>
          {extractHost(status.remoteUrl)}
        </span>
      )}
    </span>
  )
}

function extractHost(url: string): string {
  try { return new URL(url).hostname } catch { return url.split('/')[0] }
}
```

- [ ] **Step 2: 在项目行 JSX 中追加 `<ProjectGitInfo>`**

在 `ProjectsSection.tsx:124` 附近的 `{p.isExternal && <span className={styles.badge}>链接</span>}` 之后追加：

```tsx
<ProjectGitInfo projectName={p.name} />
```

- [ ] **Step 3: 在 `ProjectsSection.module.css` 新增样式**

```css
.gitInfo {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  margin-left: 6px;
}

.gitBranch {
  color: var(--color-text-secondary);
}

.gitAhead {
  color: var(--color-success);
}

.gitBehind {
  color: var(--color-warning);
}

.gitRemote {
  color: var(--color-text-tertiary);
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gitNone {
  font-size: 11px;
  color: var(--color-text-tertiary);
  margin-left: 6px;
  opacity: 0.6;
}
```

- [ ] **Step 4: 类型检查 + 目视验证（dev 模式下打开项目列表）**

```bash
pnpm typecheck
```

---

### Task 6: `FileTree.tsx` — 文件状态徽标

**Files:**
- Modify: `apps/windows/src/renderer/pages/ChatPage/components/WorkspaceFilePanel/FileTree.tsx`
- Modify: `apps/windows/src/renderer/pages/ChatPage/components/WorkspaceFilePanel/FileTree.module.css`

**Interfaces:**
- Consumes: `useProjectGitStatus`（在文件树根节点调用）
- Produces: 文件行末 `M`（橙）/ `U`（绿）徽标；文件夹行末 `●` 聚合圆点

**路径比对约定：** `FileItem.path` 是绝对路径，需减去 `realPath` 前缀并转 POSIX，才能与 `ProjectGitStatus.files[].path` 匹配。

- [ ] **Step 1: 确定 `gitStatus` 来源 —— 在 `FileTree` 顶层调用 hook**

在 `FileTree` 组件内（非子组件内），根据 `props.rootPath` 判断是否落在某个 project 下：

```ts
const projects = useCodingDevProjects()  // 复用现有 hook，已有实例则直接调
const activeProject = projects.find(p => rootPath?.startsWith(p.realPath))
const { status: gitStatus } = useProjectGitStatus(activeProject?.name ?? null)
```

将 `gitStatus?.files` 转为 `Map<string, { index: string; worktree: string }>`，key 为相对路径（POSIX）：

```ts
const gitMap = useMemo<Map<string, { index: string; worktree: string }>>(() => {
  if (!gitStatus?.files || !activeProject) return new Map()
  return new Map(gitStatus.files.map(f => [f.path, { index: f.index, worktree: f.worktree }]))
}, [gitStatus, activeProject])
```

- [ ] **Step 2: 向 `FileTreeNode` 传递 `gitMap` + `projectRealPath`**

在 `FileTreeNode` props 接口中新增：

```ts
gitMap?: Map<string, { index: string; worktree: string }>
projectRealPath?: string
```

`FileTree.tsx:246` 处的递归调用，连同顶层调用，都补传这两个 prop。

- [ ] **Step 3: 在 `FileTreeNode` 内计算并渲染徽标**

路径转换（相对路径 POSIX）：

```ts
const relPath = projectRealPath && item.path.startsWith(projectRealPath)
  ? item.path.slice(projectRealPath.length).replace(/\\/g, '/').replace(/^\//, '')
  : null
```

取文件状态：

```ts
const fileGit = relPath ? gitMap?.get(relPath) : undefined
const gitChar = fileGit ? resolveGitChar(fileGit) : undefined  // 'M' | 'U' | '!!' | undefined
```

`resolveGitChar` 辅助函数（在文件顶部定义）：
```ts
function resolveGitChar(s: { index: string; worktree: string }): 'conflict' | 'modified' | 'untracked' | undefined {
  if (s.index === 'U' || s.worktree === 'U' || (s.index === 'A' && s.worktree === 'A')) return 'conflict'
  if (s.index === '?' && s.worktree === '?') return 'untracked'
  if (s.worktree === 'M' || s.index === 'M') return 'modified'
  if (s.index === 'A') return 'untracked'
  return undefined
}
```

在文件夹节点，从子树 `gitMap` 中取所有以 `relPath + '/'` 开头的条目，聚合出最高优先级（冲突 > 修改 > 未跟踪）用于圆点。

在 `styles.name`（`FileTree.tsx:216`）之后，追加：

```tsx
{item.type === 'file' && gitChar && (
  <span className={styles[`git_${gitChar}`]}>
    {gitChar === 'conflict' ? '!!' : gitChar === 'modified' ? 'M' : 'U'}
  </span>
)}
{item.type === 'directory' && folderGitChar && (
  <span className={styles[`git_dot_${folderGitChar}`]}>●</span>
)}
```

- [ ] **Step 4: 在 `FileTree.module.css` 新增样式**

```css
.git_untracked   { font-size: 10px; font-weight: 600; color: var(--color-success); margin-left: 4px; }
.git_modified    { font-size: 10px; font-weight: 600; color: var(--color-warning); margin-left: 4px; }
.git_conflict    { font-size: 10px; font-weight: 600; color: var(--color-error);   margin-left: 4px; }
.git_dot_untracked  { font-size: 8px; color: var(--color-success); margin-left: 4px; }
.git_dot_modified   { font-size: 8px; color: var(--color-warning); margin-left: 4px; }
.git_dot_conflict   { font-size: 8px; color: var(--color-error);   margin-left: 4px; }
```

- [ ] **Step 5: 刷新时机 —— 接入 `refreshToken`**

`FileTree.tsx:335` 已有 `refreshToken` 机制，在 `useEffect([refreshToken])` 中附带调用 git 状态刷新：

```ts
// 当 refreshToken 变化时（文件树刷新），同步刷新 git 状态
useEffect(() => { gitRefresh() }, [refreshToken, gitRefresh])
```

其中 `gitRefresh` 来自 `useProjectGitStatus` 返回的 `refresh` 函数。

- [ ] **Step 6: 类型检查**

```bash
pnpm typecheck
```

---

## 验收标准

- [ ] `npx vitest run src/main` 全部通过（含 `project-git-status.test.ts`）
- [ ] `pnpm typecheck` 无新增 error
- [ ] 打开一个挂载了有 `.git` 的外部项目 → 项目列表显示分支名
- [ ] 修改该项目下的文件 → 手动刷新后文件树对应行出现 `M`（橙色）
- [ ] 新建未跟踪文件 → 文件树出现 `U`（绿色），父文件夹出现绿色圆点
- [ ] 挂载一个没有 `.git` 的普通目录 → 显示「无 Git」
- [ ] 在未安装 git 的环境（或 `git` 不在 PATH）下启动 → 整块降级为「无 Git」，不崩溃
- [ ] 工作空间 VCS 快照不再包含 `projects/` 下的任何文件
