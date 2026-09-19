/**
 * @vitest-environment node
 */
/**
 * platform/system-info 的**真实调用**验证（不 mock，跑本机命令）。
 *
 * 为什么单独一个文件：`system-info.test.ts` mock 了 `node:child_process`，
 * 在同一个文件里 `require` 拿到的也是 mock，会变成自引用。
 *
 * 这组测试的价值：收敛前 `getDiskInfo` / `getProcessList` 硬编码 PowerShell，
 * 在 Linux 上**固定返回空数组**（`powershell` 不存在 → execAsync 抛错 → catch 返回 []）。
 * 所以「列表非空」本身就是「收敛真的生效了」的凭据。
 *
 * 非 POSIX 平台整体跳过——Windows 侧走 WMI/Get-Process，那套在 CI 的 Linux 上测不了。
 */
import { describe, it, expect } from 'vitest'
import { getDiskInfo, getProcessList } from './system-info'

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('platform/system-info — 真实命令（POSIX）', () => {
  it('df 真的返回本机磁盘，且挂了根分区', async () => {
    const disks = await getDiskInfo()

    expect(disks.length).toBeGreaterThan(0)
    expect(disks.some((d) => d.mount === '/')).toBe(true)
    expect(disks.every((d) => d.total > 0)).toBe(true)
    // 用量占比应在 0–100 之间（排除把 "45%" 当 45 以外的解析错位）
    expect(disks.every((d) => d.usagePercent >= 0 && d.usagePercent <= 100)).toBe(true)
  }, 15_000)

  it('ps 真的返回本机进程，字段合理', async () => {
    const procs = await getProcessList()

    expect(procs.length).toBeGreaterThan(5)
    expect(procs.every((p) => Number.isInteger(p.pid) && p.pid > 0 && p.name.length > 0)).toBe(true)
    // 至少有一个进程占用内存——排除「全都解析成 0」这种静默失败
    expect(procs.some((p) => p.memory > 0)).toBe(true)
  }, 15_000)

  it('虚拟文件系统已过滤（不混入 tmpfs / devtmpfs / squashfs / snap）', async () => {
    const disks = await getDiskInfo()

    expect(disks.filter((d) => /tmpfs|squashfs|devtmpfs/.test(d.name))).toEqual([])
    expect(disks.filter((d) => d.mount.startsWith('/snap'))).toEqual([])
  }, 15_000)
})
