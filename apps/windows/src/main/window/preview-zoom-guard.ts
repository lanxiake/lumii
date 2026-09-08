/**
 * preview-zoom-guard — 文件预览缩放快捷键守卫
 *
 * 问题：Electron 默认应用菜单为 zoomIn / zoomOut / resetZoom 角色注册了
 * Ctrl+Plus / Ctrl+- / Ctrl+0 加速键（无边框主窗口同样生效），真实键盘输入下
 * 会缩放整个窗口 UI——与文件预览内的内容缩放快捷键（Ctrl+= / Ctrl+- / Ctrl+0）
 * 冲突：按 Ctrl+- 会同时缩放窗口和预览内容。
 *
 * 方案：before-input-event 先于菜单加速键处理触发，preventDefault 可同时阻断
 * 菜单快捷键与页面事件；随后用 sendInputEvent 把按键原样重注入渲染进程
 * （sendInputEvent 不走菜单加速键路径，已实测验证），由预览组件自行处理缩放。
 * 预览未打开时重注入的按键无人消费，等价于禁用了误触发的窗口级缩放。
 *
 * 注意：Ctrl+= 无需拦截——默认菜单只绑定 Plus（Shift+= / 小键盘+），
 * 主键盘 Ctrl+= 不触发窗口缩放。
 */
import type { BrowserWindow } from 'electron'

/** 与默认菜单缩放角色冲突的键 */
const GUARDED_KEYS = new Set(['-', '0', '+'])

export function installPreviewZoomGuard(win: BrowserWindow): void {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' && input.type !== 'keyUp') return
    // 仅处理纯 Ctrl 组合（本应用面向 Windows）
    if (!input.control || input.alt || input.meta) return
    if (!GUARDED_KEYS.has(input.key)) return

    event.preventDefault()
    win.webContents.sendInputEvent({
      type: input.type,
      keyCode: input.key,
      modifiers: ['control'],
    })
  })
}
