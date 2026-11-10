import { describe, expect, it } from 'vitest'
import { defaultShell } from './terminal-service'

/**
 * 只测不碰原生模块的部分：真正的 spawn 要 Electron 运行时 + PTY，
 * 在 vitest 里跑不了（也不是这个文件的职责）。
 * 这里守的是「空 shell 名 / 空 cwd」这类会让 spawn 静默失败的前提。
 */
describe('terminal-service', () => {
  it('默认 shell 总是一个非空字符串（空串会让 PTY spawn 抛得很远）', () => {
    const shell = defaultShell()
    expect(typeof shell).toBe('string')
    expect(shell.length).toBeGreaterThan(0)
  })

  it('Windows 上落到一个可执行的 .exe（COMSPEC 或 cmd.exe）', () => {
    if (process.platform !== 'win32') return
    // COMSPEC 由系统提供；缺省时函数自己兜到 cmd.exe，两条路都必须可执行
    expect(defaultShell()).toMatch(/\.exe$/i)
  })
})
