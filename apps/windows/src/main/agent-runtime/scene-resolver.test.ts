import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MIN_ALIAS_MATCH_LENGTH, matchProject, resolveChannel, resolveSceneHits } from './scene-resolver'
import { registerProject, resolveSceneMemoryDir, resolveSceneFilePath, type SceneRegistry } from './scene-memory-store'

describe('scene-resolver', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeBaseDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-resolver-'))
    tempDirs.push(dir)
    return dir
  }

  describe('resolveChannel', () => {
    it('渠道会话前缀解析为渠道类型与中文名', () => {
      expect(resolveChannel('weixin:user-1')).toEqual({ channelType: 'weixin', label: '微信' })
      expect(resolveChannel('feishu:user-1')).toEqual({ channelType: 'feishu', label: '飞书' })
      expect(resolveChannel('qbot:group-1')).toEqual({ channelType: 'qbot', label: 'QQ' })
    })

    it('客户端会话、定时任务、进化任务与空值返回 null', () => {
      expect(resolveChannel('conv-abc-123')).toBeNull()
      expect(resolveChannel('cron:job-1')).toBeNull()
      expect(resolveChannel('evolution:tick')).toBeNull()
      expect(resolveChannel(undefined)).toBeNull()
    })
  })

  describe('matchProject', () => {
    const registry: SceneRegistry = {
      projects: [
        {
          key: 'lumii',
          name: 'Lumii',
          aliases: ['Lumii', 'E:\\my-project\\open-source\\lumii'],
          path: 'E:\\my-project\\open-source\\lumii',
          lastActiveAt: 100,
        },
        {
          key: '二十四史学习规划',
          name: '二十四史学习规划',
          aliases: ['二十四史学习规划', '二十四史'],
          path: null,
          lastActiveAt: 200,
        },
        {
          key: 'ai',
          name: 'AI',
          aliases: ['AI'],
          path: null,
          lastActiveAt: 300,
        },
        {
          key: '卤米',
          name: '卤米',
          aliases: ['卤米'],
          path: null,
          lastActiveAt: 400,
        },
      ],
    }

    it('按名称命中，大小写不敏感', () => {
      expect(matchProject(registry, '帮我看看 LUMII 的编译错误')?.key).toBe('lumii')
    })

    it('按路径命中', () => {
      expect(
        matchProject(registry, '改一下 E:\\my-project\\open-source\\lumii 的 README')?.key,
      ).toBe('lumii')
    })

    it('中文项目名部分命中', () => {
      expect(matchProject(registry, '继续二十四史的规划')?.key).toBe('二十四史学习规划')
    })

    it('多项目命中取最长匹配', () => {
      // 消息同时含 "Lumii" 与 "二十四史学习规划"，后者更长
      expect(matchProject(registry, '对比 Lumii 和 二十四史学习规划')?.key).toBe('二十四史学习规划')
    })

    it('别名特异性：2 字符 ASCII 跳过（防误报），2 字中文参与匹配', () => {
      expect(MIN_ALIAS_MATCH_LENGTH).toBe(2)
      expect(matchProject(registry, 'AI 正在改变世界')).toBeNull()
      expect(matchProject(registry, '继续卤米的任务')?.key).toBe('卤米')
    })

    it('无命中返回 null', () => {
      expect(matchProject(registry, '今天天气不错')).toBeNull()
    })
  })

  describe('resolveSceneHits', () => {
    it('微信会话 + 消息命中项目 → 返回渠道与项目两个场景', async () => {
      const base = makeBaseDir()
      await registerProject(base, { name: 'Lumii', path: 'E:/repo/lumii' })

      const hits = await resolveSceneHits({
        baseDir: base,
        sessionKey: 'weixin:user-1',
        userMessage: 'lumii 里的那个 bug 修好了吗',
      })

      expect(hits).toHaveLength(2)
      const channel = hits.find((h) => h.scene === 'channel')
      const project = hits.find((h) => h.scene === 'project')
      expect(channel?.filePath).toBe(resolveSceneFilePath(base, 'channel', 'weixin'))
      expect(project?.key).toBe('lumii')
      expect(project?.filePath).toBe(path.join('E:/repo/lumii', '.lumii', 'memory.md'))
    })

    it('客户端会话不产生渠道命中', async () => {
      const base = makeBaseDir()
      const hits = await resolveSceneHits({
        baseDir: base,
        sessionKey: 'conv-abc',
        userMessage: '你好',
      })
      expect(hits).toEqual([])
    })

    it('无消息时不匹配项目；无会话时不匹配渠道', async () => {
      const base = makeBaseDir()
      await registerProject(base, { name: 'Lumii' })

      expect(await resolveSceneHits({ baseDir: base })).toEqual([])
      expect(await resolveSceneHits({ baseDir: base, userMessage: 'lumii' })).toHaveLength(1)
    })

    it('注册表损坏不影响解析（按空处理）', async () => {
      const base = makeBaseDir()
      fs.mkdirSync(resolveSceneMemoryDir(base), { recursive: true })
      fs.writeFileSync(path.join(resolveSceneMemoryDir(base), '_registry.json'), 'not json', 'utf-8')

      const hits = await resolveSceneHits({
        baseDir: base,
        sessionKey: 'weixin:u1',
        userMessage: 'lumii',
      })
      expect(hits).toHaveLength(1)
      expect(hits[0]?.scene).toBe('channel')
    })
  })
})
