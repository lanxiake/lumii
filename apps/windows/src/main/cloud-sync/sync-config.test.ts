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

import { _resetWindowsClientDataRootCacheForTest } from '../client-data-root'
import {
  DEFAULT_CLOUD_SYNC_CONFIG,
  decryptToken,
  loadCloudSyncConfig,
  saveConfigFromView,
  toConfigView,
} from './sync-config'

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
})
