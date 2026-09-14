/**
 * 转交目标项目解析（09-P2）：显式参数 > 全局活动项目；显式但未注册一律报错。
 *
 * 为什么必须报错而不能静默回落：`projectName` 会被写进开发会话的 dev-context，
 * 若它解析不出路径，`resolveDevContext` 会静默退回全局 workspace——
 * 任务就在错误目录里执行了（正是 09 文档 §一 记录的那类失败）。
 */

import { describe, expect, it } from 'vitest'
import { resolveHandoffProject } from './bridge-tool-registrar-handoff'
import type { CodingDevConfigSlice } from '../coding-dev-env'

const CFG: CodingDevConfigSlice = {
  codingDevProjects: [
    { name: 'lumii', realPath: 'C:/work/lumii', isExternal: true },
    { name: 'blog', realPath: 'C:/work/blog', isExternal: false },
  ],
  codingDevActiveProject: 'lumii',
}

describe('resolveHandoffProject', () => {
  it('显式项目名优先于全局活动项目', () => {
    expect(resolveHandoffProject(CFG, 'blog')).toEqual({ ok: true, projectName: 'blog' })
  })

  it('省略参数时回落到全局活动项目', () => {
    expect(resolveHandoffProject(CFG, undefined)).toEqual({ ok: true, projectName: 'lumii' })
  })

  it('纯空白参数视为省略（回落活动项目）', () => {
    expect(resolveHandoffProject(CFG, '   ')).toEqual({ ok: true, projectName: 'lumii' })
  })

  it('项目名两侧空白被裁剪', () => {
    expect(resolveHandoffProject(CFG, '  blog  ')).toEqual({ ok: true, projectName: 'blog' })
  })

  it('显式指定未注册项目 → 报错，并列出已注册项目供模型纠正', () => {
    const r = resolveHandoffProject(CFG, 'nope')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('nope')
      expect(r.error).toContain('lumii')
      expect(r.error).toContain('blog')
    }
  })

  it('无活动项目且未指定 → 不带 projectName（回落 Agent 绑定 / 全局默认）', () => {
    expect(resolveHandoffProject({ codingDevProjects: CFG.codingDevProjects }, undefined)).toEqual({
      ok: true,
    })
  })

  it('完全无配置且未指定 → 不报错（兼容未注册任何项目的机器）', () => {
    expect(resolveHandoffProject({}, undefined)).toEqual({ ok: true })
  })

  it('完全无配置但显式指定项目 → 仍报错（不能凭空虚造项目）', () => {
    const r = resolveHandoffProject({}, 'lumii')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('（无）')
  })
})
