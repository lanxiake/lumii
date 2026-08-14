/**
 * BundledSkillsSeeder 单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// Mock electron app
vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '1.0.0'),
  },
}))

import {
  seedBundledSkills,
  resolveBundledSkillsSourceDir,
  pruneRetiredBundledSkills,
  RETIRED_BUNDLED_SKILLS,
} from './bundled-skills-seeder'

describe('BundledSkillsSeeder', () => {
  let tmpDir: string
  let mtbotDataDir: string
  let workspaceDir: string
  let sourceBundledDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seeder-test-'))
    mtbotDataDir = path.join(tmpDir, '.lumii')
    workspaceDir = path.join(tmpDir, 'workspace')
    sourceBundledDir = path.join(tmpDir, 'bundled-skills')

    fs.mkdirSync(mtbotDataDir, { recursive: true })
    fs.mkdirSync(workspaceDir, { recursive: true })

    // 创建模拟的 bundled-skills 源目录
    fs.mkdirSync(path.join(sourceBundledDir, 'weather'), { recursive: true })
    fs.writeFileSync(path.join(sourceBundledDir, 'weather', 'SKILL.md'), '# weather skill')
    fs.mkdirSync(path.join(sourceBundledDir, 'github'), { recursive: true })
    fs.writeFileSync(path.join(sourceBundledDir, 'github', 'SKILL.md'), '# github skill')
    // 无效目录（缺少 SKILL.md）
    fs.mkdirSync(path.join(sourceBundledDir, 'invalid-skill'), { recursive: true })

    // 设置环境变量指向测试源目录
    process.env.MTBOT_BUNDLED_SKILLS_DIR = sourceBundledDir
  })

  afterEach(() => {
    delete process.env.MTBOT_BUNDLED_SKILLS_DIR
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  describe('seedBundledSkills', () => {
    it('首次运行：版本标记不存在 → 执行种子 → 写入标记', async () => {
      await seedBundledSkills(workspaceDir, mtbotDataDir)

      const skillsDir = path.join(workspaceDir, 'skills')
      expect(fs.existsSync(path.join(skillsDir, 'weather', 'SKILL.md'))).toBe(true)
      expect(fs.existsSync(path.join(skillsDir, 'github', 'SKILL.md'))).toBe(true)

      const versionFile = path.join(mtbotDataDir, '.bundled-skills-seeded')
      expect(fs.readFileSync(versionFile, 'utf-8').trim()).toBe('1.0.0')
    })

    it('版本未变化：仍会补上缺失技能', async () => {
      fs.writeFileSync(path.join(mtbotDataDir, '.bundled-skills-seeded'), '1.0.0')

      await seedBundledSkills(workspaceDir, mtbotDataDir)

      const skillsDir = path.join(workspaceDir, 'skills')
      expect(fs.existsSync(path.join(skillsDir, 'weather', 'SKILL.md'))).toBe(true)
      expect(fs.existsSync(path.join(skillsDir, 'github', 'SKILL.md'))).toBe(true)
    })

    it('已下线技能：从 workspace 删除，空分类目录一并清掉', async () => {
      const retiredRel = RETIRED_BUNDLED_SKILLS[0]
      const retiredDir = path.join(workspaceDir, 'skills', ...retiredRel.split('/'))
      fs.mkdirSync(retiredDir, { recursive: true })
      fs.writeFileSync(path.join(retiredDir, 'SKILL.md'), '# retired')
      const sibling = path.join(path.dirname(retiredDir), 'keep-me')
      fs.mkdirSync(sibling, { recursive: true })
      fs.writeFileSync(path.join(sibling, 'SKILL.md'), '# keep')

      const stats = { pruned: 0 }
      pruneRetiredBundledSkills(path.join(workspaceDir, 'skills'), stats)

      expect(stats.pruned).toBe(1)
      expect(fs.existsSync(retiredDir)).toBe(false)
      expect(fs.existsSync(sibling)).toBe(true)
    })

    it('版本升级：标记版本 ≠ 当前版本 → 执行种子', async () => {
      fs.writeFileSync(path.join(mtbotDataDir, '.bundled-skills-seeded'), '0.9.0')

      await seedBundledSkills(workspaceDir, mtbotDataDir)

      const skillsDir = path.join(workspaceDir, 'skills')
      expect(fs.existsSync(path.join(skillsDir, 'weather', 'SKILL.md'))).toBe(true)

      const versionFile = path.join(mtbotDataDir, '.bundled-skills-seeded')
      expect(fs.readFileSync(versionFile, 'utf-8').trim()).toBe('1.0.0')
    })

    it('已存在技能：目标目录已有同名技能 → 跳过（不覆盖）', async () => {
      const existingSkillDir = path.join(workspaceDir, 'skills', 'weather')
      fs.mkdirSync(existingSkillDir, { recursive: true })
      fs.writeFileSync(path.join(existingSkillDir, 'SKILL.md'), '# user modified weather')

      await seedBundledSkills(workspaceDir, mtbotDataDir)

      // 用户修改的内容应保留
      const content = fs.readFileSync(path.join(existingSkillDir, 'SKILL.md'), 'utf-8')
      expect(content).toBe('# user modified weather')
    })

    it('新增技能：目标目录无同名技能 → 复制', async () => {
      // 预先存在 weather，但没有 github
      const existingSkillDir = path.join(workspaceDir, 'skills', 'weather')
      fs.mkdirSync(existingSkillDir, { recursive: true })
      fs.writeFileSync(path.join(existingSkillDir, 'SKILL.md'), '# existing weather')

      await seedBundledSkills(workspaceDir, mtbotDataDir)

      // github 应被新增
      expect(fs.existsSync(path.join(workspaceDir, 'skills', 'github', 'SKILL.md'))).toBe(true)
      // weather 保持用户版本
      const weatherContent = fs.readFileSync(path.join(workspaceDir, 'skills', 'weather', 'SKILL.md'), 'utf-8')
      expect(weatherContent).toBe('# existing weather')
    })

    it('源目录不存在：跳过，不报错', async () => {
      delete process.env.MTBOT_BUNDLED_SKILLS_DIR
      // 不设置 MTBOT_BUNDLED_SKILLS_DIR，且 process.resourcesPath 不存在

      await expect(seedBundledSkills(workspaceDir, mtbotDataDir)).resolves.not.toThrow()
    })

    it('无效技能目录（缺少 SKILL.md）：跳过', async () => {
      await seedBundledSkills(workspaceDir, mtbotDataDir)

      const skillsDir = path.join(workspaceDir, 'skills')
      // invalid-skill 不应被复制
      expect(fs.existsSync(path.join(skillsDir, 'invalid-skill'))).toBe(false)
    })
  })

  describe('resolveBundledSkillsSourceDir', () => {
    it('MTBOT_BUNDLED_SKILLS_DIR 环境变量优先', () => {
      process.env.MTBOT_BUNDLED_SKILLS_DIR = sourceBundledDir
      expect(resolveBundledSkillsSourceDir()).toBe(sourceBundledDir)
    })

    it('环境变量不存在时：无固定 resourcesPath 时可能解析到仓库内 bundled-skills 或 undefined', () => {
      delete process.env.MTBOT_BUNDLED_SKILLS_DIR
      const result = resolveBundledSkillsSourceDir()
      // 在 monorepo 中开发时通常能解析到 apps/windows/bundled-skills；打包环境可能为 undefined
      expect(result === undefined || result.endsWith('bundled-skills')).toBe(true)
    })
  })
})
