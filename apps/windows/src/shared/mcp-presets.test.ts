import { describe, expect, it } from 'vitest'
import { findMcpPreset } from './mcp-presets'

describe('findMcpPreset', () => {
  it('清单内的名字直接命中', () => {
    expect(findMcpPreset('comfyui-remote')?.backgroundTools).toEqual(['enqueue_workflow'])
  })

  it('老用户落盘的别名 comfyui 也能回查到内置说明', () => {
    // 2026-10-24：mcp-servers.json 里这台叫 comfyui，清单里叫 comfyui-remote，
    // 查不到 → backgroundTools 补不上 → 工具不后台化 → 任务卡与中断全都不出现
    const preset = findMcpPreset('comfyui')
    expect(preset?.name).toBe('comfyui-remote')
    expect(preset?.backgroundTools).toEqual(['enqueue_workflow'])
  })

  it('自建服务返回 undefined，不瞎猜', () => {
    expect(findMcpPreset('my-own-server')).toBeUndefined()
  })
})
