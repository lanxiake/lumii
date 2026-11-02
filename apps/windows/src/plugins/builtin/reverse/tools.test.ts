/**
 * `reverse_probe` 工具：缺工具时的报法、输出校验、失败路径。
 *
 * 这三条都是**静默失败**的高发区：
 * - 缺工具时若直接抛，模型会以为目标文件有问题；
 * - 探针「跑完了但输出不完整」比报错更危险（模型拿半截输出当结论）；
 * - 脚本资产缺失（开发态忘构建）会列出一个一调就崩的工具。
 */
import { describe, expect, it, vi } from 'vitest'

import { createReverseProbeToolConfig } from './tools'
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
