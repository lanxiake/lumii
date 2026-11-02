/**
 * IPA 解析：二进制 plist、Mach-O 加密标记、包结构。
 *
 * 与前一组同样**造真字节**。二进制 plist 的失败模式和 dex 一样：
 * 尾部 32 字节的字段读错不会抛，会返回一个空字典，然后 `BUNDLE_ID=UNRESOLVED`
 * 看着像「这包信息不全」——真机上只能靠反复试，所以这里把布局钉死。
 */
import { describe, expect, it } from 'vitest'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'

import { parseBinaryPlistScalars, probeIpa, probeIpaFile, readMachOEncryption } from './ipa-probe'

// ─── 造二进制 plist ───────────────────────────────────────────────────────

/**
 * 只支持标量顶层字典（正是我们需要的）。结构：
 *   bplist00 | dict 对象 | key 对象... | value 对象... | 偏移表 | trailer(32B)
 */
function buildBplist(obj: Record<string, string | number | boolean>): Buffer {
  const objects: Buffer[] = []

  const encString = (s: string): Buffer => {
    // 真 bplist 里非纯 ASCII 的串走 UTF-16BE（标记 0x6），纯 ASCII 走 0x5。
    // 造测试数据时按同一条规则编码，否则解析器读到的就是乱码。
    const isAscii = /^[\x20-\x7e]*$/.test(s)
    if (isAscii) {
      return s.length < 15
        ? Buffer.concat([Buffer.from([0x50 | s.length]), Buffer.from(s, 'latin1')])
        : Buffer.concat([Buffer.from([0x5f, 0x10, s.length]), Buffer.from(s, 'latin1')])
    }
    const bytes = Buffer.from(s, 'utf16le')
    bytes.swap16() // 转成 BE
    return s.length < 15
      ? Buffer.concat([Buffer.from([0x60 | s.length]), bytes])
      : Buffer.concat([Buffer.from([0x6f, 0x10, s.length]), bytes])
  }
  const encInt = (n: number): Buffer => {
    if (n >= 0 && n <= 0xff) return Buffer.from([0x10, n])
    if (n >= 0 && n <= 0xffff) {
      const b = Buffer.from([0x11, 0, 0])
      b.writeUInt16BE(n, 1)
      return b
    }
    const b = Buffer.from([0x12, 0, 0, 0, 0])
    b.writeUInt32BE(n >>> 0, 1)
    return b
  }
  const encAny = (v: string | number | boolean): Buffer => {
    if (typeof v === 'boolean') return Buffer.from([v ? 0x09 : 0x08])
    if (typeof v === 'number') return encInt(v)
    return encString(v)
  }

  const keys = Object.keys(obj)
  // 顺序：dict、keys、values（对象索引 0 = dict，1..n = keys，n+1.. = values）
  objects.push(Buffer.alloc(0)) // dict 占位
  for (const k of keys) objects.push(encString(k))
  for (const k of keys) objects.push(encAny(obj[k]!))

  // dict 对象：0xD? 后跟 key 引用与 value 引用
  const keyRefs = Buffer.alloc(keys.length)
  const valRefs = Buffer.alloc(keys.length)
  keys.forEach((_, i) => {
    keyRefs[i] = 1 + i
    valRefs[i] = 1 + keys.length + i
  })
  objects[0] = Buffer.concat([Buffer.from([0xd0 | keys.length]), keyRefs, valRefs])

  // 拼对象表 + 记偏移
  const offsets: number[] = []
  let acc = 8 // 8 字节头
  const body: Buffer[] = []
  for (const o of objects) {
    offsets.push(acc)
    body.push(o)
    acc += o.length
  }
  const offsetTableOffset = acc
  const offsetSize = 2
  const table = Buffer.alloc(offsets.length * offsetSize)
  offsets.forEach((o, i) => table.writeUInt16BE(o, i * offsetSize))

  const trailer = Buffer.alloc(32)
  trailer[6] = offsetSize
  trailer[7] = 1 // objectRefSize
  trailer.writeBigUInt64BE(BigInt(objects.length), 8)
  trailer.writeBigUInt64BE(0n, 16) // topObject
  trailer.writeBigUInt64BE(BigInt(offsetTableOffset), 24)

  return Buffer.concat([Buffer.from('bplist00', 'latin1'), ...body, table, trailer])
}

// ─── 造 Mach-O ────────────────────────────────────────────────────────────

/** 最小 64 位 Mach-O 头 + 一条 LC_ENCRYPTION_INFO_64 */
function buildMachO64(cryptid: number): Buffer {
  const header = Buffer.alloc(32)
  header.writeUInt32LE(0xfeedfacf, 0) // magic
  header.writeUInt32LE(0x0100000c, 4) // cputype arm64
  header.writeUInt32LE(0, 8)
  header.writeUInt32LE(2, 12) // filetype MH_EXECUTE
  header.writeUInt32LE(1, 16) // ncmds
  header.writeUInt32LE(24, 20) // sizeofcmds
  header.writeUInt32LE(0, 24) // flags
  header.writeUInt32LE(0, 28) // reserved

  const cmd = Buffer.alloc(24)
  cmd.writeUInt32LE(0x2c, 0) // LC_ENCRYPTION_INFO_64
  cmd.writeUInt32LE(24, 4) // cmdsize
  cmd.writeUInt32LE(0x4000, 8) // cryptoff
  cmd.writeUInt32LE(0x8000, 12) // cryptsize
  cmd.writeUInt32LE(cryptid, 16)
  cmd.writeUInt32LE(0, 20) // pad
  return Buffer.concat([header, cmd])
}

// ─── 造 zip（与 apk 测试同一形态，stored） ────────────────────────────────

function buildZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(e.data.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    nameBuf.copy(local, 30)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
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

const APP = 'Payload/Demo.app'

function buildIpa(opts: { cryptid?: number; plist?: Record<string, string | number | boolean> } = {}): Buffer {
  const plist =
    opts.plist ??
    ({
      CFBundleIdentifier: 'com.demo.ios',
      CFBundleShortVersionString: '3.1.4',
      CFBundleVersion: '314',
      MinimumOSVersion: '14.0',
      NSCameraUsageDescription: '扫描二维码',
      NSLocationWhenInUseUsageDescription: '附近的门店',
    } as Record<string, string | number | boolean>)
  return buildZip([
    { name: `${APP}/Info.plist`, data: buildBplist(plist) },
    { name: `${APP}/Demo`, data: buildMachO64(opts.cryptid ?? 0) },
    { name: `${APP}/Frameworks/Flutter.framework/Flutter`, data: Buffer.from('x') },
    { name: `${APP}/embedded.mobileprovision`, data: Buffer.from(
      '<plist><dict><key>TeamIdentifier</key><array><string>ABCDE12345</string></array>' +
      '<key>ExpirationDate</key><date>2027-01-01T00:00:00Z</date></dict></plist>',
      'latin1',
    ) },
  ])
}

// ─── 用例 ─────────────────────────────────────────────────────────────────

describe('parseBinaryPlistScalars', () => {
  it('读出顶层标量（尾部 32 字节布局）', () => {
    const { scalars, skipped } = parseBinaryPlistScalars(buildBplist({ A: 'x', B: 42, C: true }))
    expect(scalars).toEqual({ A: 'x', B: 42, C: true })
    expect(skipped).toBe(0)
  })

  it('魔数不对 → 抛错', () => {
    expect(() => parseBinaryPlistScalars(Buffer.alloc(64))).toThrow(/不是二进制 plist/)
  })
})

describe('readMachOEncryption', () => {
  it('cryptid=0 → 未加密', () => {
    expect(readMachOEncryption(buildMachO64(0))).toEqual({ macho: 'Mach-O 64', encrypted: 0 })
  })

  it('cryptid 非 0 → 报告具体值（不是布尔）', () => {
    expect(readMachOEncryption(buildMachO64(1)).encrypted).toBe(1)
  })

  it('不是 Mach-O → 不猜', () => {
    expect(readMachOEncryption(Buffer.alloc(64))).toEqual({})
  })
})

describe('probeIpa', () => {
  it('读出 bundle/版本/最低系统/权限用途/框架/签名信息', () => {
    const r = probeIpa(buildIpa())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toContain('BUNDLE_ID=com.demo.ios')
    expect(r.text).toContain('VERSION=3.1.4')
    expect(r.text).toContain('MIN_IOS=14.0')
    expect(r.text).toContain('PERMISSION_USAGE_KEYS=2')
    expect(r.text).toContain('NSCameraUsageDescription: 扫描二维码')
    expect(r.text).toContain('FRAMEWORK=Flutter')
    expect(r.text).toContain('PROVISION_TEAM=ABCDE12345')
    expect(r.text).toContain('PROVISION_EXPIRY=2027-01-01T00:00:00Z')
  })

  it('加密状态如实报 cryptid，签名核验如实写 UNRESOLVED', () => {
    const r = probeIpa(buildIpa({ cryptid: 1 }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toContain('ENCRYPTED=yes(cryptid=1)')
    expect(r.text).toContain('SIGN_CODE=UNRESOLVED')
  })

  it('找不到 Payload/*.app/Info.plist → 明确报「不是 IPA」', () => {
    const r = probeIpa(buildZip([{ name: 'readme.txt', data: Buffer.from('x') }]))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/不是 IPA/)
  })

  it('不是 zip → 不抛，返回 ok:false', () => {
    const r = probeIpa(Buffer.alloc(128))
    expect(r.ok).toBe(false)
  })
})

describe('probeIpaFile', () => {
  it('完整链路：写真文件再读', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipa-probe-'))
    const file = path.join(dir, 'demo.ipa')
    fs.writeFileSync(file, buildIpa())
    const r = probeIpaFile(file)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.text).toContain('BUNDLE_ID=com.demo.ios')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('文件不存在 → ok:false', () => {
    expect(probeIpaFile(path.join(os.tmpdir(), 'nope.ipa')).ok).toBe(false)
  })
})
