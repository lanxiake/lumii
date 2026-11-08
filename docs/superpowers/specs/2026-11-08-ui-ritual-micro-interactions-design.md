# 主界面仪式微交互设计（二期）

> 日期：2026-11-08  
> 状态：已确认（方案 1）  
> 前置：开机仪式感一期（`2026-11-08-boot-ceremony-stall-design.md`）

## 1. 目标

在聊天主路径上对齐开机气质：默认干净，关键节点放出青琥珀仪式光；先统一 `Button` / `Icon` / `Loading`，再落到侧栏选中、工具栏、发送、工具运行态。

## 2. 决策

| 项 | 选择 |
| --- | --- |
| 范围 | Icon + Button + Loading 基元，再落到聊天壳关键面 |
| 强度 | 仪式感加强（选中 / 发送 / 工具运行更明显） |
| 路径 | 令牌 + 关键面增强；不上 Motion、不全站换图标 |

## 3. 令牌与工具类

在 `design-system.css` 增加：

- `--mt-glow-cyan` / `--mt-glow-amber`
- `--mt-pulse-dur`（约 1.8s）
- `.mt-glow-hover`、`.mt-pulse-amber`、`.mt-icon-ritual`
- 继续尊重现有 `prefers-reduced-motion`

## 4. 基元

- **Button**：primary hover 外晕；focus 双环加强
- **Icon**：`RitualIcon` 薄封装（统一 stroke / size 档）；不全仓库扫换
- **Loading**：双环 + 呼吸光点

## 5. 聊天落点

- 侧栏 `SessionItem.active`：左侧细高光条
- `icon-btn` / `toolbar-icon-btn`：hover 青光
- `send-btn`：hover / 可发送琥珀高光
- `ToolCallCard` 运行图标：琥珀脉动（保留或叠加 spin）

## 6. 不做

- 设置 / Wiki 等非聊天页
- 新动效库、全量 lucide 迁移
- 改浅色语义色体系（只叠加 glow）
