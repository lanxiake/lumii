/**
 * APK 静态结构探针（**纯 Node，不依赖 jadx/aapt**）。
 *
 * ## 为什么自己解 zip
 *
 * 仓库里有 `jszip`，但它只暴露「按名字取文件」；APK 分析真正要的是
 * 「整个条目表 + 每个条目的压缩方式/大小」——用来判断有哪些 dex、哪些 so、
 * 是不是分包。这部分自己读中央目录只有几十行，且**解压仍然交给 `node:zlib`**。
 *
 * ## 能拿到什么（以及拿不到什么）
 *
 * 拿到：包名/版本/权限/组件/引用库（二进制 AXML）、dx 字符串池里的
 * URL · 类描述符 · 可疑前缀、原生库清单与**加固判定**、签名文件、跨端框架判定。
 *
 * 拿不到：**Java 字节码反编译**。dex 的 class_def → code_item 解析体量大且容易出错，
 * 真正要读代码时应该报「需要 jadx」而不是给一份半对的伪代码。
 * 这一条是刻意留的边界：错了比没有更糟。
 */
import * as fs from 'node:fs'
import * as zlib from 'node:zlib'

export interface ZipEntryInfo {
  readonly name: string
  /** 0 = stored，8 = deflate */
  readonly method: number
  readonly compressedSize: number
  readonly localOffset: number
}

/** 读 EOCD → 中央目录。**不解析 zip64**：APK 极少超过 4GB，遇到就如实报。 */
export function readZipDirectory(buf: Buffer): ZipEntryInfo[] {
  let eocd = -1
  const floor = Math.max(0, buf.length - 66_000)
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是 zip/APK（找不到目录结尾）')
  const count = buf.readUInt16LE(eocd + 10)
  let cd = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cd === 0xffffffff) {
    throw new Error('zip64（或条目数超限）——当前实现不支持')
  }
  const out: ZipEntryInfo[] = []
  for (let i = 0; i < count; i++) {
    if (cd + 46 > buf.length || buf.readUInt32LE(cd) !== 0x02014b50) break
    const nameLen = buf.readUInt16LE(cd + 28)
    const extraLen = buf.readUInt16LE(cd + 30)
    const commentLen = buf.readUInt16LE(cd + 32)
    out.push({
      name: buf.toString('utf8', cd + 46, cd + 46 + nameLen),
      method: buf.readUInt16LE(cd + 10),
      compressedSize: buf.readUInt32LE(cd + 20),
      localOffset: buf.readUInt32LE(cd + 42),
    })
    cd += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** 解出一个条目（stored 直取，deflate 交给 zlib） */
export function extractEntry(buf: Buffer, entry: ZipEntryInfo): Buffer {
  const p = entry.localOffset
  const nameLen = buf.readUInt16LE(p + 26)
  const extraLen = buf.readUInt16LE(p + 28)
  const start = p + 30 + nameLen + extraLen
  const raw = buf.subarray(start, start + entry.compressedSize)
  return entry.method === 0 ? raw : zlib.inflateRawSync(raw)
}

// ─── dex ──────────────────────────────────────────────────────────────────

export interface DexSummary {
  readonly version: string
  readonly stringCount: number
  readonly typeCount: number
  readonly classCount: number
  readonly urls: readonly string[]
  readonly classes: readonly string[]
  readonly longStrings: readonly string[]
}

function readUleb128(buf: Buffer, offset: number): [number, number] {
  let result = 0
  let shift = 0
  let byte: number
  let o = offset
  do {
    byte = buf[o++]
    result |= (byte & 0x7f) << shift
    shift += 7
  } while (byte & 0x80)
  return [result >>> 0, o]
}

/**
 * 读 dex 头与字符串池。**字段偏移是 dex 035 规范**：
 * `string_ids_size` 在 0x38、`string_ids_off` 在 0x3c（不是 56/60 —— 那里是
 * `data_size`/`data_off`，读错会拿到全零然后静默输出空列表）。
 *
 * 字符串是 MUTF-8、以 0 结尾，前面还有 uleb128 的 utf16 长度。
 * 少量条目是二进制（dex 里确实存在），按可打印性过滤。
 */
export function summarizeDex(buf: Buffer, limit = 50_000): DexSummary {
  if (buf.length < 0x70 || buf.toString('ascii', 0, 4) !== 'dex\n') {
    throw new Error('不是 dex（魔数不符）')
  }
  const stringCount = buf.readUInt32LE(0x38)
  const stringOff = buf.readUInt32LE(0x3c)
  const typeCount = buf.readUInt32LE(0x40)
  const classCount = buf.readUInt32LE(0x60)
  const n = Math.min(stringCount, limit)
  const urls = new Set<string>()
  const classes = new Set<string>()
  const longStrings = new Set<string>()
  for (let i = 0; i < n; i++) {
    const so = buf.readUInt32LE(stringOff + i * 4)
    if (so <= 0 || so >= buf.length) continue
    const [, p] = readUleb128(buf, so)
    const end = buf.indexOf(0, p)
    const s = buf.toString('utf8', p, end < 0 ? buf.length : end)
    if (s.length < 4) continue
    if (/^[\x00-\x1f]/.test(s)) continue // 二进制条目
    // 顺序要紧：类描述符 `Lcom/x/Y;` 也符合下面那条标识符正则，
    // 先判它，否则 `CLASS_DESC_COUNT` 永远是 0（真机上踩过）。
    if (/^L[\w/$]+;$/.test(s)) classes.add(s)
    else if (/^https?:\/\/\S+/i.test(s) && s.length > 10) urls.add(s)
    else if (s.length >= 8 && /^[A-Za-z_][\w./$\-]*$/.test(s)) longStrings.add(s)
  }
  return {
    version: buf.toString('ascii', 4, 8).replace(/\0/g, '').trim(),
    stringCount,
    typeCount,
    classCount,
    urls: [...urls].slice(0, 40),
    classes: [...classes].slice(0, 60),
    longStrings: [...longStrings].slice(0, 60),
  }
}

// ─── 二进制 AndroidManifest.xml (AXML) ────────────────────────────────────

export interface AxmlAttribute {
  readonly name: string
  readonly value: string
}
export interface AxmlElement {
  readonly name: string
  readonly attrs: readonly AxmlAttribute[]
}

const AXML_STRING_POOL = 0x0001
const AXML_START_ELEMENT = 0x0102

const ATTR_TYPE_STRING = 0x03
const ATTR_TYPE_BOOLEAN = 0x12
const ATTR_TYPE_INT = 0x10
const ATTR_TYPE_HEX = 0x11
const NO_ENTRY = 0xffffffff

function readStringPool(buf: Buffer, start: number): { strings: string[]; size: number } {
  const size = buf.readUInt32LE(start + 4)
  const count = buf.readUInt32LE(start + 8)
  const flags = buf.readUInt32LE(start + 16)
  const stringsStart = buf.readUInt32LE(start + 20)
  const headerSize = buf.readUInt16LE(start + 2)
  const utf8 = (flags & 0x100) !== 0
  const strings: string[] = []
  for (let i = 0; i < count; i++) {
    const off = buf.readUInt32LE(start + headerSize + i * 4)
    const p = start + stringsStart + off
    if (p < 0 || p >= buf.length) {
      strings.push('')
      continue
    }
    if (utf8) {
      // 两个 varint：utf16 长度、utf8 字节数
      let q = p
      const varint = (): number => {
        let len = buf[q++]
        if (len & 0x80) len = ((len & 0x7f) << 8) | buf[q++]
        return len
      }
      varint()
      const blen = varint()
      strings.push(buf.toString('utf8', q, q + blen))
    } else {
      let q = p
      let len = buf.readUInt16LE(q)
      q += 2
      if (len & 0x8000) {
        len = ((len & 0x7fff) << 16) | buf.readUInt16LE(q)
        q += 2
      }
      strings.push(buf.toString('utf16le', q, q + len * 2))
    }
  }
  return { strings, size }
}

/**
 * 解析 AXML 的元素起始标签。
 *
 * 属性值有三种来源：字符串池索引（`rawValue`）、按 `dataType` 解释的内联值、
 * 或什么都没（引用型）。`0xffffffff` 是「无 NONE_ENTRY」哨兵——**不能当成索引 0**，
 * 否则每个没有字符串值的属性都会变成池里的第一条。
 */
export function parseAxmlManifest(buf: Buffer): AxmlElement[] {
  if (buf.length < 8 || buf.readUInt16LE(0) !== 0x0003) {
    throw new Error('不是二进制 AXML（魔数不符）')
  }
  const strings: string[] = []
  const elements: AxmlElement[] = []
  let p = buf.readUInt16LE(2)
  while (p + 8 <= buf.length) {
    const type = buf.readUInt16LE(p)
    const headerSize = buf.readUInt16LE(p + 2)
    const size = buf.readUInt32LE(p + 4)
    if (size <= 0 || p + size > buf.length) break
    if (type === AXML_STRING_POOL) {
      strings.push(...readStringPool(buf, p).strings)
    } else if (type === AXML_START_ELEMENT) {
      const ext = p + headerSize
      const nameIdx = buf.readUInt32LE(ext + 4)
      const attrStart = buf.readUInt16LE(ext + 8)
      const attrSize = buf.readUInt16LE(ext + 10)
      const attrCount = buf.readUInt16LE(ext + 12)
      const attrs: AxmlAttribute[] = []
      for (let i = 0; i < attrCount; i++) {
        const a = ext + attrStart + i * attrSize
        const nIdx = buf.readUInt32LE(a + 4)
        const rawValue = buf.readUInt32LE(a + 8)
        const dataType = buf.readUInt8(a + 15)
        const data = buf.readUInt32LE(a + 16)
        attrs.push({
          name: strings[nIdx] ?? `attr#${nIdx}`,
          value: describeAttrValue(rawValue, dataType, data, strings),
        })
      }
      elements.push({ name: strings[nameIdx] ?? `elem#${nameIdx}`, attrs })
    }
    p += size
  }
  return elements
}

function describeAttrValue(
  rawValue: number,
  dataType: number,
  data: number,
  strings: readonly string[],
): string {
  if (rawValue !== NO_ENTRY) return strings[rawValue] ?? ''
  if (dataType === ATTR_TYPE_STRING) return strings[data] ?? ''
  if (dataType === ATTR_TYPE_BOOLEAN) return data !== 0 ? 'true' : 'false'
  if (dataType === ATTR_TYPE_HEX) return `0x${(data >>> 0).toString(16)}`
  if (dataType === ATTR_TYPE_INT) return String(data | 0)
  return `0x${(data >>> 0).toString(16)}(type=${dataType})`
}

// ─── 汇总 ─────────────────────────────────────────────────────────────────

/** 加固/壳的已知迹象。命中就给名字，**不做「一定是壳」的断言**——只报证据。 */
const PACKER_SIGNS: ReadonlyArray<[RegExp, string]> = [
  [/libjiagu/i, '360 加固'],
  [/libshell|SecShell|libSecShell/i, '腾讯乐固/加固'],
  [/libnesec/i, '网易易盾'],
  [/libDexHelper|libmobisec/i, '梆梆加固'],
  [/libexec\.so|libprotectClass/i, '通用壳'],
  [/libbaiduprotect/i, '百度加固'],
  [/libkwscmm|libkwscr/i, '快手加固'],
]

/** 跨端框架判定：命中即说明「代码多半在资源里，别硬啃原生». */
const FRAMEWORK_SIGNS: ReadonlyArray<[RegExp, string]> = [
  [/libflutter\.so/i, 'Flutter'],
  [/libhermes\.so|libhermes-executor/i, 'React Native (Hermes)'],
  [/index\.android\.bundle$/i, 'React Native (bundle)'],
  [/libreactnativejni/i, 'React Native'],
  [/flutter_assets\//i, 'Flutter (assets)'],
  [/app\.asar$/i, 'Electron 套壳'],
  [/libmonobdwgc-2\.0|libil2cpp/i, 'Unity (IL2CPP)'],
  [/libcocos2d/i, 'Cocos2d-x'],
  [/assets\/www\/|libweex/i, 'Weex / H5'],
]

export interface ApkProbeResult {
  readonly ok: true
  readonly text: string
}
export interface ApkProbeFailure {
  readonly ok: false
  readonly error: string
}

export interface ApkProbeOptions {
  /** 最多解析几个 dex（大包有几十个，全解会慢；按名字顺序取前 N） */
  readonly dexLimit?: number
}

/**
 * 产出与 `ReverseProbe.java` 同风格的 `KEY=value` + `--- SECTION ---` 文本，
 * 这样技能对两种后端用同一套「抄进 evidence.md」的读法。
 */
export function probeApk(buf: Buffer, opts: ApkProbeOptions = {}): ApkProbeResult | ApkProbeFailure {
  try {
    const entries = readZipDirectory(buf)
    const lines: string[] = []
    const put = (k: string, v: string | number): void => {
      lines.push(`${k}=${v}`)
    }

    const dexEntries = entries
      .filter((e) => /^classes\d*\.dex$/.test(e.name))
      .sort((a, b) => dexIndex(a.name) - dexIndex(b.name))
    const soEntries = entries.filter((e) => /^lib\/[^/]+\/.+\.so$/.test(e.name))
    const signature = entries.filter((e) => /^META-INF\/.+\.(RSA|DSA|EC|SF)$/.test(e.name))

    put('PROGRAM', 'apk')
    put('FORMAT', 'Android APK (zip)')
    put('ENTRIES', entries.length)
    put('SIZE_KB', Math.round(buf.length / 1024))
    put('DEX_COUNT', dexEntries.length)
    put('NATIVE_LIBS', soEntries.length)
    put('ABIS', [...new Set(soEntries.map((e) => e.name.split('/')[1]))].join(',') || 'none')

    // ── Manifest ──
    const manifestEntry = entries.find((e) => e.name === 'AndroidManifest.xml')
    if (manifestEntry) {
      try {
        const els = parseAxmlManifest(extractEntry(buf, manifestEntry))
        const manifest = els.find((e) => e.name === 'manifest')
        const attr = (name: string): string => manifest?.attrs.find((a) => a.name === name)?.value ?? ''
        put('PACKAGE', attr('package') || 'UNRESOLVED')
        put('VERSION_NAME', attr('versionName') || 'UNRESOLVED')
        const sdk = els.find((e) => e.name === 'uses-sdk')
        put('MIN_SDK', sdk?.attrs.find((a) => a.name === 'minSdkVersion')?.value ?? 'unspecified')
        put('TARGET_SDK', sdk?.attrs.find((a) => a.name === 'targetSdkVersion')?.value ?? 'unspecified')

        const perms = els
          .filter((e) => e.name === 'uses-permission' || e.name === 'uses-permission-sdk-23')
          .map((e) => e.attrs.find((a) => a.name === 'name')?.value)
          .filter((v): v is string => Boolean(v))
        put('PERMISSIONS', perms.length)
        put('PERMISSIONS_SENSITIVE', countSensitive(perms))
        lines.push('--- PERMISSIONS ---')
        for (const perm of perms) lines.push(perm)

        const components = new Map<string, number>()
        for (const e of els) {
          if (!/^(activity|activity-alias|service|receiver|provider)$/.test(e.name)) continue
          components.set(e.name, (components.get(e.name) ?? 0) + 1)
        }
        for (const [k, v] of components) put(`COMPONENT.${k}`, v)

        const exported = els.filter(
          (e) => /^(activity|service|receiver|provider)$/.test(e.name) &&
            e.attrs.some((a) => a.name === 'exported' && a.value === 'true'),
        )
        put('EXPORTED_COMPONENTS', exported.length)
        lines.push('--- EXPORTED ---')
        for (const e of exported.slice(0, 40)) {
          const name = e.attrs.find((a) => a.name === 'name')?.value ?? '?'
          lines.push(`${e.name}: ${name}`)
        }
      } catch (err) {
        put('MANIFEST_PARSE', `FAILED: ${err instanceof Error ? err.message : String(err)}`)
      }
    } else {
      put('MANIFEST_PARSE', 'MISSING')
    }

    // ── dex 字符串池 ──
    const limit = opts.dexLimit ?? 10
    const urls = new Set<string>()
    const suspicious = new Set<string>()
    const classes = new Set<string>()
    let dexRead = 0
    let dexFailed = 0
    for (const e of dexEntries.slice(0, limit)) {
      try {
        const d = summarizeDex(extractEntry(buf, e))
        dexRead++
        d.urls.forEach((u) => urls.add(u))
        d.classes.forEach((c) => classes.add(c))
        for (const s of d.longStrings) {
          if (/encrypt|decrypt|token|secret|api[_-]?key|password/i.test(s)) suspicious.add(s)
        }
      } catch {
        dexFailed++
      }
    }
    put('DEX_READ', `${dexRead}/${dexEntries.length}${dexEntries.length > limit ? `（超过上限 ${limit}，只读了前 ${limit} 个）` : ''}`)
    if (dexFailed > 0) put('DEX_FAILED', dexFailed)
    lines.push('--- URLS_IN_DEX ---')
    for (const u of [...urls].slice(0, 40)) lines.push(u)
    lines.push('--- SUSPICIOUS_STRINGS ---')
    for (const s of [...suspicious].slice(0, 40)) lines.push(s)
    lines.push('--- CLASSES_SAMPLE ---')
    for (const c of [...classes].slice(0, 30)) lines.push(c)
    put('URL_COUNT', urls.size)
    put('CLASS_DESC_COUNT', classes.size)

    // ── 加固 / 框架判定 ──
    const names = entries.map((e) => e.name)
    const packers = PACKER_SIGNS.filter(([re]) => names.some((n) => re.test(n))).map(([, label]) => label)
    const frameworks = FRAMEWORK_SIGNS.filter(([re]) => names.some((n) => re.test(n))).map(([, label]) => label)
    put('PACKER_SUSPECT', packers.length ? packers.join(', ') : 'none')
    put('FRAMEWORK', frameworks.length ? [...new Set(frameworks)].join(', ') : 'unknown')
    put('SIGNATURE_FILES', signature.map((e) => e.name).join(',') || 'none')

    lines.push('--- NATIVE_LIBS ---')
    for (const e of soEntries.slice(0, 60)) lines.push(e.name)

    return { ok: true, text: `${lines.join('\n')}\n` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function dexIndex(name: string): number {
  const m = /^classes(\d*)\.dex$/.exec(name)
  return m && m[1] ? Number(m[1]) : 1
}

/** 危险权限：能在结论里说「它要读通讯录/定位/短信」这种话的依据 */
const SENSITIVE = [
  /READ_CONTACTS|WRITE_CONTACTS/,
  /ACCESS_FINE_LOCATION|ACCESS_COARSE_LOCATION|ACCESS_BACKGROUND_LOCATION/,
  /READ_SMS|RECEIVE_SMS|SEND_SMS|READ_CALL_LOG|WRITE_CALL_LOG|CALL_PHONE/,
  /CAMERA|RECORD_AUDIO/,
  /READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE|READ_MEDIA_/,
  /READ_PHONE_STATE|READ_PHONE_NUMBERS/,
  /BIND_ACCESSIBILITY_SERVICE|BIND_DEVICE_ADMIN/,
  /QUERY_ALL_PACKAGES|REQUEST_INSTALL_PACKAGES|SYSTEM_ALERT_WINDOW/,
  /BODY_SENSORS|ACTIVITY_RECOGNITION/,
]

export function countSensitive(perms: readonly string[]): number {
  return perms.filter((p) => SENSITIVE.some((re) => re.test(p))).length
}

/** 供工具层调用：读文件 → 判定 → 产出文本 */
export function probeApkFile(filePath: string, opts?: ApkProbeOptions): ApkProbeResult | ApkProbeFailure {
  try {
    const buf = fs.readFileSync(filePath)
    return probeApk(buf, opts)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
