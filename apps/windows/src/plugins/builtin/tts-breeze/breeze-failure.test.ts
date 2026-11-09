import { describe, expect, it } from 'vitest'
import { classifyBreezeFailure, describeBreezeFailure } from './breeze-failure'
import { parseNetstatListeners } from './breeze-port'

describe('Breeze 启动失败分类', () => {
  it('缺依赖：白名单内给出 pip 规格', () => {
    const f = classifyBreezeFailure("ModuleNotFoundError: No module named 'uvicorn'")
    expect(f).toEqual({ kind: 'missing-module', module: 'uvicorn', pipSpec: 'uvicorn>=0.30' })
  })

  it('缺依赖：子模块按顶层包算；未知包不自动装', () => {
    expect(classifyBreezeFailure("No module named 'multipart.multipart'").pipSpec).toBe('python-multipart>=0.0.18')
    expect(classifyBreezeFailure("No module named 'evilpkg'").pipSpec).toBeUndefined()
  })

  it('显存不足 / fast 路径 / 端口 / 模型损坏', () => {
    expect(classifyBreezeFailure('torch.OutOfMemoryError: CUDA out of memory').kind).toBe('cuda-oom')
    expect(classifyBreezeFailure('torch._inductor.exc.TritonMissing: ...').kind).toBe('fast-path')
    expect(classifyBreezeFailure('[Errno 10048] error while attempting to bind on address').kind).toBe('port-in-use')
    expect(classifyBreezeFailure('safetensors_rust.SafetensorError: Error while deserializing header').kind).toBe(
      'model-broken',
    )
    expect(classifyBreezeFailure('something else').kind).toBe('unknown')
  })

  it('未知错误的提示带上 stderr 最后两行', () => {
    const msg = describeBreezeFailure({ kind: 'unknown' }, 'a\nb\nRuntimeError: boom\n')
    expect(msg).toContain('RuntimeError: boom')
  })
})

describe('netstat 解析', () => {
  const out = [
    '  TCP    0.0.0.0:7860           0.0.0.0:0              LISTENING       100',
    '  TCP    127.0.0.1:78601        0.0.0.0:0              LISTENING       200',
    '  TCP    127.0.0.1:5000         127.0.0.1:7860         ESTABLISHED     300',
    '  TCP    [::]:7860              [::]:0                 LISTENING       100',
  ].join('\r\n')

  it('只认本地地址端口完全匹配的监听者', () => {
    expect(parseNetstatListeners(out, 7860)).toEqual([100])
  })
})
