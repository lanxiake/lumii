/**
 * pet-asset CLI
 *
 *   pet-asset dir                               打印用户宠物目录
 *   pet-asset validate <包目录>                  只读校验，报出全部问题
 *   pet-asset install  <包目录> [--target <目录>] 校验通过才搬运（两段式安装）
 *   pet-asset cutout   <输入图> <输出图> [--bg #rrggbb] [--tSolid N] [--tLow N]
 *
 * 全局：`--json` 输出机器可读结果（供 Agent 与脚本消费）。
 * 退出码：0 成功 / 1 校验未通过或执行失败 / 2 用法错误。
 */

import { resolve } from 'node:path'
import { resolveUserPetDir } from './paths.js'
import { runCutout, runInstall, runValidate } from './commands.js'
import { describeBackground } from './commands.js'

const USAGE = `pet-asset —— 宠物素材工具链

用法：
  pet-asset dir                                       打印用户宠物目录
  pet-asset validate <包目录>                          只读校验，报出全部问题
  pet-asset install  <包目录> [--target <目录>]        校验通过才搬运
  pet-asset cutout   <输入图> <输出图> [选项]          连通性抠底

cutout 选项：
  --bg <#rrggbb>   指定背景色；省略则自动估计（推荐省略，AI 出图底色会漂）
  --tSolid <n>     flood fill 容差；省略则自动调参
  --tLow <n>       直接判透明的距离阈值（默认 25）

全局选项：
  --json           以 JSON 输出结果
  -h, --help       显示本帮助

环境变量：
  PET_MODELS_DIR   覆盖用户宠物目录（优先级高于平台默认，低于 --target）
`

interface Args {
  command: string
  positional: string[]
  flags: Map<string, string | true>
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [key, inline] = a.slice(2).split('=', 2)
      if (inline !== undefined) {
        flags.set(key, inline)
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags.set(key, argv[++i])
      } else {
        flags.set(key, true)
      }
    } else if (a.startsWith('-') && a.length > 1) {
      flags.set(a.slice(1), true)
    } else {
      positional.push(a)
    }
  }
  return { command: positional.shift() ?? '', positional, flags }
}

const wantJson = (args: Args) => args.flags.get('json') === true

function fail(message: string): never {
  console.error(`错误：${message}`)
  process.exit(2)
}

function reportErrors(errors: { path: string; message: string }[]): void {
  for (const e of errors) console.error(`  ✗ ${e.path ? e.path + '：' : ''}${e.message}`)
}

function reportWarnings(warnings: { path: string; message: string }[]): void {
  for (const w of warnings) console.error(`  ! ${w.path ? w.path + '：' : ''}${w.message}`)
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const json = wantJson(args)

  if (!args.command || args.flags.get('help') === true || args.flags.get('h') === true) {
    console.log(USAGE)
    return args.command ? 0 : 2
  }

  switch (args.command) {
    case 'dir': {
      const dir = resolveUserPetDir()
      if (json) console.log(JSON.stringify({ dir }, null, 2))
      else console.log(dir)
      return 0
    }

    case 'validate': {
      const dir = args.positional[0]
      if (!dir) fail('validate 需要一个包目录参数')
      const result = await runValidate(resolve(dir))
      if (json) {
        console.log(JSON.stringify(result, null, 2))
      } else if (result.ok) {
        console.log(`✓ 校验通过：${result.pkgDir}`)
        if (result.atlasInfo) {
          console.log(
            `  图集 ${result.atlasInfo.width}×${result.atlasInfo.height}，` +
              `最小 alpha ${result.atlasInfo.minAlpha}（已抠底）`,
          )
        }
        reportWarnings(result.warnings)
      } else {
        console.error(`✗ 校验未通过：${result.pkgDir}`)
        reportErrors(result.errors)
        reportWarnings(result.warnings)
      }
      return result.ok ? 0 : 1
    }

    case 'install': {
      const dir = args.positional[0]
      if (!dir) fail('install 需要一个包目录参数')
      const targetFlag = args.flags.get('target')
      const target = resolveUserPetDir(typeof targetFlag === 'string' ? targetFlag : undefined)
      const result = await runInstall(resolve(dir), target)

      if (json) {
        console.log(JSON.stringify({ ...result, target }, null, 2))
      } else if (result.ok && result.install) {
        console.log(`✓ 已安装到 ${result.install.installedDir}`)
        console.log(`  注册表：${result.install.registryPath}`)
        for (const r of result.install.recovered) console.log(`  · ${r}`)
        reportWarnings(result.validation.warnings)
      } else if (result.error) {
        console.error(`✗ 搬运失败，已回滚：${result.error}`)
        console.error('  用户目录保持安装前状态。')
      } else {
        console.error(`✗ 校验未通过，未写入任何文件：${result.validation.pkgDir}`)
        reportErrors(result.validation.errors)
        reportWarnings(result.validation.warnings)
      }
      return result.ok ? 0 : 1
    }

    case 'cutout': {
      const [input, output] = args.positional
      if (!input || !output) fail('cutout 需要 <输入图> <输出图> 两个参数')
      const bg = args.flags.get('bg')
      const tSolid = args.flags.get('tSolid')
      const tLow = args.flags.get('tLow')
      const num = (v: string | true | undefined): number | undefined => {
        if (typeof v !== 'string') return undefined
        const n = Number(v)
        if (!Number.isFinite(n)) fail(`参数不是数字：${v}`)
        return n
      }
      const result = await runCutout(resolve(input), resolve(output), {
        bg: typeof bg === 'string' ? bg : undefined,
        tSolid: num(tSolid),
        tLow: num(tLow),
      })

      if (json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.log(`✓ 抠底完成 → ${result.output}`)
        console.log(
          `  底色 ${describeBackground(result.background)}` +
            `（${result.backgroundSource === 'estimated' ? '自动估计' : '指定'}）` +
            `，容差 ${result.tuning.tSolid}`,
        )
        console.log(
          `  不透明 ${result.opaqueCount} 像素，半透明 ${result.semiCount} 像素，` +
            `残留背景 ${(result.residualRatio * 100).toFixed(2)}%`,
        )
        if (result.bbox) {
          console.log(
            `  主体包围盒 ${result.bbox.w}×${result.bbox.h} @ (${result.bbox.x}, ${result.bbox.y})`,
          )
        }
      }
      for (const w of result.warnings) console.error(`  ! ${w}`)
      return result.bbox ? 0 : 1
    }

    default:
      console.error(`未知子命令：${args.command}`)
      console.error(USAGE)
      return 2
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`错误：${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
