# 对话时间线交错展示与回合文件净变更 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 助手气泡按 `parts[]` 时间线交错渲染思考/正文/工具，并在回合结束于气泡底部展示本轮工作区净文件变更（新增/修改/删除）。

**Architecture:** 以 `AssistantPartsContent`（`type: 'assistant_parts'`）为存储与 UI 唯一真相；主进程与渲染进程共用纯函数 `applyAssistantPartEvent` 维护 parts。回合 `prompt` 开始与 `idle` 对工作区做轻量快照 diff，结果写入同条消息的 `fileChanges`。不做旧格式兼容，开发期清空 `~/.lumii` 会话库。

**Tech Stack:** TypeScript、Electron main/renderer、`packages/agent-runtime` 存储层、Vitest、现有 `ToolCallCard` / Chat 粘底滚动

**规格:** `docs/plans/2026-08-08-chat-timeline-file-changes-design.md`

## Global Constraints

- 不做旧 `type:'text'+thinkingText+toolCalls` 兼容解析；上线前清空本地会话数据
- 变更卡标签仅「新增/修改/删除」；无上传、无 `+/-` 行数
- 连续工具每条单独一行；思考进入 parts 时间线
- Schema 表结构不变则不必 bump `SCHEMA_VERSION`（仅换 `content_json` 形态）
- 注释与用户可见文案用中文；函数级注释必加

## File Structure

| 文件 | 职责 |
|------|------|
| `packages/agent-runtime/src/storage/assistant-parts.ts` | `AssistantPart` 类型、`applyAssistantPartEvent`、`diffTurnSnapshots`、`partsToPiMessages` 辅助 |
| `packages/agent-runtime/src/storage/conversation-repo.ts` | `AssistantPartsContent`、parse、落库、`messageRowToAgentMessages` |
| `apps/windows/src/main/workspace-vcs/workspace-turn-snapshot.ts` | 工作区路径→hash 快照 |
| `apps/windows/src/main/agent-runtime/bridge-*` | 维护 `pendingParts`；start/end 快照；persist `assistant_parts` |
| `apps/windows/src/shared/agent-runtime-events.ts` | 可选 `agent:turn:file-changes` |
| `apps/windows/.../event-handler.ts` + `agent-runtime-store.ts` | `RuntimeMessage.parts` / `fileChanges` |
| `apps/windows/.../useChat.types.ts` + `ChatPage.tsx` | `ChatMessage.parts` 映射 |
| `apps/windows/.../ChatMessage/index.tsx` | 按 parts 渲染；删 ToolsSection 主路径 |
| `apps/windows/.../TurnFileChangesCard/` | 气泡底部净变更卡 |
| `apps/windows/.../ChatContainer/index.tsx` | 移除会话级 SessionFileList inline 驱动变更展示 |

---

### Task 1: `assistant-parts` 纯函数（类型 + 流式归约 + diff）

**Files:**
- Create: `packages/agent-runtime/src/storage/assistant-parts.ts`
- Create: `packages/agent-runtime/src/storage/assistant-parts.test.ts`
- Modify: `packages/agent-runtime/src/index.ts`（导出公开类型与函数）

**Interfaces:**
- Produces:
  - `AssistantPart`, `FileChangeEntry`, `AssistantPartsContent`
  - `AssistantPartEvent`（归约输入）
  - `applyAssistantPartEvent(parts, event): AssistantPart[]`
  - `finalizeAssistantParts(parts): AssistantPart[]`
  - `TurnFileSnapshot = ReadonlyMap<string, string>`（path → contentHash；不存在则无 key）
  - `diffTurnSnapshots(start, end): FileChangeEntry[]`

- [ ] **Step 1: 写失败测试**

```ts
// packages/agent-runtime/src/storage/assistant-parts.test.ts
import { describe, expect, it } from "vitest";
import {
  applyAssistantPartEvent,
  finalizeAssistantParts,
  diffTurnSnapshots,
} from "./assistant-parts.js";

describe("applyAssistantPartEvent", () => {
  it("连续 text delta 合并到同一 streaming text part", () => {
    let parts = applyAssistantPartEvent([], { kind: "text_delta", delta: "你" });
    parts = applyAssistantPartEvent(parts, { kind: "text_delta", delta: "好" });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: "text", text: "你好", status: "streaming" });
  });

  it("thinking → tool → thinking 拆成三段，不合并首尾 thinking", () => {
    let parts = applyAssistantPartEvent([], { kind: "thinking_delta", delta: "先想" });
    parts = applyAssistantPartEvent(parts, { kind: "thinking_end" });
    parts = applyAssistantPartEvent(parts, {
      kind: "tool_start",
      id: "t1",
      name: "file_read",
      args: { path: "a.ts" },
    });
    parts = applyAssistantPartEvent(parts, { kind: "thinking_delta", delta: "再想" });
    expect(parts.map((p) => p.type)).toEqual(["thinking", "tool", "thinking"]);
    expect(parts[0]).toMatchObject({ type: "thinking", text: "先想", status: "done" });
    expect(parts[2]).toMatchObject({ type: "thinking", text: "再想", status: "streaming" });
  });

  it("tool_end 按 id patch；乱序先 stub 再补全", () => {
    let parts = applyAssistantPartEvent([], {
      kind: "tool_end",
      id: "t1",
      name: "bash",
      result: "ok",
      isError: false,
    });
    expect(parts[0]).toMatchObject({ type: "tool", id: "t1", status: "done", result: "ok" });
    parts = applyAssistantPartEvent(parts, {
      kind: "tool_start",
      id: "t1",
      name: "bash",
      args: { command: "ls" },
    });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: "tool", args: { command: "ls" }, status: "done" });
  });
});

describe("diffTurnSnapshots", () => {
  it("新增/修改/删除；创建又删不出现；hash 不变不出现", () => {
    const start = new Map([
      ["a.ts", "h1"],
      ["b.ts", "h2"],
    ]);
    const end = new Map([
      ["b.ts", "h2-changed"],
      ["c.ts", "h3"],
    ]);
    const diff = diffTurnSnapshots(start, end);
    expect(diff).toEqual([
      { path: "c.ts", status: "added" },
      { path: "b.ts", status: "modified" },
      { path: "a.ts", status: "deleted" },
    ]);
  });

  it("start/end 皆无某路径 → 不收录", () => {
    expect(diffTurnSnapshots(new Map(), new Map())).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `cd packages/agent-runtime && pnpm exec vitest run src/storage/assistant-parts.test.ts`

Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `assistant-parts.ts`**

实现要点（须含函数级中文注释）：

```ts
export type AssistantPart =
  | { type: "thinking"; id: string; text: string; status: "streaming" | "done" }
  | { type: "text"; id: string; text: string; status: "streaming" | "done" }
  | {
      type: "tool";
      id: string;
      name: string;
      args: Record<string, unknown>;
      result?: unknown;
      isError?: boolean;
      status: "running" | "done" | "error";
      meta?: { sourceAgent?: { instanceId: string; label: string } };
    };

export type FileChangeEntry = {
  path: string;
  status: "added" | "modified" | "deleted";
};

export type AssistantPartsContent = {
  type: "assistant_parts";
  parts: AssistantPart[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  sourceAgent?: { instanceId: string; label: string };
  fileChanges?: FileChangeEntry[];
};

export type AssistantPartEvent =
  | { kind: "thinking_delta"; delta: string }
  | { kind: "thinking_end" }
  | { kind: "text_delta"; delta: string }
  | {
      kind: "tool_start";
      id: string;
      name: string;
      args: Record<string, unknown>;
      meta?: AssistantPart extends { type: "tool" } ? AssistantPart["meta"] : never;
    }
  | {
      kind: "tool_end";
      id: string;
      name: string;
      result: unknown;
      isError: boolean;
    };

/** 将流式事件归约进 parts；同类连续增量只 patch 末尾同类型 streaming part */
export function applyAssistantPartEvent(
  parts: readonly AssistantPart[],
  event: AssistantPartEvent,
): AssistantPart[] { /* ... */ }

/** idle 时把所有 streaming 标为 done */
export function finalizeAssistantParts(parts: readonly AssistantPart[]): AssistantPart[] { /* ... */ }

/**
 * 对比两轮快照。排序：added → modified → deleted，同组 path 字典序。
 * path 统一为正斜杠相对路径。
 */
export function diffTurnSnapshots(
  start: ReadonlyMap<string, string>,
  end: ReadonlyMap<string, string>,
): FileChangeEntry[] { /* ... */ }
```

`id` 生成：thinking/text 用 `crypto.randomUUID()` 或递增 `th-${n}` / `tx-${n}`（主进程 Node 可用 `randomUUID`；纯函数测试可注入 `createId?: () => string`）。

- [ ] **Step 4: 跑测通过**

Run: `cd packages/agent-runtime && pnpm exec vitest run src/storage/assistant-parts.test.ts`

Expected: PASS

- [ ] **Step 5: 从包入口导出并提交**

```bash
git add packages/agent-runtime/src/storage/assistant-parts.ts packages/agent-runtime/src/storage/assistant-parts.test.ts packages/agent-runtime/src/index.ts
git commit -m "$(cat <<'EOF'
feat(agent-runtime): add assistant parts reducer and turn file diff

EOF
)"
```

---

### Task 2: 存储层解析与 LLM 投影

**Files:**
- Modify: `packages/agent-runtime/src/storage/conversation-repo.ts`
- Modify: `packages/agent-runtime/src/__tests__/message-row-to-agent-messages.test.ts`
- Test: 同上 + 可增 `parse-assistant-parts.test.ts`（或并入现有测）

**Interfaces:**
- Consumes: `AssistantPartsContent`, `AssistantPart`（Task 1）
- Produces: `parseMessageContentJson` 识别 `assistant_parts`；`messageRowToAgentMessages` 按 parts 顺序投影

- [ ] **Step 1: 改写/新增失败测试**

将 `message-row-to-agent-messages.test.ts` 主用例改为 `assistant_parts`，并增加交错顺序断言：

```ts
it("assistant_parts 按 parts 顺序投影 thinking/text/toolCall，并展开 toolResult", () => {
  const row = {
    id: "m1",
    conversation_id: "c1",
    agent_id: null,
    role: "assistant",
    content_json: JSON.stringify({
      type: "assistant_parts",
      parts: [
        { type: "thinking", id: "th1", text: "分析", status: "done" },
        { type: "text", id: "tx1", text: "开始", status: "done" },
        {
          type: "tool",
          id: "tc1",
          name: "bash",
          args: { command: "ls" },
          result: "ok",
          isError: false,
          status: "done",
        },
        { type: "text", id: "tx2", text: "完成", status: "done" },
      ],
    }),
    timestamp: "2026-07-05T10:00:00.000Z",
    is_streaming: 0,
  };
  const msgs = messageRowToAgentMessages(row);
  expect(msgs).toHaveLength(2);
  const blocks = msgs[0]!.content as Array<{ type: string; text?: string; thinking?: string; id?: string }>;
  expect(blocks.map((b) => b.type)).toEqual(["thinking", "text", "toolCall", "text"]);
  expect(blocks[1]?.text).toBe("开始");
  expect(blocks[3]?.text).toBe("完成");
});
```

删除或不再依赖旧 `type:text + toolCalls` 用例（规格：无兼容）。

- [ ] **Step 2: 跑测确认失败**

Run: `cd packages/agent-runtime && pnpm exec vitest run src/__tests__/message-row-to-agent-messages.test.ts`

Expected: FAIL（仍只认 `type:text`）

- [ ] **Step 3: 更新 conversation-repo**

1. `MessageContentJson = AssistantPartsContent | TextMessageContent | ToolResultContent`  
   - `TextMessageContent` **仅保留给 user/system**（`isVoice` 等）；assistant 新写入只用 `assistant_parts`
2. `parseMessageContentJson`：`o.type === "assistant_parts"` 时校验 `parts` 数组并返回
3. `messageRowToAgentMessages`：
   - `parsed.type === "assistant_parts"` → 遍历 parts 组 assistant blocks；每个完成的 tool 再 push toolResult 消息（保持现有展开语义）
   - `parsed.type === "text"` 且 `row.role === "user"` → 现有 user 逻辑
   - assistant + 旧 text：**直接返回 [] 或忽略**（开发期已清库，不必迁移）

同时排查 `finalizeAllStreamingMessages` / `saveMessage` 类型，确保 `contentJson` 联合类型接受 `assistant_parts`。

- [ ] **Step 4: 跑测通过**

Run: `cd packages/agent-runtime && pnpm exec vitest run src/__tests__/message-row-to-agent-messages.test.ts src/storage/`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agent-runtime/src/storage/conversation-repo.ts packages/agent-runtime/src/__tests__/message-row-to-agent-messages.test.ts
git commit -m "$(cat <<'EOF'
feat(agent-runtime): persist and project assistant_parts content

EOF
)"
```

---

### Task 3: 工作区回合快照

**Files:**
- Create: `apps/windows/src/main/workspace-vcs/workspace-turn-snapshot.ts`
- Create: `apps/windows/src/main/workspace-vcs/workspace-turn-snapshot.test.ts`
- Reuse: `apps/windows/src/main/workspace-vcs/vcs-ignore.ts` 的忽略规则思想；`node:fs` / `node:crypto`

**Interfaces:**
- Consumes: `diffTurnSnapshots`（Task 1）
- Produces:
  - `captureWorkspaceTurnSnapshot(workspaceDir: string): Promise<Map<string, string>>`
  - 失败抛错或返回 `null`（由调用方决定跳过 fileChanges）

- [ ] **Step 1: 写失败测试（用临时目录）**

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureWorkspaceTurnSnapshot } from "./workspace-turn-snapshot";
import { diffTurnSnapshots } from "@mtbot/agent-runtime"; // 或相对路径到包导出

describe("captureWorkspaceTurnSnapshot", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumii-snap-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("捕获相对路径 hash；忽略 node_modules；支持净变更", async () => {
    fs.writeFileSync(path.join(dir, "a.ts"), "v1");
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.writeFileSync(path.join(dir, "node_modules", "x.js"), "lib");
    const start = await captureWorkspaceTurnSnapshot(dir);
    expect(start.has("a.ts")).toBe(true);
    expect([...start.keys()].some((k) => k.includes("node_modules"))).toBe(false);

    fs.writeFileSync(path.join(dir, "a.ts"), "v2");
    fs.writeFileSync(path.join(dir, "b.ts"), "new");
    fs.unlinkSync(path.join(dir, "a.ts")); // 删 a，留 b → a deleted, b added（相对 start）
    // 重新写回场景在实现测里分开：这里改为只改 b
  });
});
```

修正最后断言为清晰场景：start 有 a；end 改 a + 加 b + 加又删 tmp → 仅 modified a + added b。

- [ ] **Step 2: 跑测失败**

Run: `cd apps/windows && npx vitest run src/main/workspace-vcs/workspace-turn-snapshot.test.ts`

Expected: FAIL

- [ ] **Step 3: 实现快照**

```ts
/**
 * 递归遍历工作区，返回相对 posix 路径 → sha256(内容) 映射。
 * 跳过：node_modules、.git、.mtbot-vcs、tmp/temp/.cache，以及 DEFAULT_VCS_IGNORE 中的大文件模式。
 * workspaceDir 无效或不存在时抛错。
 */
export async function captureWorkspaceTurnSnapshot(
  workspaceDir: string,
): Promise<Map<string, string>> { /* walk + createHash('sha256') */ }
```

性能：可跳过单文件 > 2MB（只记 size+mtime 合成伪 hash，或直接跳过并打 debug 日志）；与规格「轻量」一致即可。

- [ ] **Step 4: 跑测通过 + Commit**

```bash
git add apps/windows/src/main/workspace-vcs/workspace-turn-snapshot.ts apps/windows/src/main/workspace-vcs/workspace-turn-snapshot.test.ts
git commit -m "$(cat <<'EOF'
feat(windows): add workspace turn snapshot for net file changes

EOF
)"
```

---

### Task 4: Bridge 维护 `pendingParts` 并按 `assistant_parts` 落库

**Files:**
- Modify: `apps/windows/src/main/agent-runtime/bridge-agent-instance-events.ts`
- Modify: instance state 类型所在文件（同文件或 `bridge-types.ts`：增加 `pendingParts`、`turnSnapshotStart`）
- Modify: 所有 `contentJson: { type: 'text', text, thinkingText, toolCalls }` 的 assistant 写入点 → `assistant_parts`

**Interfaces:**
- Consumes: `applyAssistantPartEvent`, `finalizeAssistantParts`, `AssistantPartsContent`
- Produces: DB 中 assistant 消息为 `type:'assistant_parts'`

- [ ] **Step 1: 梳理写入点并加回归测（若有 bridge 单测则改；否则先改实现，用手工/后续 UI 测）**

至少替换这些位置（行号约）：
- `persistStreamingAssistant` 辅助（约 48–70）
- `agent:start` 占位 content（约 252）
- message 中途 update（约 372、421–470）
- `agent:error` / `agent:end` 收尾（约 500–590）

- [ ] **Step 2: 扩展 instance state**

```ts
pendingParts: AssistantPart[]
// 保留 accumulatedText / accumulatedThinking / pendingTools 仅作过渡则禁止：规格要求唯一真相，直接只维护 pendingParts
turnSnapshotStart?: Map<string, string>
```

在对应事件里调用：
- thinking 增量/结束 → `thinking_delta` / `thinking_end`
- text delta → `text_delta`（从现有 delta 路径接入；注意去掉重复写入平行字段）
- tool start/end → `tool_start` / `tool_end`（可带 `meta.sourceAgent`）

落库：

```ts
contentJson: {
  type: 'assistant_parts',
  parts: finalizeAssistantParts(state.pendingParts),
  ...(usage ? { usage } : {}),
  ...(sourceAgentInfo ? { sourceAgent: sourceAgentInfo } : {}),
  ...(fileChanges && fileChanges.length > 0 ? { fileChanges } : {}),
}
```

- [ ] **Step 3: 从 raw `<think>` 解析的路径**

若仍用 `parseThinkTagsFromRaw`：在最终 finalize 时，若 parts 里尚无 thinking 而 tag 有内容，则 **unshift** 一个 done thinking part（仅兜底），正文用 finalText 对应 text parts。优先以 `message:thinking` 事件驱动 parts。

- [ ] **Step 4: 跑 agent-runtime 相关测 + windows main 测**

Run:
```bash
cd packages/agent-runtime && pnpm test
cd apps/windows && npx vitest run src/main
```

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(windows): persist assistant messages as assistant_parts timeline

EOF
)"
```

---

### Task 5: 回合快照挂钩 + `fileChanges` 事件

**Files:**
- Modify: `apps/windows/src/main/agent-runtime/bridge-prompt-dispatcher.ts`（或 `bridge-agent-instance-events.ts` 的 `agent:start`）
- Modify: `apps/windows/src/main/agent-runtime/bridge-agent-instance-events.ts`（`agent:end`）
- Modify: `apps/windows/src/shared/agent-runtime-events.ts`
- Modify: `apps/windows/src/main/agent-runtime/event-converter.ts`（若需转发新事件）

**Interfaces:**
- Produces:
```ts
export interface AgentTurnFileChangesEvent {
  readonly type: 'agent:turn:file-changes'
  readonly runId: string
  readonly sessionKey: string
  readonly messageId: string
  readonly fileChanges: readonly FileChangeEntry[]
}
```

- [ ] **Step 1: start 快照**

在 prompt 即将 `instance.prompt` 之前或 `agent:start` 时：

```ts
const cwd = getCwd()
try {
  state.turnSnapshotStart = await captureWorkspaceTurnSnapshot(cwd)
} catch (err) {
  log.warn('[turn-snapshot] start failed', err)
  state.turnSnapshotStart = undefined
}
```

- [ ] **Step 2: end 对比并写入**

在 `agent:end` 持久化成功前：

```ts
let fileChanges: FileChangeEntry[] | undefined
if (state.turnSnapshotStart) {
  try {
    const endSnap = await captureWorkspaceTurnSnapshot(getCwd())
    fileChanges = diffTurnSnapshots(state.turnSnapshotStart, endSnap)
  } catch (err) {
    log.warn('[turn-snapshot] end failed', err)
  }
}
// 写入 contentJson.fileChanges；并 forwardIpcEvent({ type: 'agent:turn:file-changes', ... })
```

清空 `turnSnapshotStart`。

- [ ] **Step 3: 单测 diff 已在 Task1；此处可对 event-converter 做轻量测（可选）**

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(windows): attach per-turn workspace fileChanges on agent idle

EOF
)"
```

---

### Task 6: Renderer store + event-handler 改为 parts

**Files:**
- Modify: `apps/windows/src/renderer/hooks/business/useAgentRuntime/agent-runtime-store.ts`
- Modify: `apps/windows/src/renderer/hooks/business/useAgentRuntime/event-handler.ts`
- Modify: `apps/windows/src/renderer/hooks/business/useAgentRuntime/useAgentRuntime.ts`（session 加载映射）
- Modify: `apps/windows/src/shared/agent-runtime-events.ts` 的 `ContentBlock` 若仍被引用则收敛
- Test: `apps/windows/src/renderer/hooks/business/useAgentRuntime/agent-runtime-store.test.ts`（若存在）或 `src/test/hooks/`

**Interfaces:**
- Produces:
```ts
interface RuntimeMessage {
  // ...
  parts: AssistantPart[]  // assistant 必填；user 可空数组
  fileChanges?: FileChangeEntry[]
  // 删除或停止写入：thinkingText、toolCalls 作为主路径；过渡期可读但勿双写
}
```

- [ ] **Step 1: 写/改 handler 测试**

覆盖：`thinking_delta`→`tool_start`→`text_delta` 后 `message.parts` 顺序；`agent:turn:file-changes` 写入 `fileChanges`。

- [ ] **Step 2: 实现 handler**

在 `handleRuntimeEvent` 中：
- `agent:thinking:delta/end` → `applyAssistantPartEvent`
- `agent:message:delta` → `text_delta`（注意与现有 batch flush 兼容：flush 时对累积字符串一次性或多个 delta 归约）
- `agent:tool:start/end` → tool 事件
- `agent:idle` → `finalizeAssistantParts`
- `agent:turn:file-changes` → `fileChanges`
- `agent:message:end`：若带完整 content，以服务端 parts 为准覆盖（若 end 事件仍只带字符串，则忽略旧字段，信任本地 parts）

加载历史：`parseMessageContentJson` → `assistant_parts` → `RuntimeMessage.parts`。

- [ ] **Step 3: 跑测**

Run: `cd apps/windows && npx vitest run src/renderer/hooks/business/useAgentRuntime src/test/hooks`

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(windows): drive runtime messages from assistant parts timeline

EOF
)"
```

---

### Task 7: ChatPage / ChatMessage 类型映射与时间线 UI

**Files:**
- Modify: `apps/windows/src/renderer/hooks/business/useChat/useChat.types.ts`
- Modify: `apps/windows/src/renderer/pages/ChatPage/ChatPage.tsx`（约 235–258 映射）
- Modify: `apps/windows/src/renderer/pages/ChatPage/components/ChatMessage/index.tsx`
- Modify: `ChatMessage.module.css`（part 间距）
- Modify: `ChatContainer/index.tsx`（子 Agent 合并改为基于 parts，删除 `textPositionAtStart` 推断）
- Test: `apps/windows/src/test/components/ChatPage.test.tsx` 或新增 `ChatMessage.parts.test.tsx`

**Interfaces:**
- `ChatMessage` 增加 `parts?: AssistantPart[]`、`fileChanges?: FileChangeEntry[]`
- `renderAssistantBody`：按 `parts` 顺序渲染 `ThinkingBlock` / markdown / `ToolCallCard`

- [ ] **Step 1: 组件测（DOM 顺序）**

用 testing-library 渲染带 4 个 parts 的助手消息，断言 thinking 文案、工具名、两段正文的先后顺序。

- [ ] **Step 2: 实现渲染**

```tsx
/** 按 parts 时间线渲染助手气泡（Cursor 式交错） */
const renderAssistantBody = () => {
  const parts = message.parts ?? []
  return wrapSubAgent(
    <>
      {parts.map((part) => {
        if (part.type === 'thinking') {
          return (
            <ThinkingBlock
              key={part.id}
              thinkingText={part.text}
              isStreaming={part.status === 'streaming' && !!message.isStreaming}
              isLive={!!message.isStreaming}
            />
          )
        }
        if (part.type === 'text') {
          return (
            <div key={part.id} className={styles['message-text']}>
              {renderTextContent(part.text)}
              {part.status === 'streaming' && message.isStreaming && (
                <span className={styles['streaming-cursor']} />
              )}
            </div>
          )
        }
        // tool → 映射为 AgentWorkflowItem 喂给现有 ToolCallCard
        return <ToolCallCard key={part.id} item={toWorkflowItem(part)} ... />
      })}
      {message.fileChanges && message.fileChanges.length > 0 && (
        <TurnFileChangesCard
          changes={message.fileChanges}
          onReview={onReviewFileChanges}
        />
      )}
    </>,
  )
}
```

删除主路径：`renderReasoningTimeline` + 顶部 `ToolsSection`；删除未使用的 `buildSegments`。

空 parts + streaming：保留「正在思考」占位。

- [ ] **Step 3: ChatPage 映射**

```ts
parts: msg.parts,
fileChanges: msg.fileChanges,
// 兼容派生：content 可改为 parts 中 text 拼接，供复制/编辑
content: msg.parts.filter(p => p.type==='text').map(p => p.text).join('\n\n'),
```

- [ ] **Step 4: 跑测**

Run: `cd apps/windows && npx vitest run src/test/components -t "parts|时间线|ChatMessage"`

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(windows): render assistant chat bubbles as interleaved parts timeline

EOF
)"
```

---

### Task 8: `TurnFileChangesCard` + 移除会话级 inline SessionFileList 变更展示

**Files:**
- Create: `apps/windows/src/renderer/pages/ChatPage/components/TurnFileChangesCard/index.tsx`
- Create: `apps/windows/src/renderer/pages/ChatPage/components/TurnFileChangesCard/TurnFileChangesCard.module.css`
- Create: `apps/windows/src/test/components/TurnFileChangesCard.test.tsx`
- Modify: `ChatContainer/index.tsx` — 去掉（或不再传入）对话流内用 `fileEvents` 渲染的 SessionFileList inline 卡
- Modify: `ChatPage.tsx` — `onReview` 打开 Workbench 并定位首个 path

**Interfaces:**
```ts
export interface TurnFileChangesCardProps {
  changes: readonly FileChangeEntry[]
  onReview?: (path: string) => void
}
```

- [ ] **Step 1: 组件测**

- 渲染 3 条：断言文案含「新增」「修改」「删除」或 `A`/`M`/`D` + 中文（实现时统一：右侧中文标签「新增|修改|删除」，左侧可用短标）
- `changes=[]` → 不渲染
- 无 `+`/`−` 行数节点

- [ ] **Step 2: 实现 UI**

视觉可参考 SessionFileList inline（扩展名徽章 + 行），但数据源为 `FileChangeEntry`。标题：`{n} 个文件变更`；按钮「查看」。

- [ ] **Step 3: ChatContainer**

删除：

```tsx
<SessionFileList files={fileEvents ?? []} variant="inline" ... />
```

（rail/composer 若仍用 SessionFileList 展示上传/产出，可保留非 inline；规格只要求对话流变更卡换源。）

- [ ] **Step 4: 跑测 + Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(windows): show per-turn net file changes card under assistant bubble

EOF
)"
```

---

### Task 9: 清理双轨字段与开发期数据重置说明

**Files:**
- Modify: 全局清理 `textPositionAtStart` 主路径写入（event-handler、ChatContainer 推断逻辑）
- Modify: `docs/plans/2026-08-08-chat-timeline-file-changes-design.md` 状态 →「实施中/已完成」
- Optional: README 或 `apps/windows/.env.example` 旁注：升级需清空 `~/.lumii` 会话 DB

- [ ] **Step 1: rg 检查残留**

Run:
```bash
rg "textPositionAtStart|thinkingText|type: 'text'.*toolCalls|ToolsSection|buildSegments" apps/windows/src packages/agent-runtime/src --glob '*.{ts,tsx}'
```

处理：assistant 主路径不应再写旧结构；user 的 `TextMessageContent` 保留。

- [ ] **Step 2: typecheck**

Run:
```bash
pnpm typecheck
```

Expected: 无因 parts 迁移导致的错误

- [ ] **Step 3: 手工验收清单（写入 PR 描述）**

1. 清空本地数据后新会话
2. 触发多工具 + 长回复：工具夹在正文中间
3. 写文件→再删临时文件：卡中无该路径
4. 仅新增/修改/删除标签，无行数、无上传
5. 重启应用后历史时间线与 fileChanges 仍在

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
chore: remove legacy assistant timeline fields and document data reset

EOF
)"
```

---

## 建议 PR 拆分

1. **PR1:** Task 1–2（纯函数 + 存储投影）— 可先合，行为未变 UI  
2. **PR2:** Task 4–6（bridge + renderer parts 管道）— 时间线数据就绪  
3. **PR3:** Task 3+5+7+8+9（快照、卡片、UI、清理）— 完整用户可见功能  

或按 Task 顺序单人连续提交（本计划默认）。

---

## Spec Coverage（自检）

| 规格条目 | Task |
|----------|------|
| `parts[]` 唯一真相 | 1, 2, 4, 6, 7 |
| 思考交错进时间线 | 1, 4, 6, 7 |
| 工具单行 | 7 |
| 回合 start→idle 净变更 | 3, 5 |
| 临时文件不出现 | 1 diff + 3/5 |
| 卡在气泡底；无上传无行数 | 8 |
| 无旧格式兼容 / 清库 | 2, 9 |
| LLM 投影顺序 | 2 |
| 快照失败不展示卡 | 5 |
| 删除 SessionFileList 会话累计驱动 | 8 |

## Placeholder / 类型一致性自检

- 统一使用 `AssistantPart` / `FileChangeEntry` / `AssistantPartsContent` / `applyAssistantPartEvent` / `diffTurnSnapshots` / `captureWorkspaceTurnSnapshot`
- 事件名统一 `agent:turn:file-changes`
- 无 TBD；旧 `type:text` assistant 写入点在 Task 4 全部替换

---

Plan complete and saved to `docs/plans/2026-08-08-chat-timeline-file-changes-implementation.md`.

**两种执行方式：**

1. **Subagent-Driven（推荐）** — 本会话按 Task 派生子代理，任务间审查  
2. **Inline Execution** — 本会话按 executing-plans 连续执行并设检查点  

要哪种？
