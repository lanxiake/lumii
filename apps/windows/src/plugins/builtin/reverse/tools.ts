/**
 * 逆向探针工具（`reverse_probe`）。
 *
 * ## 为什么是插件而不是技能自带脚本
 *
 * 技能目录（`bundled-skills/`）是**播种到工作区的数据**，用户能改、能删、能拷走。
 * 把 Ghidra 驱动脚本放进去等于：关掉插件也没用（脚本还在技能目录里，Agent 照样能 `node` 它）。
 * 放进插件的资产目录 + 做成工具后，开关才真的是开关：
 *
 * - 插件停用 ⇒ 工具从工具表消失（并且会 `refreshAllInstanceTools()`，**运行中的会话下一轮就看不到**）；
 * - 技能 `SKILL.md` 里写「有 `reverse_probe` 就用，没有就按 §7 降级」⇒ 两条路径都是显式的。
 *
 * ## 契约
 *
 * 与 `pipeline_*` / `browser_*` 同一套：`isReadOnly` 只读入参、`needsPermission` 决定要不要审批。
 * 探针本身**只读目标文件**（Ghidra 写的是临时项目目录，`-deleteProject` 收尾），所以
 * `isReadOnly: true` 但**仍需审批**——它会把二进制内容反编译成文本交给模型。
 */
import { Type, type Static } from '@sinclair/typebox'
import * as path from 'node:path'
import { spawn } from 'node:child_process'

import type { MtBotToolConfig } from '@mtbot/agent-runtime'
import type { ReverseService } from './service-api'
import { probeApkFile } from './apk-probe'

const ProbeInput = Type.Object({
  target: Type.String({
    description: '目标文件绝对路径。支持 PE / ELF / Mach-O（需 Ghidra）与 APK（内置，无需外部工具）',
  }),
  decompile: Type.Optional(
    Type.Number({
      description:
        'Ghidra 后端：反编译「最像业务入口」的 N 个函数（0 = 只做结构摘要，默认 0）。加了它耗时翻倍。APK 后端忽略此参数',
      minimum: 0,
      maximum: 20,
    }),
  ),
  dexLimit: Type.Optional(
    Type.Number({
      description:
        'APK 后端：最多解析几个 classes*.dex 的字符串池（默认 8）。大包有几十个 dex，全解会很慢',
      minimum: 1,
      maximum: 50,
    }),
  ),
})
type ProbeInputT = Static<typeof ProbeInput>

/** 结构化输出里我们真正要断言的几行——缺了就是脚本没跑对 */
const REQUIRED_KEYS = ['FORMAT=', 'ARCH=', 'FUNCTIONS=']

/**
 * 按扩展名/幻数挑后端。
 *
 * APK 只认 `.apk`（`.aab`/`.xapk` 结构不同，先如实拒绝而不是给半对的结果）；
 * 其余一律交给 Ghidra——它自己认格式，我们不重复造轮子。
 */
export function pickBackend(target: string): 'apk' | 'ghidra' {
  return /\.apk$/i.test(target) ? 'apk' : 'ghidra'
}

export interface ReverseProbeDeps {
  readonly service: ReverseService
  /** 真机验证用：换成假实现可以不装 Ghidra */
  readonly spawnProbe?: typeof runProbeScript
  /**
   * 跑脚本用的 node 可执行文件 + 环境。
   *
   * **必须由宿主注入**（`resolveNodeExec()`）：Electron 里 `process.execPath` 是
   * `electron.exe` 而不是 node，直接 spawn 会起**第二个应用**——单实例锁把它挡下后
   * 进程挂住、工具永远不返回（真机实测：会话锁 600s 后仍在等）。
   * 插件不 import 主进程（wiring ⑪），所以只能从注入点拿。
   */
  readonly resolveNode?: () => { command: string; env: Record<string, string> }
}

export function createReverseProbeToolConfig(deps: ReverseProbeDeps): MtBotToolConfig {
  return {
    name: 'reverse_probe',
    label: 'Reverse Probe',
    description:
      '对目标做静态结构分析，**两种后端自动按扩展名选**：\n' +
      '· `.apk` → 内置 APK 解析（不需要任何外部工具）：包名/版本/SDK、权限（含敏感项计数）、' +
      '组件与导出组件、dex 里的 URL 与类名、原生库与 ABI、加固与跨端框架判定、签名文件。秒级返回。\n' +
      '· 其它（PE / ELF / Mach-O）→ Ghidra headless：格式/架构/函数总数、**按能力归类的导入**、' +
      '可疑字符串、可选反编译 N 个最像业务入口的函数。**一次调用 3–5 分钟，同步等它返回**——' +
      '不要 nohup 后台起再轮询，那会重跑一遍。\n' +
      '两者都返回稳定的 `KEY=value` 文本，可直接抄进 `analysis/evidence.md`。\n' +
      '口径：能力标签只代表「导入了什么」，**不代表「它干了什么」**；' +
      'APK 的 `PACKER_SUSPECT` 只是命中特征，不是「一定是壳」的结论。',
    parameters: ProbeInput,
    category: 'filesystem' as const,
    isReadOnly: true,
    needsPermission: true,
    execute: async (_id: string, raw: unknown) => {
      const p = (raw ?? {}) as ProbeInputT
      const target = typeof p.target === 'string' ? p.target.trim() : ''
      if (!target) {
        return text({ ok: false, error: '缺少 target——要知道分析哪个文件。' })
      }

      // APK：自带实现，不依赖外部工具链，也不受「扩展没开」以外的影响
      if (pickBackend(target) === 'apk') {
        const dexLimit = Number.isFinite(p.dexLimit) ? Math.max(1, Math.min(50, p.dexLimit!)) : 8
        const r = probeApkFile(path.resolve(target), { dexLimit })
        if (!r.ok) return text({ ok: false, error: `APK 解析失败：${r.error}` })
        return { content: [{ type: 'text' as const, text: r.text }], details: undefined }
      }

      const ghidra = deps.service.backends().find((b) => b.id === 'ghidra')
      if (!ghidra?.path) {
        // 缺工具是**正常状态**，不是错误：如实说清缺什么、怎么办，别让模型以为文件有问题
        return text({
          ok: false,
          error:
            '本机没找到 Ghidra（reverse 扩展已启用，但工具链缺失）。' +
            (ghidra?.hint ?? '') +
            '\n没有 Ghidra 也能继续：按 references/desktop.md §7 做 Triage（文件头 / 字符串 / 导入表）。' +
            '\n（如果目标是 APK，用 .apk 扩展名调用——APK 后端是内置的，不需要 Ghidra。）',
        })
      }
      const decompose = Number.isFinite(p.decompile) ? Math.max(0, Math.min(20, p.decompile!)) : 0
      const runner = deps.spawnProbe ?? runProbeScript
      try {
        const out = await runner({
          scriptsDir: deps.service.scriptsDir(),
          target: path.resolve(target),
          decompile: decompose,
          resolveNode: deps.resolveNode,
        })
        if (!out.ok) {
          return text({ ok: false, error: out.error })
        }
        const missing = REQUIRED_KEYS.filter((k) => !out.stdout.includes(k))
        if (missing.length > 0) {
          // 「跑完了但没有预期输出」比直接报错更危险：模型会拿半截输出当结论
          return text({
            ok: false,
            error: `探针跑完了但输出缺少 ${missing.join(' / ')}，可能脚本没真正执行。原始尾部：\n${out.stdout.slice(-600)}`,
          })
        }
        return { content: [{ type: 'text' as const, text: out.stdout }], details: undefined }
      } catch (err) {
        return text({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }
}

function text(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    details: undefined,
    isError: true,
  }
}

export interface ProbeRunResult {
  readonly ok: boolean
  readonly stdout: string
  readonly error?: string
}

/**
 * 跑一次探针。**同步等到结束**（工具调用本来就是一个动作，超时交给 Agent 的 bash 预算）。
 *
 * 单独抽出来是为了能测：`createReverseProbeToolConfig` 的依赖注入点可以直接换掉它，
 * 不装 Ghidra 也能断言「缺工具时怎么报」。
 */
export function runProbeScript(opts: {
  scriptsDir: string
  target: string
  decompile: number
  resolveNode?: () => { command: string; env: Record<string, string> }
}): Promise<ProbeRunResult> {
  return new Promise((resolve) => {
    const script = path.join(opts.scriptsDir, 'reverse-probe.mjs')
    const args = [script, opts.target]
    if (opts.decompile > 0) args.push('--decompile', String(opts.decompile))
    // 没注入就退到 `process.execPath`——这在**纯 Node 测试环境**下是对的；
    // 在 Electron 里会起第二个应用（见 ReverseProbeDeps.resolveNode 的注释）。
    const node = opts.resolveNode?.()
    const command = node?.command ?? process.execPath
    const child = spawn(command, args, {
      windowsHide: true,
      env: node?.env ? { ...process.env, ...node.env } : process.env,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8')
    })
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8')
    })
    child.on('error', (err) => resolve({ ok: false, stdout, error: err.message }))
    child.on('close', (code) => {
      if (code === 0) return resolve({ ok: true, stdout })
      // stderr 里最有信息量的是最后几行（前面是 Ghidra 的 classpath 噪声）
      const tail = stderr.split(/\r?\n/).filter(Boolean).slice(-6).join('\n')
      resolve({ ok: false, stdout, error: `探针失败（退出码 ${code}）：\n${tail || stderr.slice(-600)}` })
    })
  })
}
