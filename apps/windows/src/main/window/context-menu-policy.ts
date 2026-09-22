/**
 * 原生右键菜单的让位策略。
 *
 * 单独成文件是为了能不引入 Electron 就跑测试 —— `main-window.ts` 顶部 import 了
 * electron，直接测它就得把整个 Electron mock 一遍，而这里要验的只是一个判断。
 */

/** `context-menu` 事件里本策略真正用到的字段 */
export interface ContextMenuParamsLike {
  isEditable: boolean
  selectionText: string
}

/**
 * 这次右键是否让给渲染层自绘（划词菜单）。
 *
 * 只在「非可编辑 + 有实际选区」时让位：
 * - **可编辑区一律不让**。让掉的话输入框的剪切/粘贴会直接消失——原生菜单是唯一来源。
 * - 无选区时不让：原生菜单本来也不弹，让位没有意义。
 *
 * ⚠️ **为什么主进程必须自己判断，而不是等渲染层示意**：Electron 的 `context-menu`
 * 事件与 DOM `contextmenu` 是两条链路，渲染层的 `preventDefault()` **是否**能阻止
 * 主进程 popup 并没有把握。
 *
 * 实测（2026-09-22，Electron 36，本机）：**挡得住**。渲染层接管的右键（聊天区、概览、
 * 文件预览三处）主进程全程零事件；而输入框不让位、不 preventDefault，每次都有事件。
 * 但这只是本机实测，不是 Electron 的文档承诺，别把它当契约。
 *
 * 所以这里不去赌：主进程侧主动让位。两种语义下结果都正确 ——
 * 若 preventDefault 确实挡得住，这里是冗余但无害；若挡不住，这里就是唯一防线。
 * **真机判据**：聊天区右键只出现一个菜单（不是两个叠在一起）。
 */
export function shouldDeferToRenderer(params: ContextMenuParamsLike): boolean {
  if (params.isEditable) return false
  return params.selectionText.trim().length > 0
}
