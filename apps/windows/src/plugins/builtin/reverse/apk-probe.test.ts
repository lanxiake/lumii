/**
 * APK 解析：zip 目录、AXML、dex 字符串池。
 *
 * 这些函数的失败模式都是**静默的**——读错偏移不会抛，而是输出一个看着合理但其实为空/错位的值：
 * - dex 的 `string_ids_size` 在 0x38 而不是 56（读错就拿到 data_size，字符串全空）；
 * - AXML 属性值的 `0xffffffff` 立刻返回会让每个无值属性都变成池里第一条；
 * - 类描述符 `Lcom/x/Y;` 也符合「标识符」正则，先判标识符就永远是 0 条。
 * 所以这里**造真字节**（手写 zip + 手写 AXML/dex 头），不 mock。
 */
import { describe, expect, it } from 'vitest'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import {
  countSensitive,
  extractEntry,
  parseAxmlManifest,
  probeApk,
  probeApkFile,
  readZipDirectory,
  summarizeDex,
} from './apk-probe'

// ─── 造 zip ───────────────────────────────────────────────────────────────

interface FakeEntry {
  name: string
  data: Buffer
}

/** 只写 stored（method=0）条目：解压路径另有 zlib，这里不重复测库 */
function buildZip(entries: FakeEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8) // method = stored
    local.writeUInt32LE(e.data.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    nameBuf.copy(local, 30)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 10) // method
    central.writeUInt32LE(e.data.length, 20)
    central.writeUInt32LE(e.data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)

    locals.push(local, e.data)
    centrals.push(central)
    offset += local.length + e.data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

// ─── 造 dex ───────────────────────────────────────────────────────────────

/** 最小可用 dex：只有头（0x70 字节）+ string_ids 表 + 字符串数据 */
function buildDex(strings: string[]): Buffer {
  const headerSize = 0x70
  const ids = Buffer.alloc(strings.length * 4)
  const chunks: Buffer[] = []
  let dataOffset = 0
  strings.forEach((s, i) => {
    const bytes = Buffer.from(s, 'utf8')
    // uleb128 utf16 长度（这里所有样例都 < 128，单字节足够）
    const prefix = s.length < 128 ? Buffer.from([s.length]) : Buffer.from([0x80 | (s.length & 0x7f), s.length >> 7])
    const chunk = Buffer.concat([prefix, bytes, Buffer.from([0])])
    ids.writeUInt32LE(headerSize + ids.length + dataOffset, i * 4)
    chunks.push(chunk)
    dataOffset += chunk.length
  })
  const data = Buffer.concat(chunks)
  const buf = Buffer.alloc(headerSize)
  buf.write('dex\n035\0', 0, 'ascii')
  buf.writeUInt32LE(buf.length + ids.length + data.length, 32) // file_size（未严格校验）
  buf.writeUInt32LE(0x70, 36) // header_size
  buf.writeUInt32LE(strings.length, 0x38)
  buf.writeUInt32LE(headerSize, 0x3c) // string_ids_off
  buf.writeUInt32LE(3, 0x40) // type_ids_size
  buf.writeUInt32LE(7, 0x60) // class_defs_size
  return Buffer.concat([buf, ids, data])
}

// ─── 造 AXML ──────────────────────────────────────────────────────────────

interface FakeElement {
  name: string
  attrs: Array<{ name: string; value: string | number; type?: 'str' | 'int' | 'bool' }>
}

function buildAxm(elements: FakeElement[]): Buffer {
  const strings: string[] = []
  const idx = (s: string): number => {
    const i = strings.indexOf(s)
    if (i >= 0) return i
    strings.push(s)
    return strings.length - 1
  }
  const chunks: Buffer[] = []

  // 元素 chunk 先占位，字符串池最后统一写（池必须排第一）
  const elementChunks: Array<{ el: FakeElement; body: Buffer; nameIdxAfterPool: number }> = []
  for (const el of elements) {
    elementChunks.push({ el, body: Buffer.alloc(0), nameIdxAfterPool: -1 })
  }

  // 先登记名字/值，保证池顺序稳定
  for (const el of elements) {
    idx(el.name)
    for (const a of el.attrs) {
      idx(a.name)
      if (typeof a.value === 'string') idx(a.value)
    }
  }

  // 字符串池
  const poolStrings: Buffer[] = []
  const offsets: number[] = []
  let acc = 0
  for (const s of strings) {
    offsets.push(acc)
    const bytes = Buffer.from(s, 'utf16le')
    const lenBuf = Buffer.alloc(2)
    lenBuf.writeUInt16LE(s.length, 0)
    const chunk = Buffer.concat([lenBuf, bytes, Buffer.alloc(2)])
    poolStrings.push(chunk)
    acc += chunk.length
  }
  const poolHeaderSize = 28
  const offsetsBuf = Buffer.alloc(strings.length * 4)
  offsets.forEach((o, i) => offsetsBuf.writeUInt32LE(o, i * 4))
  const poolData = Buffer.concat(poolStrings)
  const poolSize = poolHeaderSize + offsetsBuf.length + poolData.length
  const pool = Buffer.alloc(poolHeaderSize)
  pool.writeUInt16LE(0x0001, 0)
  pool.writeUInt16LE(poolHeaderSize, 2)
  pool.writeUInt32LE(poolSize, 4)
  pool.writeUInt32LE(strings.length, 8)
  pool.writeUInt32LE(0, 12) // styleCount
  pool.writeUInt32LE(0, 16) // flags（utf16）
  pool.writeUInt32LE(poolHeaderSize + offsetsBuf.length, 20) // stringsStart
  chunks.push(pool, offsetsBuf, poolData)

  // 元素 chunk：name=first+idx 之后池已有全部字符串，可直接取索引
  for (const el of elements) {
    const attrSize = 20
    const ext = Buffer.alloc(20 + el.attrs.length * attrSize)
    ext.writeUInt32LE(0xffffffff, 0) // ns
    ext.writeUInt32LE(strings.indexOf(el.name), 4)
    ext.writeUInt16LE(20, 8) // attributeStart
    ext.writeUInt16LE(attrSize, 10)
    ext.writeUInt16LE(el.attrs.length, 12)
    el.attrs.forEach((a, i) => {
      const at = 20 + i * attrSize
      ext.writeUInt32LE(0xffffffff, at) // ns
      ext.writeUInt32LE(strings.indexOf(a.name), at + 4)
      if (typeof a.value === 'string') {
        ext.writeUInt32LE(strings.indexOf(a.value), at + 8) // rawValue
        ext.writeUInt8(0x03, at + 15) // TYPE_STRING
        ext.writeUInt32LE(strings.indexOf(a.value), at + 16)
      } else {
        ext.writeUInt32LE(0xffffffff, at + 8) // 无 rawValue
        ext.writeUInt8(a.type === 'bool' ? 0x12 : 0x10, at + 15)
        ext.writeUInt32LE(a.value as number, at + 16)
      }
    })
    const header = Buffer.alloc(16)
    header.writeUInt16LE(0x0102, 0)
    header.writeUInt16LE(16, 2)
    header.writeUInt32LE(16 + ext.length, 4)
    chunks.push(Buffer.concat([header, ext]))
  }

  const fileHeader = Buffer.alloc(8)
  fileHeader.writeUInt16LE(0x0003, 0)
  fileHeader.writeUInt16LE(8, 2)
  const body = Buffer.concat(chunks)
  fileHeader.writeUInt32LE(8 + body.length, 4)
  return Buffer.concat([fileHeader, body])
}

// ─── 用例 ─────────────────────────────────────────────────────────────────

describe('readZipDirectory / extractEntry', () => {
  it('读出条目表并能取出内容', () => {
    const zip = buildZip([
      { name: 'AndroidManifest.xml', data: Buffer.from('manifest') },
      { name: 'classes.dex', data: Buffer.from('dex') },
    ])
    const entries = readZipDirectory(zip)
    expect(entries.map((e) => e.name)).toEqual(['AndroidManifest.xml', 'classes.dex'])
    expect(extractEntry(zip, entries[0]!).toString()).toBe('manifest')
  })

  it('不是 zip → 明确报错，不返回空表', () => {
    expect(() => readZipDirectory(Buffer.alloc(64))).toThrow(/不是 zip/)
  })
})

describe('summarizeDex', () => {
  it('按 0x38/0x3c 读字符串池（读成 56/60 会全空）', () => {
    const d = summarizeDex(buildDex(['', 'Lcom/demo/App;', 'https://api.demo.com/v1', 'ENCRYPT_KEY_ALIAS']))
    expect(d.stringCount).toBe(4)
    expect(d.classCount).toBe(7)
    expect(d.classes).toContain('Lcom/demo/App;')
    expect(d.urls).toContain('https://api.demo.com/v1')
    expect(d.longStrings).toContain('ENCRYPT_KEY_ALIAS')
  })

  it('类描述符不能被当成普通标识符吞掉（先判标识符会让 CLASS 恒为 0）', () => {
    const d = summarizeDex(buildDex(['La/b;', 'La/b/c;']))
    expect(d.classes).toEqual(['La/b;', 'La/b/c;'])
    expect(d.longStrings).not.toContain('La/b;')
  })

  it('魔数不对 → 抛错', () => {
    expect(() => summarizeDex(Buffer.alloc(0x100))).toThrow(/不是 dex/)
  })
})

describe('parseAxmlManifest', () => {
  it('读出元素与属性；无值属性不能被映射成池里第一条', () => {
    const axml = buildAxm([
      { name: 'manifest', attrs: [{ name: 'package', value: 'com.demo' }] },
      { name: 'uses-sdk', attrs: [{ name: 'minSdkVersion', value: 21, type: 'int' }] },
      {
        name: 'activity',
        attrs: [
          { name: 'name', value: '.Main' },
          { name: 'exported', value: 1, type: 'bool' },
        ],
      },
    ])
    const els = parseAxmlManifest(axml)
    expect(els.map((e) => e.name)).toEqual(['manifest', 'uses-sdk', 'activity'])
    const manifest = els[0]!
    expect(manifest.attrs.find((a) => a.name === 'package')?.value).toBe('com.demo')
    expect(els[1]!.attrs.find((a) => a.name === 'minSdkVersion')?.value).toBe('21')
    const act = els[2]!
    expect(act.attrs.find((a) => a.name === 'name')?.value).toBe('.Main')
    expect(act.attrs.find((a) => a.name === 'exported')?.value).toBe('true')
    // 关键：属性值不能串成池里的另一条字符串
    expect(act.attrs.find((a) => a.name === 'exported')?.value).not.toBe('.Main')
  })

  it('魔数不对 → 抛错', () => {
    expect(() => parseAxmlManifest(Buffer.alloc(32))).toThrow(/不是二进制 AXML/)
  })
})

describe('probeApk', () => {
  const manifest = buildAxm([
    {
      name: 'manifest',
      attrs: [
        { name: 'package', value: 'com.demo.app' },
        { name: 'versionName', value: '1.2.3' },
      ],
    },
    {
      name: 'uses-sdk',
      attrs: [
        { name: 'minSdkVersion', value: 24, type: 'int' },
        { name: 'targetSdkVersion', value: 34, type: 'int' },
      ],
    },
    { name: 'uses-permission', attrs: [{ name: 'name', value: 'android.permission.INTERNET' }] },
    { name: 'uses-permission', attrs: [{ name: 'name', value: 'android.permission.READ_CONTACTS' }] },
    {
      name: 'activity',
      attrs: [
        { name: 'name', value: '.Main' },
        { name: 'exported', value: 1, type: 'bool' },
      ],
    },
  ])

  const apk = (extra: FakeEntry[] = []): Buffer =>
    buildZip([
      { name: 'AndroidManifest.xml', data: manifest },
      { name: 'classes.dex', data: buildDex(['https://api.demo.com/v1', 'Lcom/demo/App;']) },
      ...extra,
    ])

  it('产出包名/版本/SDK/权限/组件/导出组件', () => {
    const r = probeApk(apk())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toContain('PACKAGE=com.demo.app')
    expect(r.text).toContain('VERSION_NAME=1.2.3')
    expect(r.text).toContain('MIN_SDK=24')
    expect(r.text).toContain('TARGET_SDK=34')
    expect(r.text).toContain('PERMISSIONS=2')
    expect(r.text).toContain('PERMISSIONS_SENSITIVE=1')
    expect(r.text).toContain('EXPORTED_COMPONENTS=1')
    expect(r.text).toContain('activity: .Main')
  })

  it('dex 里的 URL 与类名进报告', () => {
    const r = probeApk(apk())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toContain('https://api.demo.com/v1')
    expect(r.text).toContain('Lcom/demo/App;')
    expect(r.text).toContain('URL_COUNT=1')
  })

  it('加固与框架判定：命中特征就报名字，不命中就写 none/unknown', () => {
    const plain = probeApk(apk())
    expect(plain.ok && plain.text).toMatch(/PACKER_SUSPECT=none/)
    expect(plain.ok && plain.text).toMatch(/FRAMEWORK=unknown/)

    const packed = probeApk(
      apk([
        { name: 'lib/arm64-v8a/libjiagu.so', data: Buffer.alloc(4) },
        { name: 'lib/arm64-v8a/libflutter.so', data: Buffer.alloc(4) },
      ]),
    )
    expect(packed.ok && packed.text).toContain('360 加固')
    expect(packed.ok && packed.text).toContain('Flutter')
  })

  it('没有 AndroidManifest 时如实写 MISSING，而不是崩', () => {
    const zip = buildZip([{ name: 'classes.dex', data: buildDex(['x']) }])
    const r = probeApk(zip)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.text).toContain('MANIFEST_PARSE=MISSING')
  })

  it('不是 zip → ok:false 并带上原因', () => {
    const r = probeApk(Buffer.alloc(128))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/不是 zip/)
  })

  it('dex 数量超过 dexLimit 时只读前 N 个，并说明', () => {
    const zip = buildZip([
      { name: 'AndroidManifest.xml', data: manifest },
      { name: 'classes.dex', data: buildDex(['LAAA;']) },
      { name: 'classes2.dex', data: buildDex(['LBBB;']) },
      { name: 'classes3.dex', data: buildDex(['LCCC;']) },
    ])
    const r = probeApk(zip, { dexLimit: 1 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toContain('DEX_READ=1/3')
    expect(r.text).toContain('LAAA;')
    expect(r.text).not.toContain('LCCC;')
  })
})

describe('countSensitive', () => {
  it('只数危险权限', () => {
    expect(
      countSensitive([
        'android.permission.INTERNET',
        'android.permission.READ_CONTACTS',
        'android.permission.CAMERA',
        'com.vendor.PUSH',
      ]),
    ).toBe(2)
  })
})

// ─── 分包容器与 AAB ────────────────────────────────────────────────────────

describe('probeApk — 容器格式', () => {
  const innerManifest = buildAxm([
    {
      name: 'manifest',
      attrs: [
        { name: 'package', value: 'com.demo.split' },
        { name: 'versionName', value: '9.9.9' },
      ],
    },
    { name: 'uses-permission', attrs: [{ name: 'name', value: 'android.permission.INTERNET' }] },
  ])
  const baseApk = buildZip([
    { name: 'AndroidManifest.xml', data: innerManifest },
    { name: 'classes.dex', data: buildDex(['https://api.split.demo']) },
  ])
  const configApk = buildZip([
    { name: 'AndroidManifest.xml', data: buildAxm([{ name: 'manifest', attrs: [] }]) },
  ])

  it('.xapk / .apks：外层列出清单，挑出带 manifest 的主包做完整分析', () => {
    const container = buildZip([
      { name: 'config.arm64_v8a.apk', data: configApk },
      { name: 'com.demo.split.apk', data: baseApk },
      { name: 'manifest.json', data: Buffer.from('{}') },
    ])
    const r = probeApk(container)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toContain('PROGRAM=apk-container')
    expect(r.text).toContain('INNER_APKS=2')
    expect(r.text).toContain('BASE_APK=com.demo.split.apk') // 配置分包只有空 manifest，不是主包
    expect(r.text).toContain('PACKAGE=com.demo.split')
    expect(r.text).toContain('--- BASE_APK ---')
  })

  it('容器里没有可解析的主包 → 明确报错，并列出试过哪些', () => {
    const container = buildZip([
      { name: 'a.apk', data: Buffer.from('not-a-zip') },
      { name: 'readme.txt', data: Buffer.from('x') },
    ])
    const r = probeApk(container)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/找不到带 package 的主 APK/)
  })

  it('.aab：明确拒绝并给 bundletool 的转法（不落到 Ghidra 上去瞎分析）', () => {
    const aab = buildZip([
      { name: 'base/manifest/AndroidManifest.xml', data: Buffer.from('protobuf-not-axml') },
      { name: 'BundleConfig.pb', data: Buffer.from('x') },
    ])
    const r = probeApk(aab)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('AAB')
      expect(r.error).toContain('bundletool')
    }
  })
})

describe('probeApkFile', () => {
  it('文件不存在 → ok:false（不抛）', () => {
    const r = probeApkFile(path.join(os.tmpdir(), 'definitely-not-here.apk'))
    expect(r.ok).toBe(false)
  })

  it('完整链路：写一个真 APK 到磁盘再读', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-probe-'))
    const file = path.join(dir, 'demo.apk')
    const manifest = buildAxm([
      { name: 'manifest', attrs: [{ name: 'package', value: 'com.demo.disk' }] },
    ])
    fs.writeFileSync(file, buildZip([{ name: 'AndroidManifest.xml', data: manifest }]))
    const r = probeApkFile(file)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.text).toContain('PACKAGE=com.demo.disk')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
