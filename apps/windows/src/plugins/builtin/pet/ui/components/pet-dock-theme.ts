/**
 * 控制坞的色层与公共样式（坞本体与「经历」面板共用）
 *
 * 2026-09-24（七期 T7.6）从 `PetControlDock.tsx` 抽出来：经历面板是坞的第二个 Tab，
 * 它必须用**同一套亮度刻度**，否则切一下 Tab 整个面板的明暗会跳一格。
 * 抄一份常量过去正是"复制出来的东西不会一起改"的老路。
 *
 * ---
 *
 * 宠物模式跑在**独立窗口**里：main.tsx 直接渲染 PetModeShell，**不挂
 * AppProviders**（含 ThemeProvider）。
 *
 * ⚠️ 2026-09-23 起 PetModeShell 会给本窗口的 `<html>` 设 `data-theme`
 * （见 `utils/pet-theme.ts`，服务气泡），所以这里**取得到**主题令牌了 ——
 * 但坞**依然刻意不用**：那是"整层跟着主窗变米黄色"，当年明确否掉的
 * （`07-主题色系/12-canvas与宠物色层收敛.md` §3.2）。色值都是本层自己的常量。
 *
 * 色相集中在这里：改「坞的亮度」只需改 LIGHT / DARK。
 * 透明度逐处保留——它们是设计刻度（描边 0.08~0.18、分隔线 0.08~0.12、
 * 文字 0.35~0.82），语义各不相同，合并会丢失层级。
 */

import type { CSSProperties } from 'react'

/** 浮层上的"亮色"（描边、分隔线、叠加底、次要文字） */
const LIGHT: [number, number, number] = [255, 255, 255]
/** 浮层上的"暗色"（坞底、内嵌区底、投影） */
const DARK: [number, number, number] = [0, 0, 0]

/** 按指定透明度取"亮色"。用法：`border: 1px solid ${light(0.12)}` */
export const light = (alpha: number): string => `rgba(${LIGHT.join(', ')}, ${alpha})`
/** 按指定透明度取"暗色" */
export const dark = (alpha: number): string => `rgba(${DARK.join(', ')}, ${alpha})`

/** 可选中复制的文本区域样式（坞与经历页的所有正文都该能选中） */
export const selectableText: CSSProperties = {
  userSelect: 'text',
  WebkitUserSelect: 'text',
  cursor: 'text',
}
