import { describe, expect, it } from 'vitest'
import { MCP_PRESETS, MCP_PRESET_CATEGORIES, isReadyToUse } from '../../shared/mcp-presets'
import { validateMcpServerEntry } from '../../main/config/mcp-config'

describe('MCP 内置清单', () => {
  it('每条都能通过主进程的配置校验', () => {
    for (const preset of MCP_PRESETS) {
      expect(validateMcpServerEntry({ name: preset.name, command: preset.command })).toBeNull()
    }
  })

  it('名称不重复，分类都在枚举内', () => {
    const ids = MCP_PRESET_CATEGORIES.map((c) => c.id)
    expect(new Set(MCP_PRESETS.map((p) => p.name)).size).toBe(MCP_PRESETS.length)
    for (const preset of MCP_PRESETS) {
      expect(preset.categories.length).toBeGreaterThan(0)
      for (const cat of preset.categories) expect(ids).toContain(cat)
    }
  })

  it('每个分类都有可选项，不会出现空 Tab', () => {
    for (const cat of MCP_PRESET_CATEGORIES) {
      expect(MCP_PRESETS.filter((p) => p.categories.includes(cat.id)).length).toBeGreaterThan(0)
    }
  })

  it('需要密钥的项留空占位并给出申请地址，不写死假值', () => {
    for (const preset of MCP_PRESETS) {
      if (!preset.env) continue
      for (const value of Object.values(preset.env)) expect(value).toBe('')
      expect(preset.todo).toBeTruthy()
      expect(preset.keyUrl).toMatch(/^https:\/\//)
    }
  })

  it('全部走 npx 自动安装，不依赖 uv/pip/docker', () => {
    for (const preset of MCP_PRESETS) {
      expect(preset.command).toBe('npx')
      expect(preset.args[0]).toBe('-y')
    }
  })

  it('不重复内置的 browser_* 工具', () => {
    const pkgs = MCP_PRESETS.flatMap((p) => p.args).join(' ')
    expect(pkgs).not.toContain('playwright')
    expect(pkgs).not.toContain('chrome-devtools')
  })

  it('播种时至少有一个零配置项默认启用，需配置的都不自动启用', () => {
    const ready = MCP_PRESETS.filter(isReadyToUse)
    expect(ready.length).toBeGreaterThan(0)
    for (const preset of MCP_PRESETS) {
      if (preset.todo || preset.env) expect(isReadyToUse(preset)).toBe(false)
    }
  })

  it('filesystem 不写死盘符路径，用占位符交给主进程解析', () => {
    const fsPreset = MCP_PRESETS.find((p) => p.name === 'filesystem')
    expect(fsPreset).toBeTruthy()
    expect(fsPreset!.args).toContain('{{USER_DOCUMENTS}}')
    expect(fsPreset!.args).not.toContain('D:/Documents')
    expect(fsPreset!.args).not.toContain('D:\\Documents')
  })
})
