/**
 * 开机自启的平台抽象（设计 §6）。
 *
 * **Windows / macOS**：交给 Electron 的 `app.setLoginItemSettings`（注册表 Run 键 /
 * LaunchAgent），已有实现不动。
 *
 * **Linux**：Electron 不支持这个 API。走 **XDG autostart**——在
 * `~/.config/autostart/` 放一个 `.desktop` 文件，桌面环境登录时自动拉起。
 * 这是 freedesktop.org 的标准，GNOME / KDE / XFCE 都认。
 *
 * **AppImage 的坑（设计特别点名）**：AppImage 运行时 `process.execPath` 指向
 * **临时挂载点**（`/tmp/.mount_LumiiXXXX/...`），进程退出就没了。写进 .desktop
 * 会导致下次开机指向一个不存在的路径。正确做法是用 **`process.env.APPIMAGE`**
 * ——那是 AppImage 文件本身的真实路径。
 *
 * 判断「是否已开启」用**文件是否存在**，与 Windows 侧读注册表语义一致；
 * 不解析文件内容，避免用户手工改过 .desktop 后我们的解析失败反而报「未开启」。
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { app } from 'electron'

/** 桌面环境登录时读取的自启目录 */
const AUTOSTART_DIR = path.join(os.homedir(), '.config', 'autostart')

/** 与 Windows 侧一致的启动参数：用于检测「由系统自动启动」并隐藏到托盘 */
export const STARTUP_ARG = '--startup-launched'

/** .desktop 文件名（固定，便于读写与用户识别） */
const DESKTOP_FILE = 'lumii.desktop'

function autostartFilePath(): string {
  return path.join(AUTOSTART_DIR, DESKTOP_FILE)
}

/**
 * 取出用于自启的可执行路径。
 *
 * **AppImage 必须用 `process.env.APPIMAGE`**：`process.execPath` 在 AppImage 里
 * 指向 `/tmp/.mount_xxx/` 下的临时解包目录，重启后即失效。
 * 其它形态（deb 安装、开发态）execPath 就是稳定的真实路径。
 */
export function resolveAutostartExecPath(): string {
  const appImage = process.env.APPIMAGE
  if (appImage) return appImage
  return process.execPath
}

/**
 * 生成 .desktop 内容。
 *
 * `Exec` 里的路径**必须加引号**：家目录或安装路径可能含空格，不加引号会让
 * 桌面环境把路径按空格切成多个参数。
 */
function buildDesktopEntry(execPath: string): string {
  const args = [execPath, STARTUP_ARG]
    .map((part) => `"${part}"`)
    .join(' ')

  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Lumii',
    'Name[zh_CN]=灵栖 Lumii',
    'Comment=本地优先的 AI 桌面伙伴',
    `Exec=${args}`,
    'Terminal=false',
    // 与 electron-builder 的 desktop entry 保持同一分类，便于在菜单里归到一处
    'Categories=Utility;',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')
}

/** Linux 侧是否已开启（文件存在即视为开启） */
export function isLinuxAutostartEnabled(): boolean {
  try {
    return fs.existsSync(autostartFilePath())
  } catch {
    return false
  }
}

/** Linux 侧设置自启；失败时抛异常（调用方据此把错误回给渲染层） */
export function setLinuxAutostart(enable: boolean): void {
  const file = autostartFilePath()

  if (!enable) {
    // 不存在时删除不报错——「关掉一个本来就没开的东西」不该是错误
    fs.rmSync(file, { force: true })
    return
  }

  fs.mkdirSync(AUTOSTART_DIR, { recursive: true })
  fs.writeFileSync(file, buildDesktopEntry(resolveAutostartExecPath()), 'utf8')
}

/** 读取开机自启状态（按平台分派） */
export function getOpenAtLogin(): boolean {
  if (process.platform === 'linux') return isLinuxAutostartEnabled()
  return app.getLoginItemSettings().openAtLogin
}

/**
 * 设置开机自启（按平台分派），返回**设置后**的实际状态。
 *
 * 返回实际状态而非入参：Linux 侧写文件可能失败（权限、磁盘满），
 * 调用方应当知道最终结果。与既有 Windows 实现「写完再读一遍」的语义一致。
 */
export function setOpenAtLogin(enable: boolean): boolean {
  if (process.platform === 'linux') {
    setLinuxAutostart(enable)
    return isLinuxAutostartEnabled()
  }

  app.setLoginItemSettings({
    openAtLogin: enable,
    // 开机启动时携带参数，用于检测是否由系统自动启动（隐藏到托盘）
    args: enable ? [STARTUP_ARG] : [],
  })
  return app.getLoginItemSettings().openAtLogin
}
