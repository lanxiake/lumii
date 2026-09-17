# Lumii Logo / 能力槽 / 工作区 Implementation Plan

> **For Claude:** Implement task-by-task.

**Goal:** Logo 重设计 + 多模态能力槽配置 + 工作区初始化修复

**Architecture:** 每槽独立 LocalProvider；IPC listModels/test；订阅 stub；copy 解引用

**Tech Stack:** Electron, React, Node fs, safeStorage

---

### Task 1: provider-config 多槽
- Modify: `apps/windows/src/main/provider-config.ts`
- 结构 `{ version:1, slots: { chat, vision, image } }`，旧单字段迁移到 chat
- `loadSlotConfig(slot)` / `saveProviderSlotsConfig`

### Task 2: IPC listModels + test
- Modify: main index + preload + model-config-service
- `provider:listModels(slot)` / `provider:testConnection(slot)`

### Task 3: Settings UI 槽位卡片
- Modify: SettingsPage 模型配置区

### Task 4: Runtime 消费槽
- chat → bridge-instance-factory
- vision/image → image services / draw env 注入

### Task 5: Logo + 品牌文案
- SVG logo 组件、icon 资源、Sidebar/TitleBar/About/Wizard

### Task 6: 工作区修复
- copyFile dereference；subscription stubs；Gateway 提示
