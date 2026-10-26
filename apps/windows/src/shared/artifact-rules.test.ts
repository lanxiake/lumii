import { describe, expect, it } from 'vitest'
import { classifyArtifact, kindOf, stageOfTool } from './artifact-rules'

describe('classifyArtifact', () => {
  it('中间产物目录与切片文件名', () => {
    expect(classifyArtifact({ path: 'outputs/x/parts-10/a.png' })).toBe('intermediate')
    expect(classifyArtifact({ path: 'outputs/x/parts/a.png' })).toBe('intermediate')
    expect(classifyArtifact({ path: 'outputs/x/normalized/a.png' })).toBe('intermediate')
    expect(classifyArtifact({ path: 'outputs/x/frames/0001.png' })).toBe('intermediate')
    expect(classifyArtifact({ path: 'outputs/x/cut-13.png' })).toBe('intermediate')
  })

  it('cut- 只认词根，不误伤 cutting-board', () => {
    expect(classifyArtifact({ path: 'outputs/x/cutting-board.png' })).toBe('deliverable')
    expect(classifyArtifact({ path: 'outputs/x/re-cut.png' })).toBe('deliverable')
  })

  it('temp 是 ephemeral，记账/缓存是 internal', () => {
    expect(classifyArtifact({ path: 'temp/github3/repo/a.md' })).toBe('ephemeral')
    expect(classifyArtifact({ path: 'wiki/a.md.lumii-ref' })).toBe('internal')
    expect(classifyArtifact({ path: 'node_modules/x/index.js' })).toBe('internal')
    expect(classifyArtifact({ path: '.git/HEAD' })).toBe('internal')
    expect(classifyArtifact({ path: '.lumii/trash/a.png' })).toBe('internal')
    expect(classifyArtifact({ path: 'outputs/x/.hidden.png' })).toBe('internal')
    expect(classifyArtifact({ path: 'outputs/x/run.log.tmp' })).toBe('internal')
  })

  it('认不出的一律 deliverable', () => {
    expect(classifyArtifact({ path: 'outputs/pet-demo/final.png' })).toBe('deliverable')
    expect(classifyArtifact({ path: 'uploads/2026-10-26/photo.jpg' })).toBe('deliverable')
    expect(classifyArtifact({ path: 'README.md' })).toBe('deliverable')
  })
})

describe('kindOf', () => {
  it('按扩展名分类', () => {
    expect(kindOf('a/b/cover.PNG')).toBe('image')
    expect(kindOf('a/clip.mp4')).toBe('video')
    expect(kindOf('a/voice.mp3')).toBe('audio')
    expect(kindOf('a/doc.md')).toBe('doc')
    expect(kindOf('a/deck.pptx')).toBe('slides')
    expect(kindOf('a/sheet.xlsx')).toBe('sheet')
    expect(kindOf('a/index.html')).toBe('site')
    expect(kindOf('a/main.py')).toBe('code')
    expect(kindOf('a/bundle.zip')).toBe('archive')
    expect(kindOf('a/没有扩展名')).toBe('other')
    expect(kindOf('a/weird.xyz')).toBe('other')
  })
})

describe('stageOfTool', () => {
  it('已知工具给用户语言，未知不猜', () => {
    expect(stageOfTool('image_generate')).toBe('生成图片')
    expect(stageOfTool('mcp__comfyui__enqueue_workflow')).toBe('渲染视频')
    expect(stageOfTool('ffmpeg')).toBe('编码视频')
    expect(stageOfTool('pptx_generate')).toBe('生成幻灯片')
    expect(stageOfTool('write_file')).toBe('撰写文档')
    expect(stageOfTool('bash')).toBe('执行命令')
    expect(stageOfTool('read_file')).toBe('读取资料')
    expect(stageOfTool('todo_write')).toBeUndefined()
  })
})
