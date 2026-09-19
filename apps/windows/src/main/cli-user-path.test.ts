/**
 * @vitest-environment node
 */
/**
 * 用户 CLI 目录并入 PATH 的单测。
 *
 * 路径样例随运行平台取（`C:\...` vs `/...`）：在 Linux 上塞 Windows 路径会假失败——
 * 路径里的 `:` 与 Linux 的 `path.delimiter` 撞车，切分错乱。这不是被测逻辑的问题，
 * 是测试断言的平台假设问题。两种平台各自的语义都要保住，所以用参数化而不是删用例。
 */
import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { listUserCliBinDirs, mergePathWithCliDirs } from './cli-user-path'

const isWin = process.platform === 'win32'

/** 平台对应的一组路径样例：<用户 bin 目录, 系统目录> */
const PATHS = isWin
  ? { userBin: 'C:\\Users\\x\\.local\\bin', systemDir: 'C:\\Windows\\System32' }
  : { userBin: '/home/x/.local/bin', systemDir: '/usr/bin' }

describe('listUserCliBinDirs', () => {
  it('包含 uv 默认安装目录 ~/.local/bin', () => {
    expect(listUserCliBinDirs()).toContain(path.join(os.homedir(), '.local', 'bin'))
  })

  if (isWin) {
    it('包含 cargo 目录，且带 Windows 专属的 LOCALAPPDATA 候选', () => {
      const dirs = listUserCliBinDirs()

      expect(dirs).toContain(path.join(os.homedir(), '.cargo', 'bin'))
      // LOCALAPPDATA 存在时必须补 uv / cursor-agent 两处
      if (process.env.LOCALAPPDATA) {
        expect(dirs).toContain(path.join(process.env.LOCALAPPDATA, 'Programs', 'uv'))
      }
      // POSIX 专属项不该出现在 Windows 上
      expect(dirs).not.toContain('/usr/local/bin')
    })
  } else {
    it('包含各包管理器的默认 bin 目录（Linux 上 CLI 落点分散）', () => {
      const dirs = listUserCliBinDirs()
      const home = os.homedir()

      expect(dirs).toContain(path.join(home, '.cargo', 'bin'))
      expect(dirs).toContain(path.join(home, '.npm-global', 'bin'))
      expect(dirs).toContain(path.join(home, '.local', 'share', 'pnpm'))
      expect(dirs).toContain(path.join(home, '.bun', 'bin'))
      expect(dirs).toContain('/usr/local/bin')
    })

    it('不返回 Windows 专属项', () => {
      const dirs = listUserCliBinDirs()

      expect(dirs.some((d) => d.includes('Programs'))).toBe(false)
      expect(dirs.some((d) => d.includes('cursor-agent'))).toBe(false)
    })
  }

  it('返回的都是绝对路径（相对路径并入 PATH 没有意义）', () => {
    for (const dir of listUserCliBinDirs()) {
      expect(path.isAbsolute(dir), dir).toBe(true)
    }
  })
})

describe('mergePathWithCliDirs', () => {
  it('把已存在且不在 PATH 里的目录前置', () => {
    const extra = PATHS.userBin
    const merged = mergePathWithCliDirs(PATHS.systemDir, [extra], (dir) => dir === extra)

    expect(merged.split(path.delimiter)[0]).toBe(extra)
  })

  it('不存在的目录不写入 PATH', () => {
    const merged = mergePathWithCliDirs(PATHS.systemDir, [PATHS.userBin], () => false)

    expect(merged).toBe(PATHS.systemDir)
  })

  it('已在 PATH 中的目录不重复前置', () => {
    const extra = PATHS.userBin
    const current = `${extra}${path.delimiter}${PATHS.systemDir}`
    const merged = mergePathWithCliDirs(current, [extra], () => true)

    // Windows 路径大小写不敏感，POSIX 敏感——比较方式随之切换
    const hits = merged
      .split(path.delimiter)
      .filter((p) => (isWin ? p.toLowerCase() === extra.toLowerCase() : p === extra))
    expect(hits).toHaveLength(1)
  })

  it('多个候选目录按给定顺序前置', () => {
    const a = isWin ? 'C:\\a' : '/a'
    const b = isWin ? 'C:\\b' : '/b'
    const merged = mergePathWithCliDirs(PATHS.systemDir, [a, b], () => true)

    const parts = merged.split(path.delimiter)
    expect(parts.indexOf(a)).toBeLessThan(parts.indexOf(b))
  })
})
