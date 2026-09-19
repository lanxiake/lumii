/**
 * 子进程环境变量白名单的平台抽象（设计 §5.2）。
 *
 * 为什么要白名单而不是直接 `{ ...process.env }`：技能脚本是不可信代码（可能来自
 * 技能市场），而主进程环境里躺着模型 API key、数据库凭证、`SKILL_PARAMS` 之外的
 * 各种秘密。白名单是**默认拒绝**，只放行脚本正常工作必需的键。
 *
 * 两个平台的"必需"差别很大：
 * - Windows：GUI/COM 相关的十几项（`SYSTEMROOT`、`PATHEXT`、`APPDATA`…），
 *   少一个都可能导致 cmd.exe 或 powershell 起不来。
 * - POSIX：`HOME`/`PATH` 之外，桌面环境下还必须给 `DISPLAY`/`WAYLAND_DISPLAY`/
 *   `XAUTHORITY`/`DBUS_SESSION_BUS_ADDRESS`，否则技能里任何 `notify-send`、
 *   拉起 GUI 程序、走 D-Bus 的操作都会失败。
 *
 * **`DISPLAY` 这几项是有意的边界放宽**：它们不泄露凭证，但能让技能弹出窗口。
 * 这是产品上的取舍（技能可能确实需要拉 GUI），不是疏漏——所以在这里写明理由，
 * 而不是图省事放开整个 `process.env`。
 */
import * as os from 'node:os'

/** Windows 上子进程正常启动所必需的环境变量 */
const WINDOWS_KEYS = [
  'USERPROFILE',
  'SYSTEMROOT',
  'WINDIR',
  'APPDATA',
  'LOCALAPPDATA',
  'COMSPEC',
  'PATHEXT',
  'HOMEDRIVE',
  'HOMEPATH',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'CommonProgramFiles',
  'TEMP',
  'TMP',
] as const

/**
 * POSIX 上子进程正常工作所必需的变量。
 *
 * 分三组：
 * 1. **身份与 shell**：`HOME` `SHELL` `USER` `LOGNAME`
 * 2. **本地化**：`LANG` `LC_*`——缺了会让技能输出的中文变成 `?`（POSIX 下
 *    程序依赖 locale 决定编码，而 Windows 有自己的代码页机制）。
 * 3. **桌面会话**：`DISPLAY` `WAYLAND_DISPLAY` `XAUTHORITY` `DBUS_SESSION_BUS_ADDRESS`
 *    `XDG_*`——见文件头说明，属有意放宽。
 */
const POSIX_KEYS = [
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'LANG',
] as const

/** 桌面会话相关：值不敏感，但缺了会让 GUI / 通知类技能静默失败 */
const POSIX_DESKTOP_KEYS = [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
] as const

function isWindows(): boolean {
  return process.platform === 'win32'
}

/**
 * 构造子进程环境白名单。
 *
 * @param params 技能参数，序列化后作为 `SKILL_PARAMS` 传入（调用方负责）
 * @param extra  调用方额外注入的变量，**不能覆盖 SKILL_PARAMS**
 */
export function buildSafeChildEnv(
  params: unknown,
  extra?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {}

  // HOME / PATH 两平台通用。POSIX 上 HOME 缺失会让 `~` 展开失败；
  // Windows 上 HOME 通常不存在，退回 USERPROFILE（保留收敛前的行为）。
  env.PATH = process.env.PATH || ''
  env.HOME = process.env.HOME || process.env.USERPROFILE || ''
  env.TEMP = process.env.TEMP || process.env.TMP || os.tmpdir()
  env.SKILL_PARAMS = JSON.stringify(params)

  const keys = isWindows() ? WINDOWS_KEYS : POSIX_KEYS
  for (const key of keys) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }

  if (!isWindows()) {
    for (const key of POSIX_DESKTOP_KEYS) {
      const value = process.env[key]
      if (value !== undefined) env[key] = value
    }
    // LC_* 是前缀匹配（LC_ALL / LC_CTYPE / LC_MESSAGES …），逐个列举会漏
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('LC_') && value !== undefined) env[key] = value
    }
    // XDG_* 同样按前缀收（XDG_RUNTIME_DIR 是 D-Bus 与 Wayland 的必要项）
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('XDG_') && value !== undefined) env[key] = value
    }
  }

  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      // 保护 SKILL_PARAMS：调用方传的 params 才是唯一真源
      if (k !== 'SKILL_PARAMS') env[k] = v
    }
  }

  return env
}
