import { describe, expect, it } from 'vitest'
import { buildFormEntry } from '../../renderer/components/McpServersPanel/McpServerEditModal'

const base = { name: 'x', command: 'npx', argsText: '', envText: '', cwd: '', timeoutMsText: '' }

describe('buildFormEntry（MCP 编辑弹窗的表单 → 配置）', () => {
  it('编辑时保留表单编不了的字段——mcp:upsert 是整条替换，漏一个就静默抹掉', () => {
    // 2026-10-09 实测：打开「本机微信」的编辑再保存一下，timeoutMs: 300000 就没了，界面上看不出。
    // timeoutMsText 是弹窗打开时按 editing.timeoutMs 回填的，这里照实传。
    const entry = buildFormEntry({
      ...base,
      editing: {
        name: 'wechat-local',
        command: 'wechat-mcp.exe',
        enabled: true,
        timeoutMs: 300000,
        backgroundTools: ['enqueue_workflow'],
      },
      name: 'wechat-local',
      command: 'wechat-mcp.exe',
      timeoutMsText: '300000',
    })
    expect(entry.timeoutMs).toBe(300000)
    expect(entry.backgroundTools).toEqual(['enqueue_workflow'])
    expect(entry.enabled).toBe(true)
  })

  it('清空参数/工作目录要真的清掉（省略字段的话旧值会从 editing 漏回来）', () => {
    const entry = buildFormEntry({
      ...base,
      editing: { name: 'x', command: 'npx', args: ['-y', 'old'], cwd: 'D:/old' },
    })
    expect(entry.args).toBeUndefined()
    expect(entry.cwd).toBeUndefined()
  })

  it('超时留空 = 不写进配置（交给内置预设）；填了非法值也不写', () => {
    expect(buildFormEntry({ ...base, timeoutMsText: '  ' }).timeoutMs).toBeUndefined()
    expect(buildFormEntry({ ...base, timeoutMsText: 'abc' }).timeoutMs).toBeUndefined()
    expect(buildFormEntry({ ...base, timeoutMsText: '-5' }).timeoutMs).toBeUndefined()
    expect(buildFormEntry({ ...base, timeoutMsText: '300000' }).timeoutMs).toBe(300000)
  })

  it('超时留空能把 editing 里的旧值清掉（用户就是想改回默认）', () => {
    const entry = buildFormEntry({
      ...base,
      editing: { name: 'x', command: 'npx', timeoutMs: 999 },
    })
    expect(entry.timeoutMs).toBeUndefined()
  })

  it('参数按行拆、环境变量按 KEY=VALUE 收；表单空则整条不带', () => {
    const entry = buildFormEntry({
      ...base,
      argsText: '-y\n  @scope/pkg \n',
      envText: 'GITHUB_TOKEN=ghp_x\n# 注释\n\n',
    })
    expect(entry.args).toEqual(['-y', '@scope/pkg'])
    expect(entry.env).toEqual({ GITHUB_TOKEN: 'ghp_x' })
  })
})
