/**
 * 卸载配方解析测试：npm 安装 vs 官方脚本安装走不同卸载路径
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}))

import { previewUninstallLocalAcpTool } from './coding-dev-cli-install.js'
import * as detect from './coding-dev-cli-detect.js'
import type { LocalAcpToolStatus } from './coding-dev-cli-detect.js'

/** 构造探测结果桩 */
function stub(id: detect.PrimaryLocalAcpToolId, resolvedPath?: string): LocalAcpToolStatus {
  return {
    ...detect.LOCAL_ACP_TOOL_META[id],
    installed: true,
    ...(resolvedPath ? { resolvedPath } : {}),
  }
}

/** 让 previewUninstallLocalAcpTool 读到指定探测结果 */
function mockDetect(status: LocalAcpToolStatus): void {
  vi.spyOn(detect, 'detectLocalAcpTool').mockResolvedValue(status)
}

describe('previewUninstallLocalAcpTool', () => {
  it('claude 装在 npm 全局目录时用 npm uninstall', async () => {
    mockDetect(stub('claude', 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\.bin\\claude.cmd'))
    const p = await previewUninstallLocalAcpTool('claude')
    expect(p.displayCommand).toBe('npm uninstall -g @anthropic-ai/claude-code')
    expect(p.documented).toBe(true)
  })

  it('claude 原生安装时删官方文档给出的路径', async () => {
    mockDetect(stub('claude', 'C:\\Users\\x\\.local\\bin\\claude.exe'))
    const p = await previewUninstallLocalAcpTool('claude')
    expect(p.displayCommand).toContain('Remove-Item')
    expect(p.displayCommand).not.toContain('npm')
  })

  it('cursor 无官方卸载命令，需标记为未文档化', async () => {
    mockDetect(stub('cursor', 'C:\\Users\\x\\AppData\\Local\\cursor-agent\\agent.exe'))
    const p = await previewUninstallLocalAcpTool('cursor')
    expect(p.documented).toBe(false)
  })

  it('qoder 脚本安装无法自动卸载', async () => {
    mockDetect(stub('cursor', 'C:\\tools\\qoder\\qoder.exe'))
    const p = await previewUninstallLocalAcpTool('cursor')
    expect(p.automatic).toBe(false)
  })

  it('opencode 装在 npm 全局目录时用 npm uninstall', async () => {
    mockDetect(stub('opencode', 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\.bin\\opencode.cmd'))
    const p = await previewUninstallLocalAcpTool('opencode')
    expect(p.displayCommand).toBe('npm uninstall -g opencode-ai')
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
