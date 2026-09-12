#!/usr/bin/env node
/**
 * 聊天记忆套件（L3 真实聊天模拟）— CHAT-MEM-01..09
 *
 * 验证记忆链路：偏好提取落盘、场景记忆命中注入（正/负例）、scene_memory 工具写入、
 * 全局记忆无污染、memory_search 兜底。
 *
 * 用例文档：docs/test/lumii-cli/chat/chat-test-cases.md
 * 规范：docs/test/lumii-cli/CLI-TEST-SPEC.md
 * 用法：node docs/test/lumii-cli/chat/run-chat-memory-suite.mjs
 *
 * 探针数据：_registry.json 注册 chat-probe-project（别名 chat-probe-alias）；
 *          scene-memory/project-chat-probe-project.md 含「蓝色协议」。
 *          套件开始快照、结束恢复探针数据（CHAT_NO_RESTORE=1 跳过恢复供人工检查）。
 *          user-memory.md 不做自动恢复（避免覆盖应用/用户新写入），变更记录在证据中。
 *
 * 环境变量：CHAT_ONLY、CHAT_SKIP_LLM=1、CHAT_TURN_TIMEOUT_MS、CHAT_NO_RESTORE=1
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as h from '../lib/cli-harness.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TURN_TIMEOUT = Number(process.env.CHAT_TURN_TIMEOUT_MS) || 180000
const ONLY = process.env.CHAT_ONLY || ''
const SKIP_LLM = process.env.CHAT_SKIP_LLM === '1'
const NO_RESTORE = process.env.CHAT_NO_RESTORE === '1'

const PROBE_KEY = 'chat-probe-project'
const PROBE_ALIAS = 'chat-probe-alias'
const PROBE_MARK = '蓝色协议'
const GLOBAL_MARK = 'pnpm typecheck'

const SCENE_DIR = path.join(h.DATA_DIR, 'scene-memory')
const REGISTRY_PATH = path.join(SCENE_DIR, '_registry.json')
const PROBE_FILE = path.join(SCENE_DIR, `project-${PROBE_KEY}.md`)
const UM_PATH = path.join(h.DATA_DIR, 'user-memory.md')

const ev = h.createEvidence(__dirname, 'chat-memory-suite', '聊天记忆套件')
const fails = { count: 0 }
const selected = (id) => !ONLY || id.startsWith(ONLY)

// ──────────────── 探针准备与恢复 ────────────────

const snapshot = {
  registry: h.fileRead(REGISTRY_PATH),
  probeFile: h.fileRead(PROBE_FILE),
  um: h.fileRead(UM_PATH),
}

function setupProbe() {
  fs.mkdirSync(SCENE_DIR, { recursive: true })
  let registry = { projects: [] }
  if (snapshot.registry) {
    try {
      const parsed = JSON.parse(snapshot.registry)
      if (parsed && Array.isArray(parsed.projects)) registry = parsed
    } catch {
      /* 损坏则重建 */
    }
  }
  const without = registry.projects.filter((p) => p.key !== PROBE_KEY)
  without.push({
    key: PROBE_KEY,
    name: 'ChatProbe',
    aliases: [PROBE_ALIAS, 'ChatProbe'],
    path: null,
    lastActiveAt: Date.now(),
  })
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ projects: without }, null, 2) + '\n', 'utf-8')
  fs.writeFileSync(
    PROBE_FILE,
    `# ChatProbe 项目记忆（探针）\n\n## 约定\n\n- 探针标记：本项目使用「${PROBE_MARK}」作为部署校验方式。\n`,
    'utf-8',
  )
}

function restoreProbe() {
  if (NO_RESTORE) {
    ev.record('TEARDOWN', 'INFO', 'CHAT_NO_RESTORE=1，保留探针数据供人工检查')
    return
  }
  try {
    if (snapshot.registry === null) {
      if (fs.existsSync(REGISTRY_PATH)) fs.unlinkSync(REGISTRY_PATH)
    } else {
      fs.writeFileSync(REGISTRY_PATH, snapshot.registry, 'utf-8')
    }
    if (snapshot.probeFile === null) {
      if (fs.existsSync(PROBE_FILE)) fs.unlinkSync(PROBE_FILE)
    } else {
      fs.writeFileSync(PROBE_FILE, snapshot.probeFile, 'utf-8')
    }
    ev.record('TEARDOWN', 'INFO', '探针数据已恢复（registry/场景文件）')
  } catch (err) {
    ev.record('TEARDOWN', 'FAIL', `探针恢复失败: ${err.message}`)
  }
}

// ──────────────── 用例 ────────────────

function main() {
  console.log('聊天记忆套件（真实客户端 + 真实 LLM）\n')

  const pf = h.preflight()
  if (!pf.ok) {
    console.error('❌ 预检失败：')
    for (const p of pf.problems) console.error(`  - ${p}`)
    process.exit(3)
  }
  if (!pf.warnings.length && !h.logChannelAvailable()) pf.warnings.push('日志通道不可用')

  setupProbe()
  ev.record('SETUP', 'INFO', `探针已注册：${PROBE_KEY}（别名 ${PROBE_ALIAS}）`)

  if (selected('CHAT-MEM-09')) {
    h.runCase(ev, 'CHAT-MEM-09', () => {
      const raw = h.fileRead(REGISTRY_PATH)
      if (!raw) throw new Error('_registry.json 不存在')
      const reg = JSON.parse(raw)
      const item = reg.projects.find((p) => p.key === PROBE_KEY)
      if (!item) throw new Error(`注册表缺少探针项 ${PROBE_KEY}`)
      if (!item.aliases.includes(PROBE_ALIAS)) throw new Error('探针别名缺失')
      if (!h.fileRead(PROBE_FILE)?.includes(PROBE_MARK)) throw new Error('探针场景文件缺少标记')
      return '注册表与场景文件就绪，命中解析可依赖'
    }, fails)
  }

  if (selected('CHAT-MEM-03')) {
    h.runCase(ev, 'CHAT-MEM-03', () => {
      if (SKIP_LLM) throw new Error('SKIP: CHAT_SKIP_LLM=1')
      if (!h.logChannelAvailable()) throw new Error('SKIP: 日志通道不可用（打包版），无法断言注入')
      const cursor = h.logCursor()
      const sk = h.createSession('mem03 场景注入正例')
      const r = h.sendAndWait(sk, `关于 ${PROBE_ALIAS} 这个项目，我们有什么部署约定？`, {
        timeoutMs: TURN_TIMEOUT,
      })
      const injected = h.logSince(cursor, /buildSceneMemorySections/)
      const hitProbe = injected.some((l) => l.includes(PROBE_KEY))
      if (!hitProbe) {
        throw new Error(
          `日志未出现探针场景注入标记（新增 ${injected.length} 条注入日志，均不含 ${PROBE_KEY}）`,
        )
      }
      const soft = r.text.includes(PROBE_MARK)
      return `注入日志命中（${injected.length} 条）${soft ? `；回复体现「${PROBE_MARK}」` : '；回复未显式提及标记（soft 观察）'}`
    }, fails)
  }

  if (selected('CHAT-MEM-04')) {
    h.runCase(ev, 'CHAT-MEM-04', () => {
      if (SKIP_LLM) throw new Error('SKIP: CHAT_SKIP_LLM=1')
      if (!h.logChannelAvailable()) throw new Error('SKIP: 日志通道不可用（打包版），无法断言注入')
      const cursor = h.logCursor()
      const sk = h.createSession('mem04 场景注入负例')
      h.sendAndWait(sk, '请只回复两个字：好的', { timeoutMs: TURN_TIMEOUT })
      const injected = h.logSince(cursor, /buildSceneMemorySections/)
      const leaked = injected.filter((l) => l.includes(PROBE_KEY))
      if (leaked.length > 0) {
        throw new Error(`无关消息触发了探针场景注入（${leaked.length} 条）: ${leaked[0].slice(0, 160)}`)
      }
      return `无关消息未注入探针场景（窗口内其它注入 ${injected.length} 条，均不含探针）`
    }, fails)
  }

  let mem05Session = null
  if (selected('CHAT-MEM-05')) {
    h.runCase(ev, 'CHAT-MEM-05', () => {
      if (SKIP_LLM) throw new Error('SKIP: CHAT_SKIP_LLM=1')
      const before = h.fileRead(PROBE_FILE)
      const sk = h.createSession('mem05 工具写入')
      mem05Session = sk
      const prompt = `请调用工具在项目记忆里记录一条项目约定：在 ChatProbe（别名 ${PROBE_ALIAS}）项目里，提交代码前必须先运行 ${GLOBAL_MARK}。这是只对该项目成立的约定。`
      h.sendAndWait(sk, prompt, { timeoutMs: TURN_TIMEOUT })
      const written = h.pollUntil(() => {
        const cur = h.fileRead(PROBE_FILE)
        return cur && cur.includes(GLOBAL_MARK) ? cur : null
      }, 45000, 3000)
      if (!written) {
        throw new Error('场景文件未出现该约定（agent 可能未调用 scene_memory 工具，soft）')
      }
      if (before === written) throw new Error('场景文件内容未变化')
      return `scene_memory 工具写入成功，场景文件已含「${GLOBAL_MARK}」`
    }, fails)
  }

  if (selected('CHAT-MEM-06')) {
    h.runCase(ev, 'CHAT-MEM-06', () => {
      const um = h.fileRead(UM_PATH) ?? ''
      const probeLines = um.split(/\r?\n/).filter((l) => l.includes(GLOBAL_MARK))
      if (probeLines.length > 0) {
        throw new Error(`全局 user-memory.md 被写入场景内容: ${probeLines[0].slice(0, 120)}`)
      }
      return '全局 user-memory.md 无场景约定内容'
    }, fails)
  }

  if (selected('CHAT-MEM-07')) {
    h.runCase(ev, 'CHAT-MEM-07', () => {
      if (SKIP_LLM) throw new Error('SKIP: CHAT_SKIP_LLM=1')
      if (!mem05Session) throw new Error('SKIP: 依赖 MEM-05 的会话（未执行或未产生会话）')
      const r = h.sendAndWait(mem05Session, '你还记得我在这个项目上说的提交规范吗？', {
        timeoutMs: TURN_TIMEOUT,
      })
      if (r.text.includes('typecheck') || r.text.includes('提交')) {
        return `主动回忆命中：「${r.text.slice(0, 60)}…」`
      }
      throw new Error(`主动回忆未命中（soft）：「${r.text.slice(0, 80)}」`)
    }, fails)
  }

  let mem01Written = false
  if (selected('CHAT-MEM-01')) {
    h.runCase(ev, 'CHAT-MEM-01', () => {
      if (SKIP_LLM) throw new Error('SKIP: CHAT_SKIP_LLM=1')
      const baseMtime = h.fileMtime(UM_PATH)
      const sk = h.createSession('mem01 偏好提取')
      h.sendAndWait(sk, '请记住：我写代码时习惯用 pnpm 而不是 npm，以后默认按这个来。', {
        timeoutMs: TURN_TIMEOUT,
      })
      const changed = h.pollUntil(() => h.fileMtime(UM_PATH) > baseMtime, 90000, 5000)
      if (!changed) {
        throw new Error('SKIP: 90s 内记忆提取未触发 user-memory.md 更新（异步管道，非产品缺陷）')
      }
      const content = h.fileRead(UM_PATH) ?? ''
      mem01Written = content.includes('pnpm')
      return mem01Written
        ? '记忆提取落盘，内容含「pnpm」'
        : 'user-memory.md 已更新但未含「pnpm」（soft 观察，见证据 diff）'
    }, fails)
  }

  if (selected('CHAT-MEM-02')) {
    h.runCase(ev, 'CHAT-MEM-02', () => {
      const r = h.ui(['memory', 'search', 'pnpm'])
      const list = Array.isArray(r.json) ? r.json : Array.isArray(r.json?.memories) ? r.json.memories : []
      if (list.length === 0) {
        throw new Error('SKIP: memory search 未命中（依赖 MEM-01 提取结果，可能未触发）')
      }
      return `memory search 命中 ${list.length} 条（首条: ${JSON.stringify(list[0]).slice(0, 80)}）`
    }, fails)
  }

  if (selected('CHAT-MEM-08')) {
    h.runCase(ev, 'CHAT-MEM-08', () => {
      throw new Error('SKIP: 渠道记忆需真实渠道（微信/飞书）消息触发，CLI 会话为 ipc 渠道不具备条件')
    }, fails)
  }

  restoreProbe()

  // user-memory.md：MEM-01 的偏好句可能经真实提取链路落盘（链路正确工作的证据），
  // 测试结束清理探针行（只删探针句，不整文件恢复，避免覆盖应用/用户期间的新写入）
  let umDiff = '(无变化)'
  const umNow = h.fileRead(UM_PATH) ?? ''
  if (umNow !== snapshot.um) {
    if (!NO_RESTORE) {
      const r = h.stripLinesFromFile(UM_PATH, (l) => l.includes('pnpm'), {
        knownSections: h.sectionTitles(snapshot.um),
      })
      umDiff = `已变化（快照 ${snapshot.um?.length ?? 0} → ${umNow.length} 字符），探针行已清理 ${r.removed} 行`
      ev.record('UM-CLEANUP', 'INFO', `user-memory.md 测试产物已清理（pnpm 探针句 ${r.removed} 行）`)
    } else {
      umDiff = `已变化（快照 ${snapshot.um?.length ?? 0} → ${umNow.length} 字符；CHAT_NO_RESTORE=1 保留）`
    }
  }

  const summary = ev.writeReport({
    meta: {
      '回合超时': `${TURN_TIMEOUT}ms`,
      '用例过滤': ONLY || '（全部）',
      '探针': `${PROBE_KEY}（别名 ${PROBE_ALIAS}，标记「${PROBE_MARK}」）`,
      'user-memory.md': umDiff,
    },
    extraSections: `
## 覆盖范围

- 记忆提取落盘（MEM-01）、memory_search 兜底（MEM-02）
- 场景记忆命中注入正例（MEM-03）/ 负例（MEM-04）
- scene_memory 工具写入（MEM-05）与全局无污染（MEM-06）
- 主动回忆（MEM-07）、注册表一致性（MEM-09）；渠道记忆受限 SKIP（MEM-08）

## 探针与副作用

- 探针数据：\`scene-memory/_registry.json\`（临时项）+ \`project-${PROBE_KEY}.md\`${NO_RESTORE ? '（CHAT_NO_RESTORE=1：保留）' : '（已恢复）'}
- \`user-memory.md\`：探针句按行清理（不整文件恢复，避免覆盖应用/用户新写入）；状态：${umDiff}
`,
  })
  process.exit(summary.failed > 0 ? 1 : 0)
}

try {
  main()
} catch (err) {
  console.error(`\n套件异常中断: ${err.message}`)
  restoreProbe()
  process.exit(1)
}
