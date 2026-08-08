# Task 7 实施报告

## 完成内容

- `ChatMessage` / `useChat.types` 新增 `parts`、`fileChanges` 字段并导出 `AssistantPart` / `FileChangeEntry`。
- `ChatPage` 本地 Runtime 映射：`parts`、`fileChanges` 透传；`content` 优先由 text parts 拼接，回退 content blocks。
- `ChatMessage` 主路径改为 `renderPartsTimeline`：按 parts 顺序渲染 `ThinkingBlock` / markdown / `ToolCallCard`；删除 `renderReasoningTimeline`、`ToolsSection`、`buildSegments`。
- 空 parts + streaming 保留「正在思考」占位；无 parts 的旧消息走 legacy 回退（content + toolItems）。
- `ChatContainer` 子 Agent 合并改为 append `parts` / `fileChanges`，移除 `textPositionAtStart` 推断。
- 新增 `TurnFileChangesCard` stub（标题 + 路径 + 新增/修改/删除标签）。
- `ChatMessage.module.css` 增加 `.parts-timeline` / `.part-block` 间距。

## TDD 与验证

- RED → GREEN：`ChatMessage.parts.test.tsx` 断言 thinking / tool / 两段 text 的 DOM 顺序及流式占位。
- `npx vitest run src/test/components -t "parts|时间线|ChatMessage"`：2 passed。
- IDE lint：修改文件无诊断。

## 注意事项

- Task 8 将完善 `TurnFileChangesCard` 视觉并移除 `SessionFileList` 冗余。
- Gateway 模式仍通过 `workflowItems` / `toolItems` legacy 路径渲染（无 parts 时）。
- `onReviewFileChanges` 已预留 prop，尚未从 ChatPage 接线。

## Review 修复（Task 7 follow-up）

- **HIGH** `ChatContainer`：新增 `mergeAssistantParts`，子 Agent parts 插入父消息末尾连续 text 段之前（Cursor 式交错），不再 pure-append。
- **HIGH** `mergeFileChanges`：父子 `fileChanges` 按 path 去重合并，子条目覆盖同路径父条目。
- **WARNING** `ChatMessage`：`isAborted && hasParts` 路径改为 `wrapSubAgent(renderPartsTimeline())`，与子 Agent 折叠 UI 一致。
- 新增 `mergeAssistantParts.test.ts`（4 cases）；`ChatMessage.parts.test.tsx` 仍绿。
- 验证：`npx vitest run src/renderer/pages/ChatPage/components/ChatContainer/mergeAssistantParts.test.ts src/test/components/ChatMessage.parts.test.tsx` → 6 passed。
