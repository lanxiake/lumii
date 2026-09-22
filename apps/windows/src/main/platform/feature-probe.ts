/**
 * 能力矩阵的运行时探测（设计 §7）。
 *
 * 把「读环境 / 查运行时」这层副作用隔离在这里，`shared/feature-availability.ts`
 * 的判定保持纯函数——两边各自可测。
 *
 * **平台判断只发生在本模块与其它 platform/ 模块内**（D19）：业务代码不出现
 * `process.platform`，需要什么能力就问矩阵。
 */
import { detectSystemPython } from '../python-env'
import {
  resolveFeatureAvailability,
  type FeatureAvailability,
  type FeatureId,
  type FeatureProbeInput,
} from '../../shared/feature-availability'

/**
 * 是否 Wayland 会话。
 *
 * 三种情况要分清（只判断 `WAYLAND_DISPLAY` 会漏掉后两种）：
 * - **原生 Wayland**：`XDG_SESSION_TYPE=wayland`，且 `WAYLAND_DISPLAY` 有值；
 * - **X11 会话里的 XWayland 客户端**：`XDG_SESSION_TYPE=x11`，
 *   此时 `WAYLAND_DISPLAY` 仍可能被父进程传下来——**这种不算 Wayland 会话**，
 *   录屏走 X11 是可行的；
 * - **Wayland 会话里的 XWayland 客户端**：`XDG_SESSION_TYPE=wayland` 但
 *   `WAYLAND_DISPLAY` 可能为空（`DISPLAY` 有值）。
 *
 * 因此以 **`XDG_SESSION_TYPE` 为主**，环境变量只作兜底。
 */
export function isWaylandSession(): boolean {
  const sessionType = process.env.XDG_SESSION_TYPE?.toLowerCase()
  if (sessionType === 'wayland') return true
  if (sessionType === 'x11') return false
  // 未设置 XDG_SESSION_TYPE 时（部分精简桌面），退回看环境变量
  return Boolean(process.env.WAYLAND_DISPLAY)
}

/**
 * 启动参数是否显式要求无头模式（`--headless`）。
 *
 * `--headless` 的唯一定义处：`index.ts` 用它跳过 UI 层初始化（窗口/托盘/桌宠/录屏），
 * `isHeadlessSession()` 用它让能力矩阵与实际情况保持一致。两处各写一遍字符串会漂移。
 */
export function hasHeadlessFlag(): boolean {
  return process.argv.includes('--headless')
}

/**
 * 是否无图形会话（第二期的无头形态）。
 *
 * 判据有两层，任一成立即为真：
 * - **显式 `--headless` 启动**：此时即使机器上有 DISPLAY，UI 层也没有初始化，
 *   录屏/桌宠确实不可用。矩阵若还报「可用」，用户点进去只会静默失败（违反 D4）。
 * - **没有 DISPLAY/WAYLAND_DISPLAY**（tty、CI、systemd 里直接拉起）：
 *   没有任何可渲染的图形界面，按无头算。
 *
 * **只在 Linux 上判断**：Windows/macOS 不存在这个维度。
 */
export function isHeadlessSession(): boolean {
  if (process.platform !== 'linux') return false
  if (hasHeadlessFlag()) return true
  return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
}

/** 收集探测输入（含副作用：读环境、查运行时） */
export function collectFeatureProbeInput(): FeatureProbeInput {
  return {
    platform: process.platform,
    headless: isHeadlessSession(),
    waylandSession: isWaylandSession(),
    hasSystemPython: detectSystemPython() !== null,
  }
}

/**
 * 当前环境的能力矩阵。
 *
 * 每次调用都重新探测——`detectSystemPython` 自身有缓存，这里不必再包一层。
 * 不缓存的理由：Python 是用户可能随时装上的（安装后不该要求重启应用），
 * 而探测本身很便宜。
 */
export function getFeatureAvailability(): Record<FeatureId, FeatureAvailability> {
  return resolveFeatureAvailability(collectFeatureProbeInput())
}
