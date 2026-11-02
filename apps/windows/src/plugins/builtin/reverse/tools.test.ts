/**
 * `reverse_probe` 工具：缺工具时的报法、输出校验、失败路径。
 *
 * 这三条都是**静默失败**的高发区：
 * - 缺工具时若直接抛，模型会以为目标文件有问题；
 * - 探针「跑完了但输出不完整」比报错更危险（模型拿半截输出当结论）；
 * - 脚本资产缺失（开发态忘构建）会列出一个一调就崩的工具。
 */
import { describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { createReverseProbeToolConfig, pickBackend, resolveBackend } from './tools'
import type { ReverseService } from './service-api'

const OK_OUTPUT = [
  'PROGRAM=demo.exe',
  'FORMAT=Portable Executable (PE)',
  'ARCH=x86:LE:64:default',
  'FUNCTIONS=42',
  'IMPORTS=7',
  'CAPABILITY.network=1',
  'CAPABILITY.network.SAMPLE=InternetOpenUrlW',
]

function service(overrides: Partial<ReverseService> = {}): ReverseService {
  return {
    backends: () => [
      { id: 'ghidra', label: 'Ghidra', path: '/opt/ghidra', targets: ['PE'], hint: '' },
    ],
    scriptsDir: () => '/assets/reverse/scripts/ghidra',
    ...overrides,
  }
}

async function run(deps: Parameters<typeof createReverseProbeToolConfig>[0], params: unknown) {
  const cfg = createReverseProbeToolConfig(deps)
  return cfg.execute('call', params, undefined as never)
}

function textOf(res: Awaited<ReturnType<typeof run>>): string {
  return res.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
}

describe('reverse_probe', () => {
  it('正常：把探针输出原样交给模型', async () => {
    const spawnProbe = vi.fn(async () => ({ ok: true, stdout: OK_OUTPUT.join('\n') }))
    const res = await run({ service: service(), spawnProbe }, { target: 'C:/a.exe', decompile: 2 })
    expect(res.isError).toBeUndefined()
    expect(textOf(res)).toContain('FUNCTIONS=42')
    expect(spawnProbe).toHaveBeenCalledWith({
      scriptsDir: '/assets/reverse/scripts/ghidra',
      target: expect.stringContaining('a.exe'),
      decompile: 2,
    })
  })

  it('把宿主的 node 解析器透传下去（Electron 里 process.execPath 不是 node）', async () => {
    const resolveNode = () => ({ command: '/usr/bin/node', env: {} })
    const spawnProbe = vi.fn(async () => ({ ok: true, stdout: OK_OUTPUT.join('\n') }))
    await run({ service: service(), spawnProbe, resolveNode }, { target: 'C:/a.exe' })
    expect(spawnProbe).toHaveBeenCalledWith(expect.objectContaining({ resolveNode }))
  })

  it('缺 Ghidra：如实说缺什么 + 给出降级路径，且不误报成目标文件的问题', async () => {
    const spawnProbe = vi.fn()
    const res = await run(
      {
        service: service({
          backends: () => [
            { id: 'ghidra', label: 'Ghidra', path: null, targets: ['PE'], hint: '装到 ~/tools/' },
          ],
        }),
        spawnProbe,
      },
      { target: 'C:/a.exe' },
    )
    expect(res.isError).toBe(true)
    const text = textOf(res)
    expect(text).toContain('没找到 Ghidra')
    expect(text).toContain('装到 ~/tools/')
    expect(text).toContain('Triage') // 降级路径必须写出来
    expect(spawnProbe).not.toHaveBeenCalled()
  })

  it('探针跑完但输出缺关键行 → 报错，不把半截输出当结论', async () => {
    const res = await run(
      { service: service(), spawnProbe: async () => ({ ok: true, stdout: 'PROGRAM=a\n' }) },
      { target: 'C:/a.exe' },
    )
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('FORMAT=')
  })

  it('探针非零退出 → 带上最有信息量的尾部', async () => {
    const res = await run(
      {
        service: service(),
        spawnProbe: async () => ({ ok: false, stdout: '', error: '探针失败（退出码 4）：\njava: not found' }),
      },
      { target: 'C:/a.exe' },
    )
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('java: not found')
  })

  it('缺 target / decompile 越界 → 参数被夹到安全范围', async () => {
    const empty = await run({ service: service(), spawnProbe: async () => ({ ok: true, stdout: OK_OUTPUT.join('\n') }) }, {})
    expect(empty.isError).toBe(true)
    expect(textOf(empty)).toContain('缺少 target')

    const spawnProbe = vi.fn(async () => ({ ok: true, stdout: OK_OUTPUT.join('\n') }))
    await run({ service: service(), spawnProbe }, { target: 'C:/a.exe', decompile: 999 })
    expect(spawnProbe).toHaveBeenCalledWith(expect.objectContaining({ decompile: 20 }))
  })
})

describe('后端选择', () => {
  it('.apk / .xapk / .apks / .aab / .ipa 走内置，其它交给 Ghidra', () => {
    expect(pickBackend('C:/x/app.apk')).toBe('apk')
    expect(pickBackend('C:/x/APP.APK')).toBe('apk')
    expect(pickBackend('C:/x/app.xapk')).toBe('apk')
    expect(pickBackend('C:/x/app.apks')).toBe('apk')
    // AAB 有自己的 protobuf 解码器，不再复用 APK 的拒绝分支
    expect(pickBackend('C:/x/app.aab')).toBe('aab')
    expect(pickBackend('C:/x/APP.AAB')).toBe('aab')
    expect(pickBackend('C:/x/app.ipa')).toBe('ipa')
    expect(pickBackend('C:/x/app.exe')).toBe('ghidra')
    expect(pickBackend('/bin/ls')).toBe('ghidra')
  })

  it('IPA 走内置实现：不 spawn 外部进程、不依赖 Ghidra', async () => {
    const spawnProbe = vi.fn()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-ipa-'))
    const ipa = path.join(dir, 'demo.ipa')
    fs.writeFileSync(ipa, Buffer.alloc(128)) // 不是合法 IPA：应报解析错误而不是「缺 Ghidra」
    const res = await run(
      {
        service: service({
          backends: () => [
            { id: 'ghidra', label: 'Ghidra', path: null, targets: ['PE'], hint: '装到 ~/tools/' },
            { id: 'ipa', label: 'IPA（内置）', path: 'builtin', targets: ['.ipa'], hint: '' },
          ],
        }),
        spawnProbe,
      },
      { target: ipa },
    )
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('IPA 解析失败')
    expect(textOf(res)).not.toContain('没找到 Ghidra')
    expect(spawnProbe).not.toHaveBeenCalled()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('resolveBackend：同目录有 resources/app.asar 的 exe 走 asar，而不是花 4 分钟反编译外壳', () => {
    const spawnProbe = vi.fn()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-asar-'))
    const exe = path.join(dir, 'demo.exe')
    fs.writeFileSync(exe, 'MZ')
    expect(resolveBackend(exe)).toBe('ghidra') // 还没有 asar

    fs.mkdirSync(path.join(dir, 'resources'))
    fs.writeFileSync(path.join(dir, 'resources', 'app.asar'), Buffer.from(''))
    expect(resolveBackend(exe)).toBe('asar')
    // 内建后端不受影响
    expect(resolveBackend('C:/x/app.apk')).toBe('apk')
    expect(resolveBackend('C:/x/app.ipa')).toBe('ipa')
    fs.rmSync(dir, { recursive: true, force: true })
    expect(spawnProbe).not.toHaveBeenCalled()
  })

  it('asar 后端**即使没装 Ghidra 也能用**，且不 spawn 外部进程', async () => {
    const spawnProbe = vi.fn()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-asar-run-'))
    const asar = path.join(dir, 'app.asar')
    fs.writeFileSync(asar, Buffer.alloc(64)) // 不是合法 asar：应报解析错误而不是「缺 Ghidra」
    const res = await run(
      {
        service: service({
          backends: () => [{ id: 'ghidra', label: 'Ghidra', path: null, targets: ['PE'], hint: '' }],
        }),
        spawnProbe,
      },
      { target: asar },
    )
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('asar 解析失败')
    expect(textOf(res)).not.toContain('没找到 Ghidra')
    expect(spawnProbe).not.toHaveBeenCalled()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('APK 走内置实现：**即使没装 Ghidra 也能用**，且不 spawn 外部进程', async () => {
    const spawnProbe = vi.fn()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-apk-'))
    const apk = path.join(dir, 'demo.apk')
    // 不是合法 APK——重点是证明它走的是内置解析器（报解析错），而不是「缺 Ghidra」
    fs.writeFileSync(apk, Buffer.alloc(128))
    const res = await run(
      {
        service: service({
          backends: () => [
            { id: 'ghidra', label: 'Ghidra', path: null, targets: ['PE'], hint: '装到 ~/tools/' },
            { id: 'apk', label: 'APK（内置）', path: 'builtin', targets: ['.apk'], hint: '' },
          ],
        }),
        spawnProbe,
      },
      { target: apk },
    )
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('APK 解析失败')
    expect(textOf(res)).not.toContain('没找到 Ghidra')
    expect(spawnProbe).not.toHaveBeenCalled()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
