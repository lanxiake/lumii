import { describe, expect, it } from 'vitest'
import { mediaSrc } from './ResultPreviewPanel'
import type { BackgroundTaskOutput } from '../../../../../shared/agent-runtime-events'

const base: BackgroundTaskOutput = { name: 'a.png', path: 'a.png', kind: 'image' }

describe('mediaSrc', () => {
  it('有 previewUrl 时优先用它（需要鉴权的远端产出只能走代理）', () => {
    expect(
      mediaSrc({
        ...base,
        url: 'https://cfui/view?filename=a.png',
        previewUrl: 'lumii-remote://media/?src=https%3A%2F%2Fcfui%2Fview',
      }),
    ).toBe('lumii-remote://media/?src=https%3A%2F%2Fcfui%2Fview')
  })

  it('没有 previewUrl 时回落到 url（普通免鉴权产出）', () => {
    expect(mediaSrc({ ...base, url: 'https://x/a.png' })).toBe('https://x/a.png')
  })

  it('两者都没有时返回 undefined（调用方应整段不渲染）', () => {
    expect(mediaSrc(base)).toBeUndefined()
  })
})
