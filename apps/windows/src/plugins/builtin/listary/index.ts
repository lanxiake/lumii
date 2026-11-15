/**
 * 启动器扩展（`com.lumii.listary`）— 双击 Ctrl 唤起、搜本机文件与应用。
 *
 * 设计：`docs/design/逆向与复刻/2026-11-14-Listary复刻启动器插件设计.md`
 * 计划：`docs/plans/逆向与复刻/2026-11-14-Listary复刻启动器实施计划.md` §P3
 *
 * ## 架构定位
 *
 * 内建插件，**可热禁用**（`hot: true`）。禁用后：
 * - 键盘钩子注销、组合键注销（双击 Ctrl 不再有反应）
 * - 悬浮窗销毁、IPC 处理器随作用域摘掉
 * - 索引库**不删**（那是用户数据，重新启用应立即可用）
 *
 * ## 依赖与时序
 *
 * - 主窗口：不需要（悬浮窗独立）
 * - preload / renderer 产物：与 file-preview 同源路径约定
 * - 激活时机：`app:ready` 后，非无头模式
 *
 * ## 无头模式
 *
 * 跳过全部接线 —— 无头环境没有键盘、也没有显示器可弹窗。
 */

import { join } from 'node:path'

import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../../../main/kernel/events'
import { hasHeadlessFlag } from '../../../main/platform/feature-probe'
import { IndexService } from './index-service.js'
import { LauncherWindow } from './launcher-window.js'
import { buildListaryIpcTable } from './ipc.js'
import type { IpcHandler } from '../../api/ipc.js'
import { startHotkey, stopHotkey, type HotkeyStatus } from './hotkey.js'

/** 首次扫描的延迟：不跟主窗口抢启动资源 */
const FIRST_SCAN_DELAY_MS = 8_000

export const listaryExtension = {
  manifest: {
    id: 'com.lumii.listary',
    name: '本地启动器',
    version: '0.1.0',
    description: '双击 Ctrl 唤起，搜索本机文件、应用与快捷方式',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
    contributes: {
      ipc: [
        { method: 'ext:com.lumii.listary:search', description: '检索本机文件' },
        { method: 'ext:com.lumii.listary:open', description: '打开条目' },
        { method: 'ext:com.lumii.listary:status', description: '索引状态' },
        { method: 'ext:com.lumii.listary:roots', description: '索引根列表' },
        { method: 'ext:com.lumii.listary:addRoot', description: '添加索引根' },
        { method: 'ext:com.lumii.listary:removeRoot', description: '移除索引根' },
        { method: 'ext:com.lumii.listary:rescan', description: '重建索引' },
        { method: 'ext:com.lumii.listary:hide', description: '隐藏启动器窗口' },
        { method: 'ext:com.lumii.listary:hotkey', description: '当前生效的唤起方式' },
      ],
    },
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.listary',
    provides: ['listary'],
    apply(ctx) {
      if (hasHeadlessFlag()) {
        ctx.log.info('无头模式：跳过启动器接线')
        return
      }

      const index = new IndexService()
      const launcher = new LauncherWindow({
        preloadPath: join(__dirname, '../preload/index.js'),
        rendererUrl: process.env.ELECTRON_RENDERER_URL,
        indexHtmlPath: join(__dirname, '../renderer/index.html'),
        // 窗口显示时的 shown 事件由 LauncherWindow.show() 自己推（它知道抢焦点有没有成功）
      })

      let hotkeyStatus: HotkeyStatus = { mode: 'none', acceleratorOk: false }

      // ── 唤起：双击 Ctrl（钩子）+ 组合键兜底，都收敛到 toggle ──
      const toggle = (): void => launcher.toggle()
      hotkeyStatus = startHotkey({
        onTrigger: toggle,
        logger: {
          info: (m) => ctx.log.info(m),
          warn: (m) => ctx.log.warn(m),
        },
      })
      ctx.log.info(`唤起方式：${hotkeyStatus.mode}${hotkeyStatus.reason ? `（钩子原因：${hotkeyStatus.reason}）` : ''}`)

      // ── IPC ──
      const table = buildListaryIpcTable({
        index,
        launcher,
        getHotkeyStatus: () => hotkeyStatus,
      })
      table.install((ch: string, fn: IpcHandler) => ctx.registerIpc?.(ch, fn))

      // ── 首次扫描：延迟到启动稳定之后，且失败不能拖垮插件 ──
      const scanTimer = setTimeout(() => {
        void index
          .scanAll()
          .then((r) => {
            ctx.log.info(`首次索引完成：${r.indexed} 条，${r.durationMs}ms`)
          })
          .catch((err) => {
            ctx.log.warn(`首次索引失败：${err instanceof Error ? err.message : String(err)}`)
          })
      }, FIRST_SCAN_DELAY_MS)

      // ── 清理：停用/退出时收干净 ──
      ctx.effect(() => {
        clearTimeout(scanTimer)
        stopHotkey()
        launcher.dispose()
        index.close()
        ctx.log.info('启动器已停止（钩子已注销、窗口已销毁、索引库已关闭）')
      })

      ctx.log.info('本地启动器插件已启动')
    },
  }),
}
