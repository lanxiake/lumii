# Task 5 实施报告

## 完成内容

- 在普通 Agent prompt 调用前捕获工作区起始快照，失败时清空起点并记录警告。
- 在 `agent:end` 持久化前捕获结束快照并计算净变更，写入 `assistant_parts.fileChanges`。
- 新增 `agent:turn:file-changes` 共享 IPC 事件，并在消息持久化成功后携带真实消息 ID 转发。
- 结束快照失败时不写 `fileChanges`、不发送文件变更事件，并清理本轮快照状态。

## 验证

- `pnpm exec vitest run "src/main/agent-runtime/bridge-agent-instance-events.test.ts" "src/main/workspace-vcs/workspace-turn-snapshot.test.ts"`：2 个测试文件、11 个测试全部通过。
- `git diff --check`：通过。
- IDE lint：本任务修改文件无诊断。
- `pnpm typecheck`：未通过；失败项均为仓库现有的无关类型错误，本任务修改文件没有出现在错误列表中。

## 注意事项

- `captureWorkspaceTurnSnapshot` 当前虽返回 Promise，但内部使用同步文件系统遍历；大型工作区可能短暂阻塞主进程，本任务保持既有实现不扩展范围。

## Important/High Review 修复

- 将运行时事件处理器恢复为同步 `void` 入口；内部异步处理统一使用显式 `.catch(...)` 记录错误，调用方无需 `await` 且不会产生未处理拒绝。
- 直接生图分支在生成前捕获起始快照，成功后计算净变更、持久化关联的 `assistant_parts` 消息，并通过真实消息 ID 发送 `agent:turn:file-changes`。
- 直接生图失败或中断时同样清理并完成快照生命周期，避免起点状态污染下一轮。
- 新增同步返回契约和直接生图文件变更回归测试。

## Review 修复验证

- `pnpm exec vitest run "src/main/agent-runtime/bridge-agent-instance-events.test.ts" "src/main/agent-runtime/bridge-prompt-dispatcher.test.ts"`：2 个测试文件、8 个测试全部通过。
- `git diff --check`：通过。
- IDE lint：本次修改文件无诊断。
- `pnpm typecheck`：仍被仓库既有无关类型错误阻断；本次修改文件未出现在错误列表中。
