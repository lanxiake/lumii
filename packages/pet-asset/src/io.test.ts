import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import type { PetInstallPlan, PetModelConfig } from '@mtbot/pet-core'
import {
  cleanStale,
  installPackage,
  listFilesRecursive,
  readJson,
  upsertRegistryEntry,
  writeFileAtomic,
} from './io.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pet-asset-io-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  const p = join(root, rel)
  await fs.mkdir(join(p, '..'), { recursive: true })
  await fs.writeFile(p, content, 'utf-8')
}

const entry = (id: string, name = id): PetModelConfig => ({
  id,
  name,
  rendererType: 'sprite',
  modelUrl: `${id}/manifest.json`,
  scale: 1,
  idleMotionGroup: 'Idle',
  talkMotionGroup: 'Talk',
  emotionMap: {},
  tapMotions: {},
  defaultExpression: 0,
})

/** 造一个包目录 + 一个安装计划 */
async function makePackage(id: string): Promise<{ pkgDir: string; plan: PetInstallPlan }> {
  const pkgDir = join(root, 'pkg', id)
  await fs.mkdir(pkgDir, { recursive: true })
  await fs.writeFile(join(pkgDir, 'manifest.json'), '{}', 'utf-8')
  await fs.writeFile(join(pkgDir, 'atlas.png'), 'PNG', 'utf-8')
  const plan: PetInstallPlan = {
    id,
    dirName: id,
    files: [
      { from: 'manifest.json', to: `${id}/manifest.json` },
      { from: 'atlas.png', to: `${id}/atlas.png` },
    ],
    registryEntry: entry(id),
    warnings: [],
  }
  return { pkgDir, plan }
}

describe('listFilesRecursive', () => {
  it('给出相对路径并排序，嵌套目录用正斜杠', async () => {
    await write('a.json', '1')
    await write('sub/b.png', '2')
    await write('sub/deep/c.txt', '3')
    const files = await listFilesRecursive(root)
    expect(files).toEqual(['a.json', 'sub/b.png', 'sub/deep/c.txt'])
  })

  it('空目录返回空数组', async () => {
    expect(await listFilesRecursive(root)).toEqual([])
  })
})

describe('readJson', () => {
  it('不存在的文件 exists=false 且不算错', async () => {
    const r = await readJson(join(root, '没有这个.json'))
    expect(r.exists).toBe(false)
    expect(r.error).toBeUndefined()
  })

  it('坏 JSON 报错但不抛', async () => {
    await write('bad.json', '{ 不是 json')
    const r = await readJson(join(root, 'bad.json'))
    expect(r.exists).toBe(true)
    expect(r.error).toContain('JSON')
  })
})

describe('writeFileAtomic', () => {
  it('写入并自动建父目录', async () => {
    const p = join(root, 'deep/dir/out.json')
    await writeFileAtomic(p, '{"a":1}')
    expect(JSON.parse(await fs.readFile(p, 'utf-8'))).toEqual({ a: 1 })
  })

  it('不留临时文件', async () => {
    await writeFileAtomic(join(root, 'out.json'), '{}')
    expect(await listFilesRecursive(root)).toEqual(['out.json'])
  })
})

describe('upsertRegistryEntry', () => {
  it('注册表不存在时新建', async () => {
    const p = join(root, 'registry.json')
    await upsertRegistryEntry(p, entry('a'))
    const j = JSON.parse(await fs.readFile(p, 'utf-8'))
    expect(j.version).toBe(2)
    expect(j.models.map((m: { id: string }) => m.id)).toEqual(['a'])
    expect(j.defaultModelId).toBe('a')
  })

  it('同 id 覆盖而非追加', async () => {
    const p = join(root, 'registry.json')
    await upsertRegistryEntry(p, entry('a', '旧名'))
    await upsertRegistryEntry(p, entry('a', '新名'))
    const j = JSON.parse(await fs.readFile(p, 'utf-8'))
    expect(j.models).toHaveLength(1)
    expect(j.models[0].name).toBe('新名')
  })

  it('保留用户的其它条目与既有 defaultModelId', async () => {
    const p = join(root, 'registry.json')
    await write(
      'registry.json',
      JSON.stringify({ version: 3, models: [entry('手写的')], defaultModelId: '手写的' }),
    )
    await upsertRegistryEntry(p, entry('新装的'))
    const j = JSON.parse(await fs.readFile(p, 'utf-8'))
    expect(j.version).toBe(3)
    expect(j.models.map((m: { id: string }) => m.id)).toEqual(['手写的', '新装的'])
    expect(j.defaultModelId).toBe('手写的')
  })

  it('注册表是坏 JSON 时重建，不抛异常', async () => {
    const p = join(root, 'registry.json')
    await write('registry.json', '{ 坏掉了')
    await upsertRegistryEntry(p, entry('a'))
    const j = JSON.parse(await fs.readFile(p, 'utf-8'))
    expect(j.models.map((m: { id: string }) => m.id)).toEqual(['a'])
  })
})

describe('cleanStale', () => {
  it('未完成的安装目录一律删除', async () => {
    await write('.installing-cat-123/manifest.json', '{}')
    const actions = await cleanStale(root)
    expect(actions.some((a) => a.includes('未完成的安装目录'))).toBe(true)
    expect(await fs.readdir(root)).toEqual([])
  })

  it('正式目录缺失时从备份恢复（上次崩在两次 rename 之间）', async () => {
    await write('.bak-cat-123/manifest.json', '{}')
    const actions = await cleanStale(root)
    expect(actions.some((a) => a.includes('从备份恢复 cat'))).toBe(true)
    expect(await fs.readdir(root)).toEqual(['cat'])
  })

  it('正式目录已存在时只清理备份', async () => {
    await write('cat/manifest.json', '正式')
    await write('.bak-cat-123/manifest.json', '备份')
    const actions = await cleanStale(root)
    expect(actions.some((a) => a.includes('清理已完成安装的备份'))).toBe(true)
    expect(await fs.readdir(root)).toEqual(['cat'])
    expect(await fs.readFile(join(root, 'cat/manifest.json'), 'utf-8')).toBe('正式')
  })

  it('目录不存在时不抛', async () => {
    expect(await cleanStale(join(root, '没有这个目录'))).toEqual([])
  })
})

describe('installPackage', () => {
  it('搬运文件并写入注册表', async () => {
    const { pkgDir, plan } = await makePackage('cat')
    const targetDir = join(root, 'user')
    const outcome = await installPackage({ pkgDir, targetDir, plan })

    expect(outcome.installedDir).toBe(join(targetDir, 'cat'))
    expect(await listFilesRecursive(join(targetDir, 'cat'))).toEqual(['atlas.png', 'manifest.json'])
    const reg = JSON.parse(await fs.readFile(outcome.registryPath, 'utf-8'))
    expect(reg.models[0].id).toBe('cat')
    // 不留临时目录
    expect((await fs.readdir(targetDir)).sort()).toEqual(['cat', 'registry.json'])
  })

  it('覆盖同 id 时先备份，成功后删掉备份', async () => {
    const targetDir = join(root, 'user')
    await write('user/cat/manifest.json', '旧版本')
    const { pkgDir, plan } = await makePackage('cat')
    await installPackage({ pkgDir, targetDir, plan })

    expect(await listFilesRecursive(join(targetDir, 'cat'))).toEqual(['atlas.png', 'manifest.json'])
    expect((await fs.readdir(targetDir)).sort()).toEqual(['cat', 'registry.json'])
  })

  it('搬运失败时回滚：旧模型还在，新文件不残留', async () => {
    const targetDir = join(root, 'user')
    await write('user/cat/manifest.json', '旧版本')
    const pkgDir = join(root, 'pkg', 'cat')
    await fs.mkdir(pkgDir, { recursive: true })
    await fs.writeFile(join(pkgDir, 'manifest.json'), '{}', 'utf-8')

    const plan: PetInstallPlan = {
      id: 'cat',
      dirName: 'cat',
      // 第二个文件在包里不存在 → copyFile 抛错
      files: [
        { from: 'manifest.json', to: 'cat/manifest.json' },
        { from: '不存在.png', to: 'cat/atlas.png' },
      ],
      registryEntry: entry('cat'),
      warnings: [],
    }

    await expect(installPackage({ pkgDir, targetDir, plan })).rejects.toThrow()

    // 用户原来能用的模型必须原样还在
    expect(await fs.readFile(join(targetDir, 'cat/manifest.json'), 'utf-8')).toBe('旧版本')
    // 半成品与备份都不残留
    expect((await fs.readdir(targetDir)).sort()).toEqual(['cat'])
  })

  it('首次安装失败时目标目录保持为空（不留垃圾）', async () => {
    const targetDir = join(root, 'user')
    const pkgDir = join(root, 'pkg', 'cat')
    await fs.mkdir(pkgDir, { recursive: true })
    const plan: PetInstallPlan = {
      id: 'cat',
      dirName: 'cat',
      files: [{ from: '不存在.png', to: 'cat/atlas.png' }],
      registryEntry: entry('cat'),
      warnings: [],
    }
    await expect(installPackage({ pkgDir, targetDir, plan })).rejects.toThrow()
    expect(await fs.readdir(targetDir)).toEqual([])
  })

  it('目标目录不存在时自动创建', async () => {
    const { pkgDir, plan } = await makePackage('cat')
    const targetDir = join(root, '深层/用户目录')
    await installPackage({ pkgDir, targetDir, plan })
    expect(await fs.readdir(targetDir)).toContain('cat')
  })

  it('嵌套子目录的文件也能正确落位', async () => {
    const pkgDir = join(root, 'pkg', 'cat')
    await fs.mkdir(join(pkgDir, 'parts'), { recursive: true })
    await fs.writeFile(join(pkgDir, 'parts/eye.png'), 'x', 'utf-8')
    const plan: PetInstallPlan = {
      id: 'cat',
      dirName: 'cat',
      files: [{ from: 'parts/eye.png', to: 'cat/parts/eye.png' }],
      registryEntry: entry('cat'),
      warnings: [],
    }
    const targetDir = join(root, 'user')
    await installPackage({ pkgDir, targetDir, plan })
    expect(await listFilesRecursive(join(targetDir, 'cat'))).toEqual(['parts/eye.png'])
  })
})
