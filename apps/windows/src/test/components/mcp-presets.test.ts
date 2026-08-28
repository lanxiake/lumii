import { describe, expect, it } from 'vitest'
import { MCP_PRESETS, MCP_PRESET_CATEGORIES, findMcpPreset, isReadyToUse } from '../../shared/mcp-presets'
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
      const needsKey = Object.values(preset.env).some((value) => value.trim() === '')
      if (!needsKey) continue
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

  it('播种时至少有一个就绪项默认启用，需配置的都不自动启用', () => {
    const ready = MCP_PRESETS.filter(isReadyToUse)
    expect(ready.length).toBeGreaterThan(0)
    for (const preset of MCP_PRESETS) {
      const needsSetup =
        Boolean(preset.todo) ||
        Object.values(preset.env ?? {}).some((value) => value.trim() === '')
      if (needsSetup) expect(isReadyToUse(preset)).toBe(false)
    }
  })

  it('已下线 memory / chart / context7 / amap，并内置 comfyui-remote', () => {
    const names = MCP_PRESETS.map((p) => p.name)
    for (const name of ['memory', 'chart', 'context7', 'amap']) {
      expect(names).not.toContain(name)
    }

    const comfy = MCP_PRESETS.find((p) => p.name === 'comfyui-remote')
    expect(comfy).toBeTruthy()
    expect(comfy!.args).toEqual(['-y', 'comfyui-mcp'])
    expect(comfy!.env).toEqual({ COMFYUI_URL: 'https://cfui.cpolar.top' })
    expect(isReadyToUse(comfy!)).toBe(true)
  })

  it('不收录 sequential-thinking（模型自带推理）', () => {
    expect(MCP_PRESETS.map((p) => p.name)).not.toContain('sequential-thinking')
    expect(MCP_PRESETS.flatMap((p) => p.args).join(' ')).not.toContain('server-sequential-thinking')
  })

  it('不收录 filesystem（已内置文件工具）', () => {
    expect(MCP_PRESETS.map((p) => p.name)).not.toContain('filesystem')
    expect(MCP_PRESETS.flatMap((p) => p.args).join(' ')).not.toContain('server-filesystem')
  })

  it('新增内置项包名与官方一致，不用不存在的名字', () => {
    const pkgOf = (name: string) => MCP_PRESETS.find((p) => p.name === name)?.args.at(-1)
    expect(pkgOf('excel-mcp')).toBe('excel-mcp')
    // 官方是 firecrawl-mcp；@mcp/firecrawl 在 npm 上不存在，写错等于把安装位交给抢注者
    expect(pkgOf('firecrawl-mcp')).toBe('firecrawl-mcp')
    expect(pkgOf('mcp-trends-hub')).toBe('mcp-trends-hub')
    expect(pkgOf('civil-code-mcp')).toBe('@iflow-mcp/civil-code-of-china-mcp')
  })

  it('要密钥的默认不启用，且给出申请地址', () => {
    for (const preset of MCP_PRESETS) {
      const needsKey = Object.values(preset.env ?? {}).some((v) => v.trim() === '')
      if (!needsKey) continue
      expect(isReadyToUse(preset)).toBe(false)
      expect(preset.keyUrl).toMatch(/^https:\/\//)
    }
  })

  it('无密钥的内置项默认启用，不让用户多点一次', () => {
    for (const name of ['excel-mcp', 'mcp-trends-hub', 'civil-code-mcp']) {
      const preset = MCP_PRESETS.find((p) => p.name === name)
      expect(preset, name).toBeTruthy()
      expect(isReadyToUse(preset!), name).toBe(true)
    }
  })

  it('findMcpPreset 能按名字查到说明，自建服务查不到', () => {
    expect(findMcpPreset('firecrawl-mcp')?.keyUrl).toBe('https://www.firecrawl.dev/')
    expect(findMcpPreset('我自己配的')).toBeUndefined()
  })
})
