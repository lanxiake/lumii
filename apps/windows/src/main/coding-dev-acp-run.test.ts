import { describe, it, expect } from 'vitest'
import { stripUserEcho } from './coding-dev-acp-run.js'

describe('stripUserEcho', () => {
  it('移除开头回显的用户输入', () => {
    expect(stripUserEcho('你好\n\n你好！有什么可以帮你的？', '你好')).toBe('你好！有什么可以帮你的？')
  })

  it('回显前有空白也能识别', () => {
    expect(stripUserEcho('\n  切换后端\n结果如下', '切换后端')).toBe('结果如下')
  })

  it('不以用户输入开头时原样返回', () => {
    expect(stripUserEcho('好的，你好', '你好')).toBe('好的，你好')
  })

  it('用户输入为空时原样返回', () => {
    expect(stripUserEcho('  你好', '   ')).toBe('  你好')
  })

  it('整段都是回显时返回空串', () => {
    expect(stripUserEcho('你好', '你好')).toBe('')
  })
})
