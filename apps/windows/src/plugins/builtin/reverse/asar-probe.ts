/**
 * ASAR（Electron 打包容器）静态探针 —— **纯 Node，不依赖 `asar` 命令**。
 *
 * ## 为什么在这个插件里
 *
 * 设计 `2026-11-02-P3-EXE与APP复刻设计.md` §3 把 EXE 复刻分成四层，L1 是「认出壳并解包」。
 * Electron 是唯一一层能做到**同态复刻**的壳：解出来就是 HTML/CSS/JS。而它又恰好是
 * 纯 Node 就能解的格式——先看文件头，再看同目录 `resources/`，**不需要 Ghidra**。
 *
 * Ghidra 看 Electron 的 exe 基本没有价值（那只是个 Chromium 外壳），
 * 而 asar 里才是真正的业务代码。所以对 `.exe` 先找同目录的 `resources/app.asar`，
 * 找到就走这里，几秒出结果，而不是花 4 分钟反编译一个壳。
 *
 * ## 两个静默坑（本机两个真实样本实测，见设计 §3.2）
 *
 * 1. `dataStart` 是 `8 + u32@4`（payload 长度），**不是** `8 + u32@12`（JSON 长度）。
 *    两个数在实测样本里凑巧相等，写错了照样能跑，换个包就错位。
 * 2. `unpacked:true` 的条目**不在 asar 里**，实际文件在同目录 `app.asar.unpacked/` 下。
 *    按 offset 去读会读到隔壁条目的内容——不报错，只是数据是错的。
 *
 * ## 判据是白送的
 *
 * asar 头自带每条目的 `integrity.hash`（SHA256，可按 blockSize 分块）。
 * 所以「解包成功」不是靠肉眼，靠 `BYTES_VERIFIED=n/n`——这是全仓库少数几个
 * **不需要人工判断**的完成判据。
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'

/**
 * 读 asar 必须用 `original-fs`，不能用 `node:fs`。
 *
 * Electron 把 `.asar` 注册成一个**虚拟目录**塞进 fs：
 * - `existsSync` 返回 true、
 * - `statSync` 返回 size **0**、
 * - `openSync` / `readFileSync` 对 asar 文件本身抛 `ENOENT, not found in <asar>`。
 *
 * 真机就是这样：脚本在纯 Node 里跑得好好的，一进 Electron 就 `asar 解析失败：ENOENT`。
 * `original-fs` 是 Electron 提供的未打补丁版本，读的是真实字节。
 * 纯 Node（单测环境）没有这个模块，`require` 失败就退回 `node:fs`——两边都对。
 */
const realFs: typeof fs = (() => {
  try {
    return createRequire(import.meta.url)('original-fs') as typeof fs
  } catch {
    return fs
  }
})()

export interface AsarEntry {
  /** asar 内的绝对路径，形如 `/out/main/index.js` */
  readonly path: string
  readonly size: number
  /** 相对 dataStart 的偏移；unpacked 条目没有意义 */
  readonly offset: number
  /** 实体文件在 `app.asar.unpacked/` 下，不在 asar 内 */
  readonly unpacked: boolean
  readonly algorithm?: string
  readonly blockSize?: number
  readonly blocks?: readonly string[]
}

export interface AsarHeader {
  readonly dataStart: number
  readonly entries: readonly AsarEntry[]
}

interface AsarNode {
  files?: Record<string, AsarNode>
  size?: number
  offset?: string | number
  unpacked?: boolean
  integrity?: { algorithm?: string; blockSize?: number; blocks?: string[] }
}

/**
 * 读 asar 的头（只读前 header 段，不碰数据区）。
 *
 * 真实样本上 `8 + u32@4 === 16 + u32@12`，但**只有前者是格式定义**：
 * `u32@4` 是「pickle 里 JSON 字符串的长度（8 字节对齐后）」，`u32@12` 才是 JSON 本身长度。
 */
export function readAsarHeader(buf: Buffer): AsarHeader {
  if (buf.length < 16) throw new Error('不是 asar（文件太短）')
  const payloadSize = buf.readUInt32LE(4)
  const jsonSize = buf.readUInt32LE(12)
  const dataStart = 8 + payloadSize
  if (jsonSize === 0 || dataStart > buf.length || 16 + jsonSize > buf.length) {
    throw new Error('不是 asar（头长度越界）')
  }
  let root: AsarNode
  try {
    root = JSON.parse(buf.toString('utf8', 16, 16 + jsonSize)) as AsarNode
  } catch {
    throw new Error('不是 asar（头部 JSON 解析失败）')
  }
  if (!root || typeof root !== 'object' || typeof root.files !== 'object') {
    throw new Error('不是 asar（头部缺少 files 树）')
  }
  const entries: AsarEntry[] = []
  const walk = (node: AsarNode, prefix: string): void => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const p = `${prefix}/${name}`
      if (child.files) {
        walk(child, p)
        continue
      }
      entries.push({
        path: p,
        size: Number(child.size ?? 0),
        offset: Number(child.offset ?? 0),
        unpacked: child.unpacked === true,
        algorithm: child.integrity?.algorithm,
        blockSize: child.integrity?.blockSize,
        blocks: child.integrity?.blocks,
      })
    }
  }
  walk(root, '')
  return { dataStart, entries }
}

export interface AsarVerifyResult {
  readonly verified: number
  readonly total: number
  /** 校验失败 / 无法校验的条目（只记录前若干条，避免刷屏） */
  readonly failures: readonly string[]
}

/**
 * 逐条目核 SHA256。
 *
 * `unpacked` 条目不在 asar 里，**从 asar 无法校验**——跳过但单独计数，
 * 不把它算进 `total`（否则「没核过」会被算成「核过了」）。
 */
export function verifyAsarBytes(
  fd: number,
  header: AsarHeader,
  maxFailures = 8,
): AsarVerifyResult {
  const failures: string[] = []
  let verified = 0
  let total = 0
  const buf = Buffer.allocUnsafe(1 << 20)
  for (const e of header.entries) {
    if (e.unpacked || !e.blocks?.length) continue
    total++
    const algorithm = (e.algorithm ?? 'SHA256').toLowerCase().replace('-', '')
    if (algorithm !== 'sha256') {
      if (failures.length < maxFailures) failures.push(`${e.path}: 算法 ${e.algorithm} 不支持`)
      continue
    }
    const blockSize = e.blockSize && e.blockSize > 0 ? e.blockSize : 4 * 1024 * 1024
    let ok = true
    let read = 0
    for (let i = 0; i < e.blocks.length; i++) {
      const want = Math.min(blockSize, e.size - read)
      if (want < 0) {
        ok = false
        break
      }
      const h = createHash('sha256')
      let remaining = want
      let cursor = header.dataStart + e.offset + read
      while (remaining > 0) {
        const n = Math.min(remaining, buf.length)
        const got = realFs.readSync(fd, buf, 0, n, cursor)
        if (got <= 0) {
          ok = false
          break
        }
        h.update(buf.subarray(0, got))
        remaining -= got
        cursor += got
      }
      if (!ok) break
      if (h.digest('hex') !== e.blocks[i]) {
        ok = false
        break
      }
      read += want
    }
    if (ok) verified++
    else if (failures.length < maxFailures) failures.push(`${e.path}: SHA256 不匹配`)
  }
  return { verified, total, failures }
}

export interface AsarProbeOptions {
  /** 是否逐条目核 SHA256（默认 true）。大包会多花几秒，换一个客观判据 */
  readonly verify?: boolean
}

export interface AsarProbeResult {
  readonly ok: true
  readonly text: string
}
export interface AsarProbeFailure {
  readonly ok: false
  readonly error: string
}

/** Electron 应用里 asar 的标准位置；也接受直接传 `.asar` 路径 */
export function findElectronAsar(target: string): string | null {
  const abs = path.resolve(target)
  const stat = realFs.existsSync(abs) ? realFs.statSync(abs) : null
  const candidates: string[] = []
  if (stat?.isDirectory()) {
    candidates.push(path.join(abs, 'resources', 'app.asar'), path.join(abs, 'app.asar'))
  } else if (/\.asar$/i.test(abs)) {
    candidates.push(abs)
  } else {
    // 传的是 exe：同目录 / 上一级（有些布局把 exe 放进子目录）
    const dir = path.dirname(abs)
    candidates.push(
      path.join(dir, 'resources', 'app.asar'),
      path.join(dir, '..', 'resources', 'app.asar'),
    )
  }
  return candidates.find((c) => realFs.existsSync(c)) ?? null
}

function readJsonEntry(fd: number, header: AsarHeader, want: string): unknown {
  const e = header.entries.find((x) => x.path === want)
  if (!e || e.unpacked) return null
  if (e.size > 4 * 1024 * 1024) return null
  const buf = Buffer.allocUnsafe(e.size)
  realFs.readSync(fd, buf, 0, e.size, header.dataStart + e.offset)
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    return null
  }
}

/** 应用自身代码（非 node_modules），按大小降序——判断「业务在哪」最快 */
function appSourceFiles(entries: readonly AsarEntry[], limit = 25): AsarEntry[] {
  return entries
    .filter((e) => !e.path.startsWith('/node_modules/'))
    .sort((a, b) => b.size - a.size)
    .slice(0, limit)
}

export function probeAsarFile(
  filePath: string,
  opts: AsarProbeOptions = {},
): AsarProbeResult | AsarProbeFailure {
  try {
    const abs = path.resolve(filePath)
    if (!realFs.existsSync(abs)) return { ok: false, error: `文件不存在：${abs}` }
    const fd = realFs.openSync(abs, 'r')
    try {
      const fileSize = realFs.fstatSync(fd).size
      const head = Buffer.allocUnsafe(Math.min(fileSize, 64 * 1024 * 1024))
      realFs.readSync(fd, head, 0, head.length, 0)
      const header = readAsarHeader(head)
      const lines: string[] = []
      const push = (k: string, v: unknown): void => {
        lines.push(`${k}=${String(v)}`)
      }

      push('PROGRAM', 'asar')
      push('FRAMEWORK', 'Electron')
      push('ASAR_PATH', abs)
      push('ASAR_BYTES', fileSize)
      push('ENTRIES', header.entries.length)
      const unpackedEntries = header.entries.filter((e) => e.unpacked)
      push('UNPACKED', unpackedEntries.length)
      if (unpackedEntries.length > 0) {
        push(
          'UNPACKED_DIR',
          realFs.existsSync(`${abs}.unpacked`) ? `${abs}.unpacked` : 'MISSING（条目声明了 unpacked 但目录不存在）',
        )
      }

      const pkg = readJsonEntry(fd, header, '/package.json') as
        | { name?: string; version?: string; main?: string; description?: string }
        | null
      push('APP_NAME', pkg?.name ?? 'UNKNOWN')
      push('APP_VERSION', pkg?.version ?? 'UNKNOWN')
      push('APP_MAIN', pkg?.main ?? 'UNKNOWN')
      if (pkg?.description) push('APP_DESCRIPTION', pkg.description)

      const top = new Set(
        header.entries.map((e) => e.path.split('/').filter(Boolean)[0] ?? '').filter(Boolean),
      )
      push('TOP_LEVEL', [...top].join(','))

      const sources = appSourceFiles(header.entries)
      const appFiles = header.entries.filter((e) => !e.path.startsWith('/node_modules/'))
      push('APP_FILE_COUNT', appFiles.length)
      lines.push('--- APP_FILES（非 node_modules，按大小降序，最多 25 条）---')
      for (const e of sources) lines.push(`${e.path}  ${e.size}${e.unpacked ? '  [unpacked]' : ''}`)

      // 只数应用自身的 sourcemap：node_modules 里的 .map 是依赖自带的，
      // 混进来会让「这个应用能不能读源码」这个判断彻底失真
      const appMaps = appFiles.filter((e) => e.path.endsWith('.map'))
      push(
        'APP_SOURCEMAPS',
        appMaps.length === 0 ? '0（业务代码是压缩产物，只能读结构）' : `${appMaps.length}`,
      )
      push('DEP_SOURCEMAPS', header.entries.filter((e) => e.path.endsWith('.map')).length - appMaps.length)

      if (opts.verify !== false) {
        const v = verifyAsarBytes(fd, header)
        push('BYTES_VERIFIED', `${v.verified}/${v.total}`)
        push('BYTES_UNVERIFIABLE', `${unpackedEntries.length} 个 unpacked 条目不在 asar 内，无法从 asar 校验`)
        if (v.failures.length > 0) {
          lines.push('--- VERIFY_FAILED ---')
          for (const f of v.failures) lines.push(f)
        }
      } else {
        push('BYTES_VERIFIED', 'skipped（verify:false）')
      }

      lines.push(
        '--- 口径 ---',
        '整合性由 asar 头自带的 SHA256 核对；BYTES_VERIFIED 不等于条目总数时，差的就是 unpacked 条目。',
        '这是**解包层的判据**：它能证明「字节读对了」，不证明「业务逻辑读懂了」。',
        '要读 JS 代码看 out/ 下的 bundle；没有 sourcemap 的压缩产物只能读字符串与结构。',
      )
      return { ok: true, text: lines.join('\n') }
    } finally {
      realFs.closeSync(fd)
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
