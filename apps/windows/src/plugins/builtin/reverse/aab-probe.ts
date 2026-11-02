/**
 * AAB（Android App Bundle）静态探针。
 *
 * ## 为什么原来拒绝、现在能做
 *
 * 原先 `.aab` 直接报「manifest 是 protobuf，本探针不解析，请用 bundletool」。
 * 这条拒绝只说对了一半：
 *
 * - `base/manifest/AndroidManifest.xml` 确实是 protobuf（`Resources.proto` 的 `XmlNode`），
 * - 但 `base/dex/classes*.dex` 是**和 APK 里一样**的普通 dex —— 现有 `summarizeDex` 直接可用。
 *
 * 而且那个 protobuf 不是什么编码奇观，就是**标准 protobuf wire format** 加一层
 * 固定的消息结构（XmlNode → XmlElement → XmlAttribute）。写一个通用解码器 + 一个
 * 树遍历就能拿到 package / versionName / SDK / 权限，成本远低于「让用户先去装 bundletool」。
 *
 * ## 边界（写报告时别越过）
 *
 * - **只读 protobuf 的字符串字段**。`compiled_item`（编译后的资源引用）不解析——
 *   那要接 `resources.pb` 的资源表，属于「把 AAB 当 APK 用」，超出静态结构分析的范围。
 * - **不产出 APK、不做签名、不合并分包**。要看真实安装形态仍然用 bundletool。
 * - 模块只有 `base` 是必须的；`feature*` 模块单独列出来但不逐个深入（它们通常不含 dex 全量）。
 */
import * as fs from 'node:fs'
import { readZipDirectory, extractEntry, summarizeDex, readClassMethods } from './apk-probe'
import type { ZipEntryInfo } from './apk-probe'

// ─── 最小 protobuf 解码 ────────────────────────────────────────────────────

/** protobuf wire type；只处理 0(varint) / 1(64bit) / 2(length-delimited) / 5(32bit) */
export interface PbField {
  readonly num: number
  readonly wire: number
  /** wire=2 时是内容切片，其余是数值 */
  readonly value: number | Buffer
}

/**
 * 读一个 varint。
 *
 * protobuf 的 varint 是 **64 位**的。这里用 BigInt 累加到最后再转 Number：
 * 用 `(x << 7)` 拼 32 位整数会在超过 4 字节时静默截断——字段名/长度不会那么大，
 * 但 `resource_id` 之类的数值字段会，而截断不报错。
 */
function readVarint(buf: Buffer, pos: number, end: number): { value: number; next: number } {
  let result = 0n
  let shift = 0n
  let p = pos
  while (p < end) {
    const byte = buf[p]!
    result |= BigInt(byte & 0x7f) << shift
    shift += 7n
    p++
    if ((byte & 0x80) === 0) return { value: Number(result), next: p }
    if (shift > 70n) break // 畸形数据：别再读下去
  }
  return { value: Number(result), next: p }
}

/**
 * 把一段 buffer 解成字段列表（**不按 schema**，纯 wire-level）。
 *
 * 遇到不认识的 wire type（3/4，已废弃的 group）抛错而不是猜——
 * 静默跳过会让后面的字段全部错位，而错位后的输出看起来仍然「像个结果」。
 */
export function readPbFields(buf: Buffer, start = 0, end = buf.length): PbField[] {
  const out: PbField[] = []
  let p = start
  while (p < end) {
    const key = readVarint(buf, p, end)
    if (key.next === p) break
    p = key.next
    const num = Math.floor(key.value / 8)
    const wire = key.value % 8
    if (wire === 0) {
      const v = readVarint(buf, p, end)
      out.push({ num, wire, value: v.value })
      p = v.next
    } else if (wire === 1) {
      out.push({ num, wire, value: Number(buf.readBigUInt64LE(p)) })
      p += 8
    } else if (wire === 5) {
      out.push({ num, wire, value: buf.readUInt32LE(p) })
      p += 4
    } else if (wire === 2) {
      const len = readVarint(buf, p, end)
      p = len.next
      const stop = p + len.value
      if (stop > end) throw new Error('protobuf 长度越界（数据被截断或不是 protobuf）')
      out.push({ num, wire, value: buf.subarray(p, stop) })
      p = stop
    } else {
      throw new Error(`protobuf wire type ${wire} 不支持（字段 ${num}）`)
    }
  }
  return out
}

function pbString(f: PbField | undefined): string | undefined {
  return f && f.wire === 2 ? (f.value as Buffer).toString('utf8') : undefined
}

function pbField(fields: readonly PbField[], num: number): PbField | undefined {
  return fields.find((f) => f.num === num)
}

function pbAll(fields: readonly PbField[], num: number): PbField[] {
  return fields.filter((f) => f.num === num)
}

// ─── XmlNode 树 → 扁平元素表 ───────────────────────────────────────────────

export interface AabElement {
  readonly name: string
  readonly attrs: Readonly<Record<string, string>>
}

/**
 * 遍历 `Resources.proto` 的 XmlNode 树。
 *
 * 结构（field 号取自 aapt2 的 `Resources.proto`）：
 * - `XmlNode`：1 source，**2 element**，3 text
 * - `XmlElement`：1 namespace_uri，**2 name**，3 namespace_declaration，**4 attribute**，**5 child**
 * - `XmlAttribute`：1 namespace_uri，**2 name**，**3 value**，4 resource_id，5 compiled_item
 *
 * 只认 `value`（字符串）。`compiled_item` 要接资源表才能解，本探针不做。
 */
export function parseAabManifest(buf: Buffer): AabElement[] {
  const out: AabElement[] = []
  const walkNode = (nodeBuf: Buffer, depth: number): void => {
    if (depth > 100) return // 防御畸形数据造成的深递归
    const fields = readPbFields(nodeBuf)
    const el = pbField(fields, 2)
    if (!el || el.wire !== 2) return
    const elFields = readPbFields(el.value as Buffer)
    const name = pbString(pbField(elFields, 2))
    if (!name) return
    const attrs: Record<string, string> = {}
    for (const a of pbAll(elFields, 4)) {
      if (a.wire !== 2) continue
      const af = readPbFields(a.value as Buffer)
      const an = pbString(pbField(af, 2))
      const av = pbString(pbField(af, 3))
      if (an && av !== undefined) attrs[an] = av
    }
    out.push({ name, attrs })
    for (const c of pbAll(elFields, 5)) {
      if (c.wire === 2) walkNode(c.value as Buffer, depth + 1)
    }
  }
  walkNode(buf, 0)
  return out
}

// ─── AAB 分析 ──────────────────────────────────────────────────────────────

export interface AabProbeResult {
  readonly ok: true
  readonly text: string
}
export interface AabProbeFailure {
  readonly ok: false
  readonly error: string
}

export interface AabProbeOptions {
  readonly dexLimit?: number
}

/** 与 apk-probe 保持一致的危险权限判据（不 import 是为了不把两处的匹配顺序耦合起来） */
const SENSITIVE = [
  /READ_CONTACTS|WRITE_CONTACTS/,
  /ACCESS_FINE_LOCATION|ACCESS_COARSE_LOCATION|ACCESS_BACKGROUND_LOCATION/,
  /READ_SMS|RECEIVE_SMS|SEND_SMS|READ_CALL_LOG|WRITE_CALL_LOG|CALL_PHONE/,
  /CAMERA|RECORD_AUDIO/,
  /READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE/,
  /READ_PHONE_STATE|READ_PHONE_NUMBERS/,
  /QUERY_ALL_PACKAGES|REQUEST_INSTALL_PACKAGES/,
  /SYSTEM_ALERT_WINDOW|BIND_ACCESSIBILITY_SERVICE/,
]

const FRAMEWORK_SIGNS: ReadonlyArray<[RegExp, string]> = [
  [/libflutter\.so/i, 'Flutter'],
  [/libhermes\.so|libhermes-executor/i, 'React Native (Hermes)'],
  [/index\.android\.bundle$/i, 'React Native (bundle)'],
  [/libreactnativejni/i, 'React Native'],
  [/flutter_assets\//i, 'Flutter (assets)'],
  [/libmonobdwgc-2\.0|libil2cpp/i, 'Unity (IL2CPP)'],
  [/libcocos2d/i, 'Cocos2d-x'],
]

const PACKER_SIGNS: ReadonlyArray<[RegExp, string]> = [
  [/libjiagu/i, '360 加固'],
  [/libshell|SecShell/i, '腾讯乐固/加固'],
  [/libnesec/i, '网易易盾'],
  [/libDexHelper|libmobisec/i, '梆梆加固'],
  [/libbaiduprotect/i, '百度加固'],
]

/** AAB 的模块根目录：`base/` 一定有，其余是 feature / asset pack */
function listModules(entries: readonly ZipEntryInfo[]): string[] {
  const mods = new Set<string>()
  for (const e of entries) {
    const m = /^([^/]+)\//.exec(e.name)
    if (m) mods.add(m[1]!)
  }
  return [...mods].sort((a, b) => (a === 'base' ? -1 : b === 'base' ? 1 : a.localeCompare(b)))
}

export function probeAab(buf: Buffer, opts: AabProbeOptions = {}): AabProbeResult | AabProbeFailure {
  try {
    const entries = readZipDirectory(buf)
    const manifestEntry = entries.find((e) => e.name === 'base/manifest/AndroidManifest.xml')
    if (!manifestEntry) {
      return {
        ok: false,
        error:
          '不是 AAB（缺少 base/manifest/AndroidManifest.xml）。' +
          '如果这是 APK，请用 .apk 扩展名调用——两者走不同的解析器。',
      }
    }

    const lines: string[] = []
    const put = (k: string, v: string | number): void => {
      lines.push(`${k}=${v}`)
    }
    put('PROGRAM', 'aab')
    put('FORMAT', 'Android App Bundle (zip + protobuf manifest)')
    put('SIZE_KB', Math.round(buf.length / 1024))

    const modules = listModules(entries)
    put('MODULES', modules.length)
    lines.push('--- MODULES ---')
    for (const m of modules) {
      const inMod = entries.filter((e) => e.name.startsWith(`${m}/`))
      put(`MODULE.${m}.ENTRIES`, inMod.length)
    }

    // ─── manifest（protobuf） ───
    let els: AabElement[] = []
    try {
      els = parseAabManifest(extractEntry(buf, manifestEntry))
    } catch (e) {
      return {
        ok: false,
        error:
          `AAB 的 manifest 解析失败：${e instanceof Error ? e.message : String(e)}。` +
          '本探针按标准 protobuf wire format 解析；解不开说明这个包用了非标准编码。',
      }
    }
    if (els.length === 0) {
      return {
        ok: false,
        error: 'manifest 解出 0 个元素——这不是包信息不全，是解析失败（protobuf 结构不符预期）',
      }
    }
    put('MANIFEST_ELEMENTS', els.length)

    const manifestEl = els.find((e) => e.name === 'manifest')
    put('PACKAGE', manifestEl?.attrs.package ?? 'UNRESOLVED')
    put('VERSION_NAME', manifestEl?.attrs.versionName ?? 'UNRESOLVED')
    put('VERSION_CODE', manifestEl?.attrs.versionCode ?? 'UNRESOLVED')

    const usesSdk = els.find((e) => e.name === 'uses-sdk')
    put('MIN_SDK', usesSdk?.attrs.minSdkVersion ?? 'UNRESOLVED')
    put('TARGET_SDK', usesSdk?.attrs.targetSdkVersion ?? 'UNRESOLVED')

    const perms = els
      .filter((e) => e.name === 'uses-permission' || e.name === 'uses-permission-sdk-23')
      .map((e) => e.attrs.name)
      .filter((n): n is string => Boolean(n))
    put('PERMISSIONS', perms.length)
    put('PERMISSIONS_SENSITIVE', perms.filter((p) => SENSITIVE.some((r) => r.test(p))).length)
    lines.push('--- PERMISSIONS ---', ...perms)

    const componentTypes = ['activity', 'service', 'receiver', 'provider']
    let exported = 0
    const exportedLines: string[] = []
    for (const t of componentTypes) {
      const list = els.filter((e) => e.name === t)
      put(`COMPONENT.${t}`, list.length)
      for (const c of list) {
        if (c.attrs.exported === 'true') {
          exported++
          exportedLines.push(`${t}: ${c.attrs.name ?? 'UNNAMED'}`)
        }
      }
    }
    put('EXPORTED_COMPONENTS', exported)
    if (exportedLines.length > 0) lines.push('--- EXPORTED ---', ...exportedLines)

    // ─── dex（普通 dex，直接复用 APK 的解析器） ───
    const dexEntries = entries
      .filter((e) => /^base\/dex\/classes\d*\.dex$/.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name))
    const limit = opts.dexLimit ?? 8
    put('DEX_COUNT', dexEntries.length)
    put('DEX_READ', `${Math.min(limit, dexEntries.length)}/${dexEntries.length}`)

    const urls = new Set<string>()
    const classes = new Set<string>()
    const methodTable = new Map<string, string[]>()
    let methodNames = 0
    for (const e of dexEntries.slice(0, limit)) {
      try {
        const d = summarizeDex(extractEntry(buf, e))
        d.urls.forEach((u) => urls.add(u))
        d.classes.forEach((c) => classes.add(c))
        const m = readClassMethods(extractEntry(buf, e), new Set(d.classes))
        for (const [cls, names] of m) {
          methodTable.set(cls, [...(methodTable.get(cls) ?? []), ...names])
          methodNames += names.length
        }
      } catch {
        /* 单个 dex 坏了不影响其余 */
      }
    }
    put('URL_COUNT', urls.size)
    lines.push('--- URLS_IN_DEX ---', ...[...urls].sort())
    put('CLASS_DESC_COUNT', classes.size)
    lines.push('--- CLASSES_SAMPLE ---', ...[...classes].sort().slice(0, 30))
    put('CLASS_METHOD_TABLE', methodTable.size)
    put('METHOD_NAMES_TOTAL', methodNames)
    if (methodTable.size > 0) {
      lines.push('--- CLASS_METHODS_SAMPLE ---')
      for (const [cls, names] of [...methodTable.entries()].slice(0, 20)) {
        lines.push(`${cls}: ${names.slice(0, 12).join(', ')}`)
      }
    }

    // ─── 原生库 / 资源 / 框架 ───
    const libs = entries.filter((e) => /^base\/lib\/[^/]+\/.*\.so$/.test(e.name))
    const abis = [...new Set(libs.map((e) => e.name.split('/')[2]!))].sort()
    put('ABIS', abis.join(',') || 'none')
    put('NATIVE_LIBS', libs.length)
    if (libs.length > 0) {
      lines.push('--- NATIVE_LIBS ---', ...libs.map((e) => e.name))
    }

    const allNames = entries.map((e) => e.name).join('\n')
    const fw = FRAMEWORK_SIGNS.filter(([re]) => re.test(allNames)).map(([, n]) => n)
    put('FRAMEWORK', fw.length > 0 ? fw.join(',') : 'unknown')
    const packers = PACKER_SIGNS.filter(([re]) => re.test(allNames)).map(([, n]) => n)
    put('PACKER_SUSPECT', packers.length > 0 ? packers.join(',') : 'none')

    lines.push(
      '--- 口径 ---',
      'manifest 用自写的 protobuf 解码器读（只取字符串字段）；资源引用（compiled_item）不解析。',
      'dex 与 APK 里的完全一样，所以 URL / 类名 / 方法名都可用。',
      '这是**静态结构**，不等于安装后的形态——真要安装请先 bundletool 转 APK。',
    )
    return { ok: true, text: `${lines.join('\n')}\n` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function probeAabFile(
  filePath: string,
  opts: AabProbeOptions = {},
): AabProbeResult | AabProbeFailure {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, error: `文件不存在：${filePath}` }
    return probeAab(fs.readFileSync(filePath), opts)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
