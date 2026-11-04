/**
 * sync-config 单元测试：token 加解密（plain 兜底）、缺文件默认值、空 token 沿用旧值。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((s: string) => Buffer.from(s)),
    decryptString: vi.fn((b: Buffer) => b.toString()),
  },
}))

import { _resetWindowsClientDataRootCacheForTest } from '../../../../main/client-data-root'
import {
  DEFAULT_CLOUD_SYNC_CONFIG,
  decryptToken,
  loadCloudSyncConfig,
  saveConfigFromView,
  toConfigView,
} from './sync-config'
import { matchGlob } from './sync-scope'

const baseView = {
  enabled: true,
  provider: 'gitcode' as const,
  repoUrl: 'https://gitcode.com/alice/notes.git',
  branch: 'main',
  intervalMinutes: 15,
  token: 'secret-token',
  tokenMasked: '',
  workspaceDir: '',
}

describe('sync-config', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-sync-config-'))
    process.env.LUMII_CLIENT_DATA_DIR = tmpDir
    _resetWindowsClientDataRootCacheForTest()
  })

  afterEach(() => {
    delete process.env.LUMII_CLIENT_DATA_DIR
    _resetWindowsClientDataRootCacheForTest()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('缺文件时返回默认配置', () => {
    expect(loadCloudSyncConfig()).toEqual(DEFAULT_CLOUD_SYNC_CONFIG)
  })

  it('默认配置含分级传输阈值（1MB / 50MB）', () => {
    const cfg = loadCloudSyncConfig()
    expect(cfg.smallFileThresholdBytes).toBe(1024 * 1024)
    expect(cfg.largeFileBatchBytes).toBe(50 * 1024 * 1024)
  })

  it('saveConfigFromView 保留分级阈值 —— View 不含该字段，不能被覆写丢失', () => {
    // 落盘一个非默认阈值（模拟将来拨到 1MB）
    const file = path.join(tmpDir, 'config', 'cloud-sync.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      JSON.stringify({ ...DEFAULT_CLOUD_SYNC_CONFIG, smallFileThresholdBytes: 1048576 }),
    )

    saveConfigFromView({ ...baseView })

    expect(loadCloudSyncConfig().smallFileThresholdBytes).toBe(1048576)
  })

  it('decryptToken 处理 plain 前缀与空值', () => {
    expect(decryptToken('plain:secret')).toBe('secret')
    expect(decryptToken('')).toBe('')
    expect(decryptToken(undefined)).toBe('')
  })

  it('saveConfigFromView 保存后可读回（plain 兜底）', () => {
    saveConfigFromView({ ...baseView })
    const cfg = loadCloudSyncConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.repoUrl).toBe('https://gitcode.com/alice/notes.git')
    expect(decryptToken(cfg.tokenEnc)).toBe('secret-token')
  })

  it('空 token 沿用旧值', () => {
    saveConfigFromView({ ...baseView, token: 'first-token' })
    saveConfigFromView({ ...baseView, token: '' })
    expect(decryptToken(loadCloudSyncConfig().tokenEnc)).toBe('first-token')
  })

  it('toConfigView 只回传掩码，不泄露明文', () => {
    const view = toConfigView({ ...DEFAULT_CLOUD_SYNC_CONFIG, tokenEnc: 'plain:secret-token' })
    expect(view.tokenMasked).toBe('secr****oken')
    expect(view).not.toHaveProperty('tokenEnc')
    expect(JSON.stringify(view)).not.toContain('secret-token')
  })


/**
 * 默认排除规则：只同步文本/代码/文档。
 *
 * 现场（2026-11-04）：仓库 11GB 里 9.5GB 是历史，其中 `wiki_sources.jsonl` 的
 * 466 个版本占 7.9GB（当前文件才 4MB）、`outputs/` 的 17797 个历史 blob 占 4GB。
 * 二进制文件每次改动都在 git 里留一个完整新副本，本来就不该走版本控制。
 */
describe('默认排除规则', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-sync-excl-'))
    process.env.LUMII_CLIENT_DATA_DIR = dir
    _resetWindowsClientDataRootCacheForTest()
  })
  afterEach(() => {
    delete process.env.LUMII_CLIENT_DATA_DIR
    _resetWindowsClientDataRootCacheForTest()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('默认配置排除多媒体与压缩包', () => {
    const cfg = loadCloudSyncConfig()
    expect(cfg.syncExcludePatterns).toEqual(DEFAULT_CLOUD_SYNC_CONFIG.syncExcludePatterns)
    for (const p of ['**/*.mp4', '**/*.png', '**/*.zip', '**/*.part']) {
      expect(cfg.syncExcludePatterns).toContain(p)
    }
  })

  /**
   * **老配置里的空数组不能把默认规则覆盖掉**。
   *
   * 老用户的 cloud-sync.json 里存的是 `syncExcludePatterns: []`（默认值就是空），
   * 直接用 `{...默认, ...raw}` 展开会让排除规则失效——那正是这轮要修的问题。
   */
  it('老配置的空数组不覆盖默认规则（合并而非覆盖）', () => {
    const file = path.join(dir, 'config', 'cloud-sync.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ repoUrl: 'https://x/y.git', syncExcludePatterns: [] }))
    const cfg = loadCloudSyncConfig()
    expect(cfg.syncExcludePatterns).toContain('**/*.mp4')
    expect(cfg.repoUrl).toBe('https://x/y.git')
  })

  it('用户自己加的排除规则与默认合并（去重）', () => {
    const file = path.join(dir, 'config', 'cloud-sync.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      JSON.stringify({ syncExcludePatterns: ['**/secret/**', '**/*.mp4'] }),
    )
    const patterns = loadCloudSyncConfig().syncExcludePatterns ?? []
    expect(patterns).toContain('**/secret/**')
    // 默认的也还在，且不重复
    expect(patterns.filter((p) => p === '**/*.mp4')).toHaveLength(1)
  })

  it('文本/代码/文档不被排除', () => {
    // 类型上 syncExcludePatterns 是可选的（老配置可能没有），这里取默认值断言
    const patterns = loadCloudSyncConfig().syncExcludePatterns ?? []
    for (const f of ['a.md', 'b.json', 'c.html', 'd.ts', 'e.py', 'f.jsonl', 'g.txt']) {
      expect(patterns.some((p) => matchGlob(p, f)), f).toBe(false)
    }
    for (const f of ['x.mp4', 'y.png', 'z.zip', 'w.part']) {
      expect(patterns.some((p) => matchGlob(p, f)), f).toBe(true)
    }
  })
})
})
