/**
 * 打包图标约定：桌面 / 任务栏必须使用 assets/icon.png 生成的 ICO，
 * 且 electron-builder 必须把图标写入 Lumii.exe（不能关掉资源编辑）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const windowsRoot = resolve(__dirname, '../../..')

/**
 * 读取 electron-builder 配置。
 */
function loadBuilderConfig(): {
  win?: {
    icon?: string
    signAndEditExecutable?: boolean
    signExecutable?: boolean
  }
  nsis?: {
    installerIcon?: string
    uninstallerIcon?: string
    installerHeaderIcon?: string
  }
} {
  return JSON.parse(readFileSync(resolve(windowsRoot, 'electron-builder.json'), 'utf-8'))
}

/**
 * 解析 ICO 目录表，确认含有 Windows 任务栏常用尺寸。
 */
function readIcoSizes(icoPath: string): number[] {
  const buf = readFileSync(icoPath)
  const type = buf.readUInt16LE(2)
  const count = buf.readUInt16LE(4)
  if (type !== 1 || count < 1) {
    throw new Error(`无效 ICO: type=${type} count=${count}`)
  }
  const sizes: number[] = []
  for (let i = 0; i < count; i++) {
    const w = buf[6 + i * 16] || 256
    sizes.push(w)
  }
  return sizes
}

describe('Windows 应用图标（icon.png → exe）', () => {
  it('产品图标源文件存在', () => {
    expect(existsSync(resolve(windowsRoot, 'assets/icon.png'))).toBe(true)
    expect(existsSync(resolve(windowsRoot, 'assets/icon.ico'))).toBe(true)
  })

  it('ICO 含任务栏 / 桌面快捷方式所需尺寸', () => {
    const sizes = readIcoSizes(resolve(windowsRoot, 'assets/icon.ico'))
    expect(sizes).toEqual(expect.arrayContaining([16, 32, 48, 256]))
  })

  it('electron-builder 使用 icon.ico，且不跳过 exe 资源编辑', () => {
    const cfg = loadBuilderConfig()
    expect(cfg.win?.icon).toBe('assets/icon.ico')
    expect(cfg.win?.signAndEditExecutable).not.toBe(false)
    expect(cfg.win?.signExecutable).toBe(false)
    expect(cfg.nsis?.installerIcon).toBe('assets/icon.ico')
    expect(cfg.nsis?.uninstallerIcon).toBe('assets/icon.ico')
    expect(cfg.nsis?.installerHeaderIcon).toBe('assets/icon.ico')
  })
})
