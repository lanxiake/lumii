# 开机仪式感与卡住态设计

> 日期：2026-11-08  
> 状态：已确认（方案 1）  
> 范围：一期开机动画；二期主界面图标/微交互另开

## 1. 目标

提升 Lumii 开机画面的科技感、仪式感与高级感；当某一启动阶段长时间无进展时，画面仍明确「活着在等」，而不是假推进或死机感。

## 2. 决策摘要

| 项 | 选择 |
| --- | --- |
| 分期 | 先打透开机，再扩主界面 |
| 气质 | 混合：外壳克制极简，高潮（cognition / gate）仪式爆发 |
| 卡住态 | 慢呼吸 + 阶段友好名 + 已等待秒数；进度条数值冻结 |
| 卡住跳过 | 不提供；沿用现有就绪超时兜底 |
| 实现路径 | 在现有 `boot-visual` 五幕与真实阶段驱动上加深，不重做叙事引擎、不用视频主轴 |

## 3. 视觉叙事

### 3.1 幕次

- `dark` → `dormant`：近乎纯黑；核心极弱呼吸；顶栏极简一行；装甲 / 扫描 / 清单几乎关闭。
- `neural`：细网格地平面与稀疏光丝；遥测缓慢爬升；HUD 半透明、不全开。
- `energize`：能量环与进度条成为锚点；青 / 琥珀高光开始明显但仍克制。
- `cognition`：仪式高潮——核心脉动加强、粒子向心、清单逐条点亮；音效节拍对齐。
- `gate`：门户展开 → Logo 飞向侧栏 → 羽化溶解露出主界面。

### 3.2 卡住态（Stall）

- 触发：同一阶段约 **6s** 无新 `startup:progress`（渲染层计时，不改 IPC）。
- 行为：
  1. `data-stall="1"`；核心 / 光环切到更慢、更大的「仍在唤醒」呼吸。
  2. 阶段文案：`仍在：{友好名} · 已等待 Ns`；无真实阶段时用「等待启动信号」。
  3. 遥测 `SYNC` 显示 `HOLD`（或脉冲点）。
  4. **进度条百分比不假爬升**。
  5. **不出现跳过按钮**。
- 退出：新阶段到达或 `complete()` 时立刻清 Stall。

### 3.3 明确不做

- 卡住时微进度假推进
- 前段堆满军工仪表
- 为仪式感刻意拉长最短展示（`MIN_DISPLAY_MS` 可微调，不靠拖时间演戏）
- 改主进程进度协议

## 4. 模块与数据流

### 4.1 改动面

| 文件 | 职责 |
| --- | --- |
| `boot-visual.ts` | Stall 状态机；幕密度；卡住文案 / 呼吸；导出纯函数供单测 |
| `boot-style.ts` | 前弱后强 HUD；`[data-stall="1"]` 样式 |
| `boot-audio.ts` | `setStalled`：Stall 时低频心跳、退出恢复 |
| `early-splash.ts` | 把 Stall 回调接到音效 |
| `SplashOverlay.tsx` | 原则上不动；不新增跳过 |

### 4.2 数据流

```
main runStartupStage → startup:progress / splash:history
        ↓
early-splash publish → boot-visual
        ↓
actForPhase → dataset.act
lastPhaseAt + 6s → dataset.stall=1 + onStall(true)
SplashOverlay waitForReady → complete() → gate → fade
```

### 4.3 边界

- 从未收到真实进度：保留曲线上限 88%，也可进 Stall（「等待启动信号」）。
- `prefers-reduced-motion`：去粒子与镜头呼吸，保留阶段文字 + 耗时。
- 现有就绪超时（约 8s）仍强制收尾。

## 5. 测试

- 纯函数：Stall 判定、文案格式、阶段映射与 `TOTAL_PHASES` 对齐。
- 挂载：进入 / 退出 Stall 时 `data-stall` 与阶段文案；无跳过控件。
- 手工：拖慢某一 `runStartupStage`，确认呼吸 + 阶段/耗时；快启仍流畅过五幕。

## 6. 二期预留

主界面图标与微交互沿用「前克制、高潮爆发」与青琥珀高光语言，单独规格与计划。
