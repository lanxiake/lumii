/**
 * pet-asset-ipc — 工具链的运行时通道（主进程）
 *
 * 设计依据：docs/plans/客户端UI/2026-09-20-宠物自制系统P1实施计划.md §2.1
 *
 * ## 为什么走控制口，而不是「把 CLI 打进安装包、技能起子进程调」
 *
 * 技能的可执行入口是技能目录下的 `run.ts`，宿主用子进程执行它（`TypeScriptRunner`）。
 * 于是最直觉的做法是把 `packages/pet-asset` 的 CLI 产物作为 extraResources 打进安装包。
 * **但它不成立**：`sharp` 是原生模块，`asarUnpack` 只把它解到 `app.asar.unpacked/`，
 * 从包外的脚本 `require('sharp')` 要跨 asar 解析——dev 能跑、打包后大概率
 * `MODULE_NOT_FOUND`。P0-a 已在同类问题上栽过一次（主进程外部化 pet-core 导致启动即崩）。
 *
 * 主进程**已经**把 sharp 与 pet-core 打进去了，所以在这里跑工具链：
 *
 *   - **dev 与打包同一条路径**，不存在只在打包后才暴露的解析问题
 *   - **端点是固定的**：调用方只能选调哪个 op、传什么参数，不能注入代码
 *     （对应设计 §5.1「由固定 install 子命令校验后搬运」）
 *
 * ## 写入边界
 *
 * 工具链有写盘操作，而 Agent 侧的写权限按设计只能到 `workspace/outputs/`。
 * 所以这里对**所有输出路径**做一次根目录校验，`install` 的目标另按用户宠物目录放行。
 * 校验在 `resolve()` 之后做前缀比对，不吃「`..` 绕过」那一套。
 */

import { resolve, sep } from 'node:path'
import {
  resolveUserPetDir,
  runAlign,
  runCutout,
  runInstall,
  runNormalize,
  runPack,
  runSlice,
  runValidate,
} from '@mtbot/pet-asset'
import { resolveActiveWorkspaceDir } from '../workspace-paths'

const log = {
  info: (...args: unknown[]) => console.log('[pet-asset-ipc]', ...args),
  warn: (...args: unknown[]) => console.warn('[pet-asset-ipc]', ...args),
}

export type PetAssetOp =
  | 'validate'
  | 'install'
  | 'cutout'
  | 'slice'
  | 'align'
  | 'normalize'
  | 'pack'

const OPS: readonly PetAssetOp[] = [
  'validate',
  'install',
  'cutout',
  'slice',
  'align',
  'normalize',
  'pack',
]

export function isPetAssetOp(v: unknown): v is PetAssetOp {
  return typeof v === 'string' && (OPS as readonly string[]).includes(v)
}

/** Agent 生成物的落点：workspace/outputs */
export function resolveOutputsDir(): string {
  return resolve(resolveActiveWorkspaceDir(), 'outputs')
}

/**
 * 允许写入的根目录。
 *
 * `outputs` 是 Agent 的产物区（设计 §5.1 的边界）；用户宠物目录是 `install` 的法定目标，
 * 它本来就该被写——那是"装宠物"这件事本身。
 */
export function allowedWriteRoots(): string[] {
  return [resolveOutputsDir(), resolveUserPetDir()]
}

/**
 * 路径是否落在允许写入的根之内。
 *
 * 归一化之后再比前缀（而不是检查字符串里有没有 `..`）：符号链接、编码、
 * Windows 短名都能绕过朴素字符串检查。
 */
export function isAllowedWritePath(p: unknown): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) return false
  const abs = resolve(p)
  return allowedWriteRoots().some((root) => abs === root || abs.startsWith(root + sep))
}

/** 参数取值助手：非字符串一律视为缺参，交给下游报错 */
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

export interface PetAssetCall {
  op: PetAssetOp
  args?: Record<string, unknown>
}

export interface PetAssetResult {
  ok: boolean
  /** 成功时的工具链返回值（各 op 形状不同，与 CLI 的 --json 输出一致） */
  result?: unknown
  error?: string
}

/**
 * 执行一次工具链调用。
 *
 * **写盘前先过路径校验**：不通过就直接拒绝，不进入工具链。
 * 不抛异常——把错误包成 `{ ok: false, error }` 交给调用方判断，与其它路由的约定一致。
 */
export async function runPetAssetOp(call: PetAssetCall): Promise<PetAssetResult> {
  const a = call.args ?? {}
  try {
    switch (call.op) {
      case 'validate': {
        const dir = str(a.dir)
        if (!dir) return { ok: false, error: '缺少 dir（包目录）' }
        return { ok: true, result: await runValidate(resolve(dir)) }
      }

      case 'install': {
        const dir = str(a.dir)
        if (!dir) return { ok: false, error: '缺少 dir（包目录）' }
        const target = resolveUserPetDir(str(a.target))
        // 目标目录是 install 的法定落点，不走 outputs 那条校验；但仍要防调用方把它指到别处
        if (!isAllowedWritePath(target)) {
          return { ok: false, error: `安装目标不在允许范围内：${target}` }
        }
        return { ok: true, result: await runInstall(resolve(dir), target) }
      }

      case 'cutout': {
        const input = str(a.input)
        const output = str(a.output)
        if (!input || !output) return { ok: false, error: '缺少 input / output' }
        if (!isAllowedWritePath(output)) {
          return { ok: false, error: `输出路径不在允许范围内（只能写 workspace/outputs）：${output}` }
        }
        return {
          ok: true,
          result: await runCutout(resolve(input), resolve(output), {
            bg: str(a.bg),
            tSolid: num(a.tSolid),
            tLow: num(a.tLow),
          }),
        }
      }

      case 'slice': {
        const input = str(a.input)
        const outDir = str(a.outDir)
        if (!input || !outDir) return { ok: false, error: '缺少 input / outDir' }
        if (!isAllowedWritePath(outDir)) {
          return { ok: false, error: `输出目录不在允许范围内：${outDir}` }
        }
        return {
          ok: true,
          result: await runSlice(resolve(input), resolve(outDir), {
            cols: num(a.cols),
            rows: num(a.rows),
            cellWidth: num(a.cellWidth),
            cellHeight: num(a.cellHeight),
            prefix: str(a.prefix),
          }),
        }
      }

      case 'align': {
        const dir = str(a.dir)
        if (!dir) return { ok: false, error: '缺少 dir' }
        const baseline = str(a.baseline)
        return {
          ok: true,
          result: await runAlign(resolve(dir), {
            baseline:
              baseline === 'bottom' || baseline === 'top' || baseline === 'center'
                ? baseline
                : undefined,
          }),
        }
      }

      case 'normalize': {
        const dir = str(a.dir)
        const outDir = str(a.outDir)
        if (!dir || !outDir) return { ok: false, error: '缺少 dir / outDir' }
        if (!isAllowedWritePath(outDir)) {
          return { ok: false, error: `输出目录不在允许范围内：${outDir}` }
        }
        const canvas = a.canvas as { w?: unknown; h?: unknown } | undefined
        const w = num(canvas?.w)
        const h = num(canvas?.h)
        if (!w || !h) return { ok: false, error: '缺少 canvas: { w, h }' }
        const anchor = Array.isArray(a.anchor) ? a.anchor : undefined
        return {
          ok: true,
          result: await runNormalize(resolve(dir), resolve(outDir), {
            canvas: { w, h },
            anchor: [num(anchor?.[0]) ?? Math.floor(w / 2), num(anchor?.[1]) ?? h - 2],
            fit: num(a.fit),
          }),
        }
      }

      case 'pack': {
        const dir = str(a.dir)
        const outDir = str(a.outDir)
        if (!dir || !outDir) return { ok: false, error: '缺少 dir / outDir' }
        if (!isAllowedWritePath(outDir)) {
          return { ok: false, error: `输出目录不在允许范围内：${outDir}` }
        }
        return {
          ok: true,
          result: await runPack(resolve(dir), resolve(outDir), {
            maxCols: num(a.maxCols),
            padding: num(a.padding),
            align: a.align === true ? {} : false,
            name: str(a.name),
          }),
        }
      }

      default:
        return { ok: false, error: `未知 op：${String(call.op)}` }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`[${call.op}] 执行失败：${message}`)
    return { ok: false, error: message }
  }
}

/** 供 /pet/asset 路由用：对外只暴露"允许写哪里"，便于技能自己决定输出目录 */
export function describeRoots(): { outputs: string; userPetDir: string } {
  return { outputs: resolveOutputsDir(), userPetDir: resolveUserPetDir() }
}
