# 产物约定（技能 / 工具 / 工作台共用）

> 创建：2026-10-27 · 状态：**P1 已实施**（与 `shared/artifact-rules.ts` 及工作台 P1 同步）
> 相关：[工作台 v2 P1 实施计划](../plans/客户端UI/2026-10-26-工作台v2-P1实施计划.md) · 规则实现：[`apps/windows/src/shared/artifact-rules.ts`](../../apps/windows/src/shared/artifact-rules.ts)

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
