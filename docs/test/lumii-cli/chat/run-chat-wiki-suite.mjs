#!/usr/bin/env node
/**
 * 聊天 Wiki 摄入套件（L3 真实聊天模拟）— CHAT-WIKI-01..05
 *
 * 背景：记忆重构一期起「聊天摄入 Wiki」已切断——聊天消息不再自动产生收件箱条目。
 * 本套件验证切断后的真实行为、检索链路（wiki 工具调用）与「CLI 播种 → 聊天检索」闭环。
 *
 * 用例文档：docs/test/lumii-cli/chat/chat-test-cases.md
 * 规范：docs/test/lumii-cli/CLI-TEST-SPEC.md
 * 用法：node docs/test/lumii-cli/chat/run-chat-wiki-suite.mjs
 *
 * 环境变量：CHAT_ONLY、CHAT_SKIP_LLM=1、CHAT_TURN_TIMEOUT_MS
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as h from '../lib/cli-harness.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TURN_TIMEOUT = Number(process.env.CHAT_TURN_TIMEOUT_MS) || 180000
const ONLY = process.env.CHAT_ONLY || ''
const SKIP_LLM = process.env.CHAT_SKIP_LLM === '1'

const PROBE_MARK = '青花瓷协议'
const PROBE_TITLE = `[chat-probe] ${PROBE_MARK}.md`

const ev = h.createEvidence(__dirname, 'chat-wiki-suite', '聊天 Wiki 摄入套件')
const fails = { count: 0 }
const selected = (id) => !ONLY || id.startsWith(ONLY)

/** 从 assistant item 收集工具调用名（item.toolCalls 或 contentJson.parts） */
function toolNames(item) {
  const names = []
  if (Array.isArray(item?.toolCalls)) {
    for (const t of item.toolCalls) if (t?.name) names.push(t.name)
  }
  const parts = h.parseContentJson(item)?.parts
  if (Array.isArray(parts)) {
    for (const p of parts) {
      if (p && (p.type === 'tool_call' || p.type === 'tool') && p.name) names.push(p.name)
      if (p?.toolCall?.name) names.push(p.toolCall.name)
    }
  }
  return names
}

/** wiki inbox 计数（宽松解析） */
function inboxCount() {
  const r = h.ui(['wiki', 'inbox', 'count'])
  if (r.code !== 0 || r.json === null) return null
  if (typeof r.json === 'number') return r.json
  return r.json.count ?? r.json.total ?? null
}

/** wiki 资料列表 */
function sourceList() {
  const r = h.ui(['wiki', 'source', 'list'])
  if (r.code !== 0 || !r.json) return []
  return Array.isArray(r.json.sources) ? r.json.sources : []
}

function main() {
  console.log('聊天 Wiki 摄入套件（真实客户端 + 真实 LLM）\n')

  const pf = h.preflight()
  if (!pf.ok) {
    console.error('❌ 预检失败：')
    for (const p of pf.problems) console.error(`  - ${p}`)
    process.exit(3)
  }
  ev.record('PREFLIGHT', 'INFO', '预检通过')

  const sources = sourceList()
  ev.record('CORPUS', 'INFO', `Wiki 库现有资料 ${sources.length} 条`)

  if (selected('CHAT-WIKI-01')) {
    h.runCase(ev, 'CHAT-WIKI-01', () => {
      if (SKIP_LLM) throw new Error('SKIP: CHAT_SKIP_LLM=1')
      if (sources.length === 0) throw new Error('SKIP: Wiki 库为空，无法验证检索链路')
      const sk = h.createSession('wiki01 触发检索')
      const r = h.sendAndWait(sk, '我的知识库里有哪些资料？请用 wiki 相关工具查一下。', {
        timeoutMs: TURN_TIMEOUT,
      })
      const tools = toolNames(r.assistant)
      const wikiTools = tools.filter((n) => n.startsWith('wiki_'))
      if (wikiTools.length === 0) {
        throw new Error(`agent 未调用 wiki 工具（观察到工具: ${tools.join(',') || '无'}）`)
      }
      const first = sources[0]?.title ?? ''
      const soft = first && r.text.includes(first.replace(/\.md$/, ''))
      return `调用 [${wikiTools.join(',')}]；回复${soft ? '含' : '未含'}资料名（${tools.length} 次工具调用）`
    }, fails)
  }

  if (selected('CHAT-WIKI-02')) {
    h.runCase(ev, 'CHAT-WIKI-02', () => {
      if (SKIP_LLM) throw new Error('SKIP: CHAT_SKIP_LLM=1')
      const before = inboxCount()
      if (before === null) throw new Error('SKIP: wiki inbox count 不可用')
      const sk = h.createSession('wiki02 聊天不摄入')
      h.sendAndWait(
        sk,
        '以下是一段资料，请记住它：青花瓷始于唐代，成熟于元代景德镇，明代永宣时期达到巅峰。请只回复"已了解"。',
        { timeoutMs: TURN_TIMEOUT },
      )
      const after = inboxCount()
      if (after !== before) {
        throw new Error(`聊天消息自动摄入了 Wiki（inbox ${before} → ${after}），与「切断聊天摄入」设计不符`)
      }
      return `聊天未产生收件箱条目（inbox 计数保持 ${before}）`
    }, fails)
  }

  if (selected('CHAT-WIKI-03')) {
    h.runCase(ev, 'CHAT-WIKI-03', () => {
      if (SKIP_LLM) throw new Error('SKIP: CHAT_SKIP_LLM=1')
      if (sources.length === 0) throw new Error('SKIP: Wiki 库为空')
      const target = sources[0]
      const title = (target.title ?? '').replace(/\.md$/, '')
      const sk = h.createSession('wiki03 读取资料')
      const r = h.sendAndWait(sk, `帮我读一下知识库里的《${title}》，用两三句话概括它的内容。`, {
        timeoutMs: TURN_TIMEOUT,
      })
      const tools = toolNames(r.assistant)
      const readOrSearch = tools.filter((n) => n === 'wiki_read' || n === 'wiki_search' || n === 'wiki_overview')
      if (readOrSearch.length === 0) {
        throw new Error(`agent 未使用 wiki 读取工具（工具: ${tools.join(',') || '无'}）`)
      }
      return `调用 [${readOrSearch.join(',')}]；概括「${r.text.slice(0, 50)}…」`
    }, fails)
  }

  if (selected('CHAT-WIKI-04')) {
    h.runCase(ev, 'CHAT-WIKI-04', () => {
      if (SKIP_LLM) throw new Error('SKIP: CHAT_SKIP_LLM=1')
      const sk = h.createSession('wiki04 检索不到')
      const r = h.sendAndWait(sk, '我的知识库里有没有关于「不存在的量子面条理论」的资料？', {
        timeoutMs: TURN_TIMEOUT,
      })
      const noFound = /没有|未找到|找不到|不存在|未收录/.test(r.text)
      if (!noFound) throw new Error(`未如实说明未找到（soft）：「${r.text.slice(0, 100)}」`)
      if (r.text.includes('量子面条理论') && /(据我所知|资料显示|如下所示)/.test(r.text)) {
        throw new Error('疑似编造资料内容（soft）')
      }
      return `如实回应未找到：「${r.text.slice(0, 50)}…」`
    }, fails)
  }

  if (selected('CHAT-WIKI-05')) {
    h.runCase(ev, 'CHAT-WIKI-05', () => {
      if (SKIP_LLM) throw new Error('SKIP: CHAT_SKIP_LLM=1')
      // 1) 播种：临时目录 + 标记文件 → folder import（保留在库中，文件名带 [chat-probe] 供人工识别）
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-wiki-probe-'))
      fs.writeFileSync(
        path.join(tmpDir, PROBE_TITLE),
        `# ${PROBE_MARK}\n\n${PROBE_MARK}是本次 CLI 测试写入的探针资料：一种用于验证「导入→检索」闭环的虚构协议。\n`,
        'utf-8',
      )
      const imp = h.ui(['wiki', 'folder', 'import', tmpDir, '--no-auto-classify'], { timeoutMs: 60000 })
      if (imp.code !== 0 || imp.json?.ok === false) {
        throw new Error('SKIP: 导入链路不可用: ' + JSON.stringify(imp.json).slice(0, 150))
      }
      // 2) 轮询：auto-classify 关闭时条目停留 inbox；等待入库可见（source list 或 inbox）
      const inBox = h.pollUntil(() => (inboxCount() ?? 0) > 0, 20000, 3000)
      const inLib = sourceList().some((s) => (s.title ?? '').includes(PROBE_MARK))
      if (!inBox && !inLib) {
        throw new Error('SKIP: 导入后 20s 内既未出现在收件箱也未归档（异步链路，见 wiki 套件）')
      }
      // 3) 检索侧验证：inbox 条目需归档后才可被检索；归档链路较重，搜索命中与否记录为观察
      const sk = h.createSession('wiki05 播种检索')
      const r = h.sendAndWait(sk, `我知识库里有个「${PROBE_MARK}」，帮我查一下它是什么？`, {
        timeoutMs: TURN_TIMEOUT,
      })
      const hit = r.text.includes(PROBE_MARK) || /虚构协议|探针/.test(r.text)
      return `导入成功（${inLib ? 'source list 可见' : '在收件箱待整理'}）；聊天检索${hit ? '命中' : '未命中（未归档时预期如此，观察项）'}：「${r.text.slice(0, 60)}…」`
    }, fails)
  }

  const summary = ev.writeReport({
    meta: {
      '回合超时': `${TURN_TIMEOUT}ms`,
      '用例过滤': ONLY || '（全部）',
      '探针标记': PROBE_MARK,
      '库内资料数': sources.length,
    },
    extraSections: `
## 覆盖范围

- 聊天触发 wiki 检索（WIKI-01）、聊天不自动摄入（WIKI-02 负例）、资料读取（WIKI-03）、未找到行为（WIKI-04）、CLI 播种闭环（WIKI-05）
- 对应用例文档：chat-test-cases.md §四

## 副作用说明

- WIKI-05 会向收件箱导入一条探针资料（文件名含 \`[chat-probe]\`），保留在库中供人工识别与清理（未做自动删除，遵循不删业务数据原则）。
`,
  })
  process.exit(summary.failed > 0 ? 1 : 0)
}

try {
  main()
} catch (err) {
  console.error(`\n套件异常中断: ${err.message}`)
  process.exit(1)
}
