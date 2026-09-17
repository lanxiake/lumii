/**
 * 云同步工具注册：resolve_sync_conflict（冲突落决）+ cloud_sync_read_file（读三方内容）
 * + cloud_sync_git（只读 git/远端诊断，落决超时后核实后台结果）。
 * 与 bridge-tool-registrar-cron 同模式：纯函数式注册，仅依赖注入的 deps。
 */
import { Type } from '@sinclair/typebox'
import { createMtBotTool, type MtBotToolConfig } from '@mtbot/agent-runtime'
import { agentRuntimeLog as log, jsonToolResult } from './bridge-utils'
import { getCloudSyncManager } from '../cloud-sync/sync-accessor'
import type { BridgeToolRegistrarDeps } from './bridge-tool-registrar-types'

export function registerSyncConflictTool(deps: BridgeToolRegistrarDeps): void {
  const ctx = deps.toolContext
  if (!ctx) return

  const readFile: MtBotToolConfig = {
    name: 'cloud_sync_read_file',
    label: 'Read Cloud Sync File',
    category: 'filesystem' as const,
    description:
      '读取云同步冲突中某文件的 local/remote/base 三侧任一版本内容，用于判断如何解决冲突。仅在存在同步冲突时可用。',
    parameters: Type.Object({
      side: Type.String({
        enum: ['local', 'remote', 'base'],
        description: 'local=本地版本 / remote=远端版本 / base=共同祖先版本',
      }),
      filepath: Type.String({ description: '文件相对工作空间根目录的路径' }),
    }),
    isReadOnly: true,
    needsPermission: false,
    execute: async (_id, rawParams) => {
      const p = rawParams as { side: 'local' | 'remote' | 'base'; filepath: string }
      const m = getCloudSyncManager()
      if (!m) return jsonToolResult({ status: 'error', message: '云同步未初始化' })
      const content = await m.readFileAt(p.side, p.filepath)
      if (content === null) {
        // 区分两种「读不到」：是冲突文件但该侧已删除（delete/modify 冲突），
        // 还是压根不在冲突列表里。前者对决策至关重要 —— Agent 需据此判断
        // "远端删了、本地改了"，而不是误以为路径写错。
        const conflict = m.getConflict()
        const isConflictFile = conflict?.files.includes(p.filepath) ?? false
        if (isConflictFile) {
          const sideLabel = p.side === 'local' ? '本地' : p.side === 'remote' ? '远端' : '共同祖先'
          return jsonToolResult({
            status: 'error',
            side: p.side,
            filepath: p.filepath,
            message:
              `${sideLabel}不存在该文件（${p.filepath}）。` +
              `这是删除/修改型冲突：${sideLabel}删除了它，另一侧修改了它 —— ` +
              `选该侧即表示接受删除，选另一侧即保留修改。`,
          })
        }
        return jsonToolResult({
          status: 'error',
          message: `无法读取 ${p.side}/${p.filepath}（不是当前冲突文件）`,
        })
      }
      return jsonToolResult({ status: 'ok', side: p.side, filepath: p.filepath, content })
    },
  }
  deps.toolRegistry.register(createMtBotTool(readFile, ctx))

  const resolve: MtBotToolConfig = {
    name: 'resolve_sync_conflict',
    label: 'Resolve Cloud Sync Conflict',
    category: 'filesystem' as const,
    description:
      '解决工作空间云同步冲突。仅在收到同步冲突通知时调用。先用 cloud_sync_read_file 读三方内容再决定策略：' +
      'keep-local 全部保留本地 / keep-remote 全部采用远端 / per-file 逐文件指定取侧。',
    parameters: Type.Object({
      strategy: Type.String({
        enum: ['keep-local', 'keep-remote', 'per-file'],
        description: '冲突解决策略',
      }),
      choices: Type.Optional(
        Type.Array(
          Type.Object({
            path: Type.String({ description: '文件相对路径' }),
            side: Type.String({ enum: ['local', 'remote'], description: '该文件取哪一侧' }),
          }),
          { description: '仅 strategy=per-file 时必填，逐文件指定取侧' },
        ),
      ),
    }),
    isReadOnly: false,
    needsPermission: false,
    execute: async (_id, rawParams) => {
      const p = rawParams as {
        strategy: 'keep-local' | 'keep-remote' | 'per-file'
        choices?: { path: string; side: 'local' | 'remote' }[]
      }
      if (p.strategy === 'per-file' && !p.choices?.length) {
        return {
          ...jsonToolResult({ status: 'error', message: 'strategy=per-file 时必须提供 choices' }),
          isError: true,
        }
      }
      const m = getCloudSyncManager()
      if (!m) {
        return {
          ...jsonToolResult({ status: 'error', message: '云同步未初始化' }),
          isError: true,
        }
      }

      // 已在飞行中 → 秒回状态，不排队（T1.1 守卫的语义在这里透出给 Agent）
      if (m.isResolveInFlight()) {
        return jsonToolResult({
          status: 'running',
          message:
            '上一轮落决仍在后台执行，本次请求**未排队**。用 cloud_sync_git 的 status/log/remote 核实进度即可，不要重复调用本工具。',
        })
      }

      // 启动后台落决并**立即返回** —— 落决包含「补远端变更 + 落决提交 + 推送上传」，
      // 大仓库下可达数分钟。此前同步等待会把 Agent 卡在这里（300s 后拿到超时，
      // 而任务其实还在跑 —— 2026-09-17 死循环的一环）。
      //
      // 结果不需要回填：落决成功则冲突自行消失（下轮 _cleanupStaleConflictGoal 清理），
      // 失败则冲突仍在、下轮重试 —— 「状态变化」本身就是回填。
      void m
        .resolveConflict(p.strategy, p.choices)
        .then((r) => {
          log.info(
            `[resolve_sync_conflict] 后台落决结束: ${r.success ? '成功' : `失败(${r.error ?? '未知'})`}`,
          )
        })
        .catch((err) => {
          log.error(
            `[resolve_sync_conflict] 后台落决异常: ${err instanceof Error ? err.message : String(err)}`,
          )
        })

      return jsonToolResult({
        status: 'started',
        message:
          '落决已在后台启动（补远端变更 → 落决提交 → 推送上传，通常数分钟）。' +
          '**不要重复调用本工具**：完成后冲突状态会自动清除；' +
          '需要核实进度时用 cloud_sync_git 的 status / log / remote。',
      })
    },
  }
  deps.toolRegistry.register(createMtBotTool(resolve, ctx))

  const gitDiag: MtBotToolConfig = {
    name: 'cloud_sync_git',
    label: 'Cloud Sync Git Diagnostics',
    category: 'filesystem' as const,
    description:
      '只读查看云同步 git 仓库与远端状态，用于落决后核实后台结果。action：' +
      'status=看同步状态/是否仍冲突/HEAD/未提交变更（判断后台落决是否已成功）；' +
      'log=看本地提交历史（确认落决 commit 是否已生成）；' +
      'remote=用配置的认证信息真实请求远端 tip（确认落决是否已推上去、远端是否前进，pushed=true 表示本地分支与远端 tip 一致）。' +
      '配合 resolve_sync_conflict 使用：若落决返回超时/失败，不要反复重试，先用本工具核实结果。',
    parameters: Type.Object({
      action: Type.String({
        enum: ['status', 'log', 'remote'],
        description: 'status=仓库状态 / log=提交历史 / remote=远端 tip 查询',
      }),
      limit: Type.Optional(Type.Number({ description: 'log 的条数上限（默认 20）' })),
    }),
    isReadOnly: true,
    needsPermission: false,
    execute: async (_id, rawParams) => {
      const p = rawParams as { action: 'status' | 'log' | 'remote'; limit?: number }
      const m = getCloudSyncManager()
      if (!m) return jsonToolResult({ status: 'error', message: '云同步未初始化' })
      if (p.action === 'status') {
        return jsonToolResult({ status: 'ok', ...(await m.gitStatus()) })
      }
      if (p.action === 'log') {
        return jsonToolResult({ status: 'ok', ...(await m.gitLog(p.limit ?? 20)) })
      }
      return jsonToolResult({ status: 'ok', ...(await m.gitRemote()) })
    },
  }
  deps.toolRegistry.register(createMtBotTool(gitDiag, ctx))

  // ── 主动管理（T6.2）：按需推送 / 立即同步 ──────────────────────────────

  const pushPaths: MtBotToolConfig = {
    name: 'cloud_sync_push',
    label: 'Cloud Sync Push Paths',
    category: 'filesystem' as const,
    description:
      '把指定的产出文件**立即**推送上去（路径相对 outputs 目录，如 `小星星绘本/video/x.mp4`）。' +
      '不经分级阈值与队列轮转 —— 用于「刚生成的东西要马上在另一台设备看到」。' +
      '会作为一批提交并推送；被排除规则挡下或不存在的路径会被跳过并在结果里说明。',
    parameters: Type.Object({
      paths: Type.Array(Type.String(), {
        description: '相对 outputs 目录的路径（可多个）',
      }),
    }),
    isReadOnly: false,
    // 主动决定"推什么上去"是高危写操作（数据外发不可逆）—— 需用户确认
    needsPermission: true,
    execute: async (_id, rawParams) => {
      const p = rawParams as { paths: string[] }
      const m = getCloudSyncManager()
      if (!m) {
        return { ...jsonToolResult({ status: 'error', message: '云同步未初始化' }), isError: true }
      }
      const r = await m.pushPaths(p.paths)
      return {
        ...jsonToolResult({ status: r.success ? 'ok' : 'error', message: r.message }),
        isError: !r.success,
      }
    },
  }
  deps.toolRegistry.register(createMtBotTool(pushPaths, ctx))

  const syncNow: MtBotToolConfig = {
    name: 'cloud_sync_now',
    label: 'Cloud Sync Now',
    category: 'filesystem' as const,
    description:
      '提交一次完整同步请求（等价设置页「立即同步」按钮）。秒回 —— 同步在后台执行。' +
      '同步与工作区 Turn 快照**共用一条串行队列**，高峰期可能需要排队；返回值里的 ' +
      '`queuedBehind` 是排队时前面的任务数（0 = 可直接开跑）。**排队不等于已执行**：' +
      '需要核实进度用 cloud_sync_git 的 status（queuedBehind>0 即仍在排队），不要重复调用本工具。',
    parameters: Type.Object({}),
    isReadOnly: false,
    // 与定时同步等价，不额外要求确认
    needsPermission: false,
    execute: async () => {
      const m = getCloudSyncManager()
      if (!m) {
        return { ...jsonToolResult({ status: 'error', message: '云同步未初始化' }), isError: true }
      }
      // 先读队列深度再触发：这个数就是「前面还有几个任务」，秒回时如实报给 Agent。
      // 此前无论排多长的队都回「已触发同步」，Agent 据此断言「同步成功」——
      // 2026-09-17 实测队列被 Turn 快照堵了 14 分钟，期间每次调用都是这句不实之词。
      const queuedBehind = m.getQueueDepth()
      void m.sync()
      return jsonToolResult({
        status: 'started',
        queuedBehind,
        message:
          queuedBehind > 0
            ? `已提交同步请求，但前面还有 ${queuedBehind} 个任务（工作区快照等）在排队，**尚未开始执行**。` +
              '不要重复调用本工具；用 cloud_sync_git 的 status 看 queuedBehind 字段判断是否已轮到。'
            : '已提交同步请求（后台执行）。用 cloud_sync_git 的 status 核实进度。',
      })
    },
  }
  deps.toolRegistry.register(createMtBotTool(syncNow, ctx))

  log.info(
    '[registerSyncConflictTool] cloud_sync_read_file / resolve_sync_conflict / cloud_sync_git / cloud_sync_push / cloud_sync_now registered',
  )
}
