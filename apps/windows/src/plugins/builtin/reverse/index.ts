import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { app } from 'electron'
import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../../../main/kernel/events'
import { S } from '../../../main/kernel/services'
import { createReverseProbeToolConfig } from './tools'
import type { ReverseBackendStatus, ReverseService } from './service-api'

/**
 * 逆向工具链扩展（`com.lumii.reverse`）。
 *
 * ## 它管什么
 *
 * 一个工具 `reverse_probe`：把**已装的**逆向工具链（现在只有 Ghidra）接成结构化分析，
 * 让 `reverse` 技能从「strings + 导入表」进到「函数数 + 能力分类 + 反编译」。
 *
 * ## 为什么是插件，不是技能自带脚本
 *
 * 技能目录是**播种到工作区的数据**——用户能改、能删、能拷走。脚本留在那里，
 * 关掉插件也没用（Agent 照样能 `node` 它）。放进插件资产 + 做成工具后：
 *
 * - 停用 ⇒ 工具从工具表消失（`refreshAllInstanceTools()`，**运行中的会话下一轮就看不到**）；
 * - `SKILL.md` 写「有 `reverse_probe` 就用，没有就按 §7 降级」⇒ 两条路径都显式。
 *
 * ## 默认关闭
 *
 * 它会把二进制反编译成文本交给模型（`needsPermission: true` 每次弹审批）。
 * 用不到逆向的人不该被塞一个「能反编译任意 exe」的工具——所以 `defaultEnabled: false`，
 * 与 `com.lumii.pcwechat` 同一理由。
 *
 * ## 不做的事
 *
 * **不自动安装工具链**（设计 §8.4）。找不到 Ghidra 就在工具描述与返回里如实说缺什么、
 * 该装到哪；没有它时 Triage 那条路仍然可用。
 */

export const REVERSE_SERVICE_ID = 'reverse'

/** 插件资产目录：开发走源码目录，打包走 extraResources/assets（与 wechat 同族）。 */
function resolveReverseAssetsDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'assets', 'reverse')
  }
  // __dirname = apps/windows/out/main（electron-vite 构建后）
  return path.resolve(__dirname, '..', '..', 'assets', 'reverse')
}

/**
 * 找 Ghidra。顺序与 `reverse-probe.mjs` 保持一致——两处判据不同步会出现
 * 「工具说有、跑起来说没有」这种最难查的分叉。
 */
export function resolveGhidraDir(explicit?: string): string | null {
  const check = (dir: string): string | null => {
    const ok =
      fs.existsSync(path.join(dir, 'support', 'analyzeHeadless.bat')) ||
      fs.existsSync(path.join(dir, 'support', 'analyzeHeadless'))
    return ok ? dir : null
  }
  if (explicit?.trim()) return check(path.resolve(explicit.trim()))
  const env = process.env.LUMII_GHIDRA_DIR?.trim()
  if (env) return check(path.resolve(env))

  const bases = [
    'C:/myself/tools',
    path.join(process.env.USERPROFILE ?? '', 'tools'),
    path.join(os.homedir(), 'tools'),
    'C:/ghidra',
    '/opt/ghidra',
    '/usr/share/ghidra',
    '/usr/local/ghidra',
  ].filter(Boolean)
  for (const base of bases) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(base, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.toLowerCase().startsWith('ghidra')) continue
      const hit = check(path.join(base, e.name))
      if (hit) return hit
    }
  }
  return null
}

const GHIDRA_HINT =
  '装 Ghidra 并解压到 ~/tools/（目录名以 ghidra 开头），或设环境变量 LUMII_GHIDRA_DIR=<Ghidra 根目录>。' +
  '本扩展**不会自动安装**。'

function detectBackends(): ReverseBackendStatus[] {
  const ghidra = resolveGhidraDir()
  return [
    {
      id: 'ghidra',
      label: 'Ghidra',
      path: ghidra,
      targets: ['PE (.exe/.dll)', 'ELF', 'Mach-O'],
      hint: GHIDRA_HINT,
    },
    {
      // 自带实现，**没有外部依赖**——所以 path 恒为 'builtin'，永远是可用状态。
      // 这是 APK 线最实在的好处：不需要用户装 jadx/apktool，装上客户端就能用。
      id: 'apk',
      label: 'APK（内置）',
      path: 'builtin',
      targets: ['Android .apk'],
      hint: '',
    },
  ]
}

export const reverseExtension = {
  manifest: {
    id: 'com.lumii.reverse',
    name: '逆向工具链',
    version: '0.1.0',
    description:
      '把已装的逆向工具链接成结构化分析（现在支持 Ghidra）：函数数、按能力归类的导入、可疑字符串、反编译',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
    /**
     * 默认关闭：它能把任意二进制反编译成文本交给模型。用不到逆向的人不该被塞这个工具，
     * 与 `com.lumii.pcwechat` 同一理由（不是「还没做完」，所以不用 `disabled`）。
     */
    defaultEnabled: false,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.reverse',
    provides: ['reverse'],
    apply(ctx) {
      const scriptsDir = path.join(resolveReverseAssetsDir(), 'scripts', 'ghidra')
      ctx.provide(S.reverse, {
        backends: detectBackends,
        scriptsDir: () => scriptsDir,
      } satisfies ReverseService)

      /**
       * 装工具。和 pipeline / pcwechat 一样等 `agent:runtime-ready`：
       * bridge 在 S7.4 才建，`apply()` 跑在它之前。
       *
       * 工具装了但**脚本资产文件不存在**时也要如实降级——开发态忘了构建 assets
       * 比「Ghidra 没装」更隐蔽（工具会列出来，一调才失败）。
       */
      const wire = (): boolean => {
        const bridge = ctx.get(S.agentRuntime)?.get()
        if (!bridge) return false
        if (!fs.existsSync(path.join(scriptsDir, 'reverse-probe.mjs'))) {
          ctx.log.warn(`逆向探针脚本缺失（${scriptsDir}），工具仍会注册但调用会报错`)
        }
        const ex = bridge.createPipelineExecutor()
        const config = createReverseProbeToolConfig({
          service: { backends: detectBackends, scriptsDir: () => scriptsDir },
          resolveNode: ex.resolveNode,
        })
        ctx.effect(ex.registerTool(config as unknown as { name: string }))
        const ghidra = resolveGhidraDir()
        ctx.log.info(
          ghidra
            ? `逆向工具链插件已加载（Ghidra: ${ghidra}）`
            : '逆向工具链插件已加载（**未找到 Ghidra**，reverse_probe 会如实报缺）',
        )
        return true
      }

      if (!wire()) {
        ctx.on('agent:runtime-ready', () => {
          wire()
        })
      }
    },
  }),
}
