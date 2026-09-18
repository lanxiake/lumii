/**
 * 宫殿向量检索的宿主侧接线（语义改写检索立项 T3）
 *
 * ## 为什么单独一个文件
 *
 * `palace-backend.ts` 管的是**存储与检索入口**的替换（三个 config 回调 +
 * `onConversationEnd`）；这里管的是**向量通道的装载与后台补齐**，两者的生命周期
 * 不同（前者随 DB 打开，后者随模型加载），混在一起会让那个文件同时承担两件事。
 *
 * ## 开关默认关，且与 wiki 的默认值**故意不同**
 *
 * wiki 侧 `DEFAULT_LUMII_WIKI_VECTOR = '1'`（默认开）——那是因为它的模型加载与索引
 * 成本**本机已经在付**。宫殿是**新账**：
 * - 首次启用要索引 993 条 × 30ms ≈ **32 秒**（一次性）
 * - T1 的达标线建立在 **15 条**对照集上，分子只有 3 条（一条翻转 = ±10pp）
 *
 * 故这里默认关，且连模型都不加载——没开就不该付任何代价。
 *
 * ## 禁止静默降级
 *
 * wiki 侧模型加载失败会回退 `createBigramHashEmbedder`（哈希向量）。**这里不这么做**：
 * 哈希向量本质是词面匹配，对语义改写**毫无价值**——回退等于"看着像启用了"，
 * 而实际没解决问题。模型不可用就是**不启用**，并把原因写进日志与索引状态。
 *
 * 设计依据：`docs/plans/记忆系统/2026-09-18-语义改写检索开发计划.md` §5.3/§5.4
 */

import { PalaceVectorIndex, type LocalDatabase, type WikiEmbedder } from '@mtbot/agent-runtime'
import { agentRuntimeLog as log } from './bridge-utils'

/**
 * 默认关闭。设为 '1' 启用。
 *
 * **与 wiki 的默认值故意不同**（那边 `DEFAULT_LUMII_WIKI_VECTOR = '1'`）：
 * wiki 的模型加载与索引成本本机已经在付；宫殿是新账——首次启用要索引 993 条
 * ≈ 32 秒（一次性），而 T1 的达标线建立在 15 条对照集上、分子只有 3 条
 * （一条翻转 = ±10pp）。故连模型都不加载：没开就不该付任何代价。
 */
export const DEFAULT_LUMII_PALACE_VECTOR = '0'

/** 开关读取。未设置按默认（关） */
export function isPalaceVectorEnabled(): boolean {
  const v = process.env.LUMII_PALACE_VECTOR
  if (v === undefined || v === '') return false // 默认关
  return v === '1'
}

export interface PalaceVectorRuntime {
  /** 索引句柄；未启用时为 null（调用方据此走纯 FTS，不传 vectorSearch） */
  readonly index: PalaceVectorIndex | null
  /** 未启用的原因，供日志与体检（禁止静默） */
  readonly disabledReason: string | null
}

/**
 * 装配向量索引。
 *
 * `embedderLoader` 由调用方注入（默认用宿主已有的 `createTransformersE5Embedder`），
 * 便于测试替换与避免本模块直接依赖 transformers。
 */
export async function setupPalaceVector(params: {
  readonly localDb: LocalDatabase
  readonly embedderLoader: () => Promise<WikiEmbedder>
  readonly userId?: string
}): Promise<PalaceVectorRuntime> {
  if (!isPalaceVectorEnabled()) {
    return { index: null, disabledReason: 'LUMII_PALACE_VECTOR 未开启（默认关）' }
  }
  if (!params.localDb.isOpen) {
    return { index: null, disabledReason: '本地库未打开' }
  }

  let embedder: WikiEmbedder
  try {
    embedder = await params.embedderLoader()
    log.info(`[palace-vector] 嵌入器已加载 model=${embedder.modelId} dims=${embedder.dims}`)
  } catch (err) {
    // 不降级到哈希向量：那只是词面匹配，看着像启用而实际没解决问题
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`[palace-vector] 嵌入器不可用，向量检索**不启用**（不降级到哈希向量）：${message}`)
    return { index: null, disabledReason: `嵌入器不可用：${message}` }
  }

  const index = new PalaceVectorIndex(params.localDb.db, embedder)
  return { index, disabledReason: null }
}

/**
 * 后台补齐缺失的向量。
 *
 * **必须后台**：首次启用是全量（1046 条），阻塞启动等于每次冷启动多等几十秒。
 *
 * ## 中断与续跑（2026-09-18 实测的必要性）
 *
 * 实测补齐到 160/1046 时**应用进程崩溃**（`silero_vad.onnx` 版本不兼容，
 * `Exit status 4294930435`），补齐随之静默停住——**没有任何"我没跑完"的信号**。
 * 这与本仓「禁止静默降级」的纪律冲突，故：
 * 1. 每 20 条记一次进度与单条耗时（能区分"变慢"与"停住"）
 * 2. 中断不需要特殊处理——`stats().pending` 与查询里的 `e.drawer_id IS NULL`
 *    天然只取未索引的，下次启动自动续跑。**崩溃本身不是状态，进度才是。**
 *
 * 返回补齐条数；未启用或无事可做时返回 0。失败只记日志，不影响启动与检索。
 */
export async function backfillPalaceVectors(params: {
  readonly localDb: LocalDatabase
  readonly index: PalaceVectorIndex
  readonly userId?: string
  /** 每批之间让出事件循环的毫秒数（默认 0，即只让一个 tick） */
  readonly yieldMs?: number
  /** 单次运行的上限，防止超大库一次跑太久（默认 5000） */
  readonly maxBatch?: number
}): Promise<number> {
  const { localDb, index } = params
  if (!localDb.isOpen) return 0
  const userId = params.userId ?? 'local-user'
  const yieldMs = params.yieldMs ?? 0
  const maxBatch = params.maxBatch ?? 5000

  try {
    const stats = index.stats(userId)
    if (stats.pending === 0) return 0
    log.info(`[palace-vector] 后台补齐启动：待补 ${stats.pending} 条（已索引 ${stats.indexed}）`)

    // 只取**缺向量的**活跃抽屉：已索引的不重算（内容没变时 upsertDrawer 也会跳过，
    // 但查一遍能少走一遍嵌入的 content_hash 计算）
    const rows = localDb.db
      .prepare<{
        drawer_id: string
        agent_id: string
        user_id: string
        content: string
      }>(
        `SELECT d.drawer_id, d.agent_id, d.user_id, d.content
           FROM palace_drawers d
      LEFT JOIN palace_drawer_embeddings e ON e.drawer_id = d.drawer_id
          WHERE d.user_id = ? AND d.deleted_at IS NULL AND e.drawer_id IS NULL
          ORDER BY d.created_at DESC
          LIMIT ?`,
      )
      .all(userId, maxBatch)

    let done = 0
    for (const row of rows) {
      const t0 = Date.now()
      await index.upsertDrawer({
        drawerId: row.drawer_id,
        agentId: row.agent_id,
        userId: row.user_id,
        content: row.content,
      })
      done += 1
      // 进度与**单条耗时**都记：实测一次卡死在 160/1046 且无任何日志，
      // 单条耗时能把「突然变慢」与「彻底停住」区分开
      const elapsed = Date.now() - t0
      if (done % 20 === 0 || elapsed > 3000) {
        log.info(
          `[palace-vector] 补齐进度 ${done}/${rows.length} 本条耗时=${elapsed}ms` +
            (elapsed > 3000 ? '  ← 异常慢，疑似阻塞' : ''),
        )
      }
      // 让出事件循环：嵌入是 CPU 密集的，一口气跑完会卡住主进程的 IPC 响应
      if (done % 20 === 0) await new Promise((r) => setTimeout(r, yieldMs))
    }
    log.info(`[palace-vector] 后台补齐完成：${done} 条`)
    return done
  } catch (err) {
    // 走到这里说明补齐没跑完。**把进度一起报出去**——只说"失败"会让人以为一条没写，
    // 而实际上可能已写了 160 条（续跑时会跳过它们）。
    log.warn(`[palace-vector] 后台补齐中断（已写 ${index.stats(userId).indexed} 条，下次启动续跑）:`, err)
    return 0
  }
}
