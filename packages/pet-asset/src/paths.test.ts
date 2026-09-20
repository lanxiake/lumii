import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CLIENT_DATA_DIRNAME,
  PET_MODELS_SUBDIR,
  resolveClientDataRoot,
  resolveUserPetDir,
} from './paths.js'

const NO_ENV: NodeJS.ProcessEnv = {}

describe('resolveClientDataRoot', () => {
  it('默认取 ~/.lumii', () => {
    expect(resolveClientDataRoot(NO_ENV)).toBe(join(homedir(), '.lumii'))
  })

  it('LUMII_CLIENT_DATA_DIR 可覆盖（与客户端侧同一约定）', () => {
    expect(resolveClientDataRoot({ LUMII_CLIENT_DATA_DIR: 'D:\\data\\lumii' })).toBe('D:\\data\\lumii')
  })

  it('覆盖值里的 ~ 展开为主目录', () => {
    expect(resolveClientDataRoot({ LUMII_CLIENT_DATA_DIR: '~/alt' })).toBe(join(homedir(), 'alt'))
  })

  it('空白覆盖值按未设置处理', () => {
    expect(resolveClientDataRoot({ LUMII_CLIENT_DATA_DIR: '   ' })).toBe(join(homedir(), '.lumii'))
  })

  it('常量与客户端侧同值（改动须两边同步）', () => {
    expect(CLIENT_DATA_DIRNAME).toBe('.lumii')
    expect(PET_MODELS_SUBDIR).toBe('pet-models')
  })
})

describe('resolveUserPetDir', () => {
  it('默认 = 数据根 / pet-models', () => {
    expect(resolveUserPetDir(undefined, NO_ENV)).toBe(join(homedir(), '.lumii', 'pet-models'))
  })

  it('--target 优先于环境变量', () => {
    expect(resolveUserPetDir('C:\\explicit', { PET_MODELS_DIR: 'C:\\from-env' })).toBe('C:\\explicit')
  })

  it('PET_MODELS_DIR 优先于默认', () => {
    expect(resolveUserPetDir(undefined, { PET_MODELS_DIR: 'C:\\from-env' })).toBe('C:\\from-env')
  })

  it('数据根被覆盖时随之改变', () => {
    expect(resolveUserPetDir(undefined, { LUMII_CLIENT_DATA_DIR: 'D:\\d' })).toBe(
      join('D:\\d', 'pet-models'),
    )
  })

  it('不依赖 dev/打包模式，也不读 app.getPath —— 这是与客户端对齐的前提', () => {
    // 曾经的实现按 %APPDATA%/<应用名> 推断，dev 与打包会分叉；
    // 这条用例锁住「同一环境变量下取值稳定」这个性质。
    const a = resolveUserPetDir(undefined, NO_ENV)
    const b = resolveUserPetDir(undefined, NO_ENV)
    expect(a).toBe(b)
    expect(a).not.toMatch(/APPDATA|lumii-windows/i)
  })
})
