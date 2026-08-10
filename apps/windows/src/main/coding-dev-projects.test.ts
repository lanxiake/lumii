import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  assertValidProjectName,
  resolveActiveProjectPath,
  createProject,
  openExistingProject,
  removeProject,
  reconcileProjectsWithDisk,
} from './coding-dev-projects'

let base: string
let projectsDir: string

beforeEach(async () => {
  base = await fs.mkdtemp(join(tmpdir(), 'acp-proj-'))
  projectsDir = join(base, 'projects')
  await fs.mkdir(projectsDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

describe('assertValidProjectName', () => {
  it('拒绝空名、路径分隔符与 ..', () => {
    expect(() => assertValidProjectName('')).toThrow()
    expect(() => assertValidProjectName('a/b')).toThrow()
    expect(() => assertValidProjectName('..')).toThrow()
    expect(() => assertValidProjectName('a:b')).toThrow()
  })
  it('接受正常名', () => {
    expect(() => assertValidProjectName('my-project')).not.toThrow()
  })
})

describe('resolveActiveProjectPath', () => {
  it('返回活动项目 realPath，找不到时 undefined', () => {
    const projects = [{ name: 'p1', realPath: '/x', isExternal: false }]
    expect(resolveActiveProjectPath(projects, 'p1')).toBe('/x')
    expect(resolveActiveProjectPath(projects, 'nope')).toBeUndefined()
    expect(resolveActiveProjectPath(undefined, 'p1')).toBeUndefined()
  })
})

describe('createProject', () => {
  it('在 projectsDir 下创建目录并追加到列表', async () => {
    const list = await createProject({ projectsDir, name: 'demo', existing: [] })
    expect(list).toHaveLength(1)
    expect(list[0].isExternal).toBe(false)
    const stat = await fs.stat(join(projectsDir, 'demo'))
    expect(stat.isDirectory()).toBe(true)
  })
  it('拒绝重名', async () => {
    const list = await createProject({ projectsDir, name: 'demo', existing: [] })
    await expect(createProject({ projectsDir, name: 'demo', existing: list })).rejects.toThrow()
  })
})

describe('openExistingProject', () => {
  it('建软链接指向真实目录，realPath 为真实路径', async () => {
    const real = join(base, 'real-src')
    await fs.mkdir(real)
    await fs.writeFile(join(real, 'marker.txt'), 'hello')

    const list = await openExistingProject({ projectsDir, name: 'ext', targetPath: real, existing: [] })
    expect(list[0].isExternal).toBe(true)
    expect(list[0].realPath).toBe(real)
    // 通过链接能读到真实内容
    const content = await fs.readFile(join(projectsDir, 'ext', 'marker.txt'), 'utf-8')
    expect(content).toBe('hello')
  })
  it('目标不存在时报错', async () => {
    await expect(
      openExistingProject({ projectsDir, name: 'ext', targetPath: join(base, 'nope'), existing: [] }),
    ).rejects.toThrow()
  })
})

describe('removeProject（安全：不删真实目录）', () => {
  it('移除外部项目仅删链接，真实目录及内容保留', async () => {
    const real = join(base, 'real-src')
    await fs.mkdir(real)
    await fs.writeFile(join(real, 'keep.txt'), 'data')
    const list = await openExistingProject({ projectsDir, name: 'ext', targetPath: real, existing: [] })

    const after = await removeProject({ projectsDir, name: 'ext', existing: list })
    expect(after).toHaveLength(0)
    // 链接已删
    await expect(fs.lstat(join(projectsDir, 'ext'))).rejects.toThrow()
    // 真实目录与文件仍在
    const content = await fs.readFile(join(real, 'keep.txt'), 'utf-8')
    expect(content).toBe('data')
  })
  it('移除内部项目仅从列表移除，磁盘数据重命名为 .removed- 前缀保留', async () => {
    const list = await createProject({ projectsDir, name: 'demo', existing: [] })
    const after = await removeProject({ projectsDir, name: 'demo', existing: list })
    expect(after).toHaveLength(0)
    // 原目录名已不存在（被重命名）
    await expect(fs.stat(join(projectsDir, 'demo'))).rejects.toThrow()
    // 但数据以 .removed- 前缀保留在 projectsDir 下
    const entries = await fs.readdir(projectsDir)
    const removedEntry = entries.find((e) => e.startsWith('.removed-demo-'))
    expect(removedEntry).toBeDefined()
  })
  it('移除内部项目后 reconcile 不会把它重新扫描回列表', async () => {
    const list = await createProject({ projectsDir, name: 'demo', existing: [] })
    const after = await removeProject({ projectsDir, name: 'demo', existing: list })
    const { projects, changed } = await reconcileProjectsWithDisk({ projectsDir, existing: after })
    expect(projects).toHaveLength(0)
    expect(changed).toBe(false)
  })
})
