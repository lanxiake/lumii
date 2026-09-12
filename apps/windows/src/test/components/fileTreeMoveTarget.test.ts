/**
 * moveRefreshDirs：拖拽移动的目标校验与局部刷新目录推导
 */
import { describe, it, expect } from 'vitest'
import { moveRefreshDirs } from '../../renderer/pages/ChatPage/components/WorkspaceFilePanel/FileTree'

const ROOT = 'C:/ws'

describe('moveRefreshDirs', () => {
  it('文件移入别的目录：刷新源父目录与目标父目录', () => {
    expect(moveRefreshDirs(`${ROOT}/a/f.txt`, `${ROOT}/b`)).toEqual([ROOT, `${ROOT}/a`, `${ROOT}/b`])
  })

  it('嵌套目标：目标父目录也在刷新列表内', () => {
    expect(moveRefreshDirs(`${ROOT}/a/f.txt`, `${ROOT}/b/c`)).toEqual([`${ROOT}/b`, `${ROOT}/a`, `${ROOT}/b/c`])
  })

  it('反斜杠路径与尾部斜杠归一化后同样生效', () => {
    expect(moveRefreshDirs(`${ROOT}\\a\\f.txt`, `${ROOT}\\b\\`)).toEqual([ROOT, `${ROOT}/a`, `${ROOT}/b`])
  })

  it('拖回原目录：无变化，返回 null', () => {
    expect(moveRefreshDirs(`${ROOT}/a/f.txt`, `${ROOT}/a`)).toBeNull()
  })

  it('拖到自身：返回 null', () => {
    expect(moveRefreshDirs(`${ROOT}/a`, `${ROOT}/a`)).toBeNull()
  })

  it('拖入自己的子孙目录：返回 null（Windows 会直接失败）', () => {
    expect(moveRefreshDirs(`${ROOT}/a`, `${ROOT}/a/b/c`)).toBeNull()
  })

  it('同名前缀的不同目录不算子孙（a 与 ab）', () => {
    expect(moveRefreshDirs(`${ROOT}/a/f.txt`, `${ROOT}/ab`)).toEqual([ROOT, `${ROOT}/a`, `${ROOT}/ab`])
  })

  it('空路径返回 null', () => {
    expect(moveRefreshDirs('', `${ROOT}/a`)).toBeNull()
  })
})
