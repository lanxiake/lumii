/**
 * AAB 解析：protobuf wire format、XmlNode 树、dex 复用。
 *
 * 关键判据是「**手写 protobuf + 手写 XmlNode**」这条路真的能读出 manifest——
 * 所以这里造真字节：用最小的 protobuf 编码器把一棵 XmlNode 树写出来，
 * 再让解析器读回来。用 Buffer.from('...') 假数据测不出任何东西。
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseAabManifest, probeAab, probeAabFile, readPbFields } from './aab-probe'

// ─── 最小 protobuf 编码器（只为造测试数据） ────────────────────────────────

function varint(n: number): Buffer {
  // 用 BigInt 编码：`n >>> 0` 会先把 > 32 位的值截断，测「64 位读取」时自己先错了
  let v = BigInt(n)
  const out: number[] = []
  do {
    let b = Number(v & 0x7fn)
    v >>= 7n
    if (v > 0n) b |= 0x80
    out.push(b)
  } while (v > 0n)
  return Buffer.from(out)
}

function pbKey(num: number, wire: number): Buffer {
  return varint(num * 8 + wire)
}

function pbStr(num: number, s: string): Buffer {
  const b = Buffer.from(s, 'utf8')
  return Buffer.concat([pbKey(num, 2), varint(b.length), b])
}

function pbMsg(num: number, body: Buffer): Buffer {
  return Buffer.concat([pbKey(num, 2), varint(body.length), body])
}

function pbVarint(num: number, n: number): Buffer {
  return Buffer.concat([pbKey(num, 0), varint(n)])
}

interface FakeElement {
  name: string
  attrs?: Array<{ name: string; value: string }>
  children?: FakeElement[]
}

/** XmlElement: 2=name, 4=attribute, 5=child（child 的类型是 **XmlNode**，要再包一层） */
function encodeElement(el: FakeElement): Buffer {
  const parts: Buffer[] = [pbStr(2, el.name)]
  for (const a of el.attrs ?? []) {
    parts.push(pbMsg(4, Buffer.concat([pbStr(2, a.name), pbStr(3, a.value)])))
  }
  for (const c of el.children ?? []) parts.push(pbMsg(5, encodeXmlNode(c)))
  return Buffer.concat(parts)
}

/** XmlNode: 2=element */
function encodeXmlNode(el: FakeElement): Buffer {
  return pbMsg(2, encodeElement(el))
}

// ─── 造 zip（stored，够用；解压路径另有 zlib） ─────────────────────────────

interface FakeEntry {
  name: string
  data: Buffer
}

function buildZip(entries: FakeEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const nb = Buffer.from(e.name, 'utf8')
    const local = Buffer.alloc(30 + nb.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(e.data.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(nb.length, 26)
    nb.copy(local, 30)

    const c = Buffer.alloc(46 + nb.length)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(0, 10)
    c.writeUInt32LE(e.data.length, 20)
    c.writeUInt32LE(e.data.length, 24)
    c.writeUInt16LE(nb.length, 28)
    c.writeUInt32LE(offset, 42)
    nb.copy(c, 46)

    locals.push(local, e.data)
    centrals.push(c)
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

/** 最小 dex：只有头 + 字符串池（复用 apk-probe 测试同款构造） */
function buildDex(strings: string[]): Buffer {
  const headerSize = 0x70
  const ids = Buffer.alloc(strings.length * 4)
  const chunks: Buffer[] = []
  let dataOffset = 0
  strings.forEach((s, i) => {
    const bytes = Buffer.from(s, 'utf8')
    const prefix = Buffer.from([s.length])
    const chunk = Buffer.concat([prefix, bytes, Buffer.from([0])])
    ids.writeUInt32LE(headerSize + ids.length + dataOffset, i * 4)
    chunks.push(chunk)
    dataOffset += chunk.length
  })
  const data = Buffer.concat(chunks)
  const buf = Buffer.alloc(headerSize)
  buf.write('dex\n035\0', 0, 'ascii')
  buf.writeUInt32LE(buf.length + ids.length + data.length, 32)
  buf.writeUInt32LE(0x70, 36)
  buf.writeUInt32LE(strings.length, 0x38)
  buf.writeUInt32LE(headerSize, 0x3c)
  return Buffer.concat([buf, ids, data])
}

// ─── 用例 ─────────────────────────────────────────────────────────────────

const MANIFEST: FakeElement = {
  name: 'manifest',
  attrs: [
    { name: 'package', value: 'com.demo.bundle' },
    { name: 'versionName', value: '4.2.0' },
    { name: 'versionCode', value: '420' },
  ],
  children: [
    {
      name: 'uses-sdk',
      attrs: [
        { name: 'minSdkVersion', value: '24' },
        { name: 'targetSdkVersion', value: '34' },
      ],
    },
    { name: 'uses-permission', attrs: [{ name: 'name', value: 'android.permission.INTERNET' }] },
    { name: 'uses-permission', attrs: [{ name: 'name', value: 'android.permission.READ_CONTACTS' }] },
    {
      name: 'application',
      children: [
        {
          name: 'activity',
          attrs: [
            { name: 'name', value: '.MainActivity' },
            { name: 'exported', value: 'true' },
          ],
        },
        { name: 'service', attrs: [{ name: 'name', value: '.SyncService' }] },
        {
          name: 'activity',
          attrs: [
            { name: 'name', value: '.Internal' },
            { name: 'exported', value: 'false' },
          ],
        },
      ],
    },
  ],
}

function buildAab(extra: FakeEntry[] = []): Buffer {
  return buildZip([
    { name: 'base/manifest/AndroidManifest.xml', data: encodeXmlNode(MANIFEST) },
    { name: 'BundleConfig.pb', data: pbStr(1, '1.0') },
    { name: 'base/dex/classes.dex', data: buildDex(['https://api.demo.com/v2', 'Lcom/demo/A;']) },
    { name: 'base/lib/arm64-v8a/libflutter.so', data: Buffer.from('ELF') },
    ...extra,
  ])
}

describe('readPbFields', () => {
  it('读出三种 wire type，长度不越界', () => {
    const buf = Buffer.concat([pbVarint(1, 300), pbStr(2, 'hello'), pbMsg(3, pbStr(1, 'x'))])
    const f = readPbFields(buf)
    expect(f).toHaveLength(3)
    expect(f[0]!.value).toBe(300)
    expect((f[1]!.value as Buffer).toString()).toBe('hello')
    expect(f[2]!.num).toBe(3)
  })

  it('**varint 必须按 64 位读**：32 位拼接会在超过 4 字节时静默截断', () => {
    // 2^35 需要 6 个字节；用 (x << 7) 拼 32 位会得到错的值且不报错
    const big = 2 ** 35
    const f = readPbFields(pbVarint(1, big))
    expect(f[0]!.value).toBe(big)
  })

  it('长度越界 → 抛错，不返回半截结果', () => {
    const truncated = Buffer.concat([pbKey(1, 2), varint(100), Buffer.from('abc')])
    expect(() => readPbFields(truncated)).toThrow(/越界/)
  })

  it('未知 wire type（group）→ 抛错而不是猜', () => {
    expect(() => readPbFields(Buffer.from([0x0b, 0x0c]))).toThrow(/wire type/)
  })
})

describe('parseAabManifest', () => {
  it('解出元素树与属性（含嵌套子元素）', () => {
    const els = parseAabManifest(encodeXmlNode(MANIFEST))
    expect(els.map((e) => e.name)).toEqual([
      'manifest',
      'uses-sdk',
      'uses-permission',
      'uses-permission',
      'application',
      'activity',
      'service',
      'activity',
    ])
    expect(els[0]!.attrs.package).toBe('com.demo.bundle')
    expect(els[1]!.attrs.minSdkVersion).toBe('24')
    // 嵌套层级里的属性也要在
    const acts = els.filter((e) => e.name === 'activity')
    expect(acts[0]!.attrs.exported).toBe('true')
    expect(acts[1]!.attrs.exported).toBe('false')
  })

  it('没有 value 的属性不产出键（compiled_item 不解析）', () => {
    const el: FakeElement = { name: 'manifest', attrs: [] }
    const withCompiled = Buffer.concat([
      pbMsg(2, Buffer.concat([
        pbStr(2, el.name),
        // attribute 只有 name，没有 value（模拟 compiled_item 引用）
        pbMsg(4, pbStr(2, 'label')),
      ])),
    ])
    const els = parseAabManifest(withCompiled)
    expect(els[0]!.attrs).toEqual({})
  })
})

describe('probeAab', () => {
  it('产出包信息、权限、组件、dex、原生库、框架', () => {
    const r = probeAab(buildAab())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toContain('PACKAGE=com.demo.bundle')
    expect(r.text).toContain('VERSION_NAME=4.2.0')
    expect(r.text).toContain('VERSION_CODE=420')
    expect(r.text).toContain('MIN_SDK=24')
    expect(r.text).toContain('TARGET_SDK=34')
    expect(r.text).toContain('PERMISSIONS=2')
    expect(r.text).toContain('PERMISSIONS_SENSITIVE=1')
    expect(r.text).toContain('EXPORTED_COMPONENTS=1') // 只有 .MainActivity
    expect(r.text).toContain('activity: .MainActivity')
    expect(r.text).not.toContain('activity: .Internal')
    expect(r.text).toContain('DEX_COUNT=1')
    expect(r.text).toContain('https://api.demo.com/v2')
    expect(r.text).toContain('ABIS=arm64-v8a')
    expect(r.text).toContain('Flutter')
  })

  it('**dex 复用 APK 的解析器**：AAB 里的 classes.dex 是普通 dex', () => {
    const r = probeAab(buildAab())
    expect(r.ok && r.text).toContain('Lcom/demo/A;')
  })

  it('列出模块（base 排第一）', () => {
    const r = probeAab(
      buildAab([{ name: 'feature_login/manifest/AndroidManifest.xml', data: encodeXmlNode({ name: 'manifest' }) }]),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toContain('MODULES=2')
    const order = r.text.slice(r.text.indexOf('--- MODULES ---'))
    expect(order.indexOf('MODULE.base')).toBeLessThan(order.indexOf('MODULE.feature_login'))
  })

  it('dexLimit 生效并说明只读了多少', () => {
    const aab = buildZip([
      { name: 'base/manifest/AndroidManifest.xml', data: encodeXmlNode(MANIFEST) },
      { name: 'base/dex/classes.dex', data: buildDex(['LAAA;']) },
      { name: 'base/dex/classes2.dex', data: buildDex(['LBBB;']) },
      { name: 'base/dex/classes3.dex', data: buildDex(['LCCC;']) },
    ])
    const r = probeAab(aab, { dexLimit: 1 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toContain('DEX_READ=1/3')
    expect(r.text).toContain('LAAA;')
    expect(r.text).not.toContain('LCCC;')
  })

  it('不是 AAB → 明确说是缺 manifest，并提示 APK 走另一条', () => {
    const zip = buildZip([{ name: 'classes.dex', data: buildDex(['x']) }])
    const r = probeAab(zip)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('不是 AAB')
      expect(r.error).toContain('.apk')
    }
  })

  it('**manifest 解出 0 个元素要报错**，不能静默输出一堆 UNRESOLVED', () => {
    const zip = buildZip([
      { name: 'base/manifest/AndroidManifest.xml', data: Buffer.from([0x0b, 0x0c]) },
    ])
    const r = probeAab(zip)
    expect(r.ok).toBe(false)
  })
})

describe('probeAabFile', () => {
  it('文件不存在 → ok:false（不抛）', () => {
    const r = probeAabFile(path.join(os.tmpdir(), 'no-such.aab'))
    expect(r.ok).toBe(false)
  })

  it('完整链路：写盘再读', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-probe-'))
    const file = path.join(dir, 'demo.aab')
    fs.writeFileSync(file, buildAab())
    const r = probeAabFile(file)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.text).toContain('PACKAGE=com.demo.bundle')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
