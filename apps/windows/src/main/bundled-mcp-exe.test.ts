/** @vitest-environment node */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getBundledMcpExeRelativePath, syncMcpExecutable } from './bundled-mcp-exe'

describe('随包独立 MCP exe 部署', () => {
  let root: string
  let source: string
  let target: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-mcp-exe-'))
    source = path.join(root, 'bundle', 'wechat-mcp.exe')
    target = path.join(root, 'deploy', 'wechat-mcp', 'wechat-mcp.exe')
    fs.mkdirSync(path.dirname(source), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('首次部署：建目录并拷贝', async () => {
    fs.writeFileSync(source, 'v1')
    await expect(syncMcpExecutable(source, target)).resolves.toEqual({ ok: true, path: target, updated: true })
    expect(fs.readFileSync(target, 'utf-8')).toBe('v1')
  })

  it('内容相同不动；内容变化则更新，旧文件改名让位并在下次清理', async () => {
    fs.writeFileSync(source, 'v1')
    await syncMcpExecutable(source, target)
    await expect(syncMcpExecutable(source, target)).resolves.toMatchObject({ updated: false })

    fs.writeFileSync(source, 'v2')
    await expect(syncMcpExecutable(source, target)).resolves.toMatchObject({ ok: true, updated: true })
    expect(fs.readFileSync(target, 'utf-8')).toBe('v2')
    const dir = path.dirname(target)
    expect(fs.readdirSync(dir).some((n) => n.startsWith('wechat-mcp.exe.old-'))).toBe(true)

    await syncMcpExecutable(source, target)
    expect(fs.readdirSync(dir)).toEqual(['wechat-mcp.exe'])
  })

  it('随包文件缺失：从未部署则失败，部署过则沿用旧版并告警', async () => {
    const missing = await syncMcpExecutable(source, target)
    expect(missing.ok).toBe(false)

    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'old')
    const kept = await syncMcpExecutable(source, target)
    expect(kept).toMatchObject({ ok: true, updated: false })
    expect(kept.ok && kept.warning).toMatch(/沿用已部署版本/)
    expect(fs.readFileSync(target, 'utf-8')).toBe('old')
  })

  it('开发期取构建产物 dist/，打包后取资源目录根', () => {
    expect(getBundledMcpExeRelativePath('wechat-mcp', false)).toBe(path.join('wechat-mcp', 'dist', 'wechat-mcp.exe'))
    expect(getBundledMcpExeRelativePath('wechat-mcp', true)).toBe(path.join('wechat-mcp', 'wechat-mcp.exe'))
  })
})
