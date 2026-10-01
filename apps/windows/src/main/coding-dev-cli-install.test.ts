/**
 * 卸载配方解析与安装配方平台分派测试
 *
 * 重点：npm 安装 vs 官方脚本安装走不同卸载路径；Windows 与 Linux 的
 * 命令形态不同（PowerShell vs rm/npm），automatic 判据按「当前平台有没有命令」。
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const shellCommandMock = vi.hoisted(() => ({ runShellCommand: vi.fn() }))
vi.mock('./platform/shell-command.js', () => shellCommandMock)

import { installLocalAcpTool, previewUninstallLocalAcpTool } from './coding-dev-cli-install.js'
import * as detect from './coding-dev-cli-detect.js'
import { LOCAL_ACP_TOOL_META, type LocalAcpToolStatus } from './coding-dev-cli-detect.js'

/** 构造探测结果桩 */
function stub(id: detect.PrimaryLocalAcpToolId, resolvedPath?: string): LocalAcpToolStatus {
  return {
    ...LOCAL_ACP_TOOL_META[id],
    installed: true,
    ...(resolvedPath ? { resolvedPath } : {}),
  }
}

/** 让 previewUninstallLocalAcpTool 读到指定探测结果 */
function mockDetect(status: LocalAcpToolStatus): void {
  vi.spyOn(detect, 'detectLocalAcpTool').mockResolvedValue(status)
}

const isWin = process.platform === 'win32'

describe('previewUninstallLocalAcpTool', () => {
  it('claude 装在 npm 全局目录时用 npm uninstall', async () => {
    mockDetect(stub('claude', 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\.bin\\claude.cmd'))
    const p = await previewUninstallLocalAcpTool('claude')
    expect(p.displayCommand).toBe('npm uninstall -g @anthropic-ai/claude-code')
    expect(p.documented).toBe(true)
    expect(p.automatic).toBe(true)
  })

  it('claude 原生安装时按平台给出对应卸载命令', async () => {
    mockDetect(stub('claude', isWin ? 'C:\\Users\\x\\.local\\bin\\claude.exe' : '/home/x/.local/bin/claude'))
    const p = await previewUninstallLocalAcpTool('claude')
    if (isWin) {
      expect(p.displayCommand).toContain('Remove-Item')
    } else {
      expect(p.displayCommand).toContain('rm -f ~/.local/bin/claude')
    }
    expect(p.displayCommand).not.toContain('npm')
    expect(p.documented).toBe(true)
    expect(p.automatic).toBe(true)
  })

  it.skipIf(isWin)('Linux：非 ~/.local 的原生安装无法自动卸载（如 brew）', async () => {
    mockDetect(stub('claude', '/home/linuxbrew/.linuxbrew/bin/claude'))
    const p = await previewUninstallLocalAcpTool('claude')
    expect(p.automatic).toBe(false)
    expect(p.displayCommand).toContain('手动')
  })

  it.skipIf(isWin)('Linux：cursor 官方脚本安装（~/.local 符号链接）可自动卸载', async () => {
    mockDetect(stub('cursor', '/home/x/.local/bin/agent'))
    const p = await previewUninstallLocalAcpTool('cursor')
    expect(p.automatic).toBe(true)
    expect(p.displayCommand).toContain('rm -f ~/.local/bin/agent')
    expect(p.displayCommand).toContain('rm -rf ~/.local/share/cursor-agent')
  })

  it.skipIf(isWin)('Linux：npm 全局 bin 是符号链接时也按 npm 卸载（realpath 指向 node_modules）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-npm-cli-'))
    try {
      const target = path.join(root, 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, '')
      const binDir = path.join(root, 'bin')
      fs.mkdirSync(binDir, { recursive: true })
      const link = path.join(binDir, 'claude')
      fs.symlinkSync(target, link)

      mockDetect(stub('claude', link))
      const p = await previewUninstallLocalAcpTool('claude')
      expect(p.displayCommand).toBe('npm uninstall -g @anthropic-ai/claude-code')
      expect(p.automatic).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('cursor 无官方卸载命令，需标记为未文档化', async () => {
    mockDetect(stub('cursor', isWin ? 'C:\\Users\\x\\AppData\\Local\\cursor-agent\\agent.exe' : '/home/x/.local/bin/agent'))
    const p = await previewUninstallLocalAcpTool('cursor')
    expect(p.documented).toBe(false)
  })

  it('qoder 脚本安装无法自动卸载', async () => {
    mockDetect(stub('cursor', isWin ? 'C:\\tools\\qoder\\qoder.exe' : '/opt/qoder/qoder'))
    const p = await previewUninstallLocalAcpTool('cursor')
    expect(p.automatic).toBe(false)
  })

  it('opencode 装在 npm 全局目录时用 npm uninstall（两平台都可自动）', async () => {
    mockDetect(stub('opencode', 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\.bin\\opencode.cmd'))
    const p = await previewUninstallLocalAcpTool('opencode')
    expect(p.displayCommand).toBe('npm uninstall -g opencode-ai')
    // npm 命令两平台同形（Linux 配方就位后不再是「只有 win32 可自动」）
    expect(p.automatic).toBe(true)
  })

  it('opencode 装的是非 npm 的独立可执行文件时不能自动卸载（回归：曾误报 npm 卸载成功但实际未删除）', async () => {
    mockDetect(stub('opencode', 'D:\\mysoft\\OpenCode\\OpenCode.exe'))
    const p = await previewUninstallLocalAcpTool('opencode')
    expect(p.automatic).toBe(false)
    expect(p.displayCommand).not.toContain('npm')
  })

  it('未知工具直接拒绝', async () => {
    await expect(previewUninstallLocalAcpTool('rm-rf')).rejects.toThrow(/未知工具/)
  })
})

describe('installLocalAcpTool 平台配方', () => {
  it.skipIf(isWin)('Linux 用 linuxInstallCommand 执行（与 detect META 同源）', async () => {
    vi.spyOn(detect, 'detectLocalAcpTool')
      .mockResolvedValueOnce({ ...LOCAL_ACP_TOOL_META.claude, installed: false })
      .mockResolvedValueOnce(stub('claude', '/home/x/.local/bin/claude'))
    shellCommandMock.runShellCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })

    const r = await installLocalAcpTool('claude')

    expect(shellCommandMock.runShellCommand.mock.calls[0]?.[0]).toBe(
      LOCAL_ACP_TOOL_META.claude.linuxInstallCommand,
    )
    expect(r.ok).toBe(true)
  })

  it.skipIf(!isWin)('Windows 仍用 PowerShell 配方（回归护栏）', async () => {
    vi.spyOn(detect, 'detectLocalAcpTool')
      .mockResolvedValueOnce({ ...LOCAL_ACP_TOOL_META.claude, installed: false })
      .mockResolvedValueOnce(stub('claude', 'C:\\Users\\x\\.local\\bin\\claude.exe'))
    shellCommandMock.runShellCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })

    const r = await installLocalAcpTool('claude')

    expect(shellCommandMock.runShellCommand.mock.calls[0]?.[0]).toBe(
      'irm https://claude.ai/install.ps1 | iex',
    )
    expect(r.ok).toBe(true)
  })
})
