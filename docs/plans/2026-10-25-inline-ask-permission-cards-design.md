# 询问/审批内联消息卡 + 渠道双投递

> 状态：设计已确认，按方案 1 实施  
> 日期：2026-10-25

## 目标

1. 桌面：`ask_user_question` 与工具审批从弹窗/底部遮罩改为**时间线 pinned 消息卡**。
2. 渠道：非 ipc 会话**文字推送 + 桌面卡双投递**；复杂题也文字化；两边都能作答（先到先生效）。
3. 代聊 `pcwechat`：保持 `none`（立即取消）。

## 架构

- 投递门控：`AskUserDelivery` / `PermissionDelivery` 增加 `channel-and-desktop`；渠道承接时仍 `forwardIpcEvent`。
- 渠道 Hub：取消「>3 / multiSelect → 降级回客户端」；一律 `formatAskPrompt`。
- 权限闸门：`requestId = toolCallId`，时间线卡可按 part.id 对齐。
- UI：Phase 3 `registerTimelineCard` 注册 `builtin.ask-user`、`builtin.permission`；移除 `AskUserModal` 挂载与底部全量 `ConfirmationDialog`。
- 跨会话：他会话有 pending 时底部仅保留轻量「去处理」条，不弹完整交互。

## 明确不做

- 拆 `ask_user_card` / `ask_user_text` 两工具
- 飞书原生 interactive 选项回传
- 改宠物 deep link 协议（仍指到会话；卡在时间线）
---

# Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 询问与审批改为时间线内联卡，渠道会话文字+桌面双投递。

**Architecture:** 门控双投递 + TimelineCard 注册；权限 requestId 对齐 toolCallId。

**Tech Stack:** TypeScript、Vitest、React、现有 Phase 3 TimelineCards。

---

### Task 1: 门控双投递

**Files:**
- Modify: `apps/windows/src/main/channel/desktop-interaction-gate.ts`
- Modify: `apps/windows/src/main/channel/desktop-interaction-gate.test.ts`
- Modify: `apps/windows/src/main/channel/channel-interaction-hub.ts`
- Modify: `apps/windows/src/main/agent-runtime/bridge.ts`
- Modify: `apps/windows/src/main/agent-runtime/bridge-instance-factory.ts`

**Steps:** TDD 改 `resolveAskUserDelivery` → `channel-and-desktop`；`canChannelHandleQuestions` 恒 true（或删除调用）；bridge 在 desktop / channel-and-desktop 都发 IPC；permission 同理。

### Task 2: 权限 requestId = toolCallId

**Files:**
- Modify: `packages/agent-runtime/src/host-kit/permission-gate-hook.ts`
- Test: 相关 permission-gate 测试

### Task 3: AskUser 内联卡

**Files:**
- Create: `AskUserCard`（复用 AskUserModal 表单逻辑，去 Modal 壳）
- Modify: `TimelineCards/builtin.tsx`
- Modify: `ChatPage.tsx` 移除 AskUserModal

### Task 4: Permission 内联卡

**Files:**
- Create: `PermissionCard`（复用 ConfirmationDialog 内容）
- Modify: builtin 注册；`ChatBottomOverlay` 去掉全量审批卡，仅保留跨会话提示

### Task 5: 验证

- vitest：gate、hub、TimelineCards、ChatMessage parts、AskUser 单测
- `pnpm --filter ./apps/windows` 相关测试 + typecheck
