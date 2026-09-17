# Wiki UX 修复设计（待整理 / 多媒体 / 日志 / 清理）

> 日期：2026-08-26  
> 状态：待用户审阅  
> 范围：问题 1–5（默认资料列表、待整理计数、多媒体硬规则、运行日志明细、清理批量操作）  
> 明确不做：综述 AI 自动合成、知识图谱改造（另开设计）

## 1. 背景与目标

设置页 Wiki 存在体验与数据一致性问题：默认落在待整理、左侧待整理角标与右侧列表不一致、非多媒体被分进 `media/`、归档日志过粗、清理批量勾选不便。

本设计采用「最小补丁」路径：在现有 IPC / organizer / WikiTab / CleanupView 上修补，不新建归档事件业务表，不改综述与图谱产品边界。

### 成功标准

1. 进入 Wiki 默认看到可点击的「资料」列表。
2. 「待整理」角标与列表条数含义一致，均为 `pending`。
3. 新归档的 `document` 不会进入 `media/`。
4. 每次归档 run 可展开查看逐条落点与提取依据。
5. 清理支持按原因筛选、全选当前列表、一键归档全部建议（删除仍需勾选 + 确认）。

## 2. 默认展示资料列表

### 行为

- 进入 WikiTab 时：`category = 'sources'`，`rightView = 'page'`，`selectedPage = null`。
- 右侧展示 `sources` 分类页面列表；点击列表项打开详情（沿用现有 `handleOpenPage`）。
- 空库时显示既有空状态文案。
- 待整理 / 多媒体 / 运行日志 / 清理 / 综述 / 图谱仍需用户主动切换。

### 改动点

- `WikiTab.tsx`：调整 `useState` 初始值；确保首次 `refreshPages` 后列表可见且可点。

## 3. 待整理：计数与列表对齐

### 根因

- 角标：`pendingCount = items.filter(status === 'pending').length`
- 列表：`listInbox()` 无 status 过滤，返回全部状态（含 organized/discarded），且 `LIMIT 100`
- 标题用 `inboxItems.length`，与角标语义不一致

### 行为

- 左侧角标 = 当前 `pending` 真实总数。
- 点击「待整理」后，右侧 **只列 pending**（含带 `lastError` 的失败待重试，仍属 pending）。
- 标题 `待整理（N）` 与角标同一 N。
- 不在待整理视图展示 `organized` / `discarded`。

### 计数准确性

- `listInbox(agentId, userId, 'pending')` 用于列表（可保留 LIMIT，例如 100）。
- 角标与标题 **必须** 使用独立计数：repo 新增 `countInbox(agentId, userId, status)`；IPC 增加 `wiki:inbox:count`（或 list 响应附带 `total`）。禁止用「当前页 length」冒充总数。
- 本轮不做分页 UI；pending 超过 LIMIT 时标题可为 `待整理（N）` 并提示「仅显示最近 M 条」。

### 改动点

- `WikiTab.tsx`：`refreshInbox` 仅拉 pending；标题与角标用 `countInbox`。
- `wiki-repo.ts` + `wiki-commands.ts` + `useWikiPage`：新增 count 查询与透传。

## 4. 多媒体分类硬规则

### 规则

| media_type | 允许顶层 |
|---|---|
| `image` / `audio` / `video` | `media/`、`sources/`、`inbox/` |
| `document`（及其他非多媒体） | 仅 `sources/`、`inbox/`；**禁止** `media/` |

- 若模型给出 `media/...` 且条目非多媒体：改写为 `sources/<原 slug>`（保留 slug，只改顶层），标记纠正原因 `non_media_forced_to_sources`。
- 提示词同步：文档一律 `sources/`；仅图片/音频/视频可进 `media/`。
- 推荐落点：在 `classifyBatch` 解析校验后统一拦截（与路径合法性降级同一层），便于单测。

### 存量数据

- 本轮 **不** 强制迁移历史误入 `media/` 的文档页。
- 保证新归档不再误入即可。

### 改动点

- `wiki-classifier.ts`（prompt + 校验）及对应测试。
- organizer 若另有落库路径，复用同一校验函数，避免双份逻辑。

## 5. 运行日志明细

### 列表行

- 保持：状态、时间、一行短摘要。
- 摘要示例：`3 项已归档 · 1 项纠正到 sources/ · 0 项失败`。

### 展开明细（每条 inbox 一项）

| 字段 | 含义 |
|---|---|
| `inboxId` | 收件箱 id |
| `title` | 归档标题 |
| `path` | 最终落点 |
| `mediaType` | document / image / audio / video |
| `outcome` | `archived`（正常落点）\| `corrected`（非多媒体强制改 sources）\| `degraded`（路径非法等降级到 inbox/）\| `failed`（落库失败仍 pending） |
| `reason` | 纠正/降级/失败原因（可空）；纠正固定为 `non_media_forced_to_sources` |
| `extract` | `preview`（整理前已有 content_preview）\| `extracted`（本批 extractor 补齐）\| `none`（无正文可写） |

> `extract` 不单独区分 vision 失败：当前 extractor 失败时返回 null，统一记 `none`；若日后 extractor 返回原因码再扩展枚举。

### 存储

- 保留 `result_summary` TEXT：人类可读短摘要（列表用）。
- 同表增加 `result_detail` TEXT，JSON 固定形态：`{"items":[...]}`（上表字段数组）。
- Schema 迁移为 `wiki_organize_runs` 增加可空列 `result_detail`；旧行 null 时 UI 仅显示摘要。
- `WikiOrganizer.organizeBatch` 在 `finishRun` 时写入 summary + detail。
- 整批 classify 抛错：对本批每个 inboxId 写 `outcome: failed` + 统一 error，便于「这批动了谁」可查。

### UI

- 运行日志行可展开/收起；纠正/失败用标签区分。
- 本轮不做从日志撤销归档。

### 改动点

- `schema.ts` 迁移、`wiki-repo.finishRun` / `listRuns` 映射、IPC、`WikiRunItem` 类型、WikiTab 运行日志视图。

## 6. 清理批量操作

### 工具栏

- 原因筛选（单选 chips）：全部 | 长期未用 | 来源失效 | 内容重复。
- **全选当前列表**：勾选当前筛选可见的全部建议；再点取消。
- **一键处理全部建议**：对**本次扫描返回的全部建议**（不受筛选限制）执行「批量归档」；二次确认：`将归档 N 条清理建议，确定？`。
- 一键处理 **不** 走删除。

### 既有批量按钮

- 批量归档 / 批量恢复 / 批量删除：作用于已勾选集合。
- 删除额外确认：`将永久删除已选 N 条，不可恢复`。

### 交互细节

- 筛选变更：若处于全选态，按新可见集合重算勾选。
- 重新扫描后清空勾选。
- 本轮不做分页；全选范围 = 当前完整扫描结果（与现有 `cleanupScan` 返回一致）。
- 页面状态候选区仍逐条确认/拒绝，不纳入一键处理。

### 改动点

- `CleanupView.tsx`（及样式）：筛选、全选、一键归档 + ConfirmModal。

## 7. 非目标（本轮）

- 综述由 AI 自动合成、人只改删。
- 双链图谱改为知识图谱（ERO 为主）。
- 历史误分类 `media/` 文档的批量纠正工具。
- 清理建议分页与跨页半选。
- 从运行日志一键回滚归档。

## 8. 测试要点

- WikiTab 默认 `sources` 列表可点击打开页。
- `listInbox`/`countInbox`：角标与列表均为 pending；有 organized 数据时列表不出现。
- classifier：document + path `media/x` → `sources/x` + reason；image + `media/x` 保持。
- organizer finishRun 写入 detail；IPC 返回后 UI 可解析展开。
- CleanupView：筛选后全选数量正确；一键归档确认后调用 `archiveSources` 且 id 为全部建议。

## 9. 实现顺序建议

1. 默认视图 + 待整理对齐（纯 UI/查询，风险低）
2. 多媒体硬规则 + 单测
3. `result_detail` 迁移 + organizer + 日志 UI
4. CleanupView 批量增强
