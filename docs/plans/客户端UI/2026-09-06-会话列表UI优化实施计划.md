# Session List UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将会话列表改为参考图风格的单行布局，强化选中与 Agent 运行中状态。

**Architecture:** 仅改渲染层 `SessionItem` + 少量侧栏间距；复用现有 `ContextMenu` 与 `isStreaming` 字段。

**Tech Stack:** React、CSS Modules、lucide-react、Vitest

---

### Task 1: Icon 导出

**Files:**
- Modify: `apps/windows/src/renderer/components/ui/Icon/index.tsx`

导出 `MoreHorizontal`、`Circle`（`Loader2` / `Pin` 已有）。

### Task 2: SessionItem 重构

**Files:**
- Modify: `apps/windows/src/renderer/pages/ChatPage/components/SessionItem/index.tsx`
- Modify: `apps/windows/src/renderer/pages/ChatPage/components/SessionItem/SessionItem.module.css`

单行布局、状态图标、`···` 打开菜单、去掉预览/时间/行内操作按钮。

### Task 3: 侧栏间距

**Files:**
- Modify: `apps/windows/src/renderer/pages/ChatPage/components/ChatSidebar/ChatSidebar.module.css`

列表行距微调，更贴近参考图。

### Task 4: 测试

**Files:**
- Modify: `apps/windows/src/test/components/SessionItem.test.tsx`

去掉预览相关用例；悬停操作改为测 `···`；补充 streaming / more-menu 用例。

```bash
pnpm --filter ./apps/windows test -- src/test/components/SessionItem.test.tsx
```
