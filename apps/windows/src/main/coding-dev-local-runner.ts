/**
 * 本机 ACP / CLI 运行器：在活动工作目录 spawn 各开发类 AI CLI
 *
 * 不经 Gateway，仅连接本机已安装的 CLI（print / exec 非交互模式）。
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import {
  detectLocalAcpTool,
  isPrimaryLocalAcpToolId,
  needsWindowsShell,
  PRIMARY_LOCAL_ACP_TOOLS,
  type PrimaryLocalAcpToolId,
} from './coding-dev-cli-detect.js'
import type {
  CodingDevLightweightBackendOutput,
  CodingDevLightweightBackendProgress,
} from './coding-dev-backends-stub/contracts.js'
import { AcpToolStreamParser } from './coding-dev-jsonl-parsers.js'

export type LocalAcpRunParams = {
  backendId: string
  text: string
  cwd: string
  emitProgress?: (progress: CodingDevLightweightBackendProgress) => Promise<void> | void
  abortSignal?: AbortSignal
}

/**
 * 为各工具构造本机非交互命令行
 */
function buildLocalCliArgs(
  toolId: PrimaryLocalAcpToolId,
  resolvedCommand: string,
  prompt: string,
): { command: string; args: string[]; shell?: boolean } {
  switch (toolId) {
    case 'claude':
      return {
        command: resolvedCommand,
        args: ['-p', prompt, '--output-format', 'stream-json', '--verbose'],
      }
    case 'codex':
      return {
        command: resolvedCommand,
        args: ['exec', '--skip-git-repo-check', '--json', prompt],
      }
    case 'cursor':
      return {
        command: resolvedCommand,
        args: ['-p', prompt, '--output-format', 'stream-json'],
      }
    case 'copilot': {
      const base = path.basename(resolvedCommand).toLowerCase()
      // 独立 @github/copilot：非交互 print；旧版 gh copilot suggest
      if (base.startsWith('gh')) {
        return {
          command: resolvedCommand,
          args: ['copilot', 'suggest', '-t', 'shell', '-s', prompt],
        }
      }
      return {
        command: resolvedCommand,
        args: ['-p', prompt],
      }
    }
    // gemini-cli 及其分支（qwen）：-p 非交互 + 纯文本输出
    case 'gemini':
    case 'qwen':
      return {
        command: resolvedCommand,
        args: ['-p', prompt, '--output-format', 'text'],
      }
    case 'opencode':
      return {
        command: resolvedCommand,
        args: ['run', prompt],
      }
    case 'auggie':
      return {
        command: resolvedCommand,
        args: ['--print', prompt, '--quiet'],
      }
    case 'kimi':
    case 'qoder':
      return {
        command: resolvedCommand,
        args: ['-p', prompt],
      }
    case 'hermes':
      // 注意：hermes 的 -p 是 --profile，一次性执行用 -z
      return {
        command: resolvedCommand,
        args: ['-z', prompt],
      }
  }
}

/**
 * 在本机 cwd 下运行对应 CLI，流式转发 stdout 为进度，返回最终文本
 */
export async function runLocalAcpCli(
  params: LocalAcpRunParams,
): Promise<CodingDevLightweightBackendOutput> {
  const id = params.backendId.trim().toLowerCase()
  if (!isPrimaryLocalAcpToolId(id)) {
    throw new Error(
      `未知的本机工具「${id}」。可用命令：${PRIMARY_LOCAL_ACP_TOOLS.map((t) => `/${t}`).join('、')}，或 /lumii 切回主代理。`,
    )
  }

  const status = await detectLocalAcpTool(id)
  if (!status.installed || !status.resolvedPath) {
    const winHint =
      id === 'cursor' && process.platform === 'win32'
        ? ` Windows 可在 PowerShell 执行：irm 'https://cursor.com/install?win32=true' | iex（安装的是 agent，不是编辑器里的 cursor）。`
        : ''
    throw new Error(
      `未检测到 ${status.label}。请先安装：${status.installUrl}${winHint}`,
    )
  }

  const cmdName = status.resolvedCommand ?? status.commands[0]
  const { command, args } = buildLocalCliArgs(id, status.resolvedPath, params.text)

  await params.emitProgress?.({
    kind: 'status',
    text: `正在本机启动 ${status.label}（${cmdName}）…`,
  })

  return new Promise((resolve, reject) => {
    // Windows 上 .cmd/.bat 必须经 shell，否则 spawn 报 ENOENT
    const useShell = needsWindowsShell(command)
    // ponytail: stdin:'ignore' 防挂住 — codex/cursor 之类即使传了位置参数 prompt
    // 也会检测 stdin 可读性，有就阻塞等更多输入。关掉 stdin 让 CLI 知道这是单发。
    const child = spawn(command, args, {
      cwd: params.cwd,
      windowsHide: true,
      env: { ...process.env },
      shell: useShell,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    const parser = new AcpToolStreamParser(id)
    let stdoutBuffer = ''

    const onAbort = () => {
      try {
        child.kill()
      } catch { /* ignore */ }
      if (!settled) {
        settled = true
        reject(new Error('任务已中止'))
      }
    }
    params.abortSignal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (buf: Buffer) => {
      const chunk = buf.toString('utf8')
      stdout += chunk
      stdoutBuffer += chunk
      // 逐行解析（JSONL 是行分隔 JSON）
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        const progress = parser.parseLine(line)
        if (progress) void params.emitProgress?.(progress)
      }
    })
    child.stderr?.on('data', (buf: Buffer) => {
      const chunk = buf.toString('utf8')
      stderr += chunk
      void params.emitProgress?.({ kind: 'status', text: chunk.slice(0, 400) })
    })

    child.on('error', (err) => {
      params.abortSignal?.removeEventListener('abort', onAbort)
      if (settled) return
      settled = true
      reject(err)
    })

    child.on('close', (code) => {
      params.abortSignal?.removeEventListener('abort', onAbort)
      if (settled) return
      settled = true
      // 处理末尾未闭合行（如果有）
      if (stdoutBuffer.trim()) {
        const progress = parser.parseLine(stdoutBuffer)
        if (progress) void params.emitProgress?.(progress)
      }
      const text = stdout.trim() || stderr.trim()
      if (code !== 0 && !text) {
        reject(new Error(`${status.label} 退出码 ${code}${stderr ? `：${stderr.slice(0, 300)}` : ''}`))
        return
      }
      if (code !== 0 && text) {
        // 部分 CLI 非 0 仍有有用输出
        resolve({ text: `${text}\n\n（进程退出码 ${code}）` })
        return
      }
      resolve({ text: text || `（${status.label} 无输出）` })
    })
  })
}
