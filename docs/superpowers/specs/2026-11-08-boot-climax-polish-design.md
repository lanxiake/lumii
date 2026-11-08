# 开机高潮打透（cognition → gate）

> 日期：2026-11-08  
> 状态：已确认（方案 A）  
> 前置：`2026-11-08-boot-ceremony-stall-design.md`

## 1. 目标

在现有五幕与真实进度驱动上，打透 `cognition` → `gate` 仪式高潮：粒子向心、门户裂开、Logo 落点与音效节拍对齐。不重做叙事引擎，不假爬升，不提供跳过。

## 2. 行为

| 节点 | 视觉 | 音效 |
| --- | --- | --- |
| 进入 cognition | 粒子向心、核心脉动加重、清单点亮短青光、进度条琥珀晕 | `climaxPulse` |
| gate 竖缝 | shock + seam 更亮；闪白前短暂青→白 | `gateOpen` |
| Logo 飞侧栏 | 飞行拖尾；落点青晕 | `logoLand`（随后沿用 `finish` 三和音） |

## 3. 改动面

- `boot-climax.ts`：高潮判定纯函数（阶段→音效档、向心强度）
- `boot-visual.ts` / `boot-style.ts`：cognition 粒子与 CSS；gate 裂开 / flash / signature
- `boot-audio.ts`：`climaxPulse` / `gateOpen` / `logoLand`
- `early-splash.ts`：接线

## 4. 不做

假进度、跳过按钮、视频主轴、改 IPC、拉长 `MIN_DISPLAY_MS` 演戏。
