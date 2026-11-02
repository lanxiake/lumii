/**
 * IPA 静态结构探针（**纯 Node，不依赖 macOS 工具**）。
 *
 * ## 边界（先写清楚，免得越界给假结论）
 *
 * 能拿到：bundle id / 版本 / 最低系统版本、URL scheme、**权限用途说明**（`NS*UsageDescription`
 * 的取值本身就是它申请了哪些能力）、URL scheme 与查询域、框架清单（Flutter/RN/Unity/Electron）、
 * 加密状态（`LC_ENCRYPTION_INFO` 的 cryptid）、描述文件的团队与过期时间。
 *
 * 拿不到：**Mach-O 反汇编**（那需要 Ghidra 且本机 Ghidra 不认 iOS 的 arm64e 变体，
 * 也不该在这里硬做）、**代码签名核验**（需要 `codesign`，非 macOS 平台没有）。
 * 这两条如实写 UNRESOLVED，不猜。
 */
import * as fs from 'node:fs'

import { extractEntry, readZipDirectory, type ZipEntryInfo } from './apk-probe'

// 复用 apk-probe 的 zip 读取：IPA 与 APK 都是标准 zip，没有理由写第二份
export type { ZipEntryInfo }

/** 极简二进制 plist（bplist00）读取——只为拿 Info.plist 的顶层标量。 */
export interface PlistScalars {
  readonly [key: string]: string | number | boolean
}

const BPLIST_MAGIC = 'bplist00'

/** Node 没有 `utf16be` 编码：按字节交换后用 `utf16le` 解 */
function decodeUtf16Be(buf: Buffer): string {
  const swapped = Buffer.from(buf)
  swapped.swap16()
  return swapped.toString('utf16le')
}

/**
 * 解析二进制 plist 的**顶层字典**，只取标量（string/int/bool/real）。
 *
 * 刻意不实现「任意嵌套」：Info.plist 里我们需要的（CFBundleIdentifier、
 * MinimumOSVersion、NS*UsageDescription 等）都是顶层标量。数组/字典一律跳过并记一笔，
 * 硬解全部类型只会让代码翻几倍而收益接近零。
 */
export function parseBinaryPlistScalars(buf: Buffer): { scalars: PlistScalars; skipped: number } {
  if (buf.length < 40 || buf.toString('ascii', 0, 8) !== BPLIST_MAGIC) {
    throw new Error('不是二进制 plist')
  }
  // 尾部 32 字节：6 字节未用 + offsetSize + objectRefSize + numObjects + topObject + offsetTableOffset
  const trailer = buf.length - 32
  const offsetSize = buf[trailer + 6]
  const objectRefSize = buf[trailer + 7]
  const numObjects = Number(buf.readBigUInt64BE(trailer + 8))
  const topObject = Number(buf.readBigUInt64BE(trailer + 16))
  const offsetTableOffset = Number(buf.readBigUInt64BE(trailer + 24))
  if (!offsetSize || !objectRefSize || !Number.isFinite(numObjects)) {
    throw new Error('plist 尾部不合法')
  }

  const objectOffset = (i: number): number => {
    const at = offsetTableOffset + i * offsetSize
    let v = 0
    for (let k = 0; k < offsetSize; k++) v = v * 256 + buf[at + k]!
    return v
  }
  const readSized = (at: number, size: number): number => {
    let v = 0
    for (let k = 0; k < size; k++) v = v * 256 + buf[at + k]!
    return v
  }

  /** 读一个对象；只对标量返回，其它返回 undefined */
  const readObject = (index: number): string | number | boolean | undefined => {
    const off = objectOffset(index)
    const marker = buf[off]!
    const type = marker >> 4
    const info = marker & 0x0f
    if (type === 0x0 && info === 0x8) return false
    if (type === 0x0 && info === 0x9) return true
    if (type === 0x1) {
      // int，长度 2^info 字节
      const size = 1 << info
      return readSized(off + 1, size)
    }
    if (type === 0x2) {
      const size = 1 << info
      if (size === 4) return buf.readFloatBE(off + 1)
      if (size === 8) return buf.readDoubleBE(off + 1)
      return undefined
    }
    if (type === 0x3) {
      // date：8 字节浮点（Apple epoch 2001-01-01）
      return new Date(Date.UTC(2001, 0, 1) + buf.readDoubleBE(off + 1) * 1000).toISOString()
    }
    if (type === 0x5 || type === 0x6) {
      // ASCII / UTF-16BE 字符串。
      // **小对象（info < 15）时 info 本身就是长度**；只有 info == 15 才另跟一个 int 表示长度。
      // 混成「总是读一个 int」会让每个短字符串都读错长度，返回空串或乱码且不报错。
      const { length: len, dataStart: start } = readLengthAndDataStart(off, info)
      if (len < 0 || len > buf.length - start) return undefined
      return type === 0x5
        ? buf.toString('latin1', start, start + len)
        : decodeUtf16Be(buf.subarray(start, start + len * 2))
    }
    return undefined
  }

  /** bplist 的「小对象 / 0x0F 扩展」规则：取长度与数据起点 */
  const readLengthAndDataStart = (
    off: number,
    info: number,
  ): { length: number; dataStart: number } => {
    if (info !== 0x0f) return { length: info, dataStart: off + 1 }
    const marker = buf[off + 1]!
    const sizeBytes = 1 << (marker & 0x0f)
    return { length: readSized(off + 2, sizeBytes), dataStart: off + 2 + sizeBytes }
  }
  const top = objectOffset(topObject)
  if (buf[top] === undefined) throw new Error('顶层对象偏移越界')
  // 字典标记是 `0xD0 | count`：**只认 0xD0/0xD1 会把所有多字段的 dict 判成「不是字典」**
  // （Info.plist 永远是十几个键，于是这条路径在真机上必挂）。判高 4 位。
  if ((buf[top]! & 0xf0) !== 0xd0) throw new Error('顶层不是字典')
  const { length: count, dataStart: keyStart } = readLengthAndDataStart(top, buf[top]! & 0x0f)
  const keySize = objectRefSize
  const valStart = keyStart + count * keySize

  const scalars: Record<string, string | number | boolean> = {}
  let skipped = 0
  for (let i = 0; i < count; i++) {
    const key = readObject(readSized(keyStart + i * keySize, keySize))
    if (typeof key !== 'string') continue
    const idx = readSized(valStart + i * keySize, keySize)
    const v = readObject(idx)
    if (v === undefined) skipped++
    else scalars[key] = v
  }
  return { scalars, skipped }
}

export interface IpaProbeResult {
  readonly ok: true
  readonly text: string
}
export interface IpaProbeFailure {
  readonly ok: false
  readonly error: string
}

const FRAMEWORK_SIGNS: ReadonlyArray<[RegExp, string]> = [
  [/Flutter\.framework\//i, 'Flutter'],
  [/React\.framework\/|hermes\.framework\//i, 'React Native'],
  [/UnityFramework\.framework\//i, 'Unity'],
  [/Electron\.framework\//i, 'Electron 套壳'],
  [/Cocos2d\.framework\//i, 'Cocos2d-x'],
]

export function probeIpa(buf: Buffer): IpaProbeResult | IpaProbeFailure {
  try {
    const entries = readZipDirectory(buf)
    const lines: string[] = []
    const put = (k: string, v: string | number): void => {
      lines.push(`${k}=${v}`)
    }
    put('PROGRAM', 'ipa')
    put('FORMAT', 'iOS IPA (zip)')
    put('ENTRIES', entries.length)
    put('SIZE_KB', Math.round(buf.length / 1024))

    // `Payload/<Name>.app/Info.plist` —— 目录名随产品名变化，不能写死
    const infoEntry = entries.find((e) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(e.name))
    const appDir = infoEntry ? infoEntry.name.replace(/\/Info\.plist$/, '') : null
    if (!infoEntry || !appDir) {
      return { ok: false, error: '不是 IPA：找不到 Payload/*.app/Info.plist' }
    }
    put('APP_DIR', appDir)

    let plist: Record<string, string | number | boolean> = {}
    try {
      const raw = extractEntry(buf, infoEntry)
      if (raw.toString('ascii', 0, 6) === 'bplist') {
        plist = parseBinaryPlistScalars(raw).scalars
      } else {
        // 文本 plist（少见但不是没有）：退到 XML 正则，只为拿几个键
        const xml = raw.toString('utf8')
        const grab = (key: string): string | undefined =>
          new RegExp(`<key>${key}</key>\\s*<(string|integer|true|false)>([^<]*)</`).exec(xml)?.[2]
        for (const k of [
          'CFBundleIdentifier',
          'CFBundleShortVersionString',
          'CFBundleVersion',
          'MinimumOSVersion',
        ]) {
          const v = grab(k)
          if (v !== undefined) plist[k] = v
        }
        if (!plist.CFBundleIdentifier) {
          return {
            ok: false,
            error: 'Info.plist 既不是二进制 plist，也没从文本里读到 CFBundleIdentifier',
          }
        }
      }
    } catch (err) {
      return { ok: false, error: `Info.plist 解析失败：${err instanceof Error ? err.message : String(err)}` }
    }

    const str = (k: string): string => {
      const v = plist[k]
      return typeof v === 'string' || typeof v === 'number' ? String(v) : 'UNRESOLVED'
    }
    // plist 里**一个能用的键都没有** = 解析失败（不是「这包信息不全」）。
    // 真机踩过：造样本时 trailer 少写 topObject，解析器返回空字典，
    // 输出八个 UNRESOLVED 看着像包有问题。必须显式说清是解析的问题。
    if (Object.keys(plist).length === 0) {
      return {
        ok: false,
        error:
          'Info.plist 解析出 0 个字段（解析器没能读出任何标量）。' +
          '这不是「包信息不全」，而是 plist 结构不被支持或已损坏——请用 `plutil -p` 或 macOS 侧工具复核。',
      }
    }
    put('BUNDLE_ID', str('CFBundleIdentifier'))
    put('VERSION', str('CFBundleShortVersionString'))
    put('BUILD', str('CFBundleVersion'))
    put('MIN_IOS', str('MinimumOSVersion'))

    // 权限：只统计 NS*UsageDescription —— 有这条说明它真的申请了对应能力
    const usage = Object.keys(plist).filter((k) => /^NS\w+UsageDescription$/.test(k))
    put('PERMISSION_USAGE_KEYS', usage.length)
    lines.push('--- PERMISSIONS ---')
    for (const k of usage) lines.push(`${k}: ${String(plist[k]).slice(0, 80)}`)

    // 加密：Mach-O 的 LC_ENCRYPTION_INFO(cmd=0x21) 里 cryptid != 0 表示 App Store 加壳
    const exeEntry = entries.find(
      (e) => new RegExp(`^${escapeRe(appDir)}/[^/]+$`).test(e.name) && !/\.(png|jpg|plist|nib|car|storyboardc)$/i.test(e.name),
    )
    if (exeEntry) {
      put('EXECUTABLE', exeEntry.name.slice(appDir.length + 1))
      const exe = extractEntry(buf, exeEntry)
      const enc = readMachOEncryption(exe)
      put('MACHO', enc.macho || 'unknown')
      put('ENCRYPTED', enc.encrypted === undefined ? 'unresolved' : enc.encrypted ? 'yes(cryptid=' + enc.encrypted + ')' : 'no')
    } else {
      put('EXECUTABLE', 'UNRESOLVED')
      put('ENCRYPTED', 'unresolved')
    }

    // 框架
    const names = entries.map((e) => e.name)
    const frameworks = FRAMEWORK_SIGNS.filter(([re]) => names.some((n) => re.test(n))).map(([, l]) => l)
    put('FRAMEWORK', frameworks.length ? [...new Set(frameworks)].join(', ') : 'unknown')
    const fwEntries = names.filter((n) => /^Payload\/[^/]+\.app\/Frameworks\/[^/]+\.framework\//.test(n))
    put('FRAMEWORKS_COUNT', new Set(fwEntries.map((n) => n.split('/')[3])).size)

    // 描述文件（团队 / 过期）
    const provEntry = entries.find((e) => /^Payload\/[^/]+\.app\/embedded\.mobileprovision$/.test(e.name))
    if (provEntry) {
      const text = extractEntry(buf, provEntry).toString('latin1')
      const team = /<key>TeamIdentifier<\/key>\s*<array>\s*<string>([^<]+)<\/string>/.exec(text)?.[1]
      const expiry = /<key>ExpirationDate<\/key>\s*<date>([^<]+)<\/date>/.exec(text)?.[1]
      put('PROVISION_TEAM', team || 'UNRESOLVED')
      put('PROVISION_EXPIRY', expiry || 'UNRESOLVED')
    } else {
      put('PROVISION_TEAM', 'none')
      put('PROVISION_EXPIRY', 'none')
    }

    put('SIGN_CODE', 'UNRESOLVED（需要 codesign，本平台没有——如实标注，不猜）')
    return { ok: true, text: `${lines.join('\n')}\n` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 读 Mach-O 的加密状态。
 *
 * 只做一件事：遍历 load commands 找 `LC_ENCRYPTION_INFO`(0x21) / `LC_ENCRYPTION_INFO_64`(0x2C)。
 * 顺带认出是哪种 Mach-O（fat 里可能有多个架构，取第一个切片并说明）。
 */
export function readMachOEncryption(buf: Buffer): { macho?: string; encrypted?: number } {
  if (buf.length < 32) return {}
  const magic = buf.readUInt32BE(0)
  let offset = 0
  let macho: string | undefined
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    // fat binary：先报出来，取第一个切片继续
    macho = 'fat/universal'
    const nArch = buf.readUInt32BE(4)
    if (nArch === 0 || buf.length < 8 + 20) return { macho }
    offset = buf.readUInt32BE(16) // 第一个 arch 的 offset
  }
  if (offset + 28 > buf.length) return { macho }
  const m = buf.readUInt32LE(offset)
  if (m === 0xfeedfacf) macho = macho ? `${macho} (arm64 slice)` : 'Mach-O 64'
  else if (m === 0xfeedface) macho = macho ? `${macho} (32-bit slice)` : 'Mach-O 32'
  else return { macho }

  const is64 = m === 0xfeedfacf
  const nCmds = buf.readUInt32LE(offset + 16)
  let p = offset + (is64 ? 32 : 28)
  for (let i = 0; i < nCmds && p + 8 <= buf.length; i++) {
    const cmd = buf.readUInt32LE(p)
    const size = buf.readUInt32LE(p + 4)
    if (size < 8) break
    if (cmd === 0x21 || cmd === 0x2c) {
      // cryptid 在 cmd 之后第 4 个 uint32（cryptoff, cryptsize, cryptid）
      const cryptid = buf.readUInt32LE(p + 16)
      return { macho, encrypted: cryptid }
    }
    p += size
  }
  return { macho, encrypted: 0 }
}

export function probeIpaFile(filePath: string): IpaProbeResult | IpaProbeFailure {
  try {
    return probeIpa(fs.readFileSync(filePath))
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
