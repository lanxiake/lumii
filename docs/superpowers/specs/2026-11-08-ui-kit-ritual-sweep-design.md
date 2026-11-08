# 全局 UI 基元仪式化扫一轮

> 日期：2026-11-08  
> 状态：已确认（方案 1）  
> 前置：`2026-11-08-ui-ritual-micro-interactions-design.md`

## 目标

把已有青琥珀仪式令牌铺到 `components/ui` 通用基元：Modal / Toast / Switch / Select / Input / Checkbox / Card / Empty / Tooltip / Badge，全站交互语言统一。

## 改动原则

- 默认仍干净；焦点 / 开态 / hover / 入场才放光
- 焦点环统一：双环 + cyan 淡光（`--mt-focus-ring`）
- Switch 开态琥珀外晕；表单 focus 用仪式环
- Modal 入场略加强；Toast 语义左边线 + 淡光
- Card hover 叠 cyan glow；Empty 图标呼吸环
- 尊重 `prefers-reduced-motion`

## 范围

仅 `apps/windows/src/renderer/components/ui/**` 与 `design-system.css` 令牌补充；不改业务页私有样式。
