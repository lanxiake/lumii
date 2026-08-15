# 对话时间线 + 回合文件净变更 — 实施交接说明

> 日期：2026-08-08  
> 用途：换环境 / 另一程序继续开发时的进度与后续计划  
> 关联规格：`docs/plans/2026-08-08-chat-timeline-file-changes-design.md`  
> 关联计划：`docs/plans/2026-08-08-chat-timeline-file-changes-implementation.md`

---

## 1. 整体任务目标

在灵栖 Windows 客户端的**对话气泡**里，把助手回复做成接近 Cursor 的可读时间线，并在每轮结束时诚实展示「本轮到底改了哪些工作区文件」。

### 1.1 要解决的问题

| 痛点 | 目标 |
|------|------|
| 工具调用全堆在气泡顶部，长文一出思考/工具被滚出视野 | 思考、正文、工具按真实发生顺序**交错**出现 |
| 「N 个文件变更」只有上传/产出语义，看不出新增/改/删 | 按本轮净结果展示 **新增 / 修改 / 删除**（不要上传、不要行数） |
| 中间建临时文件又删掉仍可能污染列表 | 只比回合 **开始 vs 结束** 快照；中间过程不进卡 |

### 1.2 功能目标（交付范围）

1. **时间线交错（含思考）**  
   助手消息以有序 `parts[]`（`thinking` / `text` / `tool`）为唯一真相；UI 按数组顺序渲染；连续工具**每条单独一行**（可点开详情），不再把全部工具收成顶部大折叠组。

2. **本轮文件净变更卡**  
   - 边界：一次用户提问的 Agent 回合（prompt start → idle）  
   - 数据：工作区快照 diff → `fileChanges`  
   - 展示：气泡**最底部**；标签仅「新增 / 修改 / 删除」；无上传；无 `+/-` 行数  
   - 临时文件写了又删 → **不出现**

3. **全链路一致**  
   主进程落库、Renderer store、气泡 UI、重启后历史恢复，都走 `assistant_parts`；**不做**旧 `text + thinkingText + toolCalls` 兼容（开发期清空 `~/.lumii` 会话数据即可）。

### 1.3 明确不做（非目标）

- 旧消息启发式还原交错 / 兼容解析  
- 变更卡展示行数（右侧版本工作台仍可有 `+/-`）  
- 改 LLM 工具语义、改右侧 Workbench 信息架构  
- 解析 `bash` 命令猜文件操作（靠工作区快照）  
- 跨多轮「会话累计净变更」总览、变更卡一键保存版本等（可后期）

### 1.4 已确认交互口径（摘要）

| 议题 | 决定 |
|------|------|
| 数据架构 | `parts[]` 唯一真相 |
| 思考 | 进入时间线（可多段），不只钉在顶部一块 |
| 工具 | 单行 ToolCallCard，默认可折叠详情 |
| 文件卡 | 仅本轮净变更；在气泡底 |
| 历史 | 清库，无回退布局 |

---

## 2. 预期结果（做完长什么样）

### 2.1 用户可见体验

一次典型回合结束后，助手气泡应接近：

```
[思考可折叠] …
一段说明文字…
[工具] Read xxx
[工具] file_write yyy
又一段说明文字…
[思考] …
终稿正文…

── 收尾 ──
N 个文件变更          [查看]
  A  path/a.ts        新增
  M  path/b.ts        修改
  D  path/c.ts        删除
```

流式过程中：新 part 追加/patch；粘底跟随最新活动；用户上滚阅读历史工具时打断粘底（沿用现有逻辑）。

### 2.2 验收标准（全部 Task 完成后必须满足）

1. **交错**：新会话助手气泡按时间线展示思考、正文、单条工具卡（顺序与真实发生一致）。  
2. **长文**：长回复时工具不再全部钉在气泡顶部被滚没；工具夹在对应正文之间，仍可上滚回看。  
3. **变更卡**：回合 idle 后气泡底部出现净变更卡；标签仅为新增/修改/删除；**无上传、无行数**。  
4. **净结果**：临时文件创建后删除 → 卡中无该路径。  
5. **持久化**：重启应用后，时间线 parts 与 `fileChanges` 仍可从本地库恢复。  
6. **数据策略**：本地旧会话已清空或不可用；代码路径无旧格式兼容分支。

### 2.3 技术预期结果（实现层面）

| 层 | 完成后状态 |
|----|------------|
| 存储 | assistant `content_json.type === 'assistant_parts'`，含 `parts` + 可选 `fileChanges` |
| Bridge | `pendingParts` 为运行时真相；prompt 前快照、idle 后 diff 写入并推送 `agent:turn:file-changes` |
| Renderer | `RuntimeMessage.parts` / `fileChanges`；事件按到达顺序归约 |
| UI | `ChatMessage` 按 parts 渲染；底部 `TurnFileChangesCard`；对话流不再用 SessionFileList 的 upload/output 冒充变更 |

### 2.4 与「当前进度」的对照

| 预期结果 | 现状（截至 `4cc6b12`） |
|----------|------------------------|
| parts 全链路 + 交错 UI | ✅ 主路径已通（Task 1–7） |
| 回合快照 + fileChanges 事件/落库 | ✅ 已通（Task 5） |
| 变更卡视觉与「查看」、去掉 SessionFileList inline | 🟨 stub 有；**Task 8 未完成** |
| 双轨清理 + 清库说明 + 手工验收收口 | ❌ **Task 9 未做** |

---

## 3. 一句话状态

**9 个 Task 中，1–6 已审查通过；Task 7 代码与审查修复已提交，正式复审被中断（可视为实质完成）；Task 8–9 未做。**

功能链路「parts 存储 → Bridge 落库 → 回合快照 fileChanges → Renderer store → 气泡交错渲染」主路径已通；剩余主要是变更卡打磨、去掉会话级 SessionFileList、清理双轨字段与验收。

---

## 4. 工作区与分支（务必在此继续）

| 项 | 值 |
|----|-----|
| Git worktree | `E:/my-project/open-source/lumii/.worktrees/chat-timeline-file-changes` |
| 分支 | `feat/chat-timeline-file-changes`（**尚未设置 upstream / 未 push**） |
| 当前 HEAD | `4cc6b12` |
| 计划基线 | `62a55e0`（docs 计划提交） |
| 主工作区 | `E:/my-project/open-source/lumii` 仍在 `feat/ui-tech-refresh`，含无关脏文件；**不要在主目录继续本功能** |

### 换环境后第一步

```powershell
cd E:\my-project\open-source\lumii\.worktrees\chat-timeline-file-changes
git status
git log --oneline 62a55e0..HEAD
# 可选：推远程
# git push -u origin feat/chat-timeline-file-changes
```

SDD 账本（gitignored，仅 worktree 本地）：

- `.superpowers/sdd/progress.md`
- `.superpowers/sdd/task-N-brief.md` / `task-N-report.md`（1–7）

---

## 5. 已完成任务进度

### Task 1 — `assistant-parts` 纯函数 ✅ 已审查

- 提交：`d5f2b84` → 修复 `c0fc951`
- 产出：`packages/agent-runtime/src/storage/assistant-parts.ts`
- API：`applyAssistantPartEvent` / `finalizeAssistantParts` / `diffTurnSnapshots` / `AssistantPart` / `FileChangeEntry` / `AssistantPartsContent`
- 修复点：`tool_start.meta` 类型；finalize 不把 running tool 标成 done

### Task 2 — 存储解析与 LLM 投影 ✅ 已审查

- 提交：`569eddc`
- `parseMessageContentJson` 识别 `assistant_parts`
- `messageRowToAgentMessages` 按 parts 顺序投影；旧 assistant `type:text` 不再兼容（返回空/忽略）

### Task 3 — 工作区回合快照 ✅ 已审查

- 提交：`591dc89` → 修复 `1406aa4`
- `apps/windows/src/main/workspace-vcs/workspace-turn-snapshot.ts`
- `captureWorkspaceTurnSnapshot`；readdir 失败抛错（不返回空 Map）

### Task 4 — Bridge `pendingParts` + `assistant_parts` 落库 ✅ 已审查

- 提交：`0cff113`
- `bridge-agent-instance-events.ts` / `bridge-instance-state.ts`
- 助手写入一律 `type: 'assistant_parts'`
- Minor（可延后）：事件处理器持久化测试偏薄；`toolTextPositionMap` 残留依赖

### Task 5 — 回合快照 + `fileChanges` 事件 ✅ 已审查

- 提交：`442ab5b` → 修复 `1ef5403`
- prompt 前 `turnSnapshotStart`；`agent:end` diff → `fileChanges`；IPC `agent:turn:file-changes`
- 修复：EventSink 保持同步 `void` + 内部 async catch；直接生图路径也走快照

### Task 6 — Renderer store / event-handler ✅ 已审查

- 提交：`d363b7e` → 修复 `e210b58`
- `RuntimeMessage.parts` / `fileChanges`
- delta 队列保序；LLM 错误注入 parts
- Minor：`agent:error` / 渠道入站 parts 仍可能为空（非主路径）

### Task 7 — ChatMessage 交错时间线 UI 🟨 代码完成，复审中断

- 提交：`21700ee` → 修复 `4cc6b12`
- 按 `parts` 渲染 Thinking / text / `ToolCallCard`；删除顶部 ToolsSection / `buildSegments`
- 新增 stub：`TurnFileChangesCard`（Task 8 要 polish）
- `mergeAssistantParts`：子 Agent parts 插到父消息末尾连续 text 之前
- aborted 路径已 `wrapSubAgent(renderPartsTimeline())`
- **换机后建议**：对 `e210b58..4cc6b12` 快速复审一眼，或直接记 Task 7 complete 后开 Task 8

---

## 6. 后续计划（剩余 Task）

严格按实施计划继续；推荐仍用 **Subagent-Driven** 或按 Task 勾选执行。

### Task 8 — `TurnFileChangesCard` 打磨 + 去掉会话级 inline SessionFileList（下一优先）

**目标**

- 气泡底部净变更卡：标题 `{n} 个文件变更`，「查看」打开 Workbench 并尽量定位首文件
- 行：扩展名徽章 + 路径 + **新增 / 修改 / 删除**（可用 `A`/`M`/`D` + 中文）；**无 +/- 行数**；**无上传**
- 从 `ChatContainer` 对话流移除用 `fileEvents` 驱动的 SessionFileList inline（rail/composer 若仍展示上传/产出可保留）
- 接好 `onReviewFileChanges`（Task 7 已留 prop）

**关键文件（计划）**

- `apps/windows/.../TurnFileChangesCard/`（已有 stub，补 CSS + 交互）
- `ChatContainer/index.tsx`、`ChatPage.tsx`
- 测试：`TurnFileChangesCard.test.tsx`

**验收**

- `fileChanges` 非空才显示；idle 后出现
- 无行数、无上传标签

### Task 9 — 清理双轨 + 数据重置说明

**目标**

- `rg` 清理 assistant 主路径上的 `textPositionAtStart` / 旧 `thinkingText`+`toolCalls` 双写
- `pnpm typecheck`（注意仓库可能仍有既有无关错误，聚焦本功能引入的）
- 文档注明：开发期清空 `~/.lumii` 会话 DB，无旧格式兼容
- 手工验收清单写入 PR 描述

**手工验收（计划 §9）**

1. 清库后新会话  
2. 多工具 + 长回复：工具夹在正文中间  
3. 写临时文件再删：卡中无该路径  
4. 仅新增/修改/删除，无行数、无上传  
5. 重启后时间线与 fileChanges 仍在  

### 全部完成后

- 分支级最终 code review  
- 可选：`git push -u origin feat/chat-timeline-file-changes` 并开 PR（相对合适 base，如 `feat/ui-tech-refresh` 或 `main`——以团队习惯为准）  
- finishing-a-development-branch：是否合并 / 保留 worktree  

---

## 7. 关键接口备忘（跨任务契约）

```ts
// packages/agent-runtime — 已导出
AssistantPart = thinking | text | tool
FileChangeEntry = { path: string; status: 'added' | 'modified' | 'deleted' }
AssistantPartsContent = { type: 'assistant_parts'; parts; usage?; sourceAgent?; fileChanges? }
applyAssistantPartEvent(parts, event): AssistantPart[]
finalizeAssistantParts(parts): AssistantPart[]
diffTurnSnapshots(start, end): FileChangeEntry[]

// main
captureWorkspaceTurnSnapshot(workspaceDir): Promise<Map<string, string>>

// IPC
{ type: 'agent:turn:file-changes'; runId; sessionKey; messageId; fileChanges }
```

全局约束（勿违背）：

- 不做旧 assistant `text+thinkingText+toolCalls` 兼容  
- 变更卡无上传、无行数  
- 工具单行；思考进 parts  
- 函数级中文注释  

---

## 8. 提交列表（`62a55e0..4cc6b12`）

```
4cc6b12 fix(windows): correct sub-agent parts merge order and aborted UI
21700ee feat(windows): render assistant chat bubbles as interleaved parts timeline
e210b58 fix(windows): preserve delta order and inject LLM errors into parts
d363b7e feat(windows): drive runtime messages from assistant parts timeline
1ef5403 fix(windows): preserve synchronous event sink and image file changes
442ab5b feat(windows): attach per-turn workspace fileChanges on agent idle
0cff113 feat(windows): persist assistant messages as assistant_parts timeline
1406aa4 fix(windows): throw on workspace snapshot readdir failure
591dc89 feat(windows): add workspace turn snapshot for net file changes
569eddc feat(agent-runtime): persist and project assistant_parts content
c0fc951 fix(agent-runtime): correct assistant-parts review findings
d5f2b84 feat(agent-runtime): add assistant parts reducer and turn file diff
```

约 **37 files，+2808 / −802**（含 worktree 内 `.superpowers` 报告若曾误入统计则忽略；正式提交以 git log 为准）。

---

## 9. 已知遗留 / Minor（合并前可扫）

| 来源 | 内容 |
|------|------|
| Task 4 | Bridge 事件→仓储端到端测试偏少；`toolTextPositionMap` 可删 |
| Task 6 | `agent:error`、渠道入站消息 `parts: []` |
| Task 7 | `onReviewFileChanges` 未接线（属 Task 8）；Gateway 无 parts 时仍 legacy |
| 全局 | 全仓 `pnpm typecheck` 可能有既有无关错误，勿与本功能混为一谈 |

---

## 10. 给下一会话的启动提示（可直接粘贴）

```
继续实施「对话时间线 + 回合文件净变更」。

工作目录：E:/my-project/open-source/lumii/.worktrees/chat-timeline-file-changes
分支：feat/chat-timeline-file-changes @ 4cc6b12

先读：
- docs/plans/2026-08-08-chat-timeline-file-changes-handoff.md（本文件）
  → 重点看 §1 整体目标、§2 预期结果
- docs/plans/2026-08-08-chat-timeline-file-changes-implementation.md Task 8–9
- docs/plans/2026-08-08-chat-timeline-file-changes-design.md

目标：气泡 Cursor 式交错时间线 + 本轮净文件变更卡（新增/修改/删除，无上传无行数）。
进度：Task 1–6 已审查完成；Task 7 已提交含修复，可标完成。
下一步：执行 Task 8（TurnFileChangesCard + 移除 SessionFileList inline），然后 Task 9 清理与验收。
上线前清空 ~/.lumii 会话数据；不做旧消息兼容。
验收以 handoff §2.2 六条为准。
```

---

## 11. 文档索引

| 文档 | 路径 |
|------|------|
| 本交接（含目标与预期结果） | `docs/plans/2026-08-08-chat-timeline-file-changes-handoff.md` |
| 设计规格 | `docs/plans/2026-08-08-chat-timeline-file-changes-design.md` |
| 实施计划 | `docs/plans/2026-08-08-chat-timeline-file-changes-implementation.md` |
