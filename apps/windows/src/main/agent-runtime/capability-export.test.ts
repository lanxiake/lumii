/**
 * capability_export：可读目录 + 片段，拒绝覆盖，失败不留残骸。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exportCapability } from './capability-export'

let workspace: string
let configDir: string

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-cap-export-'))
  configDir = path.join(workspace, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  const skillDir = path.join(workspace, 'skills', '逆向与复刻', 'reverse')
  fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# reverse\n\n逆向分析。\n', 'utf8')
  fs.writeFileSync(path.join(skillDir, 'references', 'web.md'), '参考\n', 'utf8')
})

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true })
})

function writeMcp(content: unknown): void {
  fs.writeFileSync(path.join(configDir, 'mcp-servers.json'), JSON.stringify(content), 'utf8')
}

describe('exportCapability — skill', () => {
  it('技能目录完整拷贝，README 非空', () => {
    const res = exportCapability({
      workspaceDir: workspace,
      configDir,
      name: 'reverse-copy',
      source: { kind: 'skill', id: '逆向与复刻/reverse' },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(fs.readFileSync(path.join(res.dir, 'SKILL.md'), 'utf8')).toContain('逆向分析')
    expect(fs.readFileSync(path.join(res.dir, 'references', 'web.md'), 'utf8')).toBe('参考\n')
    expect(fs.readFileSync(path.join(res.dir, 'README.md'), 'utf8').length).toBeGreaterThan(0)
  })

  it('id 不存在 → ok:false，且不建半个目录', () => {
    const res = exportCapability({
      workspaceDir: workspace,
      configDir,
      name: 'nope',
      source: { kind: 'skill', id: '不存在/skill' },
    })
    expect(res.ok).toBe(false)
    expect(fs.existsSync(path.join(workspace, 'exports', 'nope'))).toBe(false)
  })

  it('目标已存在 → 拒绝覆盖', () => {
    fs.mkdirSync(path.join(workspace, 'exports', 'dup'), { recursive: true })
    const res = exportCapability({
      workspaceDir: workspace,
      configDir,
      name: 'dup',
      source: { kind: 'skill', id: '逆向与复刻/reverse' },
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('拒绝覆盖')
  })

  it('dest 指到工作区外 → 拒绝', () => {
    const res = exportCapability({
      workspaceDir: workspace,
      configDir,
      name: 'x',
      dest: '../outside',
      source: { kind: 'skill', id: '逆向与复刻/reverse' },
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('工作区内')
  })
})

describe('exportCapability — mcp', () => {
  it('只拷选中的一条，内容深拷贝原样（标准 mcpServers 格式）', () => {
    const entry = { command: 'npx', args: ['-y', 'demo'], env: { KEY: 'v' } }
    writeMcp({ mcpServers: { demo: entry, other: { command: 'x' } } })
    const res = exportCapability({
      workspaceDir: workspace,
      configDir,
      name: 'demo-mcp',
      source: { kind: 'mcp', id: 'demo' },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const snippet = JSON.parse(
      fs.readFileSync(path.join(res.dir, 'mcp-servers.snippet.json'), 'utf8'),
    )
    expect(snippet).toEqual({ mcpServers: { demo: entry } })
    expect(fs.readFileSync(path.join(res.dir, 'README.md'), 'utf8')).toContain('凭据')
  })

  it('兼容旧 servers 数组格式', () => {
    writeMcp({ servers: [{ name: 'legacy', command: 'old' }] })
    const res = exportCapability({
      workspaceDir: workspace,
      configDir,
      name: 'legacy-mcp',
      source: { kind: 'mcp', id: 'legacy' },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const snippet = JSON.parse(
      fs.readFileSync(path.join(res.dir, 'mcp-servers.snippet.json'), 'utf8'),
    )
    expect(snippet.mcpServers.legacy).toEqual({ name: 'legacy', command: 'old' })
  })

  it('id 不存在 → 报错并列出可用 id', () => {
    writeMcp({ mcpServers: { alpha: { command: 'a' } } })
    const res = exportCapability({
      workspaceDir: workspace,
      configDir,
      name: 'nope-mcp',
      source: { kind: 'mcp', id: 'beta' },
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('alpha')
  })
})
