/**
 * Task 8：老工作区 .gitignore 迁移。
 *
 * 判据来自它在计划里的理由：`buildDefaultGitignore()` 只在**新建**工作区生效，
 * 老库不会重建——不补的话老用户的 `runs/` 会被 git 跟踪。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrateGitignoreForPipelines } from './index'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-pipe-gi-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const gi = () => path.join(dir, '.gitignore')

describe('migrateGitignoreForPipelines', () => {
  it('无该行时追加，不改动既有内容', () => {
    fs.writeFileSync(gi(), 'node_modules/\ntemp/\n', 'utf8')
    expect(migrateGitignoreForPipelines(dir)).toBe(true)
    const after = fs.readFileSync(gi(), 'utf8')
    expect(after).toContain('node_modules/')
    expect(after).toContain('temp/')
    expect(after.split('\n')).toContain('pipelines/**/runs/')
  })

  it('已有该行时不动（幂等，不重复追加）', () => {
    fs.writeFileSync(gi(), 'temp/\npipelines/**/runs/\n', 'utf8')
    expect(migrateGitignoreForPipelines(dir)).toBe(false)
    const after = fs.readFileSync(gi(), 'utf8')
    expect(after.match(/pipelines\/\*\*\/runs\//g)).toHaveLength(1)
  })

  it('末行无换行时不把两行粘在一起', () => {
    fs.writeFileSync(gi(), 'temp/', 'utf8') // 无尾换行
    migrateGitignoreForPipelines(dir)
    expect(fs.readFileSync(gi(), 'utf8')).toBe('temp/\npipelines/**/runs/\n')
  })

  it('没有 .gitignore 就跳过（不新建一个）', () => {
    expect(migrateGitignoreForPipelines(dir)).toBe(false)
    expect(fs.existsSync(gi())).toBe(false)
  })
})
