/**
 * ToolWriter — 进化工具定义落盘（工具进化 M2）
 *
 * 目录结构（仿 skill-evolution/skill-writer 的文件系统方案）：
 * - 已批准工具：~/.lumii/workspace/tools/<name>/tool.json
 * - 待审批队列：~/.lumii/workspace/tool-evolution-pending.json
 *
 * 全部为本地数据文件，不进入 git 仓库、不参与云同步。
 * 写入用串行锁（promise 链）防并发交错。
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveLegacyWorkspaceDir } from '../../paths'
import type { TemplateToolDefinition } from '@mtbot/agent-runtime'
import type { ToolDraft } from '@mtbot/agent-runtime'

/** 落盘工具定义 = 草稿 + 元数据 */
export interface StoredToolDefinition extends TemplateToolDefinition {
  /** approved：已注册生效；disabled：用户已禁用（保留文件，可重新启用） */
  status: 'approved' | 'disabled'
  /** 原始命令样本（审计/回放参考） */
  samples: string[]
  createdAt: string
  approvedAt: string
}

export interface PendingToolDraft extends ToolDraft {
  /** 草稿对应的命令模式（审批展示与回放校验用） */
  pattern: string
  samples: string[]
  createdAt: string
  /** 唯一草稿 ID（同一模式可重复草拟） */
  draftId: string
}

export function resolveToolsDir(): string {
  return path.join(resolveLegacyWorkspaceDir(), 'tools')
}

function pendingFilePath(): string {
  return path.join(resolveLegacyWorkspaceDir(), 'tool-evolution-pending.json')
}

function toolFilePath(name: string): string {
  return path.join(resolveToolsDir(), safeSegment(name), 'tool.json')
}

/** 防路径穿越：工具名必须是安全文件名 */
function safeSegment(name: string): string {
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`非法工具名: ${name}`)
  }
  return name
}

// ── 串行锁：所有写操作排队执行，防交错 ──
let writeQueue: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = writeQueue.then(fn, fn)
  writeQueue = run.catch(() => undefined)
  return run
}

/** 读待审批队列（不存在/损坏时返回空数组） */
export function loadPendingDrafts(): PendingToolDraft[] {
  try {
    const raw = fs.readFileSync(pendingFilePath(), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isPendingDraft)
  } catch {
    return []
  }
}

function isPendingDraft(value: unknown): value is PendingToolDraft {
  const v = value as Record<string, unknown>
  return (
    typeof v?.name === 'string' &&
    typeof v?.commandTemplate === 'string' &&
    typeof v?.draftId === 'string'
  )
}

/** 覆盖写待审批队列 */
export function savePendingDrafts(drafts: PendingToolDraft[]): Promise<void> {
  return withLock(async () => {
    const dir = path.dirname(pendingFilePath())
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.writeFile(
      pendingFilePath(),
      JSON.stringify(drafts, null, 2),
      'utf-8',
    )
  })
}

/** 批准：写 tool.json（status=approved） */
export function saveApprovedTool(
  def: TemplateToolDefinition,
  samples: string[],
): Promise<void> {
  return withLock(async () => {
    const stored: StoredToolDefinition = {
      ...def,
      status: 'approved',
      samples: samples.slice(0, 20),
      createdAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
    }
    const file = toolFilePath(def.name)
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    await fs.promises.writeFile(file, JSON.stringify(stored, null, 2), 'utf-8')
  })
}

/** 读取全部已落盘工具（含禁用，管理 UI 用；缺失/损坏文件跳过） */
export function loadStoredTools(): Array<{ def: StoredToolDefinition; status: 'approved' | 'disabled' }> {
  const dir = resolveToolsDir()
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: Array<{ def: StoredToolDefinition; status: 'approved' | 'disabled' }> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const raw = fs.readFileSync(path.join(dir, entry.name, 'tool.json'), 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (typeof parsed.name === 'string' && (parsed.status === 'approved' || parsed.status === 'disabled')) {
        out.push({
          def: parsed as unknown as StoredToolDefinition,
          status: parsed.status,
        })
      }
    } catch {
      // 跳过损坏文件
    }
  }
  return out
}

/** 读取已批准工具（启动时注册用；缺失/损坏文件跳过） */
export function loadApprovedTools(): StoredToolDefinition[] {
  return loadStoredTools()
    .filter((e) => e.status === 'approved')
    .map((e) => e.def)
}

/** 更新工具启用状态（approved / disabled） */
export function updateToolStatus(name: string, status: 'approved' | 'disabled'): boolean {
  try {
    const file = toolFilePath(name)
    const raw = fs.readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed.status === status) return true
    parsed.status = status
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

/** 删除已批准工具（后续「停用工具」治理用） */
export function removeApprovedTool(name: string): void {
  try {
    fs.rmSync(path.dirname(toolFilePath(name)), { recursive: true, force: true })
  } catch {
    // 删除失败不影响主链路
  }
}

/** 生成草稿 ID */
export function newDraftId(): string {
  return randomUUID()
}
