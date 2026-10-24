import { describe, expect, it } from 'vitest'
import { buildRemoteMediaUrl, REMOTE_MEDIA_SCHEME } from './remote-media-url'

describe('buildRemoteMediaUrl', () => {
  it('把远端地址包进代理 scheme，原始 URL 完整编码', () => {
    const remote = 'https://cfui2.cpolar.top/view?filename=a.mp4&subfolder=h3/x&type=output'
    const proxied = buildRemoteMediaUrl(remote)
    expect(proxied.startsWith(`${REMOTE_MEDIA_SCHEME}://media/?src=`)).toBe(true)
    const src = new URL(proxied).searchParams.get('src')
    expect(src).toBe(remote)
  })

  it('往返可还原（含中文与空格）', () => {
    const remote = 'https://x.test/view?filename=%E4%B8%AD%E6%96%87 name.png'
    const back = new URL(buildRemoteMediaUrl(remote)).searchParams.get('src')
    expect(back).toBe(remote)
  })

  it('凭据不出现在代理地址里', () => {
    const proxied = buildRemoteMediaUrl('https://cfui2.cpolar.top/view?filename=a.png')
    expect(proxied).not.toContain('YWRtaW46')
    expect(proxied).not.toContain('Basic')
  })
})
