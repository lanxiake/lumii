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
import { probeAabFile } from './aab-probe'
import { probeIpaFile } from './ipa-probe'
import { findElectronAsar, extractAsar, probeAsarFile, readAsarEntry } from './asar-probe'

const ProbeInput = Type.Object({
  target: Type.String({
    description:
      '目标文件绝对路径。支持 PE / ELF / Mach-O（需 Ghidra）、.apk / .xapk / .apks（内置解析）、' +
      '.ipa（内置解析）、.asar / Electron 应用目录或 exe（内置解析，无需 Ghidra）。' +
      '.aab：manifest 是 protobuf，本工具自带解码器（只取字符串字段），dex 与 APK 完全相同。' +
      '不产出 APK、不做签名、不合并分包——要安装形态仍然用 bundletool',
  }),
  decompile: Type.Optional(
    Type.Number({
      description:
        'Ghidra 后端：反编译「最像业务入口」的 N 个函数（0 = 只做结构摘要，默认 0）。加了它耗时翻倍。APK / IPA / asar 后端忽略此参数',
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
  verify: Type.Optional(
    Type.Boolean({
      description:
        'asar 后端：是否逐条目核 SHA256（默认 true）。关掉快几秒，但就失去唯一一个客观判据',
    }),
  ),
  extractTo: Type.Optional(
    Type.String({
      description:
        'asar 后端：把内层资产解到这个目录（工作区相对或绝对路径）。给了就解包并列出产物；' +
        '不给只做结构摘要。默认跳过 node_modules（几万个文件，几乎不是要找的东西）',
    }),
  ),
  includeDeps: Type.Optional(
    Type.Boolean({
      description: 'asar 后端：解包时是否连 node_modules 一起解（默认 false）',
    }),
  ),
  read: Type.Optional(
    Type.String({
      description:
        'asar 后端：读容器内**单个文件**的内容（如 "out/main/index.js"，先看不带 read 的 APP_FILES 清单）。' +
        '只读文本，上限 512KB；二进制会明确拒绝。**不要**自己写脚本解析 asar 头——偏移容易读错',
    }),
  ),
})
type ProbeInputT = Static<typeof ProbeInput>

/** 结构化输出里我们真正要断言的几行——缺了就是脚本没跑对 */
const REQUIRED_KEYS = ['FORMAT=', 'ARCH=', 'FUNCTIONS=']

/**
 * 按扩展名挑后端。
 *
 * `.apk` / `.xapk` / `.apks` / `.aab` / `.ipa` 都交给内置解析（不需要任何外部工具）：
 * - `.aab` 的 manifest 是 protobuf（`Resources.proto` 的 XmlNode），自带一个最小解码器就能读；
 *   dex 与 APK 里的完全一样，所以 URL / 类名 / 方法名都可用；
 * - `.ipa` 用同一套 zip 读取 + 自己的 plist/Mach-O 解析。
 * 其余一律交给 Ghidra：它自己认格式，我们不重复造轮子。
 */
export function pickBackend(target: string): 'apk' | 'ipa' | 'aab' | 'ghidra' {
  if (/\.ipa$/i.test(target)) return 'ipa'
  if (/\.aab$/i.test(target)) return 'aab'
  return /\.(apk|xapk|apks)$/i.test(target) ? 'apk' : 'ghidra'
}

/**
 * 在 `pickBackend` 之上补一次**文件系统探测**：Electron 应用的 exe 按扩展名是 `ghidra`，
 * 但同目录 `resources/app.asar` 才是业务代码所在。先认它，省掉 4 分钟反编译一个外壳。
 *
 * 只对「本来是 ghidra」的目标探测，APK/IPA 不做多余 IO。
 */
export function resolveBackend(target: string): 'apk' | 'ipa' | 'aab' | 'asar' | 'ghidra' {
  const base = pickBackend(target)
  if (base !== 'ghidra') return base
  return findElectronAsar(target) ? 'asar' : 'ghidra'
}

export interface ReverseProbeDeps {
  readonly service: ReverseService
  /** 真机验证用：换成假实现可以不装 Ghidra */
  readonly spawnProbe?: typeof runProbeScript
  /** 解包目标目录里相对路径的基准（工作区根）。缺省退回 `process.cwd()` */
  readonly resolveWorkspaceDir?: () => string
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
      '对目标做静态结构分析，**四种后端自动按扩展名/文件系统选**：\n' +
      '· `.apk` / `.xapk` / `.apks` → 内置 APK 解析（不需要任何外部工具）：包名/版本/SDK、权限（含敏感项）、' +
      '组件与导出组件、dex 里的 URL 与类名、原生库与 ABI、加固与跨端框架判定、签名文件。秒级返回。\n' +
      '· `.aab`（App Bundle）→ 内置 AAB 解析：manifest 是 protobuf，工具自带最小解码器读字符串字段；' +
      '**dex 与 APK 里的完全一样**，所以 URL / 类名 / 方法名都可用；另列模块与原生库。秒级返回。' +
      '不产出 APK、不合并分包——要安装形态仍用 bundletool。\n' +
      '· `.ipa` → 内置 IPA 解析：bundle id/版本/最低 iOS、权限用途说明、框架、' +
      'Mach-O 加密状态（cryptid）、描述文件团队与过期时间。秒级返回。\n' +
      '· `.asar`，**或任何路径的同目录/上级有 `resources/app.asar`**（Electron 套壳）→ 内置 asar 解析：' +
      '应用名/版本/main、文件清单（按体积降序，node_modules 单列）、sourcemap 数、' +
      '**逐条目 SHA256 核对**（`BYTES_VERIFIED=n/n`，这是解包层唯一的客观判据）。秒级返回。\n' +
      '  Electron 应用优先走这条——Ghidra 看 Electron 的 exe 只是反编译一个 Chromium 外壳，' +
      '真正的业务代码在 asar 里。\n' +
      '· 其它（PE / ELF / Mach-O）→ Ghidra headless：格式/架构/函数总数、**按能力归类的导入**、' +
      '可疑字符串、可选反编译 N 个最像业务入口的函数。**一次调用 3–5 分钟，同步等它返回**——' +
      '不要 nohup 后台起再轮询，那会重跑一遍。\n' +
      '都返回稳定的 `KEY=value` 文本，可直接抄进 `analysis/evidence.md`。\n' +
      '口径：能力标签只代表「导入了什么」，**不代表「它干了什么」**；' +
      'APK/AAB 的 `PACKER_SUSPECT` 只是命中特征，不是「一定是壳」的结论；' +
      'asar 的 `BYTES_VERIFIED` 只证明「字节读对了」，不证明「业务逻辑读懂了」。',
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

      // APK / IPA / asar：自带实现，不依赖外部工具链
      const backend = resolveBackend(target)
      if (backend === 'apk') {
        const dexLimit = Number.isFinite(p.dexLimit) ? Math.max(1, Math.min(50, p.dexLimit!)) : 8
        const r = probeApkFile(path.resolve(target), { dexLimit })
        if (!r.ok) return text({ ok: false, error: `APK 解析失败：${r.error}` })
        return { content: [{ type: 'text' as const, text: r.text }], details: undefined }
      }
      if (backend === 'ipa') {
        const r = probeIpaFile(path.resolve(target))
        if (!r.ok) return text({ ok: false, error: `IPA 解析失败：${r.error}` })
        return { content: [{ type: 'text' as const, text: r.text }], details: undefined }
      }
      if (backend === 'aab') {
        const dexLimit = Number.isFinite(p.dexLimit) ? Math.max(1, Math.min(50, p.dexLimit!)) : 8
        const r = probeAabFile(path.resolve(target), { dexLimit })
        if (!r.ok) return text({ ok: false, error: `AAB 解析失败：${r.error}` })
        return { content: [{ type: 'text' as const, text: r.text }], details: undefined }
      }
      if (backend === 'asar') {
        const asarPath = findElectronAsar(target)
        if (!asarPath) return text({ ok: false, error: `找不到 Electron 的 app.asar：${target}` })
        // 只读单文件：不跑完整探针，省掉一遍 SHA256 全量核对
        if (p.read?.trim()) {
          const rd = readAsarEntry(asarPath, p.read.trim())
          if (!rd.ok) return text({ ok: false, error: `读 ${p.read.trim()} 失败：${rd.error}` })
          return { content: [{ type: 'text' as const, text: rd.text }], details: undefined }
        }
        const r = probeAsarFile(asarPath, { verify: p.verify !== false })
        if (!r.ok) return text({ ok: false, error: `asar 解析失败：${r.error}` })
        if (!p.extractTo?.trim()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `${r.text}\n\n提示：加 extractTo（如 "projects/_reverse/<slug>/unpacked"）可把内层资产解出来。`,
              },
            ],
            details: undefined,
          }
        }
        const outDir = path.isAbsolute(p.extractTo.trim())
          ? p.extractTo.trim()
          : path.resolve(deps.resolveWorkspaceDir?.() ?? process.cwd(), p.extractTo.trim())
        const ex = extractAsar(asarPath, outDir, { includeDeps: p.includeDeps === true })
        if (!ex.ok) return text({ ok: false, error: `asar 解包失败：${ex.error}` })
        return {
          content: [{ type: 'text' as const, text: `${r.text}\n\n${ex.text}` }],
          details: undefined,
        }
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
