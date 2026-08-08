# Task 4 报告：Bridge 持久化 assistant_parts

## 实现结果

- `InstanceState` 以 `pendingParts: AssistantPart[]` 作为助手轮次正文、思考和工具状态的唯一真相，并预留可选 `turnSnapshotStart`。
- `message:thinking`、`message:delta`、`tool:start`、`tool:end` 均通过 `applyAssistantPartEvent` 更新 parts。
- 占位、流式更新、`message:end`、`agent:error`、`agent:end` 以及降级补写均持久化 `type: 'assistant_parts'`。
- 最终落库统一调用 `finalizeAssistantParts`；原始 `<think>` 标签按 text part 逐段清理，仅在没有事件型 thinking part 时增加兜底 thinking part。
- 高频 token 持久化按 100ms 合并，工具边界和终态强制刷新，避免工具大结果随每个 token 同步重复写库。

## 测试

- `packages/agent-runtime`: `pnpm test`，71 个文件、557 项测试通过。
- `apps/windows`: `pnpm exec vitest run src/main`，33 个文件通过，224 项通过、51 项跳过。
- 新增 bridge 回归测试覆盖唯一状态、终态 parts、`<think>` 兜底、多段工具时间线、已有 thinking 和前导空白保留。
- `tsc --noEmit`：本次修改文件无新增错误；仓库仍存在 `bridge-tool-registrar.ts`、`bridge-utils.ts`、`bridge.ts` 既有类型错误及其他跨包既有错误。
- IDE lint：修改文件无诊断。

## 后续关注

- `fileChanges` 与工作区快照由 Task 5 接入。
- Bridge 外其他历史 `type: 'text'` 写入点及专用读侧不在本任务范围，应在后续迁移任务统一处理。
