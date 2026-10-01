/** @vitest-environment node */
/**
 * shell-command：真实子进程验证（正常退出 / 非零 / 超时杀进程树）。
 *
 * 与 shell-runner / python-runner 的测试同一路数——执行原语的判据是
 * 「真进程真的按预期结束」，mock 掉的 spawn 证明不了这一点。
 */
import { describe, expect, it } from 'vitest'
import { runShellCommand } from './shell-command'

const isWin = process.platform === 'win32'
const sleep5 = isWin ? 'Start-Sleep -Seconds 5' : 'sleep 5'
const echoHi = isWin ? "Write-Output 'hi'" : "echo hi"
const exit3 = isWin ? 'exit 3' : 'exit 3'

describe('runShellCommand', () => {
  it('正常命令：退出码 0、stdout 带回输出', async () => {
    const r = await runShellCommand(echoHi, 20_000)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('hi')
  }, 30_000)

  it('非零退出码原样返回', async () => {
    const r = await runShellCommand(exit3, 20_000)
    expect(r.exitCode).toBe(3)
  }, 30_000)

  it('超时：杀进程树并返回 exitCode=null，stderr 带超时说明', async () => {
    const started = Date.now()
    const r = await runShellCommand(sleep5, 500)
    expect(r.exitCode).toBeNull()
    expect(r.stderr).toContain('执行超时')
    // 不能等满 5 秒才返回——那说明 kill 没生效，只是等命令自己结束
    expect(Date.now() - started).toBeLessThan(4_000)
  }, 30_000)

  it('命令不存在：报错信息原样带回（不抛异常）', async () => {
    const r = await runShellCommand('definitely-not-a-command-xyz', 20_000)
    expect(r.exitCode).not.toBe(0)
    // 报错文案随 locale 变化（本机中文 bash 报「未找到命令」），不断言具体措辞
    expect(`${r.stderr}${r.stdout}`.toLowerCase()).toMatch(
      /not found|未找到命令|无法将|不是内部或外部命令/,
    )
  }, 30_000)
})
