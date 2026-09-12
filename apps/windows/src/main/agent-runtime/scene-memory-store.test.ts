import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findProject,
  listScenes,
  loadRegistry,
  registerProject,
  resolveSceneFilePath,
  resolveSceneMemoryDir,
  resolveSceneRegistryPath,
  slugifySceneKey,
  readSceneMemory,
  writeSceneMemory,
  SCENE_MEMORY_MAX_CHARS,
} from './scene-memory-store'

describe('scene-memory-store', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeBaseDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-scene-'))
    tempDirs.push(dir)
    return dir
  }

  describe('slugifySceneKey', () => {
    it('英文小写化，空格与非法字符转 -', () => {
      expect(slugifySceneKey('Lumii')).toBe('lumii')
      expect(slugifySceneKey('My Project')).toBe('my-project')
      expect(slugifySceneKey('a\\b/c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j')
    })

    it('中文保留', () => {
      expect(slugifySceneKey('二十四史学习规划')).toBe('二十四史学习规划')
      expect(slugifySceneKey('picture-book-studio')).toBe('picture-book-studio')
    })

    it('空输入回退到时间戳 key', () => {
      expect(slugifySceneKey('   ')).toMatch(/^scene-[a-z0-9]+$/)
    })
  })

  describe('路径解析', () => {
    it('有目录项目 → 项目目录内 .lumii/memory.md', () => {
      const p = resolveSceneFilePath('C:/base', 'project', 'lumii', 'E:/repo/lumii')
      expect(p).toBe(path.join('E:/repo/lumii', '.lumii', 'memory.md'))
    })

    it('无目录项目 → 数据目录 project-<key>.md', () => {
      const p = resolveSceneFilePath('C:/base', 'project', '二十四史', null)
      expect(p).toBe(path.join(resolveSceneMemoryDir('C:/base'), 'project-二十四史.md'))
    })

    it('渠道 → 数据目录 channel-<type>.md', () => {
      const p = resolveSceneFilePath('C:/base', 'channel', 'weixin')
      expect(p).toBe(path.join(resolveSceneMemoryDir('C:/base'), 'channel-weixin.md'))
    })
  })

  describe('注册表', () => {
    it('不存在时返回空注册表', async () => {
      const base = makeBaseDir()
      expect(await loadRegistry(base)).toEqual({ projects: [] })
    })

    it('JSON 损坏时按空处理不抛错', async () => {
      const base = makeBaseDir()
      fs.mkdirSync(resolveSceneMemoryDir(base), { recursive: true })
      fs.writeFileSync(resolveSceneRegistryPath(base), '{invalid json', 'utf-8')
      expect(await loadRegistry(base)).toEqual({ projects: [] })
    })

    it('新建项目：生成 slug key、别名含名称与路径', async () => {
      const base = makeBaseDir()
      const entry = await registerProject(base, {
        name: 'Lumii',
        path: 'E:\\repo\\lumii',
      })
      expect(entry.key).toBe('lumii')
      expect(entry.name).toBe('Lumii')
      expect(entry.aliases).toContain('Lumii')
      expect(entry.aliases).toContain(path.resolve('E:\\repo\\lumii'))
      expect(entry.path).toBe(path.resolve('E:\\repo\\lumii'))

      const registry = await loadRegistry(base)
      expect(registry.projects).toHaveLength(1)
    })

    it('按路径查重：同路径再次登记不新建而是合并别名', async () => {
      const base = makeBaseDir()
      const first = await registerProject(base, { name: 'Lumii', path: 'E:/repo/lumii' })
      const second = await registerProject(base, {
        name: 'lumii-repo',
        path: 'E:\\repo\\lumii',
        aliases: ['卤米'],
      })
      expect(second.key).toBe(first.key)
      expect(second.aliases).toContain('卤米')
      expect((await loadRegistry(base)).projects).toHaveLength(1)
    })

    it('重名不同项目：key 冲突时加数字后缀', async () => {
      const base = makeBaseDir()
      const a = await registerProject(base, { name: 'demo' })
      const b = await registerProject(base, { name: 'demo2' })
      const c = await registerProject(base, { name: 'demo' }) // 按名查重会命中 a
      expect(a.key).toBe('demo')
      expect(b.key).toBe('demo2')
      expect(c.key).toBe('demo')
      // 真正同名不同项（例如 name 不同但 slug 撞车）走后缀
      const d = await registerProject(base, { name: 'DEMO!' })
      expect(d.key).toBe('demo-2')
    })

    it('无目录项目登记：path 为 null', async () => {
      const base = makeBaseDir()
      const entry = await registerProject(base, { name: '二十四史学习规划' })
      expect(entry.path).toBeNull()
      expect(entry.key).toBe('二十四史学习规划')
    })
  })

  describe('findProject', () => {
    it('按 key / 路径 / 名称不区分大小写匹配', async () => {
      const base = makeBaseDir()
      const entry = await registerProject(base, { name: 'Lumii', path: 'E:/repo/lumii' })
      const registry = await loadRegistry(base)

      expect(findProject(registry, 'lumii')?.key).toBe(entry.key)
      expect(findProject(registry, 'LUMII')?.key).toBe(entry.key)
      expect(findProject(registry, 'E:\\repo\\lumii')?.key).toBe(entry.key)
      expect(findProject(registry, 'nope')).toBeNull()
    })
  })

  describe('场景文件读写', () => {
    it('写入自动建目录，覆盖前备份 .bak', async () => {
      const base = makeBaseDir()
      const file = resolveSceneFilePath(base, 'channel', 'weixin')

      expect(await writeSceneMemory(file, '## 渠道偏好\n\n- 回复简短')).toBe(true)
      expect(await writeSceneMemory(file, '## 渠道偏好\n\n- 回复极简')).toBe(true)

      expect(fs.existsSync(`${file}.bak`)).toBe(true)
      expect(fs.readFileSync(`${file}.bak`, 'utf-8')).toContain('回复简短')
      expect(fs.readFileSync(file, 'utf-8')).toContain('回复极简')
    })

    it('读取返回内容与更新时间；不存在返回 undefined', async () => {
      const base = makeBaseDir()
      const file = resolveSceneFilePath(base, 'project', 'x', null)
      expect(await readSceneMemory(file)).toBeUndefined()

      await writeSceneMemory(file, 'hello')
      const read = await readSceneMemory(file)
      expect(read?.content).toBe('hello')
      expect(read?.updatedAt).toBeTruthy()
    })

    it('超过上限拒绝写入', async () => {
      const base = makeBaseDir()
      const file = resolveSceneFilePath(base, 'project', 'big', null)
      const huge = 'x'.repeat(SCENE_MEMORY_MAX_CHARS + 1)
      expect(await writeSceneMemory(file, huge)).toBe(false)
      expect(fs.existsSync(file)).toBe(false)
    })
  })

  describe('listScenes', () => {
    it('合并注册表项目与渠道文件，标记 hasMemory', async () => {
      const base = makeBaseDir()
      const withMem = await registerProject(base, { name: '有记忆的项目' })
      await registerProject(base, { name: '没记忆的项目' })
      await writeSceneMemory(
        resolveSceneFilePath(base, 'project', withMem.key, null),
        '## 内容',
      )
      await writeSceneMemory(resolveSceneFilePath(base, 'channel', 'weixin'), '## 渠道')

      const scenes = await listScenes(base)
      const proj = scenes.filter((s) => s.scene === 'project')
      const chans = scenes.filter((s) => s.scene === 'channel')

      expect(proj).toHaveLength(2)
      expect(proj.find((p) => p.key === withMem.key)?.hasMemory).toBe(true)
      expect(proj.find((p) => p.name === '没记忆的项目')?.hasMemory).toBe(false)
      expect(chans).toEqual([
        { scene: 'channel', key: 'weixin', name: 'weixin', path: null, hasMemory: true },
      ])
    })
  })
})
