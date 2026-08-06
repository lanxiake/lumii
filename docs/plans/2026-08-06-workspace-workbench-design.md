# Workspace Workbench 设计规格

> 日期：2026-08-06  
> 范围：Chat 页「工作空间文件」+「工作空间版本」  
> 状态：设计已确认，待实施计划

## 目标

把对话页右侧的文件抽屉与版本面板，收成**同一套工作台**，优先提升**扫读效率**与**和对话页 `--mt-*` 玻璃体系的视觉统一**。版本 Tab 的信息架构对齐 Cursor「Changes」式堆叠多文件 Diff，而不是旧的「左列表 + 右单文件」。

非目标：设置页工作空间目录、软件更新/关于、FilesPage、IPC / `useWorkspace` / `useWorkspaceVcs` 业务语义大改、Git 暂存区、Push、blame、冲突解决。

## 方案选择

采用**双栏工作台（方案 2）**：共享右侧壳 + `文件 | 版本` 分段；版本内再分 `更改 | 历史`。

未选：纯样式对齐（效率不变）；全屏编辑器式 VCS（打断对话心流）。

## 1. 信息架构与壳层

### 结构

```
ChatPage toolbar
  [FolderTree] [GitBranch]  → 同一 WorkspaceWorkbench
         │
         ▼
┌─ WorkspaceWorkbench（右侧固定壳，无全屏遮罩）─────────────┐
│  Header: [文件 | 版本] tabs + 未提交角标 + 刷新/关闭      │
│  Body:                                                   │
│    tab=files  → 搜索 / 项目区 / 文件树 / 预览与右键       │
│    tab=vcs    → Subnav [更改|历史] + 堆叠 Diff + 右栏列表 │
└──────────────────────────────────────────────────────────┘
```

### 打开 / 关闭规则

| 入口 | 行为 |
|------|------|
| 文件钮 | 打开壳 + `tab=files`；已开且在 files → 关闭 |
| 版本钮 | 打开壳 + `tab=vcs`；已开且在 vcs → 关闭 |
| 互斥 | 同一时刻只开一个壳；切换 tab **不卸载**壳（状态保留） |
| 宽度 | files ≈ 280px；vcs ≈ 760px（带 width transition） |
| 遮罩 | **去掉**版本面板全屏 dim |
| Esc | 关闭壳 |
| `@` 定位文件 | 打开壳 → files tab → 展开路径并高亮 |

`ChatPage` 用单一状态 `workbench: { open, tab }` 替代 `showFilePanel` + `showVersionPanel`。

### 代码落点

- 新增薄壳组件：`WorkspaceWorkbench`（或等价命名）
- 现有 `WorkspaceFilePanel` / `WorkspaceVersionPanel` 变为壳内 tab 内容；业务 hook 原样复用
- 不改 `useWorkspace` / `useWorkspaceVcs` 的对外契约；仅在 UI 层组合调用（例如为堆叠 Diff 补拉 hunks）

## 2. 交互流

### 2.1 文件 Tab

| 场景 | 行为 |
|------|------|
| 搜索 | 置顶常驻；输入即过滤（保留现有搜索逻辑） |
| 树密度 | 行高约 26px；hover 才出预览/更多 |
| 预览 | 点击 → 现有 `FilePreviewModal`（不变） |
| `@` 定位 | 打开壳 → files → 展开并高亮约 1.2s |
| 键盘 | 树聚焦时：`↑↓` 移动、`Enter` 预览/展开、`/` 聚焦搜索 |

本轮**不做**：文件树 Git 状态角标（M/A/D）、拖拽、虚拟列表。

### 2.2 版本 Tab — 更改子页（默认，对齐原型）

布局：

```
Subnav: [更改] [历史]     未提交  +N −M     [保存版本]
┌─────────────────────────────┬──────────────────┐
│ 主区：堆叠多文件 Diff 卡片   │ 右栏：变更文件列表 │
└─────────────────────────────┴──────────────────┘
```

| 规则 | 行为 |
|------|------|
| 默认 | 打开 vcs →「更改」；有变更时并行加载带 hunks 的 Diff |
| Diff 卡片 | 每文件一张：路径、`+n −m`、状态、撤销、可选「在文件中显示」 |
| 未改行 | 连续未改行收成 `N unmodified lines`，可点开 |
| 右栏 | 路径 + `+n −m`；点击 → 主区 `scrollIntoView` 到对应卡片 |
| 保存 | 主钮「保存版本」= 现有 `commit()`；`Ctrl+S` 同效（仅更改子页） |
| 单文件撤销 | 卡片头 ghost 危险色 → `ConfirmModal` → `revertFile('HEAD', path)` |
| 空态 | 无变更时轻提示，可引导切「历史」 |

映射与裁剪（相对 Cursor Changes 原型）：

| 原型 | Lumii |
|------|--------|
| Changes 堆叠 Diff | 更改子页主区 |
| 右侧 Files Changed | 右栏变更列表（可按目录分组，**无 checkbox**） |
| Commit & Push | **保存版本**（本地，无 Push） |
| Browser | **历史**子页 |
| 分支下拉 | 不做；可不显示或静态「工作区」 |
| 暂存 checkbox | **不做**（`commit()` 全量，不做假 staging） |
| 行内 AI 标记 | 不做 |

未提交 hunks：优先复用已有 IPC（`statusDiff` 若已带 hunks 则直用；否则用 `diff` / `readFileAt` 在 UI 层组合）。**不新造协议，除非现有 API 无法给出逐行 Diff**——若无法，卡片内明确提示，禁止伪造 Diff。

### 2.3 版本 Tab — 历史子页

- 时间线：message、短 oid、时间、作者（agent/user **文字标签**，不用 emoji）
- 点某版 → 主区换成该版相对父版的**同一套堆叠 Diff 皮肤**
- 「回滚到此版本」：行 hover 显示 → ConfirmModal（文案含「当前状态会自动备份」）→ `rollback(oid)`

### 2.4 跨 Tab 与快捷键

- 版本卡片「在文件中显示」→ 切 files tab 并定位该路径（本轮做）
- 壳打开且焦点不在输入框时：`1` / `2` 切 files / vcs；`Esc` 关闭
- `Ctrl+S` 仅在 vcs「更改」子页触发保存

### 2.5 本轮明确不做

拖拽改文件、多选/部分暂存提交、blame、冲突 UI、虚拟列表、文件树 Git 角标、远程 Push。

## 3. 视觉规格

### 气质

玻璃壳 + 高信息密度 + 克制动效。浅色跟暖奶油 `--mt-*`，深色跟现有 surface；**不抄**原型冷白 IDE 底色。无紫色光晕、无大阴影堆叠、无 Commit&Push 文案。

### 壳层（共用）

| 项 | 规格 |
|----|------|
| 背景 | `var(--mt-glass-bg)` + `blur(var(--mt-glass-blur))` |
| 边框 | 左侧 `1px solid var(--mt-border-hairline)` |
| Header | 高 44px；tabs `--mt-fs-xs`；激活底边 `2px solid var(--mt-accent-500)` |
| 未提交角标 | accent 12% 底小 pill；`0` 时隐藏 |
| 宽度过渡 | 280 ↔ 760，`var(--mt-dur-normal)` + `--mt-ease-decel` |
| 图标 | 一律 lucide-react |

### 文件 Tab

- 行高 ~26px；缩进 12px/级
- 搜索：顶下 sticky；`--mt-surface-2`；圆角 8px
- Hover：`--mt-surface-3`；操作钮仅 hover
- 定位高亮：accent 10% 底，约 1.2s 淡出

### 版本 · 更改

| 项 | 规格 |
|----|------|
| 保存版本 | 实心 accent 主钮 + `.mt-press` |
| 汇总 | `未提交` + 绿 `+N` / 红 `−M`，等宽数字 |
| 右栏 | 宽 200px；`--mt-surface-2`；行 28px；激活左边 2px accent |
| Diff 卡片 | 圆角 10px；hairline；头 `--mt-surface-2`；体 `--mt-code-bg`；间距 12px |
| Diff 行 | 等宽 12px；add/del 用 success/error 低透明混色（见 token） |
| 折叠条 | `N unmodified lines`，`--mt-fg-4`，可点 |
| 撤销 | ghost；hover 转 `--mt-error` |
| 行号 | `--mt-fg-4` 固定宽 gutter |

### 版本 · 历史

- 时间线：左 2px 竖线 + 圆点
- Diff 卡片与更改子页同一皮肤
- 回滚默认隐藏，hover 显示

### 动效

1. 壳滑入 `translateX` + 宽度过渡  
2. Diff 卡片 stagger 入场（最多前 4 张）  
3. 保存成功：主钮短暂 ✓ 再复原  

尊重全局 `prefers-reduced-motion: reduce`。

### Token

优先已有 `--mt-*`。若缺，仅在 `design-system.css` 深/浅主题各补：

- `--mt-diff-add-bg`
- `--mt-diff-del-bg`

组件新样式统一写 `--mt-*`，不新建第二套体系。

## 4. 组件边界

| 单元 | 职责 | 依赖 |
|------|------|------|
| `WorkspaceWorkbench` | 壳、tabs、宽度、Esc、与 ChatPage 状态桥接 | 无业务 hook |
| 文件内容区 | 现有 FilePanel 逻辑（树/搜索/预览/右键） | `useWorkspace` / `useFiles` / `useCodingDevProjects` |
| 版本内容区 | 更改/历史子导航、堆叠 Diff、右栏、保存/撤销/回滚 UI | `useWorkspaceVcs` |
| `DiffFileCard`（可抽） | 单文件头 + hunks + 未改折叠 | 纯展示 + 回调 |
| `ChangedFilesRail`（可抽） | 右栏导航列表 | 纯展示 + 回调 |

错误与反馈：沿用现有 toast / `ConfirmModal`；加载用轻量 skeleton 或「加载中…」，不挡整壳关闭。

## 5. 测试与验收

- 手动：深/浅主题下打开关闭、files↔vcs 宽度过渡、更改堆叠 Diff、右栏跳转、保存/撤销/回滚确认、Esc、`1`/`2`、`Ctrl+S`、`@` 定位仍可用
- 自动化：若已有 FilePanel / VCS 相关测试则更新选择器；不强制本轮新写大套 E2E
- 类型：`apps/windows` 下 `tsc --noEmit` **不新增** error（基线以改造前计数为准）

## 6. 实施约束

- 纯前端：CSS Modules + 少量 JSX；不动主进程 / preload，除非证实无法取得未提交 hunks
- 中文注释；函数级注释保留项目习惯
- 与 `docs/plans/2026-08-05-ui-tech-refresh-client-implementation.md` 的 token / lucide / 浅色暖奶油约定一致
