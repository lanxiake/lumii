# 开机五幕密度层次

> 日期：2026-11-08  
> 状态：已确认（方案 B）  
> 前置：高潮打透 `2026-11-08-boot-climax-polish-design.md`

## 1. 目标

拉开 `dark → dormant → neural → energize` 的 HUD / 画布密度，使快进时肉眼能分出「静 → 联 → 充 → 聚」；不改叙事引擎与 IPC，不削弱 A 已打透的 cognition/gate。

## 2. 密度阶梯（摘录）

| 幕 | HUD | 画布 |
| --- | --- | --- |
| dark | 顶栏极弱；装甲/遥测/清单关 | 核心 ~0.16；无环/流 |
| dormant | 顶栏弱；进度条隐约 | 核心 ~0.26；仍无环 |
| neural | 装甲/框线半透；清单淡 | 光丝注入；电路生长；环仍关 |
| energize | HUD 明显；进度条满显 | 能量环成锚；核心 ~0.62 |
| cognition+ | 沿用 A 高潮 | 向心 / 门户 |

判据：同层透明度与核心目标光须严格 `dark < dormant < neural < energize`（cognition 可更高）。

## 3. 改动面

- `boot-density.ts`：幕密度表 + 核心/环强度纯函数
- `boot-style.ts`：前中段 opacity 对齐密度表
- `boot-visual.ts`：`targetCore` / `drawRings` / 进度条显隐跟表

## 4. 不做

假进度、拉长最短展示、改 gate 收尾、改主进程阶段协议。
