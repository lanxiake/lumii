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
import { shell } from 'electron'
import { definePlugin } from '@mtbot/plugin-core'
import { S } from '../../../main/kernel/services'
import type { MainEvents } from '../../../main/kernel/events'
import { resolvePipelinesDir } from '../../../main/workspace-paths'
import { createPipelineToolConfigs } from './tools'
import { createPipelineService } from './runtime'
import { registerPipelineIpcHandlers } from './ipc'
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

/**
 * 老工作区的 `.gitignore` 迁移：补一行「pipelines 下的 runs 目录」忽略规则。
 *
 * `buildDefaultGitignore()` 只在**新建**工作区时生效，老库的 `.gitignore` 早已写好且
 * 不会重建——不补的话老用户的运行记录会被 git 跟踪。**追加而非重写**（用户可能加了别的规则），
 * 已经有这行就不动；读失败跳过并 warn。
 * （注意：本注释刻意不写那条 glob 字面量——它含 `星号斜杠`，会提前闭合块注释。）
 */
export function migrateGitignoreForPipelines(workspaceDir: string): boolean {
  const gi = path.join(workspaceDir, '.gitignore')
  const line = 'pipelines/**/runs/'
  try {
    if (!fs.existsSync(gi)) return false
    const cur = fs.readFileSync(gi, 'utf8')
    if (cur.split('\n').some((l) => l.trim() === line)) return false
    const sep = cur.endsWith('\n') || cur === '' ? '' : '\n'
    fs.appendFileSync(gi, `${sep}${line}\n`, 'utf8')
    return true
  } catch {
    return false
  }
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

      // 老工作区的 .gitignore 补迁移（新建工作区由 buildDefaultGitignore 覆盖）
      try {
        if (migrateGitignoreForPipelines(path.dirname(resolvePipelinesDir()))) {
          ctx.log.info('已为老工作区补上 pipelines/**/runs/ 忽略规则')
        }
      } catch {
        /* 迁移失败不影响功能 */
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
          onProgress: (e) => ex.emitProgress(e),
          onFinished: (e) => ex.emitFinished(e),
        })
        // 三个工具：插件造 config，核心用它的 toolContext 建实例并注册
        for (const c of createPipelineToolConfigs(impl)) {
          ctx.effect(ex.registerTool(c as unknown as { name: string }))
        }
        // 把「有哪些流水线」写进提示词。**这是闭环的关键**：引擎建好但模型不知道它存在，
        // 就会绕过它手工调底层工具（2026-10-31 真机：让它录教程，它直接调 screen_record_*）。
        void refreshHints(bridge, impl)
        return true
      }

      /** 把当前流水线清单推给 bridge（提示词据此注入 Pipelines 一节） */
      const refreshHints = async (
        bridge: { setPipelineHints(h: readonly { id: string; name: string; description?: string; stepCount: number }[]): void },
        svc: PipelineService,
      ) => {
        try {
          const list = await svc.list()
          bridge.setPipelineHints(
            list
              .filter((p) => !p.error)
              .map((p) => ({
                id: p.id,
                name: p.name ?? p.id,
                description: p.description,
                stepCount: p.stepCount,
              })),
          )
        } catch (err) {
          ctx.log.warn(`刷新流水线提示失败（已忽略）: ${err instanceof Error ? err.message : err}`)
        }
      }
      if (!wire()) {
        ctx.on('agent:runtime-ready', () => {
          wire()
        })
      }

      // IPC：挂在插件作用域上，停用即摘（rerender 页会看到表不见了）
      registerPipelineIpcHandlers(
        {
          getService: () => impl,
          openPath: (p) => shell.openPath(p),
          resolvePath: (target, id) => {
            const base = path.join(resolvePipelinesDir(), id)
            return target === 'run' ? path.join(base, 'runs') : base
          },
        },
        { handle: (channel, listener) => ctx.registerIpc?.(channel, listener) },
      )

      ctx.log.info('确定性流水线插件已加载')
    },
  }),
}
