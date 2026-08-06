# Composer「+」菜单 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 ChatInput 左侧加入「+」菜单，合并附件，并支持技能/MCP/Agent 搜索与全局开关。

**Architecture:** 抽出 `ComposerPlusMenu`；ChatInput 布局加 composer-row；SkillsPage 监听 tab 事件；沿用 useSkills / useToolSearch。

**Tech Stack:** React 18、CSS Modules、`--mt-*` token、vitest

---

### Task 1: 附件 accept 合并 helper

**Files:**
- Modify: `apps/windows/src/renderer/pages/ChatPage/utils/file-attachment-strategy.ts`

新增 `getSupportedAttachmentAccept()` = 文档 + 图片。

### Task 2: ComposerPlusMenu 组件

**Files:**
- Create: `.../ChatInput/ComposerPlusMenu.tsx`
- Create: `.../ChatInput/ComposerPlusMenu.module.css`

主菜单四项 + 技能/MCP/Agent 子面板（搜索、Switch、管理跳转）。

### Task 3: 改造 ChatInput

去掉工具栏 Agent / 双附件按钮；composer-row 放「+」+ textarea；单一 attachment input。

### Task 4: 导航接线

ChatPage 传 `onViewChange`；SkillsPage 监听 `mtbot:open-skills-tab`。

### Task 5: 测试

新增 ComposerPlusMenu / ChatInput 冒烟用例并跑 vitest。
