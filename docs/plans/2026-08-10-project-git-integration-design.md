# 项目级 Git 集成 — 设计规格

> 日期：2026-08-10
> 范围：`workspace/projects/<name>` 下挂载的用户项目的 Git 状态展示（分支/远程/文件改动标记）
> 状态：设计已确认，待实施

## 背景

当前系统有两套完全独立、互不知晓的版本管理：

1. **工作空间 VCS**（`apps/windows/src/main/workspace-vcs/`）：基于 `isomorphic-git`，元数据存于 `{workspaceDir}/.mtbot-vcs`，服务于 Agent 自动快照与对话回溯，线性历史、无分支、无远程。
2. **项目自身 Git**：用户挂载到 `workspace/projects/<name>` 的项目通常自带 `.git`（真实仓库，可能有分支/远程）。项目挂载方式见 `apps/windows/src/main/coding-dev-projects.ts`：
   - 内部新建（`createProject`）：`workspace/projects/<name>` 是真实目录，`isExternal: false`
   - 外部挂载（`openExistingProject`）：`workspace/projects/<name>` 是指向 `realPath` 的 junction 软链接，`isExternal: true`

## 已确认的问题（现状缺陷）

1. **隔离靠巧合，不靠设计**：`WorkspaceVcs.walkWorktreeFiles()`（`vcs-repo.ts:133-156`）用 `entry.isDirectory()` / `entry.isFile()` 判断，junction 的 `Dirent` 两者都不成立，故 `projects/` 下的 junction 目录被静默跳过。这只覆盖了「外部挂载」场景；一旦用户用「新建项目」（真实目录），`.mtbot-vcs` 会把整个项目源码树纳入自动快照，与项目自身 `.git` 产生语义冲突（例如把 `node_modules` 之外的 build 产物也快照进去，或者在项目里生成大量与工作空间快照无关的历史）。
2. **项目列表无 Git 信息**：`ProjectsSection.tsx` 只展示 `isExternal` 徽标和活动态，没有分支/远程/改动。
3. **文件树无变更标记**：`FileTree.tsx` 渲染 `FileItem` 时只有名称和图标，没有 git 状态装饰。
4. **新增项目未出现在版本管理列表**：根因见上第 1 点 —— 不是 bug，而是设计意图应该如此（项目不该被工作空间 VCS 接管），需要用显式规则替代当前的隐式行为。

## 目标

- 工作空间 VCS 与项目 Git **显式隔离**，不依赖 junction 的 Dirent 类型判断这种隐式行为。
- 项目列表（`ProjectsSection`）内联展示当前分支、ahead/behind、远程 URL。
- 文件树按 git 状态标记：新增（绿）、修改（橙）、文件夹聚合圆点。
- 不做任何写操作（分支切换/创建/提交/pull/push）在本期范围内 —— 见「非目标」。

## 非目标（本期不做）

- 分支切换、新建分支（下一期）
- 暂存区操作、提交、pull、push（下一期，push 需独立确认交互）
- fs watcher 自动刷新（先手动/时机触发刷新，观察实际使用后再评估）
- diff 内容展示、blame、merge 冲突解决、stash
- 修改工作空间 VCS 已有的快照/回滚/diff 功能本身

## 方案

### 1. 隔离规则（替代隐式行为）

在 `vcs-ignore.ts` 的 `DEFAULT_VCS_IGNORE_RULES` 中显式加入 `projects/`，并在 `vcs-repo.ts` 的 `walkWorktreeFiles()` 中于**根层**直接跳过 `projects` 目录（不能塞进 `VCS_SKIP_DIRS`，那是按名称任意深度剪枝，会误伤项目内部同名目录）。

效果：无论项目是 junction 还是真实目录，工作空间 VCS 都不再遍历 `projects/` 下的内容。已初始化的 `.mtbot-vcs` 仓库中若已误跟踪 `projects/` 下文件（当前实测未发生，`git ls-files` 结果为空），下次 `stageAll()` 会因文件不在 walk 结果中被当作「已删除」处理并 `git.remove` —— 这是幂等的收敛行为，无需额外迁移脚本。

### 2. 项目 Git 服务（新增，主进程）

新目录 `apps/windows/src/main/project-git/`：

- `git-cli.ts`：`execFile('git', args, { cwd })` 包装，不经过 shell（避免命令注入）。`cwd` 必须是 `project.realPath`（真实路径），不能是 junction 路径 —— Windows 上 git 在 junction 路径下解析工作树可能给出错误的相对路径。
- `project-git-status.ts`：调用 `git status --porcelain=v1 -z --branch -unormal` 一次性获取分支、ahead/behind、文件状态；`git remote get-url origin` 获取远程 URL（拿不到则视为无远程，不报错）。
- `types.ts`：状态返回类型（见下）。

```ts
export interface ProjectGitStatus {
  available: boolean          // 系统是否已安装 git（探测一次，进程内缓存）
  isRepo: boolean              // realPath 下是否存在 .git
  branch?: string
  ahead?: number
  behind?: number
  remoteUrl?: string
  files: Array<{
    /** 相对项目根（realPath）的路径，POSIX 分隔 */
    path: string
    /** 索引状态：' '|'M'|'A'|'D'|'R'|'C'|'U'|'?' */
    index: string
    /** 工作区状态，同上 */
    worktree: string
  }>
}
```

选用 `-unormal` 而非 `-uall`：未跟踪目录（如新建的 `node_modules`）折叠为单条 `dir/`，避免炸出成千上万条目。文件树侧对未列出但父目录已知为未跟踪的子路径，按「祖先未跟踪 ⇒ 自身未跟踪」向下继承推导。

`git status --porcelain=v1 -z` 输出路径相对 `git rev-parse --show-toplevel`（真实路径）。渲染侧文件树路径是基于 junction 的绝对路径，两者**必须都换算成「相对项目根的 POSIX 路径」再比对**，否则标记会全部静默失效（无报错、无异常，只是查不到）。

### 3. IPC

一个通道返回全部字段，不按分支/远程/文件拆多个通道（`preload` 每加一个通道要同步三处：main handler、preload 类型+实现、renderer 调用点，拆多了成本线性增加，且这几项状态本身就该原子刷新）。

```ts
// preload ElectronAPI
projectGit: {
  status(projectName: string): Promise<ProjectGitStatus>
}
```

Main handler 通过项目名查 `configManager.getAppConfig().codingDevProjects` 找到对应 `realPath`，再调用 `project-git-status.ts`。

### 4. UI — 项目列表内联（`ProjectsSection.tsx`）

在 `p.isExternal && <span className={styles.badge}>链接</span>`（`ProjectsSection.tsx:124`）之后追加分支/远程展示：

```
lumii     链接  活动   main ↑2      origin
Clawith   链接        dev          origin
lumo      链接        无 Git
```

- 无 git / 未安装 git：显示「无 Git」，弱化色
- 有 ahead/behind：`main ↑2 ↓1` 形式，只在非零时显示对应箭头
- 远程 URL 过长：截断显示 host，`title` 属性放全 URL

数据来源：新 hook `useProjectGitStatus(projectName)`（按需加载，项目列表渲染时逐个调用，不做全量并发风暴 —— 项目数量通常个位数，可接受）。

### 5. UI — 文件树标记（`FileTree.tsx`）

`FileTreeNode` 新增可选 prop `gitStatus?: Map<string, { index: string; worktree: string }>`（相对项目根路径 → 状态），随递归传递（`FileTree.tsx:246` 处的递归调用追加此 prop，不用 Context，两处改动足够）。

在 `styles.name`（`FileTree.tsx:216`）后追加徽标：

```
src/
 ├─ index.ts       M   ← 橙 var(--color-warning) #f59e0b
 ├─ new-file.ts    U   ← 绿 var(--color-success) #22c55e
 └─ utils/         ●   ← 聚合圆点，颜色取子树最高优先级状态
```

优先级（用于文件夹圆点聚合，及索引/工作区状态冲突时的显示选择）：**冲突 > 修改 > 新增**。冲突态本期 git 层面可能返回 `UU` 等，直接映射到 `var(--color-error)` 红色，即便本期不做合并操作，展示上不能吞掉这个信号。

复用现有 `--color-success` / `--color-warning` / `--color-error`（定义于 `tokens.css:29,33,37`），不新增 token。

`gitStatus` 只在渲染树的根节点判定「当前树是否某个 Git 项目」时才计算（即 `rootPath` 落在某个 `project.realPath` 下），非项目路径（如普通工作空间文件浏览）不受影响、不发起任何 git 调用。

### 6. 刷新时机（本期不做 watcher）

- 项目列表打开/切换活动项目时刷新对应 Git 状态
- 文件树 `refreshToken` 变化时（已有机制，`FileTree.tsx:335`）附带重新拉取当前根路径的 git 状态
- 提供手动刷新入口（复用已有的刷新按钮位置，不新增按钮）

不引入 `chokidar`/`fs.watch` 监听整个项目源码树：大仓库的监听成本与「状态可能有几秒延迟」这个可接受的代价不成比例。用户实际感知到状态陈旧后再评估加 watcher。

## 分期

| 期 | 范围 |
|---|---|
| 一期（本次实施） | 隔离规则 + `project-git` 服务（只读 status）+ IPC + 项目列表内联 + 文件树标记 |
| 二期 | 分支切换（切换前检查工作区干净）、新建分支 |
| 三期 | 暂存、提交、pull、push（push 需要独立的破坏性操作确认交互） |

## 风险与边界

- **git 未安装**：`isGitAvailable()` 探测失败时整块降级为「未检测到 Git，功能不可用」提示，不阻塞其他功能，不重试轮询。
- **cwd 必须是 realPath**：所有 `execFile('git', ...)` 调用严禁传入 junction 路径下的路径拼接。
- **路径分隔符**：Windows 下 git 输出可能是 `/`，项目内文件路径在 IPC 层和 `FileItem.path` 都统一转换为 POSIX 分隔（现有 `FileTree.tsx:112` 已有先例）后再匹配。
- **不修改**现有 `workspace-vcs` 的公开 API 签名，只在 `vcs-ignore.ts` / `vcs-repo.ts` 内部追加隔离规则。
