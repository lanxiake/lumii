/**
 * 进程树终止的平台抽象（设计 §5.1）。
 *
 * 收敛前的现状：仓库里有 6 处各写各的终止逻辑，且两个平台的语义完全不同——
 *
 * - **Windows**：SIGTERM 对 cmd.exe / powershell 起的子进程树无效，必须用
 *   `taskkill /pid <pid> /T /F`。少了 `/T`，孙进程会继续占着 stdio 管道，
 *   'close' 事件永不触发，调用方的 Promise 永久挂起（python / bash 技能最常踩）。
 * - **POSIX**：先发 SIGTERM 给**进程组**（负 pid），2s 后仍在则 SIGKILL。
 *   用进程组而非单进程，才能连带孙进程一起收掉。
 *
 * **进程组的前提是 `spawnChildInGroup`**：POSIX 上只有 `detached: true` 才让子进程
 * 自成进程组，`process.kill(-pid)` 才有意义；否则负 pid 会打到调用者自己的组，
 * 把主进程一起带走。所以四个 runner 必须改用它来 spawn，而不是裸 `spawn`。
 *
 * **随之而来的取舍**：`detached: true` 的进程不随父进程退出而终止 —— Electron 挂了
 * 它会变孤儿。这是本次移植**有意引入的行为变化**，由 `killAllTrackedChildren()` 在
 * `performCleanup()` 里兜底回收（见 index.ts）。
 */
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'

/** SIGTERM 之后等待多久升级到 SIGKILL */
const SIGKILL_GRACE_MS = 2000

/** taskkill 自身的超时：卡住时不能拖住调用方 */
const TASKKILL_TIMEOUT_MS = 5000

/**
 * 是否 Windows。
 *
 * **必须每次调用时读，不要在模块顶层缓存成常量**：缓存会在模块加载那一刻定死平台，
 * 既与收敛前的实现不符（`forceKillProcess` 各处都是调用时读 `process.platform`），
 * 也让单测无法切平台验证分支（T3.0 的测试正是这么锁 win32 语义的）。
 */
function isWindows(): boolean {
  return process.platform === 'win32'
}

/**
 * 已 spawn 的子进程登记表。
 *
 * 只用于应用退出时兜底回收，不参与单次 kill —— 一次普通的命令结束不该从表里
 * 摘除后又被并发 kill 打扰，所以 kill 只做「尽力而为」，重复 kill 由调用方
 * 自行去重（现有实现也是这个语义）。
 */
const tracked = new Set<ChildProcess>()

/** 把子进程登记进来，退出时统一回收 */
function track(child: ChildProcess): ChildProcess {
  tracked.add(child)
  child.once('close', () => tracked.delete(child))
  // spawn 失败（如 ENOENT）时 'close' 不一定触发，'error' 也兜一下，
  // 否则失败的进程会永远留在表里
  child.once('error', () => tracked.delete(child))
  return child
}

/**
 * spawn 一个子进程，并让它成为**独立进程组**（POSIX）。
 *
 * Windows 上 `detached` 会另开控制台窗口，反而干扰 `windowsHide`，因此不设。
 * POSIX 上 `detached: true` 是 `process.kill(-pid)` 生效的前提（见文件头）。
 *
 * 四个 runner 的 `spawn` 都应改走这里——只改 kill 不改 spawn 的话，POSIX 侧
 * 拿到的仍是普通进程，进程组 kill 会打错对象。
 */
export function spawnChildInGroup(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  const child = spawn(command, args as string[], {
    ...options,
    ...(isWindows() ? {} : { detached: true }),
  })

  return track(child)
}

/**
 * 终止子进程及其整棵进程树。
 *
 * 语义与收敛前的 `forceKillProcess` × 4 保持一致（T3.0 的单测是凭据）：
 * - `pid` 缺失 → 只能对 child 本身 `SIGKILL`，没有树可谈；
 * - win32 → `taskkill /pid <pid> /T /F`，命令本身失败（非零退出）时不回退，
 *   与现状一致（现状的 try/catch 只在 spawnSync **抛异常**时才回退）；
 * - 其它 → `killPidTree(pid)` 的 SIGTERM → 2s → SIGKILL。
 */
export function killProcessTree(child: ChildProcess, _signal: NodeJS.Signals = 'SIGTERM'): void {
  const pid = child.pid
  if (!pid) {
    child.kill('SIGKILL')
    return
  }

  killPidTree(pid)
}

/**
 * 按 pid 终止整棵进程树（外部进程：浏览器残留、技能拉起的孙子进程等）。
 *
 * `_signal` 目前只用于文档化调用方意图——POSIX 侧一律从 SIGTERM 起步再升级，
 * Windows 侧 taskkill 无对应概念。保留参数是为了将来支持「直接 SIGKILL」。
 */
export function killPidTree(pid: number, _signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!Number.isInteger(pid) || pid <= 0) return

  if (isWindows()) {
    // 注意 `spawnSync` **不抛异常**：命令不存在时返回的是 `{ error }`，不是 throw。
    // 收敛前的四处实现只用 try/catch 兜底，因此 taskkill 缺失时那段回退是**死代码**。
    // 这里显式检查 `error`（以及 status），把回退真正接上。
    let failed = false
    try {
      const res = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: TASKKILL_TIMEOUT_MS,
        windowsHide: true,
      })
      failed = Boolean(res.error)
    } catch {
      // spawnSync 本身异常（参数非法等），同样走回退
      failed = true
    }

    if (failed) {
      // 退化为单进程 kill，尽力而为——进程可能已退出
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // ignore
      }
    }
    return
  }

  // POSIX：先发给进程组（负 pid），让孙进程一起收到。
  // 进程组不存在（ESRCH）或没权限（EPERM）时退回单进程，不让调用方拿到异常。
  sendToGroup(pid, 'SIGTERM')

  const timer = setTimeout(() => {
    sendToGroup(pid, 'SIGKILL')
  }, SIGKILL_GRACE_MS)
  // 调用方通常在等待 'close'，这个定时器不该独自把事件循环撑住
  timer.unref?.()
}

/**
 * 发信号给进程组；进程组不可用时退回单进程。
 *
 * 先试负 pid（进程组）：`spawnChildInGroup` 出来的进程必然有独立组。
 * 退回单进程是为了兼容**没有**走 `spawnChildInGroup` 的历史调用点
 * （如 `system-service.killProcess` 杀的是外部 pid，本就不存在组归属）。
 */
function sendToGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
    return
  } catch {
    // 负 pid 打不到（非进程组长 / 组已解散）→ 退回单进程
  }

  try {
    process.kill(pid, signal)
  } catch {
    // 进程已退出，属正常情况
  }
}

/**
 * 回收所有登记在册的子进程（应用退出兜底）。
 *
 * 为什么需要：`spawnChildInGroup` 在 POSIX 用了 `detached: true`，子进程不再随
 * 父进程退出而终止。正常路径下 runner 自己会把进程收掉，这里是防止
 * 「Electron 崩溃 / 强杀时技能进程变孤儿继续跑」的兜底。
 *
 * 同步执行、不等待回执——退出流程只剩几秒（见 index.ts 的 CLEANUP_TIMEOUT），
 * 等每个子进程的 SIGKILL 升级不现实。
 */
export function killAllTrackedChildren(): number {
  const pids = Array.from(tracked)
    .map((c) => c.pid)
    .filter((p): p is number => typeof p === 'number' && p > 0)

  for (const pid of pids) {
    killPidTree(pid)
  }
  tracked.clear()

  return pids.length
}

/** 仅供测试：重置登记表 */
export function __resetTrackedChildrenForTests(): void {
  tracked.clear()
}

/** 仅供测试：查看登记数量 */
export function __trackedChildCountForTests(): number {
  return tracked.size
}
