# 对话时间线交错展示与回合文件净变更 — 设计规格

> 日期：2026-08-08  
> 范围：Chat 气泡内助手消息渲染（思考 / 工具 / 正文交错）+ 本轮文件净变更卡片  
> 状态：设计已确认；实施计划见 `2026-08-08-chat-timeline-file-changes-implementation.md`  
> 参考：Cursor Agent 面板的时间线与 Files Changed 收尾卡

## 目标

1. **文件变更卡片**：对话流内展示本轮 Agent 对工作区的**净文件变更**，标签为「新增 / 修改 / 删除」；不展示用户上传；不附带 `+/-` 行数。
2. **时间线交错**：助手气泡按真实发生顺序交叉渲染「思考 → 文字 → 工具 → 思考 → …」，接近 Cursor；避免「全部工具堆在顶部 + 长文在下」导致思考/工具被滚出视野。

## 非目标

- 不做旧消息兼容回退（当前可清空本地会话数据）
- 变更卡不展示行数统计（右侧版本工作台仍保留 `+/-`）
- 不做多段思考的「第二期」——本期思考即进入 `parts` 时间线
- 不改 LLM 工具语义、不改右侧 Workspace Workbench 信息架构
- 不把 `bash` 命令解析成文件操作清单（净变更靠工作区快照对比）

## 方案选择

采用 **`parts[]` 为唯一真相（方案 1）**：

| 方案 | 结论 |
|------|------|
| 1. `parts[]` 唯一真相 | **采用** — 与 Cursor 同构，流式 = append/patch，思考可自然交错 |
| 2. 旁路字段 + 扩展 `buildSegments` | 不采用 — 多段 thinking/text 表达力不足 |
| 3. 运行时 parts、落库扁平 | 不采用 — 刷新会丢交错，与「新消息保留完整时间线」冲突 |

已确认交互细节：

| 议题 | 选择 |
|------|------|
| 文件卡范围 | 对话流卡片；仅本轮净变更 |
| 文件状态 | 新增 / 修改 / 删除；无上传；无行数 |
| 快照边界 | 单次用户提问的 Agent 回合（start → idle） |
| 中间临时文件 | 建了又删 → 净结果不出现 |
| 交错程度 | 完整时间线（含思考） |
| 连续工具 | 每条单独一行（可点开详情） |
| 变更卡位置 | 固定在本轮气泡最底部 |
| 历史兼容 | 不需要；可清空旧数据 |

---

## 1. 数据模型

### 1.1 Assistant `content_json`

替换现有 `TextMessageContent`（`type:'text'` + `thinkingText` + `toolCalls[]`）为：

```ts
type AssistantPart =
  | {
      type: 'thinking'
      id: string
      text: string
      status: 'streaming' | 'done'
    }
  | {
      type: 'text'
      id: string
      text: string
      status: 'streaming' | 'done'
    }
  | {
      type: 'tool'
      id: string // = toolCallId
      name: string
      args: Record<string, unknown>
      result?: unknown
      isError?: boolean
      status: 'running' | 'done' | 'error'
      /** 子 Agent 等扩展元数据（可选） */
      meta?: {
        sourceAgent?: { instanceId: string; label: string }
      }
    }

type FileChangeEntry = {
  path: string // 工作区相对路径，统一 `/`
  status: 'added' | 'modified' | 'deleted'
}

type AssistantPartsContent = {
  type: 'assistant_parts'
  parts: AssistantPart[]
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheRead?: number
    cacheWrite?: number
  }
  sourceAgent?: { instanceId: string; label: string }
  /** 本轮 idle 后写入；无变更则省略或空数组 */
  fileChanges?: FileChangeEntry[]
}
```

用户消息、`tool_result` 行（若仍单独存）保持现有结构；本期焦点是 **assistant 气泡**。

### 1.2 流式更新规则

| 事件 | 对 `parts` 的操作 |
|------|-------------------|
| 思考开始 / 增量 | 若末尾是 `thinking` 且 `streaming` → 追加 `text`；否则 push 新 `thinking` |
| 思考结束 | 将该 thinking part 标 `done` |
| 正文增量 | 若末尾是 `text` 且 `streaming` → 追加；否则 push 新 `text` |
| 工具开始 | push `tool`（`running`），携带 name/args |
| 工具结束 | 按 `id` patch `result` / `isError` / `status` |
| 回合 idle | 全部 streaming part → `done`；写入 `fileChanges` |

禁止把「工具之后又出现的思考」合并进回合开头的旧 thinking part。

### 1.3 送给 LLM 的投影

从 `parts` 按顺序投影为 pi-agent 历史：

1. `thinking` → thinking block（若上游需要）
2. `text` → text block
3. `tool` → tool_use；结果仍通过既有 tool_result 消息或嵌入字段关联

投影顺序 = UI 时间线顺序。删除旧的「thinking 整块置顶 + 全部 tool 挂文末」组装逻辑（`messageRowToAgentMessages` 等需同步改）。

### 1.4 渲染层类型

`ChatMessage` / `RuntimeMessage` 改为持有 `parts`（或等价 `AssistantPart[]`），去掉对「单一 `content: string` + 旁路 toolCalls」的依赖。  
`buildSegments` 可删除或改为对 `parts` 的薄适配；不再用 `textPositionAtStart` 做主路径。

---

## 2. 回合文件快照与净变更

### 2.1 边界

```
用户发送 → [snapshotStart] → Agent 循环（思考/工具/正文）→ idle → [snapshotEnd] → diff → 写入 fileChanges
```

- **start**：本轮 prompt 派发成功、即将开始执行时
- **end**：该 session 本轮进入 idle（流结束且无运行中工具）

同一会话连续多轮：每轮独立快照与独立 `fileChanges`，挂在**该轮** assistant 消息上。

### 2.2 快照内容

轻量映射：`path → { existed: boolean; contentHash: string }`

- **优先**：复用工作区 VCS 能力（`statusMatrix` / 工作树文件哈希）；路径相对 workspace root
- **非 git 工作区**：遍历工作区文件并哈希；忽略 `node_modules`、`.git`、构建产物等常见目录（与现有 ignore 策略对齐）
- 哈希算法：内容 hash（如 sha256 截断）即可；不要求存全文

### 2.3 Diff 规则

| start | end | 结果 |
|-------|-----|------|
| 无 | 有 | `added` |
| 有 | 无 | `deleted` |
| 有 | 有，hash 不同 | `modified` |
| 有 | 有，hash 相同 | 不收录 |
| 无 | 无 | 不收录（含「中间创建又删除」） |

排序：建议 `added` → `modified` → `deleted`，同组按路径字典序。

### 2.4 与 SessionFileList / FileRepo

| 能力 | 本期行为 |
|------|----------|
| 对话流「N 个文件变更」卡 | **改为**读当前（或各）assistant 消息的 `fileChanges`；挂在气泡底部 |
| 用户上传 | **不进**该卡（上传仍可在用户气泡附件等处展示） |
| `agent:file:created` / FileRepo | 可保留，服务预览/下载；**不再驱动**变更卡文案 |
| 会话级累计 SessionFileList | 对话流 inline 卡不再用会话累计 upload+output 列表 |

### 2.5 失败兜底

- 任一端快照失败 → 本轮不写 `fileChanges`，不展示变更卡（不回退成「产出」假标签）
- 工作区未设置 → 跳过快照，无变更卡

---

## 3. UI 渲染与交互

### 3.1 气泡结构（助手）

```
[角色标] lumii
┌─ message body ─────────────────────────────────────┐
│  part: thinking（可折叠；streaming 时自动滚内容）     │
│  part: text（markdown）                              │
│  part: tool  ← 单行 ToolCallCard                     │
│  part: tool                                          │
│  part: text                                          │
│  part: thinking                                      │
│  …                                                   │
│  ── 本轮收尾 ────────────────────────────────────── │
│  [N 个文件变更]  [查看]                              │
│    A  path/to/new.ts        新增                     │
│    M  path/to/edit.ts       修改                     │
│    D  path/to/old.ts        删除                     │
│  token / 记忆提示 / MessageActions / 时间             │
└──────────────────────────────────────────────────────┘
```

### 3.2 各 part 展示

| Part | UI |
|------|-----|
| `thinking` | 可折叠块；默认折叠（流式进行中可展开跟滚）；文案「思考」 |
| `text` | 现有 markdown / 流式光标 |
| `tool` | **每条单独一行** `ToolCallCard`；默认折叠入参/出参；running 显示进行中 |

连续工具之间无文字时，仍逐条排列，不收成「工具组」折叠区（去掉当前「全部工具堆顶」的 `ToolsSection` 主路径）。

### 3.3 文件变更卡

- 标题：`{n} 个文件变更`；右侧「查看」→ 打开工作台版本/文件 Tab 并尽量定位首个路径（复用现有 `onReview` 思路）
- 行：扩展名徽章 + 文件名（或相对路径）+ 状态标签（「新增」/「修改」/「删除」或短标 `A`/`M`/`D`，视觉二选一但语义完整）
- **无** `+/-` 行数
- 仅在 `fileChanges?.length > 0` 时渲染；出现时机：idle 写入后（流式过程中可不闪空卡）

### 3.4 滚动

- 保持粘底：跟随时间线**最新 part**
- 用户上滚阅读历史工具时，取消粘底（沿用现有 chat 粘底打断逻辑）
- 交错后，最新活动附近的工具自然可见；不再依赖「顶部工具堆」

### 3.5 子 Agent

子 Agent 工具仍作为 `tool` part（`meta.sourceAgent`）；插入位置按主时间线真实顺序。合并进主气泡的现有策略可保留，但数据源改为 parts，不再推断 `textPositionAtStart`。

---

## 4. 事件与 IPC 数据流

### 4.1 主进程 / runtime

1. `prompt` 开始 → 对当前 workspace 做 `snapshotStart`，挂在本轮 run 上下文
2. 思考/文本/工具事件 → 更新该 assistant 消息的 `parts`（内存 + 适时落库）
3. idle → `snapshotEnd` → diff → `fileChanges` 写入消息 → 推送 UI 事件（可复用 message update 或新增 `agent:turn:file-changes`）

### 4.2 渲染进程

- `event-handler` / store：按 part id 更新，而不是维护平行的 `thinkingText` + `toolCalls` + 拼接 `content`
- `ChatMessage`：`parts.map` 渲染；底部条件渲染 `TurnFileChangesCard`（可由 SessionFileList inline 改造或新组件）

### 4.3 落库

- `messages.content_json` 存 `AssistantPartsContent`
- Schema：可视需要 bump `SCHEMA_VERSION`；**不写旧格式解析器**
- 上线前清空本地 DB / 会话（`~/.lumii` 下相关库，或以应用内「清空全部会话」完成）

---

## 5. 代码落点（预期）

| 区域 | 文件/模块（示意） | 改动 |
|------|-------------------|------|
| 存储类型 | `packages/agent-runtime/.../conversation-repo.ts` | `AssistantPartsContent`；投影函数 |
| Schema | `packages/agent-runtime/.../schema.ts` | 版本 bump；可选清理迁移 |
| 事件 | `apps/windows/src/shared/agent-runtime-events.ts` | part 增量事件（或扩展现有 stream 事件） |
| Bridge | `main/agent-runtime/bridge-*` | 组装 parts；回合快照 |
| 快照 | 新建 `workspace-turn-snapshot.ts`（main）或挂 VCS 旁路 | start/end/diff |
| Store | `agent-runtime-store.ts` / `event-handler.ts` | RuntimeMessage.parts |
| UI | `ChatMessage/index.tsx` | 按 parts 渲染；删除未接线的旧交错主路径 |
| 变更卡 | `SessionFileList` 改造或 `TurnFileChangesCard` | 读 `fileChanges` |
| 清理 | 移除对 `textPositionAtStart` 的主路径依赖 | 避免双轨 |

---

## 6. 错误处理

| 场景 | 行为 |
|------|------|
| part 更新乱序（工具 result 早于 start） | 按 id upsert；缺失则先建 stub 再补全 |
| 快照超时/IO 错误 | 打日志；本轮无 fileChanges |
| 路径在 workspace 外 | 不纳入净变更 |
| markdown 渲染失败 | 该 text part 降级纯文本，不影响其余 parts |
| 清空数据后首启 | 空会话列表；无迁移提示强依赖 |

---

## 7. 测试计划

### 单元

- parts 流式合并：连续 text 合并、thinking→tool→thinking 拆段
- 净变更 diff：新增/修改/删除；创建又删除 → 空；仅 hash 不变 → 空
- LLM 投影：parts 顺序与 tool_use 对齐

### 组件

- `ChatMessage`：给定 parts fixture，断言 DOM 顺序（thinking/text/tool 交错）
- 变更卡：三种状态标签；无行数；空数组不渲染

### 手工

- 长回复 + 多工具：滚动时仍能在时间线中部看到工具行
- 写临时文件再删：卡不出现该路径
- 清空数据后新会话：时间线与变更卡正常

---

## 8. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 大工作区全量哈希慢 | ignore 目录；优先 VCS；可只哈希「相对 start 有 mtime/size 变化」的候选集 |
| bash 改文件漏检 | 快照对比天然覆盖；不依赖工具名 |
| 一次改动面大（存储+UI+事件） | 实施计划拆 PR：① parts 管道 ② UI 时间线 ③ 回合照与卡片；但规格上仍是同一功能 |
| 清空数据不可逆 | 文档与发版说明写明；仅开发期可接受 |

---

## 9. 验收标准

1. 新会话助手气泡按时间线交错展示思考、正文、单条工具卡。
2. 长文场景下，工具不再全部钉在气泡顶部被滚出；而是夹在对应正文之间。
3. 回合结束后，气泡底部出现净变更卡；标签仅为新增/修改/删除；无上传、无行数。
4. 临时文件写后删除不出现在卡中。
5. 本地旧会话数据已清空或不可用；无旧格式兼容分支。

---

## 10. 后续可选项（本期不做）

- 变更卡展示 `+/-` 行数（与版本面板对齐）
- 思考 part 默认展开策略的用户设置
- 将 `fileChanges` 一键「保存版本」接入 Workbench
- 会话级「累计净变更」总览（跨多轮）

---

## 附录：已否决的交互

- 工具全置顶 + 吸顶摘要条（不真正交错）
- 连续工具收成 ToolsSection 大折叠组（主路径）
- 思考永远单独置顶、不进 parts
- 用 SessionFileList 的 upload/output 冒充 Git 状态
- 旧消息启发式还原交错
