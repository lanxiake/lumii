# 产物约定（技能 / 工具 / 工作台共用）

> 创建：2026-10-27 · 状态：**P1 / P2 已实施**（与 `shared/artifact-rules.ts` 及工作台 P1/P2 同步）
> 相关：[工作台 v2 P1 实施计划](../plans/客户端UI/2026-10-26-工作台v2-P1实施计划.md) ·
> [工作台 v2 P2 实施计划](../plans/客户端UI/2026-10-27-工作台v2-P2实施计划.md) ·
> 规则实现：[`apps/windows/src/shared/artifact-rules.ts`](../../apps/windows/src/shared/artifact-rules.ts)

## 1. 为什么需要约定

工作台 rail 只回答三个问题：**哪个任务产出了什么、哪些是成品、现在是什么状态**。
它不猜工具名、不猜文件名——工具/技能**声明**，声明缺失时才按路径派生。

**规则只有一份实现**：`apps/windows/src/shared/artifact-rules.ts`。
本文只描述约定，不重复实现；两边冲突时以代码与测试为准。

## 2. 目录约定

| 类型 | 位置 | 例子 |
|---|---|---|
| 成品 | `outputs/<任务>/…` | `outputs/pet-demo/sprite.png` |
| 过程文件 | `outputs/<任务>/{parts*,normalized,frames,cut-*}` | `outputs/pet-demo/cut-13.png` |
| 临时文件 | `temp/…` | `temp/github3/repo/` |
| 记账/缓存 | `.lumii/`、`.git/`、`node_modules/`、`.cache/`、`*.lumii-ref`、`*.tmp` | — |

- 过程文件会折叠，临时文件不进 rail（由清理功能负责），记账文件永远不展示也不删。
- 认不出的路径一律按**成品**处理（清理时保守）。

## 3. 声明优先级

```
工具 details.artifacts  >  侧车 <name>.lumii-artifact.json  >  路径派生
```

- 声明与 `fileChanges` 同路径时：**声明覆盖 kind/role/meta**，文件状态仍以 `fileChanges` 为准。
- 失败的工具结果没有 `details`（pi 会清空），只能靠 `fileChanges`/目录派生。
- 未知工具/缺失元数据时静默降级，不报错、不编造。

## 4. 工具声明（推荐）

工具结果里加：

```ts
return {
  content: [{ type: 'text', text: JSON.stringify(payload) }],
  details: {
    ...payload,
    artifacts: [
      {
        kind: 'image',                 // image|image-set|video|audio|doc|slides|sheet|site|code|archive|other
        path: 'outputs/20261027/a.png', // 工作区相对路径（posix）
        role: 'deliverable',            // deliverable | intermediate（缺省按路径派生）
        title: '正面图',                // 可选：比文件名更可读
        meta: { width: 1024, height: 1024, model: 'seedream', prompt: '…' },
      },
    ],
  },
}
```

- `path` 必须是**工作区相对路径**；绝对路径、`..`、盘符会被丢弃。
- 远端产物用 `remoteUrl`（P1 只展示，不打开/不清理）。
- 单次最多 50 条声明；`meta` 只保留已知字段（见 `shared/artifact-declaration.ts`）。

## 5. 侧车（无工具层的技能用）

PPT 目前是「技能 + bash」，没有工具 `details` 可写。技能在**成品同目录**写：

`output.pptx` → `output.pptx.lumii-artifact.json`

```json
{
  "kind": "slides",
  "title": "2026 年 10 月月报",
  "meta": { "pages": 12 }
}
```

- 只在成品旁写，不给每个过程文件写（避免制造上千个侧车）。
- 文件内容 ≤64KB；坏 JSON 会被静默忽略。
- 编辑产物后要同步更新（例如页数变化）。
- 侧车本身按 internal 处理：不展示、不清扫。

## 6. 状态与卡片（AG-UI 对齐）

工作台卡片是状态的视图，不按工具名猜：

| 生命周期 | 来源 | 卡片动作 |
|---|---|---|
| `running` | `TOOL_CALL_START`（当前只有生图；视频/录屏不造占位） | 中断 |
| `waiting_input` | `INTERRUPT`（审批 / 提问） | 允许一次 / 总是允许 / 拒绝 / 回答 |
| `ready` | 声明或 `fileChanges` + 路径 | 打开 / 导出 / 定位 / 对比 |
| `failed` | 工具失败 | 重试（只预填 prompt，不自动发送） |
| `cancelled` | 中断/进程重启 | 重试 / 移入回收站 |

实现：`apps/windows/src/shared/card-state.ts`。完整事件映射见 P1 计划 §2.3。

## 7. 清理边界

- 只深扫 `outputs/` 与 `temp/`；其它位置只做浅统计。
- 成品（deliverable）**永不**进入清理候选。
- 被成品文本引用（html/svg/json/md/js ≤2MB）的中间文件跳过。
- 删除 = 移入 `<ws>/.lumii/trash/`，可恢复；trash 到期才真删。

## 8. 三条产出链的最小要求

| 链 | 最少要做到 | 可以不做 |
|---|---|---|
| 生图（image_generate） | 工具结果 `details.artifacts` 带 `path` / `kind:"image"` / `meta{width,height,model}`；首发与直连生图**两条分支都要写** | 不需要侧车；缩略图由主进程生成 |
| PPT（技能 + bash） | 成品写到 `outputs/<任务>/`；在成品旁写侧车（`kind:"slides"` + `meta.pages` + 可选 `title`） | 不需要首页缩略图（P2）；不需要每页声明 |
| 视频（enqueue_workflow 等） | 真实产出写到 `outputs/<任务>/`（不要只写 `temp/`）；文件名能看出是什么 | 不需要工具层声明（后台任务产物由 `fileChanges` 派生）；首帧由主进程 ffmpeg 抽 |

**允许但需声明**：技能把成品写到别的目录时，请给工具结果加 `details.artifacts` 或写侧车；
不声明就只能按路径派生，rail 可能把它当成过程文件折叠起来（不是错误，但用户看不到）。

## 9. 就地修改与版本约定（P2）

> 实现：`main/artifact-edit.ts` · `main/artifact-versions.ts` · `main/artifact-pins.ts` ·
> `main/artifact-checkpoint.ts` · `main/workbench-comments.ts` · `main/workspace-dedupe.ts`。
> 契约：`shared/artifact-edit-types.ts` · `shared/artifact-version-types.ts` · `shared/artifact-pin-types.ts`。

### 9.1 局部修改

| 约定 | 说明 |
|---|---|
| 先候选、后应用 | 任何改写都必须落成**候选稿**（`.lumii/edits/<editId>/candidate.*`），用户确认后才原子替换目标文件；不允许「直接改目标文件再提示」 |
| `baseHash` 冲突闸 | 候选生成时记录磁盘内容 sha256；应用前重算，不一致直接拒绝（`code:"conflict"`），文件保持用户手改后的版本 |
| 回传 `changedScope` | 提案必须说明动了哪一段：`{type:"text-range",start,end}` / `{type:"slide",index}` / `{type:"file"}` / `{type:"image-variant"}`；UI 据此定位预览，服务端据此净化写回范围 |
| 只改该区间 | 文本用「原文前缀 + 替换 + 后缀」构造候选；PPT 只接受目标页的标题/要点 spec；不允许模型返回整篇后整文件覆盖 |
| 撤销也是版本 | 撤销写入一条新的 `local` 版本（`action:"undo"`），不删历史 |

### 9.2 版本来源与内容可用性

| 来源 | 内容从哪来 | 何时不可取 |
|---|---|---|
| `turn:<messageId>` | 该轮 `agent:end` 精确文本副本（`.lumii/versions/turn-<id>/`）→ VCS 快照 | 二进制旧版（VCS 不含二进制）、快照合并/缺失时标 `approximate` |
| `local:<editId>` | `.lumii/edits/<editId>/candidate.*` | 变体等只登记索引、没有候选副本时 |

- **固化（以此为准）不是版本来源**，是版本上的标记：选定后把内容**复制**到 `.lumii/pins/<pinId>/`，
  之后文件被覆盖也能导出该版；同一 `(session, path)` 只保留一个选定，旧副本留到用户清理。
- 内容不可取时必须给出可读原因（`content.reason`），**不允许**用当前文件冒充历史版本。

### 9.3 图片变体

「同源变体」= 用同一 prompt / 模型 / 尺寸**再生成一张新文件**（同目录 `<name>-variant-<HHmmss>`，
索引里 `action:"variant"` + `derivedFrom`）。**不是**同路径新版本：生图固定写新文件名，
同路径覆盖会破坏「每次生成都可回溯」。

### 9.4 评论与复用

- 评论是工作台草稿（`.lumii/comments/<conversationId>.json`），不是消息 part；
  「带着评论继续」只把拼好的文本**预填**到输入框，**绝不自动发送**。
- 锚点只有两种：文本区间 `{start,end,quote}`（编辑态选区）与 PPT 页 `{index,quote}`；
  图片不做区域锚点。
- 一次最多拼 10 条 / 2000 字，超出注明「还有 N 条」。
- **复用中间产物（把某次的过程文件直接接进新一轮）属 P3**，P2 只定义评论；
  不要去猜「哪个中间产物可以复用」。

### 9.5 清理与去重的边界

- 本地编辑：未应用 24h 清、已应用 30 天 / 1GB；固化副本 2GB 软上限（超限**拒绝新增**，不自动删）。
- 去重只碰**中间产物**、只手动触发、>64KB 且 >24h；用硬链接（同卷），路径与内容不变；
  被成品引用的文件名跳过。硬链接被原地改写会同时影响另一路径——这是用户显式操作接受的边界。
