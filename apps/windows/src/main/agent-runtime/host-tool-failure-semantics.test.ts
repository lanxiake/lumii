/**
 * 宿主工具失败语义守卫（批次 1 宿主侧延伸）
 *
 * 契约见 `packages/agent-runtime/src/types/tool.ts` 的 `MtBotToolResult`：
 * 工具失败必须产**顶层** `isError`——那才是 ToolRunner / ToolRegistry / 模型认得的信号。
 *
 * 宿主侧的特殊性：内置工具的 execute 直接返回 `isError`，而宿主工具有**两套载荷约定**
 * 表达失败（`ok:false` 与 `status:'error'`，共 196 处），由 `bridge-utils.ts` 的
 * `jsonToolResult` 统一提到顶层。所以宿主的契约只有一个判定点——本守卫围绕它守三件事：
 *
 * | 断言 | 守什么 |
 * | --- | --- |
 * | A | `jsonToolResult` 对每种载荷的判定正确——**含刻意不标的那几种** |
 * | B | 失败载荷的形状规范（防止新写的分支用第三种约定，静默漏判） |
 *
 * ## 为什么 A 里"不标"的用例比"标"的更重要
 *
 * 契约第 3 条列举的例外（云同步超时 / 搜索零结果 / 用户取消 …）在宿主侧**真实存在**：
 * `bridge-tool-registrar-sync.ts` 的两条文案里明写着「**不要重复调用本工具**」——
 * 一旦把它们标成失败，Agent 会恰好去重复调用，把「不让它重排落决」的设计意图反转。
 * 这类"统一时顺手抹掉例外"是本批次最容易犯的错，所以逐条钉死。
 *
 * 类型系统在这里管不了：`jsonToolResult(data: unknown)` 的入参是 unknown，
 * 载荷形状是运行时约定，只能靠断言。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { jsonToolResult } from './bridge-utils'

const HERE = __dirname

/** 取出结果的文本载荷（jsonToolResult 把 data 序列化进 content[0].text） */
function payloadOf(result: { content: ReadonlyArray<unknown> }): unknown {
  const first = result.content[0] as { text?: string } | undefined
  return JSON.parse(first?.text ?? 'null')
}

describe('宿主工具失败语义守卫', () => {
  // ────────────────────────────────────────────
  // A. 识别逻辑：标失败的四种载荷
  // ────────────────────────────────────────────
  describe('A1. 失败载荷被提到顶层 isError', () => {
    it.each([
      ['ok: false（102 处宿主工具的主约定）', { ok: false, error: 'capture_failed' }],
      ['ok: false + 动态值（如 ok: res.ok）', { ok: false, agentId: 'a', error: 'x' }],
      ['status: error（94 处的主约定）', { status: 'error', message: '云同步未初始化' }],
      ['status: not_found（删除时目标不存在）', { status: 'not_found', id: 'job-1' }],
      ['status: partial（批量操作部分失败）', { status: 'partial', errors: [] }],
    ])('%s', (_label, payload) => {
      const r = jsonToolResult(payload)
      expect(r.isError, `${_label} 应被标为失败`).toBe(true)
      // 载荷本体必须原样保留——模型要看到 ok:false / status 与错误详情
      expect(payloadOf(r)).toEqual(payload)
    })
  })

  // ────────────────────────────────────────────
  // A2. 识别逻辑：**刻意不标**的载荷（契约第 3 条）
  // ────────────────────────────────────────────
  describe('A2. 非理想结局不得被误标（契约第 3 条）', () => {
    it.each([
      [
        '云同步 running —— 文案明写「不要重复调用本工具」（3a）',
        {
          status: 'running',
          message: '上一轮落决仍在后台执行，本次请求**未排队**。不要重复调用本工具。',
        },
      ],
      [
        '云同步 started —— 落决已在后台启动（3a）',
        { status: 'started', message: '落决已在后台启动。**不要重复调用本工具**。' },
      ],
      [
        '开发转交 proposed —— 宿主未启用自动执行时的正常终态',
        { status: 'proposed', handoffId: 'h1', message: '已生成转交提案。' },
      ],
      ['任务删除成功 ok', { status: 'ok', id: 'job-1' }],
      ['搜索零结果（3b）', { results: [], provider: 'none', query: 'x', note: 'no match' }],
      ['普通数据载荷', { channels: [{ id: 'weixin' }] }],
    ])('%s', (_label, payload) => {
      const r = jsonToolResult(payload)
      expect(r.isError, `${_label} 不得被标为失败`).toBeFalsy()
    })
  })

  // ────────────────────────────────────────────
  // B. 形状规范：防止新写的失败分支用第三种约定
  // ────────────────────────────────────────────
  describe('B. 失败载荷的形状规范', () => {
    /**
     * 扫描所有 `jsonToolResult({...})` 的**对象字面量**实参：
     * 含失败字样、却既无 `ok` 也无 `status` 的，就是 jsonToolResult 认不出的形状——
     * 它会被静默当作成功（正是本批次要消灭的那种"模型得自己读"的失败）。
     *
     * 历史证据：`bridge-tool-registrar-guide.ts` 曾有一处 `{ error: ..., available_sections }`，
     * 形状与其余 196 处都不同，是扫描中唯一被漏判的失败返回。
     */
    function scanMalformedFailurePayloads(): string[] {
      const bad: string[] = []
      for (const f of readdirSync(HERE)) {
        if (!f.startsWith('bridge-') || !f.endsWith('.ts') || f.endsWith('.test.ts')) continue
        const src = readFileSync(join(HERE, f), 'utf8')
        const re = /jsonToolResult\(/g
        let m: RegExpExecArray | null
        while ((m = re.exec(src)) !== null) {
          // 取实参（花括号匹配）
          let i = m.index + m[0].length - 1
          let depth = 0
          let j = i
          for (; j < src.length; j++) {
            const c = src[j]
            if (c === '{') depth++
            else if (c === '}') {
              depth--
              if (depth === 0) break
            }
          }
          const inner = src.slice(m.index + m[0].length, j).trim()
          if (!inner.startsWith('{')) continue // 变量 / 函数调用实参
          if (/\bok\s*:/.test(inner) || /\bstatus\s*:/.test(inner)) continue // 形状规范
          if (/error|failed|失败|invalid|required|not found/i.test(inner)) {
            const line = src.slice(0, m.index).split(/\r?\n/).length
            bad.push(`${f}:${line} → ${inner.replace(/\s+/g, ' ').slice(0, 80)}`)
          }
        }
      }
      return bad
    }

    it('没有「含失败字样却无 ok/status 字段」的载荷', () => {
      const bad = scanMalformedFailurePayloads()
      expect(
        bad,
        `以下 jsonToolResult 载荷带失败语义，但既没有 \`ok\` 也没有 \`status\` 字段——\n` +
          `jsonToolResult 认不出它们，会被当成成功返回（模型只能自己读文本猜）。\n` +
          `修法：补 \`ok: false\`（或 \`status: 'error'\`），与其余 196 处保持一致。\n\n` +
          bad.join('\n'),
      ).toEqual([])
    })

    it('守卫自身有效：上述扫描能抓到不规范形状', () => {
      // 元测试——防止正则写错导致扫描永远返回空
      const probe = `jsonToolResult({ error: 'boom', available_sections: [] })`
      const inner = probe.slice(probe.indexOf('(') + 1, probe.lastIndexOf(')'))
      const looksMalformed =
        !/\bok\s*:/.test(inner) && !/\bstatus\s*:/.test(inner) && /error|failed/i.test(inner)
      expect(looksMalformed).toBe(true)
    })
  })
})
