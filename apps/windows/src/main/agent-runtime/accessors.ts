/**
 * Agent Runtime 存储层的单例访问器。
 *
 * 为什么要拆出来：`bridge.ts` 4500+ 行，任何只想用 `conversationRepo` 的模块
 * 都得 import 整个 bridge（连带它的全部依赖进依赖图）。这些仓储本身是被动的
 * 数据访问对象，没有生命周期，不需要穿过门面。
 *
 * 与 `cloud-sync/sync-accessor.ts` 同模式：bridge.initialize() 时 set，
 * 调用方 get。语义与桥上的 getter 一致——**未初始化就抛错**，不返回 undefined
 * （只有 segmentMemory 例外，它本身是可选灰度服务）。
 *
 * 迁移期：bridge 上的 getter 保留并转发到这里，调用点可逐批替换。
 */
import type {
  AgentMemoryRepo,
  AuditRepo,
  AutonomousRepo,
  BashCommandRepo,
  ConversationRepo,
  DatabaseAdapter,
  FileRepo,
  MemoryManager,
  RuntimeStateRepo,
  SegmentRepo,
  TaskRepo,
  WikiCleanupScanner,
  WikiIngestHook,
  WikiLibraryMigrate,
  WikiOrganizeQueue,
  WikiOrganizer,
  WikiReclassifier,
  WikiRepo,
} from '@mtbot/agent-runtime'

import type { SegmentMemoryService } from './segment-memory-service'

export interface AgentRuntimeRepos {
  db: DatabaseAdapter
  conversationRepo: ConversationRepo
  segmentRepo: SegmentRepo
  taskRepo: TaskRepo
  auditRepo: AuditRepo
  bashCommandRepo: BashCommandRepo
  runtimeStateRepo: RuntimeStateRepo
  autonomousRepo: AutonomousRepo
  fileRepo: FileRepo
  memoryRepo: AgentMemoryRepo
  memoryManager: MemoryManager
  /** 段落总结记忆（灰度，可能关闭） */
  segmentMemory: SegmentMemoryService | null
  wikiRepo: WikiRepo
  wikiOrganizer: WikiOrganizer
  wikiIngestHook: WikiIngestHook
  wikiReclassifier: WikiReclassifier
  wikiOrganizeQueue: WikiOrganizeQueue
  wikiCleanupScanner: WikiCleanupScanner
}

let repos: AgentRuntimeRepos | null = null

/**
 * 库级迁移状态机是**惰性**创建的（依赖 wikiRepo + LLM 回调），
 * 没法在 initialize 末尾一次性登记，所以单独一个槽位，创建时再填。
 */
let wikiLibraryMigrate: WikiLibraryMigrate | null = null

export function setAgentRuntimeRepos(next: AgentRuntimeRepos): void {
  repos = next
}

export function setWikiLibraryMigrate(repo: WikiLibraryMigrate): void {
  wikiLibraryMigrate = repo
}

/** 销毁/关闭时清空，避免已卸载的实例被后续调用悄悄用上。 */
export function clearAgentRuntimeRepos(): void {
  repos = null
  wikiLibraryMigrate = null
}

/** 刻意不叫 `require`：knip 会把同名调用当成 CommonJS require，逐条报成「未声明的依赖」。 */
function mustGet<K extends keyof AgentRuntimeRepos>(key: K): AgentRuntimeRepos[K] {
  if (!repos) {
    throw new Error(`AgentRuntimeBridge not initialized (${key}). Call initialize() first.`)
  }
  return repos[key]
}

export function getDb(): DatabaseAdapter { return mustGet('db') }
export function getConversationRepo(): ConversationRepo { return mustGet('conversationRepo') }
export function getSegmentRepo(): SegmentRepo { return mustGet('segmentRepo') }
export function getTaskRepo(): TaskRepo { return mustGet('taskRepo') }
export function getAuditRepo(): AuditRepo { return mustGet('auditRepo') }
export function getBashCommandRepo(): BashCommandRepo { return mustGet('bashCommandRepo') }
export function getRuntimeStateRepo(): RuntimeStateRepo { return mustGet('runtimeStateRepo') }
export function getAutonomousRepo(): AutonomousRepo { return mustGet('autonomousRepo') }
export function getFileRepo(): FileRepo { return mustGet('fileRepo') }
export function getMemoryRepo(): AgentMemoryRepo { return mustGet('memoryRepo') }
export function getMemoryManager(): MemoryManager { return mustGet('memoryManager') }
/** 灰度服务：未开启时返回 null，与桥上 getter 的语义一致 */
export function getSegmentMemory(): SegmentMemoryService | null { return repos?.segmentMemory ?? null }
export function getWikiRepo(): WikiRepo { return mustGet('wikiRepo') }
export function getWikiOrganizer(): WikiOrganizer { return mustGet('wikiOrganizer') }
export function getWikiIngestHook(): WikiIngestHook { return mustGet('wikiIngestHook') }
export function getWikiReclassifier(): WikiReclassifier { return mustGet('wikiReclassifier') }
export function getWikiLibraryMigrate(): WikiLibraryMigrate {
  if (!wikiLibraryMigrate) {
    throw new Error('AgentRuntimeBridge not initialized (wikiLibraryMigrate). Call initialize() first.')
  }
  return wikiLibraryMigrate
}
export function getWikiOrganizeQueue(): WikiOrganizeQueue { return mustGet('wikiOrganizeQueue') }
export function getWikiCleanupScanner(): WikiCleanupScanner { return mustGet('wikiCleanupScanner') }
