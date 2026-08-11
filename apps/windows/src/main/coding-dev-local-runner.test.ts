/**
 * coding-dev-local-runner 单元测试
 *
 * 重点覆盖 shell 参数引号化：Windows 上 .cmd shim（如 cursor 的 agent.cmd）必须
 * 经 cmd.exe 启动，而 spawn(shell:true) 不会引号化 args，实测会把带空格的 prompt
 * 切成多个 argv，并把 & | > 当命令分隔符执行。
 */
import { describe, expect, it } from 'vitest'
import { quoteForCmd } from './coding-dev-local-runner'

describe('quoteForCmd', () => {
  it('带空格的参数被包成单个 token', () => {
    expect(quoteForCmd('say hi')).toBe('"say hi"')
  })

  it('shell 元字符不再暴露给 cmd 解释', () => {
    // 未引号化时 cmd 会执行 `echo INJECTED`
    const quoted = quoteForCmd('a & echo INJECTED')
    expect(quoted).toBe('"a & echo INJECTED"')
    expect(quoted.startsWith('"')).toBe(true)
    expect(quoted.endsWith('"')).toBe(true)
  })

  it('内部引号按 cmd 规则转义为两个引号', () => {
    expect(quoteForCmd('has "quotes" inside')).toBe('"has ""quotes"" inside"')
  })

  it('管道与重定向被当作字面量', () => {
    expect(quoteForCmd('pipe | redirect > file')).toBe('"pipe | redirect > file"')
  })
})
