/**
 * 条目动作 — 打开 / 定位 / 复制 / 管理员运行。
 *
 * 设计：`docs/design/逆向与复刻/2026-11-14-Listary复刻启动器插件设计.md` §6.6（P5 才做全量快捷菜单，
 * 本阶段只做"打开"这一个，够跑通闭环）。
 *
 * 打开成功即记使用历史 —— 这是 P2 排序想要的"越用越准"闭环的**写入侧**。
 * 不变量：只有**真的打开了**才写，检索本身不写（见 P2 总结的防自激一节）。
 */

import type { DatabaseSync } from 'node:sqlite'
import { shell } from 'electron'

import { recordUsage } from './query.js'

export type OpenAction = 'open' | 'reveal' | 'copy-path' | 'run-as-admin'

export interface OpenResult {
  ok: boolean
  action: OpenAction
  path: string
  error?: string
}

/**
 * 执行动作。
 *
 * 用 `shell.openPath` 而非 `child_process.exec`：
 * 前者走系统关联（.txt 用记事本、.lnk 走目标、目录用资源管理器），且**不做字符串拼接**，
 * 没有命令注入面。`run-as-admin` 是唯一需要 PowerShell 的，那里做显式单引号转义。
 */
export async function performAction(
  action: OpenAction,
  targetPath: string,
  usage?: { db: DatabaseSync; keyword: string },
): Promise<OpenResult> {
  try {
    switch (action) {
      case 'open': {
        const err = await shell.openPath(targetPath)
        if (err) return { ok: false, action, path: targetPath, error: err }
        usage && recordUsage(usage.db, usage.keyword, targetPath)
        return { ok: true, action, path: targetPath }
      }

      case 'reveal': {
        shell.showItemInFolder(targetPath)
        // 定位不算"打开"，不记使用历史
        return { ok: true, action, path: targetPath }
      }

      case 'copy-path': {
        const { clipboard } = await import('electron')
        clipboard.writeText(targetPath)
        return { ok: true, action, path: targetPath }
      }

      case 'run-as-admin': {
        const { execFile } = await import('node:child_process')
        // 显式转义：路径进 PowerShell 单引号串，内部的 ' 要写成 ''
        const escaped = targetPath.replace(/'/g, "''")
        await new Promise<void>((resolve, reject) => {
          execFile(
            'powershell.exe',
            ['-NoProfile', '-Command', `Start-Process -FilePath '${escaped}' -Verb RunAs`],
            { windowsHide: true },
            (e) => (e ? reject(e) : resolve()),
          )
        })
        usage && recordUsage(usage.db, usage.keyword, targetPath)
        return { ok: true, action, path: targetPath }
      }

      default: {
        const never: never = action
        return { ok: false, action: never, path: targetPath, error: '未知动作' }
      }
    }
  } catch (err) {
    return {
      ok: false,
      action,
      path: targetPath,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
