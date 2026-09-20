/** @vitest-environment node */
/**
 * 凭据解密失败的**可辨识性**测试。
 *
 * 背景：`decryptApiKey` 曾经是 `catch { return '' }`，于是「密文读不出来」和
 * 「用户没填」在调用方看来完全一样，屏幕上永远是「请先在设置中填写文本对话模型的
 * API Key」。用户重填、重存、重启，凭据依旧读不出来，而没有任何线索指向真正的原因。
 *
 * 所以这里锁的不是「解密算法对不对」（那是 Electron 的事），而是
 * **两条路必须留下可区分的痕迹**。
 *
 * 为什么要 node 环境：jsdom 下 `vi.mock` 对被测模块可能静默失效（仓库既有教训，
 * 见 T3.0 实测记录），那样这些用例会假绿——mock 的 safeStorage 根本没被用上。
 * 单独成文件是为了不把 mock 带进同目录的纯函数用例（`provider-config.test.ts`）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((s: string) => Buffer.from(`SEALED(${s})`, 'utf8')),
  /** 置为 true 时模拟「密钥环变更、这份密文解不开」 */
  failing: { value: false },
  decryptString: vi.fn((b: Buffer) => {
    if (safeStorageMock.failing.value) {
      throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
    }
    const s = b.toString('utf8')
    if (!s.startsWith('SEALED(')) throw new Error('bad ciphertext')
    return s.slice(7, -1)
  }),
}))

vi.mock('electron', () => ({ safeStorage: safeStorageMock }))

let dataRoot = ''
let importSeq = 0

/** 每个用例都要拿到一份全新的模块实例：`client-data-root` 有进程级路径缓存 */
async function loadModule() {
  vi.resetModules()
  importSeq += 1
  void importSeq
  return import('./provider-config')
}

function writeProviderFile(apiKeyEnc: string | undefined) {
  const dir = path.join(dataRoot, 'config')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'provider.json'),
    JSON.stringify({
      version: 1,
      slots: {
        chat: {
          enabled: true,
          type: 'openai',
          baseUrl: 'https://example.invalid',
          modelId: 'm',
          ...(apiKeyEnc === undefined ? {} : { apiKeyEnc }),
        },
      },
    }),
    'utf8',
  )
}

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-config-cred-'))
  process.env.LUMII_CLIENT_DATA_DIR = dataRoot
  safeStorageMock.failing.value = false
  safeStorageMock.decryptString.mockClear()
})

afterEach(() => {
  delete process.env.LUMII_CLIENT_DATA_DIR
  fs.rmSync(dataRoot, { recursive: true, force: true })
})

describe('解密失败必须与「没填」可区分', () => {
  it('解密抛异常时：apiKey 为空，且 apiKeyDecryptFailed 为 true', async () => {
    const { loadProviderConfig } = await loadModule()
    writeProviderFile('some-ciphertext')
    safeStorageMock.failing.value = true

    const cfg = loadProviderConfig()

    expect(safeStorageMock.decryptString).toHaveBeenCalled()
    expect(cfg.apiKey).toBe('')
    expect(cfg.apiKeyDecryptFailed).toBe(true)
  })

  it('解密成功时：拿到明文，且不带 apiKeyDecryptFailed', async () => {
    const { loadProviderConfig } = await loadModule()
    writeProviderFile(Buffer.from('SEALED(sk-live-123)').toString('base64'))

    const cfg = loadProviderConfig()

    expect(cfg.apiKey).toBe('sk-live-123')
    expect(cfg.apiKeyDecryptFailed).toBeUndefined()
  })

  it('压根没有密文时不算失败（用户真的没填）', async () => {
    const { loadProviderConfig } = await loadModule()
    writeProviderFile(undefined)

    const cfg = loadProviderConfig()

    expect(cfg.apiKey).toBe('')
    expect(cfg.apiKeyDecryptFailed).toBeUndefined()
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
  })

  it('plain: 前缀走明文路径，不判为失败', async () => {
    const { loadProviderConfig } = await loadModule()
    writeProviderFile('plain:sk-plain-456')

    const cfg = loadProviderConfig()

    expect(cfg.apiKey).toBe('sk-plain-456')
    expect(cfg.apiKeyDecryptFailed).toBeUndefined()
  })

  it('标记不落盘——重新读一次仍由实际解密结果决定', async () => {
    const { loadProviderConfig } = await loadModule()
    writeProviderFile(Buffer.from('SEALED(sk-x)').toString('base64'))
    safeStorageMock.failing.value = true
    expect(loadProviderConfig().apiKeyDecryptFailed).toBe(true)

    const onDisk = JSON.parse(fs.readFileSync(path.join(dataRoot, 'config', 'provider.json'), 'utf8'))
    expect(onDisk.slots.chat).not.toHaveProperty('apiKeyDecryptFailed')
    // 只读不写：原密文必须还在（这是用户唯一的恢复凭据）
    expect(onDisk.slots.chat.apiKeyEnc).toBe(Buffer.from('SEALED(sk-x)').toString('base64'))
  })
})

describe('保存不得静默抹掉解不开的凭据', () => {
  /**
   * 复现路径（设置页保存时不带 `apiKeyDecryptFailed`，见 `ModelConfigSection` 挑字段构造）：
   * 读出来 apiKey 为空 → 用户顺手改个模型就保存 → 原密文原本会被写成 ''。
   */
  async function saveWithEmptyKey() {
    const cfg = await loadModule()
    writeProviderFile('ORIGINAL-UNREADABLE-CIPHERTEXT')
    safeStorageMock.failing.value = true
    const loaded = cfg.loadProviderSlotsConfig()
    expect(loaded.chat.apiKey).toBe('')
    cfg.saveProviderSlotsConfig({ ...loaded, chat: { ...loaded.chat, apiKey: '' } })
    return JSON.parse(fs.readFileSync(path.join(dataRoot, 'config', 'provider.json'), 'utf8')).slots.chat
  }

  it('解不开且用户没重填时，原密文必须留着（用户唯一的恢复凭据）', async () => {
    const saved = await saveWithEmptyKey()
    expect(saved.apiKeyEnc).toBe('ORIGINAL-UNREADABLE-CIPHERTEXT')
  })

  it('能解开时用户清空 = 主动删除，照清（原行为不变）', async () => {
    const cfg = await loadModule()
    writeProviderFile(Buffer.from('SEALED(sk-old)').toString('base64'))
    const loaded = cfg.loadProviderSlotsConfig()
    expect(loaded.chat.apiKey).toBe('sk-old')

    cfg.saveProviderSlotsConfig({ ...loaded, chat: { ...loaded.chat, apiKey: '' } })

    const saved = JSON.parse(fs.readFileSync(path.join(dataRoot, 'config', 'provider.json'), 'utf8')).slots.chat
    expect(saved.apiKeyEnc).toBe('')
  })

  it('用户填了新值就写新的，旧密文让位', async () => {
    const cfg = await loadModule()
    writeProviderFile('ORIGINAL-UNREADABLE-CIPHERTEXT')
    safeStorageMock.failing.value = true
    const loaded = cfg.loadProviderSlotsConfig()

    // 注意：这一步之后 decryptString 恢复正常，模拟「重填就能用」
    safeStorageMock.failing.value = false
    cfg.saveProviderSlotsConfig({ ...loaded, chat: { ...loaded.chat, apiKey: 'sk-new' } })

    const saved = JSON.parse(fs.readFileSync(path.join(dataRoot, 'config', 'provider.json'), 'utf8')).slots.chat
    expect(saved.apiKeyEnc).not.toBe('ORIGINAL-UNREADABLE-CIPHERTEXT')
    expect(Buffer.from(saved.apiKeyEnc, 'base64').toString('utf8')).toBe('SEALED(sk-new)')
  })
})

describe('missingApiKeyMessage', () => {
  it('解不开时说明原因，并让用户去重填', async () => {
    const { missingApiKeyMessage } = await loadModule()

    const msg = missingApiKeyMessage({ apiKeyDecryptFailed: true })

    expect(msg).toContain('无法解密')
    expect(msg).toContain('重新填写')
    // 不能只说「请先填写」——那会让用户以为是自己没填
    expect(msg).not.toBe('请先在设置中填写文本对话模型的 API Key')
  })

  it('没填时保持原文案（Windows 上现网用户看到的就是这句）', async () => {
    const { missingApiKeyMessage } = await loadModule()

    expect(missingApiKeyMessage({})).toBe('请先在设置中填写文本对话模型的 API Key')
    expect(missingApiKeyMessage(undefined)).toBe('请先在设置中填写文本对话模型的 API Key')
  })
})
