/**
 * ASAR 解析：头格式、unpacked 条目、SHA256 核对。
 *
 * 这里的失败模式与 apk-probe 同族——**读错但不报错**：
 * - `dataStart` 写成 `8 + u32@12`（JSON 长度）在实测样本里凑巧也对，换个包就错位；
 * - `unpacked:true` 的条目不在 asar 内，按 offset 读会读到隔壁条目的字节。
 * 两个坑只有真字节能测出来，所以这里手写 asar（头 + 数据区），不 mock。
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { findElectronAsar, probeAsarFile, readAsarHeader, verifyAsarBytes } from './asar-probe'

interface FakeFile {
  /** asar 内路径，以 `/` 开头 */
  path: string
  data: Buffer
  unpacked?: boolean
  /** 故意写错的 hash，用来测「核对真的会失败」 */
  badHash?: boolean
}

interface FakeAsarOptions {
  /** 头部 JSON 与数据区之间插入的填充字节，模拟 8 字节对齐后 payload ≠ JSON 长度 */
  pad?: number
}

/** 手写一个 asar：`u32@0=4, u32@4=payload, u32@8=strLen, u32@12=jsonLen`，JSON 从 16 开始 */
export function buildAsar(files: FakeFile[], opts: FakeAsarOptions = {}): Buffer {
  const root: Record<string, unknown> = { files: {} }
  const dataChunks: Buffer[] = []
  let dataLen = 0
  for (const f of files) {
    const segs = f.path.split('/').filter(Boolean)
    let node = root.files as Record<string, Record<string, unknown>>
    for (let i = 0; i < segs.length - 1; i++) {
      const key = segs[i]!
      node[key] ??= { files: {} }
      node = (node[key] as { files: Record<string, Record<string, unknown>> }).files
    }
    const hash = createHash('sha256').update(f.data).digest('hex')
    const entry: Record<string, unknown> = { size: f.data.length }
    if (f.unpacked) {
      entry.unpacked = true
    } else {
      entry.offset = String(dataLen)
      dataChunks.push(f.data)
      dataLen += f.data.length
    }
    entry.integrity = {
      algorithm: 'SHA256',
      hash,
      blockSize: 4 * 1024 * 1024,
      blocks: [f.badHash ? '0'.repeat(64) : hash],
    }
    node[segs[segs.length - 1]!] = entry
  }

  const json = Buffer.from(JSON.stringify(root), 'utf8')
  const pad = opts.pad ?? 0
  const padding = Buffer.alloc(pad)
  const payload = 8 + json.length + pad
  const strLen = json.length + 4
  const header = Buffer.alloc(16)
  header.writeUInt32LE(4, 0)
  header.writeUInt32LE(payload, 4)
  header.writeUInt32LE(strLen, 8)
  header.writeUInt32LE(json.length, 12)
  return Buffer.concat([header, json, padding, ...dataChunks])
}

function writeTemp(buf: Buffer, name = 'app.asar'): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-probe-'))
  const file = path.join(dir, name)
  fs.writeFileSync(file, buf)
  return { dir, file }
}

describe('readAsarHeader', () => {
  it('按 u32@4 算 dataStart，条目与 offset 正确', () => {
    const h = readAsarHeader(
      buildAsar([
        { path: '/package.json', data: Buffer.from('{"name":"x"}') },
        { path: '/out/main/index.js', data: Buffer.from('console.log(1)') },
      ]),
    )
    expect(h.entries.map((e) => e.path)).toEqual(['/package.json', '/out/main/index.js'])
    const first = Buffer.from('{"name":"x"}')
    expect(h.entries[0]!.offset).toBe(0)
    expect(h.entries[1]!.offset).toBe(first.length)
  })

  it('dataStart 用 JSON 长度（u32@12）会错位——真机样本里两个数凑巧相等，换个包就错', () => {
    const buf = buildAsar([{ path: '/a.js', data: Buffer.from('AAAA') }], { pad: 8 })
    const h = readAsarHeader(buf)
    // 头里 u32@4 = 8 + jsonLen + 8，u32@12 = jsonLen；只有前者指向数据区
    expect(buf.readUInt32LE(4)).not.toBe(buf.readUInt32LE(12))
    expect(buf.subarray(h.dataStart, h.dataStart + 4).toString()).toBe('AAAA')
  })

  it('不是 asar → 明确报错', () => {
    expect(() => readAsarHeader(Buffer.alloc(64))).toThrow(/不是 asar/)
  })
})

describe('verifyAsarBytes', () => {
  it('逐条核 SHA256：全对时 verified === total', () => {
    const { dir, file } = writeTemp(
      buildAsar([
        { path: '/package.json', data: Buffer.from('{"name":"demo"}') },
        { path: '/out/main/index.js', data: Buffer.from('hello') },
      ]),
    )
    const fd = fs.openSync(file, 'r')
    try {
      const buf = fs.readFileSync(file)
      const v = verifyAsarBytes(fd, readAsarHeader(buf))
      expect(v.total).toBe(2)
      expect(v.verified).toBe(2)
      expect(v.failures).toEqual([])
    } finally {
      fs.closeSync(fd)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('hash 不符要报出来（否则「核对过」是假的）', () => {
    const { dir, file } = writeTemp(
      buildAsar([
        { path: '/a.js', data: Buffer.from('x') },
        { path: '/b.js', data: Buffer.from('y'), badHash: true },
      ]),
    )
    const fd = fs.openSync(file, 'r')
    try {
      const v = verifyAsarBytes(fd, readAsarHeader(fs.readFileSync(file)))
      expect(v.total).toBe(2)
      expect(v.verified).toBe(1)
      expect(v.failures.join('\n')).toContain('/b.js')
    } finally {
      fs.closeSync(fd)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('unpacked 条目不算进 total（没核过的不能算核过）', () => {
    const { dir, file } = writeTemp(
      buildAsar([
        { path: '/a.js', data: Buffer.from('x') },
        { path: '/native.node', data: Buffer.from(''), unpacked: true },
      ]),
    )
    const fd = fs.openSync(file, 'r')
    try {
      const v = verifyAsarBytes(fd, readAsarHeader(fs.readFileSync(file)))
      expect(v.total).toBe(1)
      expect(v.verified).toBe(1)
    } finally {
      fs.closeSync(fd)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('findElectronAsar', () => {
  it('传 exe 路径时找同目录 resources/app.asar', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-find-'))
    fs.mkdirSync(path.join(dir, 'resources'))
    const asar = path.join(dir, 'resources', 'app.asar')
    fs.writeFileSync(asar, buildAsar([{ path: '/package.json', data: Buffer.from('{}') }]))
    const exe = path.join(dir, 'demo.exe')
    fs.writeFileSync(exe, 'MZ')
    expect(findElectronAsar(exe)).toBe(asar)
    // 传安装目录也可以
    expect(findElectronAsar(dir)).toBe(asar)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('没有 asar → null（不能返回一个假路径）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-none-'))
    const exe = path.join(dir, 'plain.exe')
    fs.writeFileSync(exe, 'MZ')
    expect(findElectronAsar(exe)).toBeNull()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('probeAsarFile', () => {
  it('产出应用信息、文件清单与核对结果', () => {
    const { dir, file } = writeTemp(
      buildAsar([
        {
          path: '/package.json',
          data: Buffer.from(
            JSON.stringify({ name: 'demo-app', version: '2.1.0', main: 'out/main/index.js' }),
          ),
        },
        { path: '/out/main/index.js', data: Buffer.alloc(5000, 0x61) },
        { path: '/out/renderer/assets/index.js', data: Buffer.alloc(9000, 0x62) },
        { path: '/node_modules/foo/index.js', data: Buffer.from('x') },
        { path: '/node_modules/foo/index.js.map', data: Buffer.from('{}') },
      ]),
    )
    const r = probeAsarFile(file)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toContain('APP_NAME=demo-app')
    expect(r.text).toContain('APP_VERSION=2.1.0')
    expect(r.text).toContain('APP_MAIN=out/main/index.js')
    expect(r.text).toContain('ENTRIES=5')
    expect(r.text).toContain('APP_FILE_COUNT=3') // node_modules 之外的
    expect(r.text).toContain('BYTES_VERIFIED=5/5')
    // 依赖自带的 .map 不能算进「应用能不能读源码」
    expect(r.text).toContain('APP_SOURCEMAPS=0')
    expect(r.text).toContain('DEP_SOURCEMAPS=1')
    // 体积降序：renderer bundle 在最前
    const listed = r.text.slice(r.text.indexOf('--- APP_FILES'))
    expect(listed.indexOf('/out/renderer/assets/index.js')).toBeLessThan(listed.indexOf('/package.json'))
  })

  it('unpacked 条目如实计数，说明为什么它不在核对范围内', () => {
    const { dir, file } = writeTemp(
      buildAsar([
        { path: '/package.json', data: Buffer.from('{"name":"x"}') },
        { path: '/native.node', data: Buffer.from(''), unpacked: true },
      ]),
    )
    const r = probeAsarFile(file)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toContain('UNPACKED=1')
    expect(r.text).toContain('BYTES_VERIFIED=1/1')
    expect(r.text).toContain('无法从 asar 校验')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('文件不存在 → ok:false（不抛）', () => {
    const r = probeAsarFile(path.join(os.tmpdir(), 'no-such-app.asar'))
    expect(r.ok).toBe(false)
  })
})
