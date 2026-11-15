/**
 * 启动器 IPC 通道表。
 *
 * 用 `createIpcTable()` 攒表、`apply` 时一次挂载（见 `plugins/api/ipc.ts` 的约定）。
 * 停用插件时随作用域自动 removeHandler —— **不要**在这里直接 `ipcMain.handle`。
 *
 * 通道名前缀 `ext:com.lumii.listary:`，与既有约定一致。
 */

import { app } from 'electron'

import { createIpcTable, type IpcHandler, type IpcTable } from '../../api/ipc.js'
import type { IndexService } from './index-service.js'
import type { LauncherWindow } from './launcher-window.js'
import { performAction, type OpenAction, type OpenResult } from './actions.js'
import { search, type SearchHit } from './query.js'
import type { HotkeyStatus } from './hotkey.js'

export const LISTARY_CHANNEL = {
  search: 'ext:com.lumii.listary:search',
  open: 'ext:com.lumii.listary:open',
  status: 'ext:com.lumii.listary:status',
  roots: 'ext:com.lumii.listary:roots',
  addRoot: 'ext:com.lumii.listary:addRoot',
  removeRoot: 'ext:com.lumii.listary:removeRoot',
  rescan: 'ext:com.lumii.listary:rescan',
  hide: 'ext:com.lumii.listary:hide',
  hotkey: 'ext:com.lumii.listary:hotkey',
  icons: 'ext:com.lumii.listary:icons',
} as const

/** 主进程 → 渲染层的推送 */
export const LISTARY_EVENT = {
  /** 窗口显示时通知渲染层聚焦输入框 */
  shown: 'ext:com.lumii.listary:shown',
} as const

export interface ListaryIpcDeps {
  index: IndexService
  launcher: LauncherWindow
  getHotkeyStatus: () => HotkeyStatus
  /** 索引根之外的额外目录（如项目目录），扫描时并入 */
  extraRoots?: () => string[]
}

export function buildListaryIpcTable(deps: ListaryIpcDeps): IpcTable {
  const table = createIpcTable()

  table.register(LISTARY_CHANNEL.search, (_e: unknown, query: string, limit?: number): SearchHit[] => {
    const q = typeof query === 'string' ? query : ''
    return search(deps.index.open().db, q, { limit: typeof limit === 'number' ? limit : 50 })
  })

  table.register(
    LISTARY_CHANNEL.open,
    async (_e: unknown, action: OpenAction, targetPath: string, keyword?: string): Promise<OpenResult> => {
      if (typeof targetPath !== 'string' || !targetPath) {
        return { ok: false, action, path: String(targetPath), error: '路径为空' }
      }
      const result = await performAction(action, targetPath, {
        db: deps.index.open().db,
        keyword: typeof keyword === 'string' ? keyword : '',
      })
      // 打开成功后收起窗口 —— 这是启动器的交互约定（Listary 同样）
      if (result.ok && action !== 'copy-path' && action !== 'reveal') {
        deps.launcher.hide()
      }
      return result
    },
  )

  table.register(LISTARY_CHANNEL.status, () => deps.index.status())
  table.register(LISTARY_CHANNEL.roots, () => deps.index.listRoots())
  table.register(LISTARY_CHANNEL.hotkey, () => deps.getHotkeyStatus())

  table.register(LISTARY_CHANNEL.addRoot, (_e: unknown, rootPath: string) => {
    deps.index.addRoot(rootPath)
    return deps.index.listRoots()
  })

  table.register(LISTARY_CHANNEL.removeRoot, (_e: unknown, rootPath: string) => {
    const removed = deps.index.removeRoot(rootPath)
    return { removed, roots: deps.index.listRoots() }
  })

  table.register(LISTARY_CHANNEL.rescan, async () => {
    const result = await deps.index.scanAll(deps.extraRoots?.())
    return { indexed: result.indexed, durationMs: result.durationMs, perRoot: result.perRoot }
  })

  table.register(LISTARY_CHANNEL.hide, () => {
    deps.launcher.hide()
    return { ok: true }
  })

  /**
   * 批量取真实文件图标（PNG dataURL）。
   *
   * ## 快捷方式必须按 IconLocation 取，不能取 .lnk 自己
   *
   * 实测（`verify/listary-p3/probe-lnk-iconlocation.cjs`）：
   * `app.getFileIcon('xxx.lnk')` 对**所有**快捷方式返回同一个 546 B 的通用箭头。
   * 而资源管理器里显示的是 **`IconLocation`**（用户可在属性里自定义，
   * 很多安装程序也写这一项）—— 那才是"一眼认出是哪个软件"的那个图标。
   *
   * 优先级（与资源管理器一致）：
   *   1. `IconLocation` 里的文件（去掉 `,index`）
   *   2. 为空时回退到 `TargetPath` 的 exe
   *   3. 都取不到才退化成 lnk 自身（至少有个箭头，好过空白）
   *
   * ## 尺寸用 large（32×32）
   *
   * `small` 是 16×16，在 720px 宽的启动器里显示会糊成一坨，认不出是什么软件。
   *
   * ## 带索引的 IconLocation（`foo.dll,3`）
   *
   * `getFileIcon` 只给文件的主图标，取不到第 N 个。这类走 `ExtractIconEx`
   * （PowerShell，实测可用）。只在 `index !== 0` 时才付这个代价 —— 绝大多数是 `,0`。
   */
  table.register(LISTARY_CHANNEL.icons, async (_e: unknown, paths: string[]) => {
    if (!Array.isArray(paths)) return {}
    const wanted = paths.filter((p): p is string => typeof p === 'string' && p.length > 0)
    const out: Record<string, string> = {}

    const links = await resolveLinks(wanted.filter(isLink))

    /** 某个原始路径该用哪个文件取图标 */
    const sourceOf = (p: string): string => {
      const l = links.get(p)
      if (l?.iconFile) return l.iconFile
      if (l?.target) return l.target
      return p
    }
    /** 该图标文件的索引（IconLocation 的 `,N`） */
    const indexOf = (p: string): number => links.get(p)?.iconIndex ?? 0

    // 按「图标文件 + 索引」去重：同一扩展名的普通文件图标一样
    const keyOf = (p: string): string => {
      const src = sourceOf(p)
      const idx = indexOf(p)
      const ext = extOf(src)
      // exe/lnk/目录图标各不相同，不能按扩展名收敛
      const shareable = ext !== '' && ext !== '.exe' && ext !== '.lnk' && ext !== '.url' && idx === 0
      return shareable ? `__ext__${ext}` : `${src}#${idx}`
    }

    const firstOfKey = new Map<string, string>()
    for (const p of wanted) {
      const k = keyOf(p)
      if (!firstOfKey.has(k)) firstOfKey.set(k, p)
    }

    for (const [key, representative] of firstOfKey) {
      const src = sourceOf(representative)
      const idx = indexOf(representative)
      const url = await extractIcon(src, idx)
      if (!url) continue
      for (const p of wanted) {
        if (keyOf(p) === key) out[p] = url
      }
    }

    // 实在取不到的 lnk，退回自己的图标（通用箭头，但至少不是空白）
    for (const p of wanted) {
      if (out[p] || !isLink(p)) continue
      try {
        const img = await app.getFileIcon(p, { size: 'large' })
        if (!img.isEmpty()) out[p] = img.toDataURL()
      } catch {
        /* 忽略 */
      }
    }

    return out
  })

  return table
}

/** `.lnk` / `.url` */
function isLink(p: string): boolean {
  const e = extOf(p)
  return e === '.lnk' || e === '.url'
}

/** 取小写扩展名（含点）；无扩展名返回空串 */
function extOf(p: string): string {
  const base = p.slice(p.lastIndexOf('\\') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot).toLowerCase() : ''
}

/**
 * 取单个图标。
 *
 * `index === 0` 走 Electron 的 `app.getFileIcon`（快、无外部进程）；
 * 非 0 才付 PowerShell 的代价 —— 那是少数派。
 */
async function extractIcon(file: string, index: number): Promise<string | undefined> {
  if (index === 0) {
    try {
      const img = await app.getFileIcon(file, { size: 'large' })
      if (!img.isEmpty()) return img.toDataURL()
    } catch {
      /* 落到下面走 ExtractIconEx */
    }
  }
  return extractIndexedIcon(file, index)
}

/**
 * `ExtractIconEx` 取指定索引的图标。
 *
 * 只在 `getFileIcon` 取不到、或索引非 0 时用。一次一个进程（~200ms），
 * 但正常使用中带索引的快捷方式是少数，且结果有缓存。
 */
async function extractIndexedIcon(file: string, index: number): Promise<string | undefined> {
  try {
    const { execFile } = await import('node:child_process')
    const esc = file.replace(/'/g, "''")
    const script = `
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class LzIcon {
  [DllImport("shell32.dll", CharSet=CharSet.Auto)]
  public static extern uint ExtractIconEx(string f, int i, IntPtr[] lg, IntPtr[] sm, uint n);
}
'@
$lg = New-Object IntPtr[] 1
$sm = New-Object IntPtr[] 1
$n = [LzIcon]::ExtractIconEx('${esc}', ${index}, $lg, $sm, 1)
if ($n -gt 0 -and $lg[0] -ne [IntPtr]::Zero) {
  $ico = [System.Drawing.Icon]::FromHandle($lg[0])
  $bmp = $ico.ToBitmap()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  [Convert]::ToBase64String($ms.ToArray())
}`
    const b64 = await new Promise<string>((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (_e, so) => resolve(String(so ?? '').trim()),
      )
    })
    if (!b64) return undefined
    return `data:image/png;base64,${b64}`
  } catch {
    return undefined
  }
}

interface LinkInfo {
  /** 目标程序 */
  target?: string
  /** IconLocation 里的文件（已去掉 `,index`） */
  iconFile?: string
  iconIndex: number
}

/** 快捷方式信息缓存：目标和图标基本不变，重启才失效 */
const linkCache = new Map<string, LinkInfo>()

/**
 * 批量读 `.lnk` 的 TargetPath + IconLocation。
 *
 * 一次 PowerShell 解析全部（每个 lnk 一个进程会到秒级）。
 * 解析失败（PowerShell 被策略禁用等）只是少了个性化图标，不影响检索。
 */
async function resolveLinks(links: string[]): Promise<Map<string, LinkInfo>> {
  const out = new Map<string, LinkInfo>()
  const todo: string[] = []
  for (const l of links) {
    if (extOf(l) !== '.lnk') continue
    const cached = linkCache.get(l)
    if (cached) out.set(l, cached)
    else todo.push(l)
  }
  if (todo.length === 0) return out

  try {
    const { execFile } = await import('node:child_process')
    const arr = todo.map((p) => `'${p.replace(/'/g, "''")}'`).join(',')
    const script =
      `$sh = New-Object -ComObject WScript.Shell; ` +
      `foreach ($p in @(${arr})) { try { ` +
      `  $s = $sh.CreateShortcut($p); ` +
      `  Write-Output ($p + "\`t" + $s.TargetPath + "\`t" + $s.IconLocation) ` +
      `} catch { } }`

    const stdout = await new Promise<string>((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', timeout: 8000, windowsHide: true },
        (_e, so) => resolve(String(so ?? '')),
      )
    })

    for (const line of stdout.split(/\r?\n/)) {
      const parts = line.split('\t')
      if (parts.length < 3) continue
      const link = parts[0].trim()
      if (!link) continue
      const target = parts[1].trim()
      // IconLocation 形如 `C:\x\y.exe,0` 或 `,0`（空）
      const loc = parts[2].trim()
      const comma = loc.lastIndexOf(',')
      const rawFile = comma >= 0 ? loc.slice(0, comma).trim() : loc.trim()
      const rawIdx = comma >= 0 ? Number(loc.slice(comma + 1)) : 0

      const info: LinkInfo = {
        target: target || undefined,
        iconFile: rawFile || undefined,
        iconIndex: Number.isFinite(rawIdx) && rawIdx >= 0 ? rawIdx : 0,
      }
      linkCache.set(link, info)
      out.set(link, info)
    }
  } catch {
    // PowerShell 不可用 → 回退到"取 lnk 自己的图标"
  }

  return out
}
