/**
 * Stub for src/process/exec.ts
 * Windows 客户端不需要 trash 功能的完整实现
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function runExec(
  command: string,
  args: string[],
  options?: { timeoutMs?: number },
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, args, {
    timeout: options?.timeoutMs ?? 10_000,
  })
  return { stdout: result.stdout, stderr: result.stderr }
}
