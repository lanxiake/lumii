/**
 * pet-asset-protocol 单元测试
 *
 * 这里守的是**安全边界**：`lumii-pet://` 只允许读到用户宠物目录之内。
 * 越界判定在 `resolve()` 之后做前缀比对，所以 `..`、URL 编码、混合分隔符
 * 这些花招都该被同一道闸拦住——用例逐个覆盖。
 *
 * 根目录用固定的假数据根，不依赖真实 `~/.lumii`，也不依赖 dev/打包模式。
 */
import { describe, it, expect, vi } from 'vitest'

const DATA_ROOT = 'C:\\fake\\data\\lumii'
const USER_PET_DIR = `${DATA_ROOT}\\pet-models`

vi.mock('../client-data-root', () => ({
  resolveClientStateDir: () => DATA_ROOT,
  resolveWindowsClientDataRoot: () => DATA_ROOT,
}))

vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
}))

import {
  buildPetAssetUrl,
  petAssetUrlToDiskPath,
  resolveUserPetModelsDir,
} from './pet-asset-protocol'

describe('resolveUserPetModelsDir', () => {
  it('取客户端数据根下的 pet-models（不用 app.getPath，避免 dev/打包分叉）', () => {
    expect(resolveUserPetModelsDir()).toBe(USER_PET_DIR)
  })
})

describe('buildPetAssetUrl', () => {
  it('目录内路径 → lumii-pet://model/<相对路径>', () => {
    expect(buildPetAssetUrl(`${USER_PET_DIR}\\cat\\manifest.json`)).toBe(
      'lumii-pet://model/cat/manifest.json',
    )
  })

  it('路径分隔符统一为 /', () => {
    expect(buildPetAssetUrl(`${USER_PET_DIR}\\a\\b\\c.png`)).toBe('lumii-pet://model/a/b/c.png')
  })

  it('特殊字符按段编码', () => {
    expect(buildPetAssetUrl(`${USER_PET_DIR}\\my cat\\图.png`)).toBe(
      'lumii-pet://model/my%20cat/%E5%9B%BE.png',
    )
  })

  it('目录本身（根）不可作为资源 URL → 抛错', () => {
    expect(() => buildPetAssetUrl(USER_PET_DIR)).toThrow()
  })

  it('目录外的路径 → 抛错（调用方传错路径属于 bug，不该静默）', () => {
    expect(() => buildPetAssetUrl('C:\\Windows\\win.ini')).toThrow()
    expect(() => buildPetAssetUrl(`${USER_PET_DIR}\\..\\..\\secret.png`)).toThrow()
  })
})

describe('petAssetUrlToDiskPath — 正常路径', () => {
  it('还原为绝对路径', () => {
    expect(petAssetUrlToDiskPath('lumii-pet://model/cat/manifest.json')).toBe(
      `${USER_PET_DIR}\\cat\\manifest.json`,
    )
  })

  it('编码过的段被正确解码', () => {
    expect(petAssetUrlToDiskPath('lumii-pet://model/my%20cat/%E5%9B%BE.png')).toBe(
      `${USER_PET_DIR}\\my cat\\图.png`,
    )
  })

  it('与 buildPetAssetUrl 互逆', () => {
    const abs = `${USER_PET_DIR}\\my_pet\\atlas.png`
    expect(petAssetUrlToDiskPath(buildPetAssetUrl(abs))).toBe(abs)
  })
})

describe('petAssetUrlToDiskPath — 越界与非法输入', () => {
  /** 唯一要守的不变式：结果要么为 null，要么落在用户宠物目录之内 */
  const withinRoot = (p: string | null, root: string) =>
    p === null || p === root || p.startsWith(root + '\\')

  it('任何敌意输入都逃不出用户宠物目录', () => {
    const probes = [
      'lumii-pet://model/../../../Windows/win.ini',
      'lumii-pet://model/cat/../../outside.png',
      'lumii-pet://model/%2e%2e/%2e%2e/secret.png',
      'lumii-pet://model/..%5C..%5Csecret.png',
      'lumii-pet://model/....//....//x.png',
      'lumii-pet://model/C:/Windows/win.ini',
      'lumii-pet://model/C%3A/Windows/win.ini',
      'lumii-pet://model//server/share/x.png',
      'lumii-pet://model///../../x.png',
      'lumii-pet://model/cat/%2E%2E/%2E%2E/%2E%2E/x.png',
    ]
    for (const p of probes) {
      expect(withinRoot(petAssetUrlToDiskPath(p), USER_PET_DIR), p).toBe(true)
    }
  })

  it('上跳段被 URL 解析器归一化后关在目录内（不是靠字符串检查拦下的）', () => {
    // 实测：WHATWG URL 会在我们拿到 pathname 之前就折叠 `..` 与 `%2e%2e`，
    // 以 `/` 开头的路径上不去根。所以这些输入得到的是**目录内的**路径而非 null。
    // 真正兜底的是下面这条前缀比对——归一化后再比，才不会被编码/分隔符变体绕过。
    expect(petAssetUrlToDiskPath('lumii-pet://model/../../../Windows/win.ini')).toBe(
      `${USER_PET_DIR}\\Windows\\win.ini`,
    )
    expect(petAssetUrlToDiskPath('lumii-pet://model/%2e%2e/%2e%2e/secret.png')).toBe(
      `${USER_PET_DIR}\\secret.png`,
    )
  })

  it('反斜杠形式的上跳逃出目录 → null（URL 不归一化 %5C，由前缀比对拦住）', () => {
    expect(petAssetUrlToDiskPath('lumii-pet://model/..%5C..%5Csecret.png')).toBeNull()
  })

  it('绝对路径（Windows 盘符）→ null（resolve 到根盘，前缀比对失败）', () => {
    expect(petAssetUrlToDiskPath('lumii-pet://model/C:/Windows/win.ini')).toBeNull()
    expect(petAssetUrlToDiskPath('lumii-pet://model/C%3A/Windows/win.ini')).toBeNull()
  })

  it('双斜杠开头的路径被当作目录内相对路径（UNC 前缀被剥掉，不构成越权）', () => {
    expect(petAssetUrlToDiskPath('lumii-pet://model//server/share/x.png')).toBe(
      `${USER_PET_DIR}\\server\\share\\x.png`,
    )
  })

  it('空路径与仅根路径', () => {
    expect(petAssetUrlToDiskPath('lumii-pet://model/')).toBeNull()
    expect(petAssetUrlToDiskPath('lumii-pet://model')).toBeNull()
  })

  it('错误的 host', () => {
    expect(petAssetUrlToDiskPath('lumii-pet://other/cat/manifest.json')).toBeNull()
  })

  it('错误的协议', () => {
    expect(petAssetUrlToDiskPath('file:///C:/x.png')).toBeNull()
    expect(petAssetUrlToDiskPath('https://example.com/x.png')).toBeNull()
    expect(petAssetUrlToDiskPath('lumii-local://media/?path=C:/x.png')).toBeNull()
  })

  it('不是 URL 的输入', () => {
    expect(petAssetUrlToDiskPath('cat/manifest.json')).toBeNull()
    expect(petAssetUrlToDiskPath('')).toBeNull()
  })

  it('含 NUL 的路径', () => {
    expect(petAssetUrlToDiskPath('lumii-pet://model/cat/a%00b.png')).toBeNull()
  })
})
