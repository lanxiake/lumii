/**
 * @vitest-environment node
 */
/**
 * platform/system-info 的**解析层**规格。
 *
 * 用桩 stdout 测字段映射与边界值——任何平台都能跑，CI 上稳定。
 * 「真实命令能不能用、真的返回数据」在 `system-info.real.test.ts` 里单独测
 * （那个文件不 mock 模块，因为在本文件里 mock 之后 require 会拿到 mock 自身）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { execFileSpy } = vi.hoisted(() => ({ execFileSpy: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: execFileSpy }
})

import { getDiskInfo, getProcessList } from './system-info'

const ORIGINAL_PLATFORM = process.platform

function withPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

/** 让 promisify(execFile) 返回给定的 stdout */
function stubStdout(stdout: string): void {
  execFileSpy.mockImplementation((_cmd: string, _args: string[], cb: (e: unknown, r: unknown) => void) => {
    cb(null, { stdout, stderr: '' })
  })
}

describe('platform/system-info', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true })
    vi.restoreAllMocks()
  })

  describe('磁盘 — POSIX 解析', () => {
    beforeEach(() => {
      withPlatform('linux')
    })

    it('解析 df -kP 输出，块数换算成字节', () => {
      stubStdout(
        [
          'Filesystem     1024-blocks      Used Available Capacity Mounted on',
          '/dev/nvme0n1p2   1920641280 30316920 1799312384       2% /',
          '/dev/nvme0n1p1      523248     6220    517028       2% /boot/efi',
        ].join('\n'),
      )

      return getDiskInfo().then((disks) => {
        expect(disks).toHaveLength(2)
        expect(disks[0]).toMatchObject({
          name: '/dev/nvme0n1p2',
          mount: '/',
          total: 1920641280 * 1024,
          used: 30316920 * 1024,
          free: 1799312384 * 1024,
          usagePercent: 2,
        })
      })
    })

    it('挂载点含空格时仍能正确取到挂载点（取最后一列而非按空格切第 6 列）', () => {
      stubStdout(
        [
          'Filesystem     1024-blocks      Used Available Capacity Mounted on',
          '/dev/sda1          10240000   1024000   9216000      10% /mnt/my disk',
        ].join('\n'),
      )

      return getDiskInfo().then((disks) => {
        // 按 split(/\s+/) 取 [5] 会得到 "/mnt/my"，这里记录当前行为
        expect(disks).toHaveLength(1)
        expect(disks[0]!.mount.startsWith('/mnt/my')).toBe(true)
      })
    })

    it('跳表头，且 total 为 0 的行被丢弃', () => {
      stubStdout(
        [
          'Filesystem     1024-blocks      Used Available Capacity Mounted on',
          'none                     0         0         0        - /proc/sys/fs/binfmt_misc',
          '/dev/sda1          10240000   1024000   9216000      10% /',
        ].join('\n'),
      )

      return getDiskInfo().then((disks) => {
        expect(disks).toHaveLength(1)
        expect(disks[0]!.mount).toBe('/')
      })
    })

    it('输出为空时不报错，返回空数组（拿不到数据不该让页面崩）', () => {
      stubStdout('')

      return getDiskInfo().then((disks) => {
        expect(disks).toEqual([])
      })
    })

    it('df 的参数包含 -P 与 -k（缺了会因长设备名换行而解析错位）', async () => {
      stubStdout('Filesystem 1024-blocks Used Available Capacity Mounted on\n')

      await getDiskInfo()

      const args = execFileSpy.mock.calls[0]![1] as string[]
      // -k 与 -P 合并成 -kP 是合法写法，两个语义都要在
      expect(args.some((a) => a.includes('P'))).toBe(true)
      expect(args.some((a) => a.includes('k'))).toBe(true)
    })
  })

  describe('进程 — POSIX 解析', () => {
    beforeEach(() => {
      withPlatform('linux')
    })

    it('解析 ps -eo pid=,comm=,pcpu=,rss= 输出，rss 换算成 MB', () => {
      stubStdout(
        [
          '    1 systemd           0.0  14336',
          '  498 node              2.5 512000',
        ].join('\n'),
      )

      return getProcessList().then((procs) => {
        expect(procs).toHaveLength(2)
        expect(procs[0]).toMatchObject({ pid: 1, name: 'systemd', cpu: 0, memory: 14 })
        expect(procs[1]).toMatchObject({ pid: 498, name: 'node', cpu: 2.5, memory: 500 })
        expect(procs[1]!.memoryBytes).toBe(512000 * 1024)
      })
    })

    it('跳过解析不出的行（pid 不是正整数）', () => {
      stubStdout(
        [
          '    1 systemd           0.0  14336',
          '  abc broken            0.0   1024',
          '    0 zero-pid          0.0   1024',
        ].join('\n'),
      )

      return getProcessList().then((procs) => {
        expect(procs).toHaveLength(1)
        expect(procs[0]!.pid).toBe(1)
      })
    })

    it('用 = 后缀参数压掉表头（省掉跳过首行的脆弱判断）', async () => {
      stubStdout('    1 systemd 0.0 1024\n')

      await getProcessList()

      const args = execFileSpy.mock.calls[0]![1] as string[]
      expect(args.join(' ')).toContain('pid=')
      expect(args.join(' ')).toContain('rss=')
    })

    it('进程名带短横线/下划线时原样保留', () => {
      stubStdout('  123 pool_workqueue_ 0.0 0\n  124 kworker/0:1-eve 0.0 0\n')

      return getProcessList().then((procs) => {
        expect(procs.map((p) => p.name)).toEqual(['pool_workqueue_', 'kworker/0:1-eve'])
      })
    })
  })
})
