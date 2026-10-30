/**
 * 确定性流水线插件（`com.lumii.pipeline`）。
 *
 * 引擎在这里、流水线是数据（`{workspace}/pipelines/<id>/spec.json`）。加一条流水线 = 加一个 JSON。
 * 与技能同一套动词（list↔search、inspect↔invoke、run↔execute），不发明第五个概念。
 *
 * `apply()` 做三件事：
 * 1. 播种 `bundled-pipelines/` → `{workspace}/pipelines/`（**目标已有内容就整体跳过**）；
 * 2. `bridge.installPipelineTools()` 注册三个工具（bridge 在 S7.4 才建，故等 `agent:runtime-ready`）；
 * 3. `provide(S.pipeline, service)`：service 的执行上下文（callTool / 录屏 / 视图回读）全由 bridge 注入，
 *    插件只是转手——停用后 `S.pipeline` 消失，IPC 表与工具一起静默降级。
 *
 * **不在 ALL_BUILT_IN_TOOL_CONFIGS 里**：那会让工具在停用后仍出现在模型工具表里，
 * 白调一次再拿 not_implemented（与 dashboard-feed 同一取舍）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { definePlugin } from '@mtbot/plugin-core'
import { S } from '../../../main/kernel/services'
import type { MainEvents } from '../../../main/kernel/events'
import { resolvePipelinesDir } from '../../../main/workspace-paths'
import { createPipelineToolConfigs } from './tools'
import { createPipelineService } from './runtime'
import type { PipelineService } from './service-api'

const BUNDLED_DIR_NAME = 'bundled-pipelines'

/** 解析 `bundled-pipelines/` 源目录（仿 bundled-skills-seeder 的三段回退） */
export function resolveBundledPipelinesDir(): string | undefined {
  const override = process.env.LUMII_BUNDLED_PIPELINES_DIR?.trim()
  if (override && fs.existsSync(override)) return override
  try {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    if (resourcesPath) {
      const c = path.join(resourcesPath, BUNDLED_DIR_NAME)
      if (fs.existsSync(c)) return c
    }
  } catch {
    /* ignore */
  }
  try {
    // __dirname = apps/windows/out/main/（electron-vite 构建后）
    const dev = path.resolve(__dirname, '..', '..', BUNDLED_DIR_NAME)
    if (fs.existsSync(dev)) return dev
  } catch {
    /* ignore */
  }
  return undefined
}

/**
 * 播种：**目标目录已有内容就整体跳过**。
 *
 * 与 bundled-skills 的哈希基线不同——流水线没有「内置条目下线」的需求，而 spec 是
 * **用户可以改的数据**。所以简化成「有内容就跳过」：绝不用种子覆盖用户改过的 spec。
 * 用户删掉某条又想要回来，删掉 `{workspace}/pipelines` 整目录即可。
 */
export function seedBundledPipelines(
  sourceDir: string | undefined,
  pipelinesDir: string,
): { seeded: number; skipped: boolean } {
  if (!sourceDir || !fs.existsSync(sourceDir)) return { seeded: 0, skipped: false }
  try {
    if (fs.readdirSync(pipelinesDir).length > 0) return { seeded: 0, skipped: true }
  } catch {
    /* 目录不存在：下面 cpSync 会建 */
  }
  let seeded = 0
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      fs.cpSync(path.join(sourceDir, entry.name), path.join(pipelinesDir, entry.name), { recursive: true })
      seeded++
    } catch {
      /* 单条失败不影响其余 */
    }
  }
  return { seeded, skipped: false }
}

/** 引擎未就绪时的兜底（插件已加载但 bridge 还没建好） */
function notReady(): { ok: false; runId: string; journalPath: string; steps: never[]; error: string } {
  return { ok: false, runId: '', journalPath: '', steps: [], error: '流水线引擎尚未就绪' }
}

export const pipelineExtension = {
  manifest: {
    id: 'com.lumii.pipeline',
    name: '确定性流水线',
    version: '0.1.0',
    description: '可枚举步骤的自动化：代码执行 JSON spec，零 LLM 往返，每步落 journal',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.pipeline',
    provides: ['pipeline'],
    apply(ctx) {
      try {
        const seeded = seedBundledPipelines(resolveBundledPipelinesDir(), resolvePipelinesDir())
        if (seeded.seeded > 0) ctx.log.info(`已播种 ${seeded.seeded} 条内置流水线`)
      } catch (err) {
        ctx.log.warn(`播种内置流水线失败（已忽略）: ${err instanceof Error ? err.message : err}`)
      }

      // service 的真实现由 bridge 提供（它才有 callTool / 录屏 / 视图回读）。
      // 这里存一个可变的引用：provide 的四个方法转发过去，未就绪时安全降级。
      let impl: PipelineService | null = null

      ctx.provide(S.pipeline, {
        list: async () => impl?.list() ?? [],
        detail: async (id) => impl?.detail(id) ?? null,
        run: async (id, opts) => impl?.run(id, opts) ?? notReady(),
        cancel: (runId) => impl?.cancel(runId),
      } satisfies PipelineService)

      const wire = (): boolean => {
        const bridge = ctx.get(S.agentRuntime)?.get()
        if (!bridge) return false
        // 核心**注入**执行器（含权限闸门过的 callTool / 录屏 / 视图回读 / 工具注册口）。
        // 方向是核心→插件，插件从不 import 核心（wiring ⑪ 守的这条）。
        const ex = bridge.createPipelineExecutor()
        impl = createPipelineService({
          callTool: ex.callTool,
          screenRecord: ex.screenRecord,
          readViewState: ex.readViewState,
          knownTools: ex.knownTools,
          needsPermission: ex.needsPermission,
          pipelinesRoot: () => resolvePipelinesDir(),
        })
        // 三个工具：插件造 config，核心用它的 toolContext 建实例并注册
        for (const c of createPipelineToolConfigs(impl)) {
          ctx.effect(ex.registerTool(c as unknown as { name: string }))
        }
        return true
      }
      if (!wire()) {
        ctx.on('agent:runtime-ready', () => {
          wire()
        })
      }
      ctx.log.info('确定性流水线插件已加载')
    },
  }),
}
