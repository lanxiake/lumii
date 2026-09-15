/**
 * coding-dev-local-runner 单元测试
 *
 * 重点覆盖 shell 参数引号化：Windows 上 .cmd shim（如 cursor 的 agent.cmd）必须
 * 经 cmd.exe 启动，而 spawn(shell:true) 不会引号化 args，实测会把带空格的 prompt
 * 切成多个 argv，并把 & | > 当命令分隔符执行。
 */
import { describe, expect, it } from 'vitest'
import { buildLocalCliArgs, quoteForCmd } from './coding-dev-local-runner'

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

describe('buildLocalCliArgs 多轮续接参数', () => {
  it('claude：prompt 走 stdin，argv 里不含 prompt；有续接追加 --resume', () => {
    expect(buildLocalCliArgs('claude', 'claude', 'hi')).toEqual({
      command: 'claude',
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      stdinPrompt: true,
    })
    expect(buildLocalCliArgs('claude', 'claude', 'hi', 'sid-1').args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--resume',
      'sid-1',
    ])
  })

  it('claude：多行 prompt 不进 argv（回归：曾被 cmd shim 截断，连 --output-format 一起丢失）', () => {
    const multi = '第一行\n\n第二行\n第三行'
    const { args, stdinPrompt } = buildLocalCliArgs('claude', 'claude', multi)
    // 走 stdin 才可能完整送达 —— 命令行放不下字面换行符
    expect(stdinPrompt).toBe(true)
    expect(args.join(' ')).not.toContain('第一行')
    // 关键参数必须齐备，且不受 prompt 内容影响
    expect(args).toContain('--output-format')
    expect(args).toContain('stream-json')
    expect(args).toContain('--verbose')
  })

  it('cursor：prompt 排在最后（同为 .cmd shim，截断时关键参数仍先生效）', () => {
    const args = buildLocalCliArgs('cursor', 'cursor', 'hi').args
    expect(args[args.length - 1]).toBe('hi')
    expect(args.indexOf('--output-format')).toBeLessThan(args.indexOf('hi'))
  })

  it('codex：续接改子命令形态 exec resume；按平台带沙箱参数', () => {
    const sandboxArgs =
      process.platform === 'win32'
        ? ['--dangerously-bypass-approvals-and-sandbox']
        : ['-s', 'workspace-write']
    expect(buildLocalCliArgs('codex', 'codex', 'hi', 'th-1').args).toEqual([
      'exec',
      'resume',
      'th-1',
      '--skip-git-repo-check',
      ...sandboxArgs,
      '--json',
      'hi',
    ])
    expect(buildLocalCliArgs('codex', 'codex', 'hi').args).toEqual([
      'exec',
      '--skip-git-repo-check',
      ...sandboxArgs,
      '--json',
      'hi',
    ])
  })

  it('opencode：续接用 --session，且始终带 --format json', () => {
    expect(buildLocalCliArgs('opencode', 'opencode', 'hi').args).toEqual(['run', '--format', 'json', 'hi'])
    expect(buildLocalCliArgs('opencode', 'opencode', 'hi', 's1').args).toEqual([
      'run',
      '--session',
      's1',
      '--format',
      'json',
      'hi',
    ])
  })

  it('cursor：续接追加 --resume（prompt 仍排在最后）', () => {
    const args = buildLocalCliArgs('cursor', 'cursor', 'hi', 'c1').args
    expect(args).toEqual([
      '--output-format',
      'stream-json',
      '--trust',
      '--resume',
      'c1',
      '-p',
      'hi',
    ])
    expect(args[args.length - 1]).toBe('hi')
  })
})
