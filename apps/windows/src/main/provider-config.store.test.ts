/** @vitest-environment node */
/**
 * 多 Provider 存储（v2）的迁移与解析测试。
 *
 * 锁的是三件事：
 * 1. 旧的 v1（每槽内嵌凭据）/ 更早的单模型结构，读出来不能丢配置；
 * 2. 同一家同一把 Key 被多个槽使用时，迁移成一个 provider 而不是三份重复条目；
 * 3. 槽引用解析出的平铺视图，与改造前运行时的形状一致（bridge 不用改）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`SEALED(${s})`, 'utf8'),
  decryptString: (b: Buffer) => {
    const s = b.toString('utf8')
    // SEALED2( 也是合法密文：用来模拟「同一把 Key、两次加密得到不同密文」
    const m = /^SEALED2?\((.*)\)$/s.exec(s)
    if (!m) throw new Error('bad ciphertext')
    return m[1]!
  },
}))

vi.mock('electron', () => ({ safeStorage: safeStorageMock }))

let dataRoot = ''

async function loadModule() {
  vi.resetModules()
  return import('./provider-config')
}

function writeProviderFile(payload: unknown) {
  const dir = path.join(dataRoot, 'config')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'provider.json'), JSON.stringify(payload), 'utf8')
}

function readProviderFile() {
  return JSON.parse(fs.readFileSync(path.join(dataRoot, 'config', 'provider.json'), 'utf8'))
}

function seal(plain: string): string {
  return Buffer.from(`SEALED(${plain})`, 'utf8').toString('base64')
}

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-store-'))
  process.env.LUMII_CLIENT_DATA_DIR = dataRoot
})

afterEach(() => {
  delete process.env.LUMII_CLIENT_DATA_DIR
  fs.rmSync(dataRoot, { recursive: true, force: true })
})

describe('v1 → v2 迁移', () => {
  it('同一份凭据被 chat/vision 共用时合并成一个 provider，模型取并集', async () => {
    const cfg = await loadModule()
    writeProviderFile({
      version: 1,
      slots: {
        chat: {
          enabled: true,
          type: 'deepseek',
          baseUrl: 'https://api.deepseek.com',
          modelId: 'deepseek-v4-flash',
          allowedModelIds: ['deepseek-v4-flash'],
          apiKeyEnc: seal('sk-shared'),
        },
        vision: {
          enabled: true,
          type: 'deepseek',
          baseUrl: 'https://api.deepseek.com',
          modelId: 'deepseek-vl',
          allowedModelIds: ['deepseek-vl'],
          apiKeyEnc: seal('sk-shared'),
        },
      },
    })

    const store = cfg.loadProviderStore()

    expect(store.providers).toHaveLength(1)
    expect(store.providers[0]!.apiKey).toBe('sk-shared')
    expect(store.providers[0]!.modelIds.sort()).toEqual(['deepseek-v4-flash', 'deepseek-vl'])
    expect(store.slots.chat.providerId).toBe(store.slots.vision.providerId)
    expect(store.slots.chat.modelId).toBe('deepseek-v4-flash')
    expect(store.slots.vision.modelId).toBe('deepseek-vl')
  })

  it('同一份凭据的**不同密文**也必须合并（DPAPI 每次加密结果不同）', async () => {
    const cfg = await loadModule()
    // 真实场景：safeStorage 对同一把 Key 两次加密得到的密文并不相同。
    // 若拿密文当去重键，同一家会被拆成多条重复条目（实测踩到）。
    writeProviderFile({
      version: 1,
      slots: {
        chat: {
          enabled: true,
          type: 'anthropic',
          baseUrl: 'https://www.llm-link.top',
          modelId: 'deepseek-flash',
          // 两次加密的产物不同，但明文都是 sk-same
          apiKeyEnc: Buffer.from('SEALED(sk-same)', 'utf8').toString('base64'),
        },
        vision: {
          enabled: true,
          type: 'anthropic',
          baseUrl: 'https://www.llm-link.top',
          modelId: 'deepseek-flash',
          apiKeyEnc: Buffer.from('SEALED2(sk-same)', 'utf8').toString('base64'),
        },
      },
    })

    const store = cfg.loadProviderStore()
    expect(store.providers).toHaveLength(1)
    expect(store.slots.chat.providerId).toBe(store.slots.vision.providerId)
  })

  it('不同端点的槽迁移成两条独立 provider', async () => {
    const cfg = await loadModule()
    writeProviderFile({
      version: 1,
      slots: {
        chat: {
          enabled: true,
          type: 'openai',
          baseUrl: 'https://a.example.com',
          modelId: 'm1',
          apiKeyEnc: seal('sk-a'),
        },
        image: {
          enabled: true,
          type: 'rightapi',
          baseUrl: 'https://www.rightapi.ai/draw/v1',
          modelId: 'img-1',
          apiKeyEnc: seal('sk-b'),
        },
      },
    })

    const store = cfg.loadProviderStore()
    expect(store.providers).toHaveLength(2)
    expect(store.slots.chat.providerId).not.toBe(store.slots.image.providerId)
    expect(store.slots.image.modelId).toBe('img-1')
  })

  it('更早的单模型结构并入 chat', async () => {
    const cfg = await loadModule()
    writeProviderFile({
      enabled: true,
      type: 'openai',
      baseUrl: 'https://legacy.example.com',
      modelId: 'legacy-model',
      apiKeyEnc: seal('sk-legacy'),
    })

    const store = cfg.loadProviderStore()
    expect(store.providers).toHaveLength(1)
    expect(store.slots.chat.providerId).toBe(store.providers[0]!.id)
    expect(cfg.loadProviderConfig().apiKey).toBe('sk-legacy')
  })
})

describe('槽引用解析为平铺视图', () => {
  it('loadSlotConfig 返回运行时需要的全部字段', async () => {
    const cfg = await loadModule()
    writeProviderFile({
      version: 2,
      providers: [
        {
          id: 'p1',
          name: 'DeepSeek',
          type: 'deepseek',
          baseUrl: 'https://api.deepseek.com',
          apiKeyEnc: seal('sk-1'),
          modelIds: ['deepseek-v4-flash', 'deepseek-v4-pro'],
        },
      ],
      slots: {
        chat: {
          enabled: true,
          providerId: 'p1',
          modelId: 'deepseek-v4-flash',
          contextWindowK: { 'deepseek-v4-flash': 1048 },
        },
      },
    })

    const chat = cfg.loadSlotConfig('chat')
    expect(chat.enabled).toBe(true)
    expect(chat.type).toBe('deepseek')
    expect(chat.baseUrl).toBe('https://api.deepseek.com')
    expect(chat.apiKey).toBe('sk-1')
    expect(chat.modelId).toBe('deepseek-v4-flash')
    expect(chat.allowedModelIds).toContain('deepseek-v4-pro')
    expect(chat.contextWindowK).toEqual({ 'deepseek-v4-flash': 1048 })
  })

  it('槽指向不存在的 provider 时视为未配置，而不是乱用别家凭据', async () => {
    const cfg = await loadModule()
    writeProviderFile({
      version: 2,
      providers: [
        { id: 'p1', type: 'openai', baseUrl: 'https://a.example.com', apiKeyEnc: seal('sk-a') },
      ],
      slots: { chat: { enabled: true, providerId: 'gone', modelId: 'm' } },
    })

    const chat = cfg.loadSlotConfig('chat')
    expect(chat.enabled).toBe(false)
    expect(chat.apiKey).toBe('')
  })

  it('按 providerId::modelId 取到对应 provider 的凭据（会话跨 Provider 切换）', async () => {
    const cfg = await loadModule()
    writeProviderFile({
      version: 2,
      providers: [
        {
          id: 'p1',
          type: 'deepseek',
          baseUrl: 'https://api.deepseek.com',
          apiKeyEnc: seal('sk-deepseek'),
          modelIds: ['deepseek-v4-flash'],
        },
        {
          id: 'p2',
          type: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKeyEnc: seal('sk-or'),
          modelIds: ['anthropic/claude-sonnet-4'],
        },
      ],
      slots: { chat: { enabled: true, providerId: 'p1', modelId: 'deepseek-v4-flash' } },
    })

    const cfg2 = cfg.loadSlotConfigForModel('chat', 'p2::anthropic/claude-sonnet-4')
    expect(cfg2.type).toBe('openrouter')
    expect(cfg2.apiKey).toBe('sk-or')
    expect(cfg2.baseUrl).toBe('https://openrouter.ai/api/v1')

    // 不带前缀时仍用槽自己的 provider
    expect(cfg.loadSlotConfigForModel('chat').apiKey).toBe('sk-deepseek')
  })

  it('模型 id 自带斜杠时不被 :: 解析切坏', async () => {
    const cfg = await loadModule()
    expect(cfg.parseModelRef('p2::anthropic/claude-sonnet-4')).toEqual({
      providerId: 'p2',
      modelId: 'anthropic/claude-sonnet-4',
    })
    expect(cfg.parseModelRef('anthropic/claude-sonnet-4')).toEqual({
      modelId: 'anthropic/claude-sonnet-4',
    })
  })
})

describe('对话页跨 Provider 切换的完整回环', () => {
  /**
   * 用户旅程：设置页配了两家 → 对话页切到第二家的模型 →
   * 下一条消息必须带第二家的 Key/端点，而不是默认那家。
   */
  it('切到非默认 Provider 后，运行时取到的是它的凭据与端点', async () => {
    const cfg = await loadModule()
    cfg.saveProviderStore({
      providers: [
        {
          id: 'p1',
          name: 'DeepSeek',
          type: 'deepseek',
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'sk-deepseek',
          modelIds: ['deepseek-v4-flash'],
        },
        {
          id: 'p2',
          name: 'OpenRouter',
          type: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'sk-or',
          modelIds: ['anthropic/claude-sonnet-4'],
        },
      ],
      slots: {
        chat: { enabled: true, providerId: 'p1', modelId: 'deepseek-v4-flash' },
        vision: { enabled: false, providerId: '', modelId: '' },
        image: { enabled: false, providerId: '', modelId: '' },
      },
    })

    // 对话页可见的候选：两家都在，且带 provider 前缀
    const refs = cfg.listChatModelRefs()
    expect(refs).toContain('p1::deepseek-v4-flash')
    expect(refs).toContain('p2::anthropic/claude-sonnet-4')

    // 默认仍是第一家
    expect(cfg.chatDefaultModelRef()).toBe('p1::deepseek-v4-flash')

    // 切到第二家的模型：运行时按引用取配置
    const live = cfg.loadSlotConfigForModel('chat', 'p2::anthropic/claude-sonnet-4')
    expect(live.type).toBe('openrouter')
    expect(live.baseUrl).toBe('https://openrouter.ai/api/v1')
    expect(live.apiKey).toBe('sk-or')
  })

  it('会话偏好校验不会因前缀差异误清（升级后旧会话仍可用）', async () => {
    const { BridgeSessionModelCatalog } = await import('./agent-runtime/bridge-session-model-catalog')
    const catalog = new BridgeSessionModelCatalog()
    catalog.setSessionPreferredModel('sess-1', 'deepseek-v4-flash') // 旧格式，裸 id
    catalog.setSessionPreferredModel('sess-2', 'p1::deepseek-v4-flash') // 新格式

    catalog.clearInvalidSessionPreferredModels(['p1::deepseek-v4-flash'])

    expect(catalog.getPreferredModelRawForStream('sess-1', 'sess-1')).toBe('deepseek-v4-flash')
    expect(catalog.getPreferredModelRawForStream('sess-2', 'sess-2')).toBe('p1::deepseek-v4-flash')
  })
})

describe('保存', () => {
  it('保存完整 store：新增 provider 后槽能指向它', async () => {
    const cfg = await loadModule()
    const saved = cfg.saveProviderStore({
      providers: [
        {
          id: 'p1',
          name: 'DeepSeek',
          type: 'deepseek',
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'sk-1',
          modelIds: ['deepseek-v4-flash'],
        },
        {
          id: 'p2',
          name: 'OpenRouter',
          type: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'sk-or',
          modelIds: ['gpt-4o'],
        },
      ],
      slots: {
        chat: { enabled: true, providerId: 'p1', modelId: 'deepseek-v4-flash' },
        vision: { enabled: true, providerId: 'p2', modelId: 'gpt-4o' },
        image: { enabled: false, providerId: '', modelId: '' },
      },
    })

    expect(saved.providers).toHaveLength(2)
    expect(saved.slots.vision.providerId).toBe('p2')
    // 密文落盘，不存明文
    const onDisk = readProviderFile()
    expect(onDisk.version).toBe(2)
    expect(JSON.stringify(onDisk)).not.toContain('sk-or')
    expect(saved.providers[1]!.apiKey).toBe('sk-or')
  })

  it('槽选的模型会并入该 provider 的模型列表（否则下次读盘就丢了）', async () => {
    const cfg = await loadModule()
    const saved = cfg.saveProviderStore({
      providers: [
        {
          id: 'p1',
          name: '',
          type: 'openai',
          baseUrl: 'https://a.example.com',
          apiKey: 'sk',
          modelIds: ['m1'],
        },
      ],
      slots: {
        chat: { enabled: true, providerId: 'p1', modelId: 'm2' },
        vision: { enabled: false, providerId: '', modelId: '' },
        image: { enabled: false, providerId: '', modelId: '' },
      },
    })

    expect(saved.providers[0]!.modelIds).toContain('m2')
    expect(saved.slots.chat.modelId).toBe('m2')
  })

  it('旧的多槽扁平保存入口仍可用，并落到 v2 结构', async () => {
    const cfg = await loadModule()
    const base = cfg.DEFAULT_SLOT_CONFIG
    cfg.saveProviderSlotsConfig({
      chat: {
        ...base.chat,
        enabled: true,
        type: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        modelId: 'deepseek-v4-flash',
        apiKey: 'sk-chat',
      },
      vision: { ...base.vision },
      image: { ...base.image },
    })

    const store = cfg.loadProviderStore()
    expect(store.providers).toHaveLength(1)
    expect(store.slots.chat.enabled).toBe(true)
    expect(cfg.loadProviderConfig().apiKey).toBe('sk-chat')
  })
})
