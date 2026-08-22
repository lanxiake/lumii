/**
 * 外部技能加载：从本地技能存储扫描已安装技能，检测入口文件，构造 SkillDefinition。
 * loadExternalSkills 返回新加载的 Map，由调用方（ClientSkillRuntime）合并进自身的 skills 表，
 * 不直接写入调用方状态。
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { LocalSkillStore, SkillIndexEntry } from './skill-store'
import type { TypeScriptRunner, RunnerOptions, RunnerResult } from './ts-runner'
import type { PythonRunner } from './python-runner'
import type { ShellRunner } from './shell-runner'
import type { SkillDefinition, SkillExecutionContext } from './skill-runtime-types'
import { createLogger } from './logger'

const log = createLogger('SkillRuntime')

type Runner = { execute: (opts: RunnerOptions) => Promise<RunnerResult> }

export interface SkillExternalLoaderRunners {
  tsRunner: TypeScriptRunner | null
  pyRunner: PythonRunner | null
  shellRunner: ShellRunner | null
}

/**
 * 根据 runtime 类型选择对应的 Runner
 *
 * @param runtime - 技能运行时类型
 * @returns 对应的 Runner 实例，不支持的类型返回 null
 */
export function selectRunner(runners: SkillExternalLoaderRunners, runtime: string): Runner | null {
  switch (runtime) {
    case 'typescript':
    case 'javascript':
      return runners.tsRunner
    case 'python':
      return runners.pyRunner
    case 'shell':
      return runners.shellRunner
    default:
      log.warn('未知的 runtime 类型', { runtime })
      return null
  }
}

/**
 * 读取技能目录下的 skill-env.json，展开 ~ 路径为 Windows 绝对路径
 *
 * 技能作者（或安装 UI）可在技能目录下放置 skill-env.json，格式：
 * { "SOME_VAR": "~/path/to/something", ... }
 */
async function readSkillEnv(skillDir: string): Promise<Record<string, string> | undefined> {
  try {
    const raw = await fs.readFile(path.join(skillDir, 'skill-env.json'), 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const home = os.homedir()
    const result: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') {
        // 展开 ~ 并统一为 Windows 路径分隔符
        result[k] = v.replace(/^~(?=[/\\]|$)/, home).replace(/\//g, path.sep)
      }
    }
    return Object.keys(result).length > 0 ? result : undefined
  } catch {
    return undefined
  }
}

/**
 * 检测 Claude Code 技能的入口文件
 *
 * 检测优先级：
 * 1. 根目录下的 .py 文件（如 save_markdown.py）
 * 2. scripts/ 目录下的 .py 文件
 * 3. 根目录下的 .ts/.js 文件
 * 4. scripts/ 目录下的 .ts/.js 文件
 * 5. Windows: .ps1 / .bat / .cmd，其他平台: .sh
 */
async function detectClaudeCodeEntry(skillDir: string): Promise<{ path: string; runtime: string } | null> {
  try {
    // 检测根目录
    const rootFiles = await fs.readdir(skillDir)

    // 优先查找 Python 文件
    const pyFiles = rootFiles.filter(f => f.endsWith('.py') && !f.startsWith('test_') && !f.startsWith('__'))
    if (pyFiles.length > 0) {
      return { path: pyFiles[0], runtime: 'python' }
    }

    // 查找 TypeScript/JavaScript 文件
    const tsFiles = rootFiles.filter(f => (f.endsWith('.ts') || f.endsWith('.js')) && !f.startsWith('test_'))
    if (tsFiles.length > 0) {
      const runtime = tsFiles[0].endsWith('.ts') ? 'typescript' : 'javascript'
      return { path: tsFiles[0], runtime }
    }

    // Windows 原生脚本（.ps1 / .bat / .cmd，Windows 平台优先于 .sh）
    if (process.platform === 'win32') {
      const ps1Files = rootFiles.filter(f => f.endsWith('.ps1'))
      if (ps1Files.length > 0) return { path: ps1Files[0], runtime: 'shell' }
      const batFiles = rootFiles.filter(f => f.endsWith('.bat') || f.endsWith('.cmd'))
      if (batFiles.length > 0) return { path: batFiles[0], runtime: 'shell' }
    }

    // 查找 Shell 脚本
    const shFiles = rootFiles.filter(f => f.endsWith('.sh'))
    if (shFiles.length > 0) {
      return { path: shFiles[0], runtime: 'shell' }
    }

    // 检测 scripts/ 目录
    const scriptsDir = path.join(skillDir, 'scripts')
    try {
      await fs.access(scriptsDir)
      const scriptFiles = await fs.readdir(scriptsDir)

      // 优先查找 Python 文件
      const scriptPyFiles = scriptFiles.filter(f => f.endsWith('.py') && !f.startsWith('test_') && !f.startsWith('__'))
      if (scriptPyFiles.length > 0) {
        return { path: `scripts/${scriptPyFiles[0]}`, runtime: 'python' }
      }

      // 查找 TypeScript/JavaScript 文件
      const scriptTsFiles = scriptFiles.filter(f => (f.endsWith('.ts') || f.endsWith('.js')) && !f.startsWith('test_'))
      if (scriptTsFiles.length > 0) {
        const runtime = scriptTsFiles[0].endsWith('.ts') ? 'typescript' : 'javascript'
        return { path: `scripts/${scriptTsFiles[0]}`, runtime }
      }

      // Windows 原生脚本（scripts/ 子目录）
      if (process.platform === 'win32') {
        const scriptPs1Files = scriptFiles.filter(f => f.endsWith('.ps1'))
        if (scriptPs1Files.length > 0) return { path: `scripts/${scriptPs1Files[0]}`, runtime: 'shell' }
        const scriptBatFiles = scriptFiles.filter(f => f.endsWith('.bat') || f.endsWith('.cmd'))
        if (scriptBatFiles.length > 0) return { path: `scripts/${scriptBatFiles[0]}`, runtime: 'shell' }
      }

      // 查找 Shell 脚本
      const scriptShFiles = scriptFiles.filter(f => f.endsWith('.sh'))
      if (scriptShFiles.length > 0) {
        return { path: `scripts/${scriptShFiles[0]}`, runtime: 'shell' }
      }
    } catch {
      // scripts 目录不存在，继续
    }

    return null
  } catch (error) {
    log.error('检测 Claude Code 入口文件失败', { skillDir, error })
    return null
  }
}

/**
 * 创建 Claude Code 技能定义
 */
function createClaudeCodeSkillDefinition(
  entry: SkillIndexEntry,
  entryPath: string,
  runner: Runner,
  extraEnv?: Record<string, string>
): SkillDefinition {
  return {
    id: entry.id,
    name: entry.name,
    description: `Claude Code 技能 - ${entry.name}`,
    version: entry.version,
    runMode: 'local',
    enabled: true,
    execute: async (params: Record<string, unknown>, _context: SkillExecutionContext) => {
      const startTime = Date.now()

      try {
        // 执行技能脚本
        const result = await runner.execute({
          entryPath,
          params,
          timeoutMs: 120000, // 默认 2 分钟超时
          env: extraEnv,
        })

        const executionTime = Date.now() - startTime

        if (result.success) {
          return {
            success: true,
            result: result.result,
            executionTimeMs: executionTime,
          }
        } else {
          return {
            success: false,
            error: {
              code: 'EXECUTION_ERROR',
              message: result.error || '技能执行失败',
            },
            executionTimeMs: executionTime,
          }
        }
      } catch (error) {
        const executionTime = Date.now() - startTime
        return {
          success: false,
          error: {
            code: 'EXECUTION_ERROR',
            message: error instanceof Error ? error.message : String(error),
          },
          executionTimeMs: executionTime,
        }
      }
    }
  }
}

/**
 * 创建纯指令型 Claude Code 技能定义
 *
 * 这类技能只有 SKILL.md 文件，没有可执行脚本
 * 执行时返回 SKILL.md 的内容作为 AI 指令
 */
function createInstructionOnlySkillDefinition(
  entry: SkillIndexEntry,
  skillMdPath: string
): SkillDefinition {
  return {
    id: entry.id,
    name: entry.name,
    description: `Claude Code 指令型技能 - ${entry.name}`,
    version: entry.version,
    runMode: 'local',
    enabled: true,
    execute: async (_params: Record<string, unknown>, _context: SkillExecutionContext) => {
      const startTime = Date.now()

      try {
        // 读取 SKILL.md 内容
        const content = await fs.readFile(skillMdPath, 'utf-8')
        const executionTime = Date.now() - startTime

        return {
          success: true,
          result: {
            type: 'instruction',
            content,
            message: '这是一个 AI 指令型技能，请根据以下指令执行任务',
          },
          executionTimeMs: executionTime,
        }
      } catch (error) {
        const executionTime = Date.now() - startTime
        return {
          success: false,
          error: {
            code: 'EXECUTION_ERROR',
            message: error instanceof Error ? error.message : String(error),
          },
          executionTimeMs: executionTime,
        }
      }
    }
  }
}

/**
 * 从本地技能存储加载外部技能
 *
 * 统一使用 Claude Code 格式（SKILL.md + 可选的可执行脚本）。
 * 返回新加载的 SkillDefinition Map，调用方负责合并进自身的 skills 表。
 */
export async function loadExternalSkills(
  skillStore: LocalSkillStore,
  runners: SkillExternalLoaderRunners,
): Promise<Map<string, SkillDefinition>> {
  const loaded = new Map<string, SkillDefinition>()

  const installed = await skillStore.listInstalled()
  log.info('加载外部技能', { count: installed.length })

  for (const entry of installed) {
    if (!entry.enabled) {
      log.debug('跳过已禁用技能', { skillId: entry.id })
      continue
    }

    try {
      // 获取技能目录
      const skillDir = skillStore.getSkillDirectory(entry.id)
      if (!skillDir) {
        log.warn('技能目录不存在，跳过', { skillId: entry.id })
        continue
      }

      const skillMdPath = path.join(skillDir, 'SKILL.md')

      // 检查 SKILL.md 是否存在
      try {
        await fs.access(skillMdPath)
      } catch {
        log.warn('SKILL.md 不存在，跳过', { skillId: entry.id })
        continue
      }
      // 自动检测入口文件
      const entryFile = await detectClaudeCodeEntry(skillDir)

      if (!entryFile) {
        // 没有可执行文件，这是纯指令型技能
        // 创建纯指令型技能定义
        const skillDef = createInstructionOnlySkillDefinition(entry, skillMdPath)
        loaded.set(entry.id, skillDef)
        continue
      }

      // 有可执行文件，创建可执行型技能
      const entryPath = path.join(skillDir, entryFile.path)
      const runtime = entryFile.runtime

      log.debug('检测到入口文件', { skillId: entry.id, entryFile: entryFile.path, runtime })

      // 选择对应的 Runner
      const runner = selectRunner(runners, runtime)
      if (!runner) {
        log.warn('不支持的 runtime 类型，跳过', { skillId: entry.id, runtime })
        continue
      }

      // 读取技能自定义 env 配置（skill-env.json）
      const skillEnv = await readSkillEnv(skillDir)

      // 创建 Claude Code 技能定义
      const skillDef = createClaudeCodeSkillDefinition(entry, entryPath, runner, skillEnv)
      loaded.set(entry.id, skillDef)

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log.error('加载外部技能失败', { skillId: entry.id, error: errorMessage })
    }
  }

  return loaded
}
