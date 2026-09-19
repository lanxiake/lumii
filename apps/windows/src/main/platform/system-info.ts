/**
 * 磁盘 / 进程列表的平台实现（设计 §5.3）。
 *
 * Windows 侧沿用 `Get-WmiObject` / `Get-Process`（不动既有行为）；
 * POSIX 侧用 `df` 与 `ps`——两个命令在 Linux 与 macOS 上都存在，
 * 不需要为「哪个发行版装了 procps」做分支。
 *
 * 设计取舍：**解析失败时返回空数组而不是抛异常**。系统信息页是可选的诊断面板，
 * 拿不到数据不该让整个页面崩掉；调用方拿到空列表会显示「无数据」，比报错更可诊断。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 与 system-service.ts 的 DiskInfo 对齐（那边是从这里 import 还是自己定义见调用点） */
export interface PlatformDiskInfo {
  name: string
  mount: string
  type: string
  total: number
  free: number
  used: number
  usagePercent: number
}

export interface PlatformProcessInfo {
  pid: number
  name: string
  cpu: number
  memory: number
  memoryBytes: number
  status: string
}

function isWindows(): boolean {
  return process.platform === 'win32'
}

/** 把 PS 的 JSON 输出归一成数组（单条时 PS 返回对象而非数组） */
function asArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value]
}

/**
 * Windows：`Get-WmiObject Win32_LogicalDisk`，只取本地固定磁盘（DriveType 3）。
 *
 * 保留 `-Command` 字符串形式（而非 execFile 传数组）是沿袭现状——PowerShell
 * 的参数解析与普通可执行文件不同，改动它属于额外风险，本次不做。
 */
async function getWindowsDisks(): Promise<PlatformDiskInfo[]> {
  const { stdout } = await execFileAsync('powershell', [
    '-Command',
    'Get-WmiObject Win32_LogicalDisk | Where-Object { $_.DriveType -eq 3 } | Select-Object DeviceID, Size, FreeSpace, FileSystem | ConvertTo-Json',
  ])

  return asArray(
    JSON.parse(stdout) as {
      DeviceID: string
      Size: number
      FreeSpace: number
      FileSystem: string
    },
  ).map((disk) => {
    const total = disk.Size || 0
    const free = disk.FreeSpace || 0
    const used = total - free
    return {
      name: disk.DeviceID,
      mount: disk.DeviceID,
      type: disk.FileSystem || 'Unknown',
      total,
      free,
      used,
      usagePercent: total > 0 ? Math.round((used / total) * 100) : 0,
    }
  })
}

/**
 * POSIX：`df -kP`。
 *
 * `-P` 强制 POSIX 输出格式——不加的话长设备名会导致 `df` 换行，列数对不齐，
 * 解析静默错位。`-k` 固定以 1K 块为单位（各平台默认块大小不一致）。
 *
 * 过滤掉虚拟文件系统：`tmpfs`（内存盘，对用户没意义）、`devtmpfs`、`squashfs`
 * （snap 挂载点，数量多且无意义）。这些常驻几十条，不过滤会把列表刷满。
 */
async function getPosixDisks(): Promise<PlatformDiskInfo[]> {
  const { stdout } = await execFileAsync('df', [
    '-kP',
    '-x',
    'tmpfs',
    '-x',
    'devtmpfs',
    '-x',
    'squashfs',
    '-x',
    'overlay',
  ])

  const lines = stdout.split('\n').filter(Boolean)
  // 首行是表头 Filesystem 1024-blocks Used Available Capacity Mounted on
  const result: PlatformDiskInfo[] = []

  for (const line of lines.slice(1)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 6) continue

    const [filesystem, totalK, usedK, freeK, capacity, mount] = parts
    const total = Number(totalK) * 1024
    const used = Number(usedK) * 1024
    const free = Number(freeK) * 1024
    if (!Number.isFinite(total) || total <= 0) continue

    // 容量列形如 "45%"，去掉百分号；用它而不是自己算，和 df 的显示保持一致
    const usagePercent = Number(String(capacity).replace('%', '')) || 0

    result.push({
      name: filesystem!,
      mount: mount!,
      type: 'disk',
      total,
      free,
      used,
      usagePercent,
    })
  }

  return result
}

/** 磁盘信息：Windows 走 WMI，POSIX 走 df */
export async function getDiskInfo(): Promise<PlatformDiskInfo[]> {
  if (isWindows()) return getWindowsDisks()
  return getPosixDisks()
}

/**
 * POSIX：`ps -eo pid=,comm=,pcpu=,rss=`。
 *
 * 用 `=` 后缀压掉表头（`pid=` 而不是 `pid`）——省一次「跳过首行」的脆弱判断。
 * `rss` 单位是 KB。`comm` 只给可执行文件名（不带参数），正是这里要的短名字。
 *
 * 一次性取全量再排序，而不是 `ps | head`：进程列表页要支持排序与搜索，
 * 只取前 N 条会让排序结果不完整。
 */
async function getPosixProcesses(): Promise<PlatformProcessInfo[]> {
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,comm=,pcpu=,rss='])

  const result: PlatformProcessInfo[] = []
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 4) continue

    const [pidStr, name, cpuStr, rssStr] = parts
    const pid = Number(pidStr)
    if (!Number.isInteger(pid) || pid <= 0) continue

    const rssKb = Number(rssStr) || 0
    result.push({
      pid,
      name: name || '?',
      cpu: Number(cpuStr) || 0,
      memory: Math.round(rssKb / 1024),
      memoryBytes: rssKb * 1024,
      status: 'running',
    })
  }

  return result
}

/** Windows：`Get-Process`，字段与收敛前一致 */
async function getWindowsProcesses(): Promise<PlatformProcessInfo[]> {
  const { stdout } = await execFileAsync('powershell', [
    '-Command',
    'Get-Process | Select-Object Id, ProcessName, CPU, WorkingSet64 | ConvertTo-Json',
  ])

  return asArray(
    JSON.parse(stdout) as { Id: number; ProcessName: string; CPU: number; WorkingSet64: number }[],
  ).map((proc) => ({
    pid: proc.Id,
    name: proc.ProcessName,
    cpu: proc.CPU || 0,
    memory: Math.round((proc.WorkingSet64 || 0) / 1024 / 1024),
    memoryBytes: proc.WorkingSet64 || 0,
    status: 'running',
  }))
}

/** 进程列表：Windows 走 Get-Process，POSIX 走 ps */
export async function getProcessList(): Promise<PlatformProcessInfo[]> {
  if (isWindows()) return getWindowsProcesses()
  return getPosixProcesses()
}
