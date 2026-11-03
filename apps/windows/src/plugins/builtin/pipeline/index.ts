/**
 * 确定性流水线插件（`com.lumii.pipeline`）。
 *
 * 引擎在这里、流水线是数据（`{workspace}/pipelines/<id>/spec.json`）。加一条流水线 = 加一个 JSON。
 * 与技能同一套动词（list↔search、inspect↔invoke、run↔execute），不发明第五个概念。
 *
 * `apply()` 做三件事：
 * 1. 播种 `bundled-pipelines/` → `{workspace}/pipelines/`（按基线哈希决定覆盖/保留，见 seedBundledPipelines）；
 * 2. `bridge.installPipelineTools()` 注册三个工具（bridge 在 S7.4 才建，故等 `agent:runtime-ready`）；
 * 3. `provide(S.pipeline, service)`：service 的执行上下文（callTool / 录屏 / 视图回读）全由 bridge 注入，
 *    插件只是转手——停用后 `S.pipeline` 消失，IPC 表与工具一起静默降级。
 *
 * **不在 ALL_BUILT_IN_TOOL_CONFIGS 里**：那会让工具在停用后仍出现在模型工具表里，
 * 白调一次再拿 not_implemented（与 dashboard-feed 同一取舍）。
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { shell } from 'electron'
import { definePlugin } from '@mtbot/plugin-core'
import { S } from '../../../main/kernel/services'
import type { MainEvents } from '../../../main/kernel/events'
import { resolveActiveWorkspaceDir, resolvePipelinesDir } from '../../../main/workspace-paths'
import { createPipelineToolConfigs } from './tools'
import { createPipelineService } from './runtime'
import { registerPipelineIpcHandlers } from './ipc'
import { collectInputNames } from './spec'
import type { PipelineService } from './service-api'

const BUNDLED_DIR_NAME = 'bundled-pipelines'

/**
 * 递归复制目录（**不能用 `fs.cpSync`**）。
 *
 * Electron 36.9.5（Node 22.19）里源路径含中文时，`cpSync` 会在内部抛 `length_error`，
 * 而 Node 是 `-fno-exceptions` 编的 —— 整个主进程直接 abort，JS 层连 catch 的机会都没有。
 * 2026-11-02 在 `capability_export` 上连崩 4 次才定位；这里同样吃中文路径（pipelines 目录
 * 跟 skills 一样挂在用户可自定义的工作区下）。
 */
function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDirRecursive(from, to)
    else fs.copyFileSync(from, to)
  }
}

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
 * 播种：**逐条**播种，目标已存在同名目录就按基线哈希决定覆盖还是保留。
 *
 * 不能「目录非空就整体跳过」——那样老工作区永远收不到新内置流水线（2026-11-01
 * 真机验收时 `web-clone-evidence` 就因此没出现）。
 * 也不能直接覆盖：spec 是**用户可以改的数据**。
 *
 * ## 为什么不是「已存在就跳过」（2026-11-03 改）
 *
 * 跳过会让**修好的 spec 永远到不了老用户**。实测代价已经发生过：
 * - `web-clone` 的占位符被用户手工替换成 `https://weflow.top/` 之后，描述里那句话
 *   变成「跑之前把 https://weflow.top/ 与 weflow-top 换成真实值」——Agent 读完以为还没填；
 * - 2026-11-03 引入运行时变量后，内置 spec 全部改用 `{{input.x}}`，跳过就意味着老工作区
 *   永远停在旧形态（每次换目标都要改文件）。
 *
 * 与 `bundled-skills-seeder` 同一套判据（那边已跑了几轮，是被证明过的）：
 * - 目录里没有基线 → 分不清「用户改过」与「只是旧」→ **不动**（覆盖别人的东西不可逆）
 * - 基线 == 我们上次种下的内容 → 用户没动过 → **用新版覆盖**
 * - 基线 != 上次种下的内容 → 用户改过 → **保留**，日志里说一声
 *
 * `.bundled-pipeline-hash` 记的是**上次种下去的内容**（整目录所有文件按路径排序后拼接的 sha256），
 * 不是源目录的哈希——没有它就无法判断"用户改没改过"。
 */
export function seedBundledPipelines(
  sourceDir: string | undefined,
  pipelinesDir: string,
): { seeded: number; updated: number; kept: number } {
  if (!sourceDir || !fs.existsSync(sourceDir)) return { seeded: 0, updated: 0, kept: 0 }
  let seeded = 0
  let updated = 0
  let kept = 0
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const from = path.join(sourceDir, entry.name)
    const dest = path.join(pipelinesDir, entry.name)
    try {
      if (!fs.existsSync(dest)) {
        copyDirRecursive(from, dest)
        seedInputsTemplate(path.join(dest, 'spec.json'), dest)
        writeBaseline(dest)
        seeded++
        continue
      }
      const baseline = readBaseline(dest)
      if (baseline === null) {
        // 没有基线：可能是老版本种的，也可能是用户自己造的。两种情况都不该覆盖。
        kept++
        continue
      }
      if (hashDir(dest) !== baseline) {
        kept++
        continue
      }
      // 没改过 → 覆盖，但**保留用户填的 inputs.json**（那是运行输入，不是 spec）
      const userInputs = path.join(dest, 'inputs.json')
      const saved = fs.existsSync(userInputs) ? fs.readFileSync(userInputs) : undefined
      copyDirRecursive(from, dest)
      if (saved && !fs.existsSync(userInputs)) fs.writeFileSync(userInputs, saved)
      else if (saved) fs.writeFileSync(userInputs, saved)
      seedInputsTemplate(path.join(dest, 'spec.json'), dest, { overwrite: false })
      writeBaseline(dest)
      updated++
    } catch {
      /* 单条失败不影响其余 */
    }
  }
  return { seeded, updated, kept }
}

/** 基线哈希文件（放在流水线目录里，与 spec 同级） */
const BASELINE_FILENAME = '.bundled-pipeline-hash'

/**
 * 整目录内容哈希：相对路径 + 文件内容，按路径排序后拼接。
 *
 * **不含** `.bundled-pipeline-hash` 自己（自指）与 `runs/`（运行产物，与"改没改过"无关）
 * 和 `inputs.json`（用户填的运行输入，覆盖 spec 不该把它算成"用户改过"）。
 */
function hashDir(dir: string): string {
  const files: string[] = []
  const walk = (d: string, rel: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (e.name === 'runs') continue
        walk(path.join(d, e.name), r)
      } else if (e.name !== BASELINE_FILENAME && e.name !== 'inputs.json') {
        files.push(r)
      }
    }
  }
  walk(dir, '')
  files.sort()
  const hash = createHash('sha256')
  for (const f of files) {
    hash.update(f)
    hash.update('\0')
    hash.update(fs.readFileSync(path.join(dir, f)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function readBaseline(dir: string): string | null {
  try {
    const v = fs.readFileSync(path.join(dir, BASELINE_FILENAME), 'utf8').trim()
    return v || null
  } catch {
    return null
  }
}

function writeBaseline(dir: string): void {
  try {
    fs.writeFileSync(path.join(dir, BASELINE_FILENAME), hashDir(dir), 'utf8')
  } catch {
    /* 基线写不进去只影响下次能否升级，不影响本次播种 */
  }
}

/**
 * 给「有变量」的内置流水线播一份 `inputs.json` 模板。
 *
 * 没有它，用户第一次跑会得到一句 `bad_reference: input.repoUrl`——报错对，但没说该填什么。
 * 有它，用户打开文件就能看到 `"repoUrl": "{{input.repoUrl}}"`，知道要换成真值。
 *
 * **只在播种时写**（上面的 `existsSync` 已经保证了这一点）：用户改过的 inputs.json
 * 与改过的 spec 一样，不该被后续更新覆盖。
 */
function seedInputsTemplate(specPath: string, destDir: string, opts: { overwrite?: boolean } = {}): void {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(specPath, 'utf8'))
    // 播种时还没有 toolRegistry（插件与 bridge 谁先就绪不定），没法跑完整校验。
    // 这里只做变量推导——它不依赖工具表，纯文本扫描。
    const explicit = (raw as { inputTemplate?: unknown }).inputTemplate
    const template: Record<string, string> = {}
    for (const [name, sample] of collectInputNames(raw)) {
      template[name] = typeof (explicit as Record<string, unknown>)?.[name] === 'string'
        ? String((explicit as Record<string, unknown>)[name])
        : sample
    }
    if (!Object.keys(template).length) return
    // 升级时用户已经填过的别覆盖——那是运行输入，不是模板
    if (opts.overwrite === false && fs.existsSync(path.join(destDir, 'inputs.json'))) return
    fs.writeFileSync(path.join(destDir, 'inputs.json'), JSON.stringify(template, null, 2) + '\n', 'utf8')
  } catch {
    /* 模板只是锦上添花，坏了不值得让整条播种失败 */
  }
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
      /**
       * 播种 + 老工作区 .gitignore 迁移。
       *
       * **不能在 apply() 里做**：apply 跑在 workspace getter 挂接之前（实测 18:36:15
       * 播种、18:36:19 才 setActiveWorkspaceDirGetter），`resolvePipelinesDir()` 会
       * 回落到默认工作区——用户配了自定义 workspace 时，内置流水线会播到错目录，
       * 列表里永远看不到。等到 `agent:runtime-ready`（核心初始化完之后）再做。
       */
      const seedAndMigrate = () => {
        try {
          const r = seedBundledPipelines(resolveBundledPipelinesDir(), resolvePipelinesDir())
          if (r.seeded > 0) ctx.log.info(`已播种 ${r.seeded} 条内置流水线`)
          if (r.updated > 0) ctx.log.info(`已升级 ${r.updated} 条内置流水线（用户没改过）`)
          if (r.kept > 0) ctx.log.info(`${r.kept} 条流水线被保留（用户改过或没有基线）`)
        } catch (err) {
          ctx.log.warn(`播种内置流水线失败（已忽略）: ${err instanceof Error ? err.message : err}`)
        }
        try {
          if (migrateGitignoreForPipelines(path.dirname(resolvePipelinesDir()))) {
            ctx.log.info('已为老工作区补上 pipelines/**/runs/ 忽略规则')
          }
        } catch {
          /* 迁移失败不影响功能 */
        }
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
        // 到这里 workspace getter 已挂接，播种/迁移才落对目录
        seedAndMigrate()
        // 核心**注入**执行器（含权限闸门过的 callTool / 录屏 / 视图回读 / 工具注册口）。
        // 方向是核心→插件，插件从不 import 核心（wiring ⑪ 守的这条）。
        const ex = bridge.createPipelineExecutor()
        impl = createPipelineService({
          callTool: ex.callTool,
          runAgentStage: ex.runAgentStage,
          screenRecord: ex.screenRecord,
          readViewState: ex.readViewState,
          knownTools: ex.knownTools,
          knownAgents: ex.knownAgents,
          needsPermission: ex.needsPermission,
          pipelinesRoot: () => resolvePipelinesDir(),
          workspaceRoot: () => resolveActiveWorkspaceDir(),
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
