# 开机仪式感与卡住态 Implementation Plan

> **For agentic workers:** 按任务顺序 TDD 实施；每任务结束跑相关 vitest。

**Goal:** 在现有五幕开机动画上加强仪式感，并实现卡住态（慢呼吸 + 阶段/耗时，无跳过、无假进度）。

**Architecture:** 渲染层 Stall 状态机挂在 `boot-visual`；纯函数可单测；音效经 `onStall` / `setStalled` 联动；不改主进程 IPC。

**Tech Stack:** TypeScript、Canvas2D、CSS、WebAudio、Vitest

## Global Constraints

- Stall 阈值 6s；不提供跳过；进度条不假爬升
- 气质：前克制、cognition/gate 爆发
- 改动限 `boot-visual` / `boot-style` / `boot-audio` / `early-splash`（及测试）

---

### Task 1: Stall 纯函数 + 单测

**Files:**
- Create: `apps/windows/src/renderer/boot/boot-stall.ts`
- Modify: `apps/windows/src/renderer/boot/boot-visual.test.ts`

- [x] 写失败测试：`shouldEnterStall` / `formatStallPhaseText`
- [x] 实现最小纯函数使测试通过

### Task 2: 挂载层 Stall 行为

**Files:**
- Modify: `boot-visual.ts`, `boot-visual.mount.test.ts`

- [x] 写失败挂载测试：超时后 `data-stall=1` 与文案；新阶段清除
- [x] 在 visual 中接入 Stall 定时检查与 `onStall`
- [x] 卡住时冻结进度条；无信号文案「等待启动信号」

### Task 3: 样式与高潮密度

**Files:**
- Modify: `boot-style.ts`, `boot-visual.ts`（核心呼吸 / HUD 密度）

- [x] 前弱后强 CSS；`[data-stall="1"]`；去掉强制 inline 装甲透明度

### Task 4: 音效联动

**Files:**
- Modify: `boot-audio.ts`, `early-splash.ts`

- [x] `setStalled`；early-splash 接线（先视觉后音效）

### Task 5: 验证

- [x] `pnpm --filter ./apps/windows exec vitest run src/renderer/boot`（18 passed）
