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
import { runAlign, runNormalize, runPack, runSheetCheck, runSlice } from './toolchain.js'

const USAGE = `pet-asset —— 宠物素材工具链

用法：
  pet-asset dir                                       打印用户宠物目录
  pet-asset cutout   <输入图> <输出图> [选项]          连通性抠底
  pet-asset slice    <输入图> <输出目录> [选项]        网格切分（用于直出图集）
  pet-asset align    <图片目录> [选项]                 报告地线对齐落位（只读）
  pet-asset normalize <图片目录> <输出目录> [选项]     归一化到目标画布（缩放 + 按锚点落位）
  pet-asset pack     <图片目录> <输出目录> [选项]      打包成图集
  pet-asset sheetcheck <出图文件> [选项]               出图闸门（切图之前判质量）
  pet-asset validate <包目录>                          只读校验，报出全部问题
  pet-asset install  <包目录> [--target <目录>]        校验通过才搬运

cutout 选项：
  --bg <#rrggbb>   指定背景色；省略则自动估计（推荐省略，AI 出图底色会漂）
  --tSolid <n>     flood fill 容差；省略则自动调参
  --tLow <n>       直接判透明的距离阈值（默认 25）

slice 选项：
  --cols <n> --rows <n>        网格行列数
  --cellWidth <n> --cellHeight <n>  或直接给格宽/格高
  --prefix <s>                 输出文件名前缀（默认取输入文件名）

align 选项：
  --baseline bottom|top|center 垂直对齐基准（默认 bottom，即地线）

normalize 选项：
  --w <n> --h <n>        目标画布尺寸（清单里的 canvas）
  --anchorX <n> --anchorY <n>  锚点，默认 (w/2, h-2) 即脚底中心
  --fit <n>              角色高度占画布高度的比例（默认 0.94）

pack 选项：
  --cols <n>       每行最多几格（默认 8）
  --padding <n>    格子留白（默认 0）
  --align          打包前先按地线对齐（直出图集建议开）
  --name <s>       输出文件名（不含扩展名，默认 atlas）

sheetcheck 选项：
  --cols <n> --rows <n>   声明的网格行列数（默认 2×2）
                          判据见 packages/pet-asset/src/sheetcheck.ts 头注释

全局选项：
  --json           以 JSON 输出结果
  -h, --help       显示本帮助

环境变量：
  PET_MODELS_DIR   覆盖用户宠物目录（优先级高于默认，低于 --target）
  LUMII_CLIENT_DATA_DIR  覆盖客户端数据根（默认 ~/.lumii）
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

/** 取一个数值型 flag；不是数字就报用法错（静默忽略会让命令跑出意外结果） */
function numArg(v: string | true | undefined, name: string): number | undefined {
  if (typeof v !== 'string') return undefined
  const n = Number(v)
  if (!Number.isFinite(n)) fail(`--${name} 不是数字：${v}`)
  return n
}

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
      const result = await runCutout(resolve(input), resolve(output), {
        bg: typeof bg === 'string' ? bg : undefined,
        tSolid: numArg(args.flags.get('tSolid'), 'tSolid'),
        tLow: numArg(args.flags.get('tLow'), 'tLow'),
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

    case 'slice': {
      const [input, outDir] = args.positional
      if (!input || !outDir) fail('slice 需要 <输入图> <输出目录>')
      const prefix = args.flags.get('prefix')
      const r = await runSlice(resolve(input), resolve(outDir), {
        cols: numArg(args.flags.get('cols'), 'cols'),
        rows: numArg(args.flags.get('rows'), 'rows'),
        cellWidth: numArg(args.flags.get('cellWidth'), 'cellWidth'),
        cellHeight: numArg(args.flags.get('cellHeight'), 'cellHeight'),
        prefix: typeof prefix === 'string' ? prefix : undefined,
      })
      if (json) {
        console.log(JSON.stringify(r, null, 2))
      } else {
        console.log(`✓ 切分完成 → ${r.outDir}`)
        console.log(`  源图 ${r.source.w}×${r.source.h}，切出 ${r.cells.length} 格`)
        for (const c of r.cells) {
          console.log(`  r${c.row}c${c.col}  ${c.w}×${c.h} @ (${c.x},${c.y})`)
        }
      }
      return 0
    }

    case 'align': {
      const dir = args.positional[0]
      if (!dir) fail('align 需要一个图片目录参数')
      const baseline = args.flags.get('baseline')
      const r = await runAlign(resolve(dir), {
        baseline: typeof baseline === 'string' ? (baseline as 'bottom' | 'top' | 'center') : undefined,
      })
      if (json) {
        console.log(JSON.stringify(r, null, 2))
      } else {
        console.log(`✓ 对齐分析（只读）：${r.input}`)
        console.log(`  公共画布 ${r.canvas.w}×${r.canvas.h}，参与基准的帧 ${r.alignedCount}/${r.placements.length}`)
        for (const p of r.placements) {
          console.log(
            `  ${p.name.padEnd(20)} 落位 (${p.x},${p.y}) ${p.width}×${p.height}` +
              (p.bbox ? `  包围盒 ${p.bbox.w}×${p.bbox.h}` : '  （全透明，不参与基准）'),
          )
        }
      }
      return 0
    }

    case 'normalize': {
      const [dir, outDir] = args.positional
      if (!dir || !outDir) fail('normalize 需要 <图片目录> <输出目录>')
      const w = numArg(args.flags.get('w'), 'w')
      const h = numArg(args.flags.get('h'), 'h')
      const ax = numArg(args.flags.get('anchorX'), 'anchorX')
      const ay = numArg(args.flags.get('anchorY'), 'anchorY')
      if (!w || !h) fail('normalize 需要 --w 与 --h（目标画布尺寸）')
      const r = await runNormalize(resolve(dir), resolve(outDir), {
        canvas: { w, h },
        anchor: [ax ?? Math.floor(w / 2), ay ?? h - 2],
        fit: numArg(args.flags.get('fit'), 'fit'),
      })
      if (json) {
        console.log(JSON.stringify(r, null, 2))
      } else {
        console.log(`✓ 归一化完成 → ${r.outDir}`)
        console.log(`  ${r.count} 张 → ${r.canvas.w}×${r.canvas.h}，共同倍率 ${r.scale.toFixed(4)}`)
        if (r.clipped.length > 0) {
          console.log(`  ! ${r.clipped.length} 张被裁：${r.clipped.join(', ')}（检查 --fit 或素材）`)
        }
      }
      return r.clipped.length === 0 ? 0 : 1
    }

    case 'pack': {
      const [dir, outDir] = args.positional
      if (!dir || !outDir) fail('pack 需要 <图片目录> <输出目录>')
      const name = args.flags.get('name')
      const r = await runPack(resolve(dir), resolve(outDir), {
        maxCols: numArg(args.flags.get('cols'), 'cols'),
        padding: numArg(args.flags.get('padding'), 'padding'),
        align: args.flags.get('align') === true ? {} : false,
        name: typeof name === 'string' ? name : undefined,
      })
      if (json) {
        console.log(JSON.stringify(r, null, 2))
      } else {
        console.log(`✓ 打包完成 → ${r.atlas}`)
        console.log(
          `  ${r.entryCount} 个条目，图集 ${r.size.w}×${r.size.h}` +
            `${r.aligned ? '（已按地线对齐）' : ''}`,
        )
        console.log(`  索引 ${r.atlasJson}`)
        console.log(`  往返自检（用运行时解析器读回）：${r.roundTripOk ? '通过' : '✗ 失败'}`)
      }
      return r.roundTripOk ? 0 : 1
    }

    case 'sheetcheck': {
      const [input] = args.positional
      if (!input) fail('sheetcheck 需要 <出图文件>')
      const cols = numArg(args.flags.get('cols'), 'cols') ?? 2
      const rows = numArg(args.flags.get('rows'), 'rows') ?? 2
      const r = await runSheetCheck(resolve(input), { cols, rows })
      if (json) {
        console.log(JSON.stringify(r, null, 2))
      } else {
        console.log(`=== 出图闸门 ===`)
        console.log(
          `  ${input}  实际 ${r.source.w}×${r.source.h}（${r.source.format}）` +
            ` → ${cols}×${rows} 格，每格 ${r.grid.cellW}×${r.grid.cellH}`,
        )
        if (!r.divisible) console.log('  ⚠ 尺寸不能被网格整除，各格大小不一')
        console.log('')
        for (const c of r.cells) {
          const bb = c.bbox ? `${c.bbox.w}×${c.bbox.h}` : '（空）'
          const edge = (v: number): string => (v >= 0.9 ? '线' : v > 0 ? `${(v * 100).toFixed(0)}%` : '净')
          console.log(
            `  第${c.index + 1}格  底色 ${c.background}  tSolid=${c.tSolid}` +
              `${c.leakAt !== null ? `（泄漏点 ${c.leakAt}）` : ''}  角色 ${bb}` +
              `  偏移 ${(c.centerOffset * 100).toFixed(0)}%  边[上${edge(c.edges.top)} 下${edge(c.edges.bottom)} 左${edge(c.edges.left)} 右${edge(c.edges.right)}]`,
          )
        }
        console.log('')
        const mark = (v: boolean): string => (v ? '✓' : '✗')
        console.log(`  S1 边界干净     ${mark(r.s1)}`)
        console.log(`  S2 格内对中     ${mark(r.s2)}`)
        console.log(
          `  S4 同一只角色   ${mark(r.s4)}   最低双向重合 ${(r.minPaletteOverlap * 100).toFixed(0)}%`,
        )
        console.log(
          `  S6 连续性       ${mark(r.s6)}   相邻差中位数 ${r.baselineDiff.toFixed(1)}，首尾差 ${r.loopDiff.toFixed(1)}`,
        )
        console.log(`  S8 底色安全     ${mark(r.s8)}   到角色色最近 ${r.bgDistance.toFixed(0)}`)
        console.log('')
        console.log(
          `  判定：${
            { ok: '✓ 全部通过', suspect: '◐ 还能用，但有判据没过（见下）', unusable: '✗ 不可用，重出这一批' }[
              r.verdict
            ]
          }`,
        )
        for (const p of r.problems) console.log(`  · ${p}`)
      }
      return r.verdict === 'unusable' ? 1 : 0
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
