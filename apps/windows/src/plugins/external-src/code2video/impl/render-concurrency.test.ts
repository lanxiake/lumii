/**
 * 并发渲染的守卫测试。
 *
 * 核心风险不是「并发跑不起来」，而是**节序乱了**：并发下各节完成顺序是随机的，
 * 按完成顺序拼起来的视频节序就是错的。这里用一个假浏览器验证：
 * 1. 产出顺序必须按节号，不按完成时间
 * 2. 每个 worker 用自己的浏览器（同一个窗口被两个循环驱动会互相踩 `__seek`）
 * 3. revise 时未点名的节被复用，不重渲
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { renderStoryboard, type BrowserLike, type RenderDeps } from './render-backend'
import type { StoryboardSection } from './teaching-core'

function section(n: number): StoryboardSection {
  return {
    id: `section_${n}`,
    title: `第 ${n} 节`,
    lectureLines: ['a', 'b'],
    animations: ['x', 'y'],
    targetSeconds: 6,
    scene: [
      { elements: [{ kind: 'rect', x: 10, y: 10, w: 20, h: 20 }] },
      { elements: [{ kind: 'rect', x: 10, y: 40, w: 20, h: 20 }] },
    ],
  }
}

/** 假浏览器：每节按可控延迟「渲染」，记录哪个浏览器渲了哪一节 */
function fakeDeps(opts: {
  delayMs?: (n: number) => number
  dir: string
}): { deps: RenderDeps; browsers: string[]; rendered: string[] } {
  const browsers: string[] = []
  const rendered: string[] = []
  let seq = 0

  const deps: RenderDeps = {
    launchBrowser: async (): Promise<BrowserLike> => {
      const id = `b${++seq}`
      browsers.push(id)
      return {
        renderSection: async (html, outMp4) => {
          // 从 html 里抠不出节号，用输出文件名判断
          const n = Number(/section_(\d+)\.mp4$/.exec(outMp4)?.[1] ?? 0)
          rendered.push(`${id}:${n}`)
          await new Promise((r) => setTimeout(r, opts.delayMs?.(n) ?? 5))
          fs.writeFileSync(outMp4, 'fake')
        },
        close: async () => {},
      }
    },
    ffmpeg: {
      resolve: async () => 'ffmpeg',
      run: async (args) => {
        // concat 时按输入顺序写一个「合并记录」供断言
        const out = args[args.length - 1]!
        if (typeof out === 'string') fs.writeFileSync(out, args.join(' '))
        return { ok: true, stderr: '' }
      },
    },
    outDir: opts.dir,
    log: vi.fn(),
  }
  return { deps, browsers, rendered }
}

describe('renderStoryboard 并发', () => {
  it('节序按节号，不按完成时间（第 1 节最慢）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2v-par-'))
    // 第 1 节故意最慢：如果按完成顺序拼，它会排到最后
    const { deps } = fakeDeps({ dir, delayMs: (n) => (n === 1 ? 40 : 5) })
    const r = await renderStoryboard(
      { sections: [section(1), section(2), section(3)] },
      { ...deps, concurrency: 3 },
    )
    expect(r.ok).toBe(true)
    expect(r.sectionVideos.map((p) => path.basename(p))).toEqual([
      'section_1.mp4',
      'section_2.mp4',
      'section_3.mp4',
    ])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('每个 worker 用自己的浏览器实例', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2v-par-'))
    const { deps, browsers } = fakeDeps({ dir })
    await renderStoryboard(
      { sections: [section(1), section(2), section(3), section(4)] },
      { ...deps, concurrency: 2 },
    )
    // 2 个 worker 各一个浏览器；同一窗口被两个循环驱动会互相踩 __seek
    expect(browsers).toHaveLength(2)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('concurrency=1 时退化为串行（一个浏览器）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2v-par-'))
    const { deps, browsers } = fakeDeps({ dir })
    await renderStoryboard(
      { sections: [section(1), section(2)] },
      { ...deps, concurrency: 1 },
    )
    expect(browsers).toHaveLength(1)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('worker 数不超过节数', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2v-par-'))
    const { deps, browsers } = fakeDeps({ dir })
    await renderStoryboard({ sections: [section(1)] }, { ...deps, concurrency: 5 })
    expect(browsers).toHaveLength(1)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('revise 时未点名的节复用已有 mp4，不重渲', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2v-par-'))
    // 预先放好第 2、3 节的成片
    fs.writeFileSync(path.join(dir, 'section_2.mp4'), 'old')
    fs.writeFileSync(path.join(dir, 'section_3.mp4'), 'old')
    const { deps, rendered } = fakeDeps({ dir })
    const r = await renderStoryboard(
      { sections: [section(1), section(2), section(3)] },
      { ...deps, onlySections: new Set([1]) },
    )
    expect(r.ok).toBe(true)
    // 只渲了第 1 节
    expect(rendered).toEqual(['b1:1'])
    expect(r.sectionVideos).toHaveLength(3)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
