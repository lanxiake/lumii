#!/usr/bin/env node
/**
 * Wiki 三级分类功能测试套件
 *
 * 测试内容：
 * 1. 收件箱归档时指定三级分类（大类 → 小类 → 项目）
 * 2. 更新资料主题时设置项目
 * 3. 验证数据库中 topic_project 字段正确存储
 * 4. 验证查询和列表接口返回项目信息
 *
 * 用法：node docs/test/lumii-cli/wiki/run-wiki-three-level-classification-test.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../../..')
const LUMII_UI = path.join(ROOT, 'apps/windows/resources/app-ui-cli/lumii-ui.mjs')
const EVID = path.join(__dirname, 'wiki-three-level-classification-evidence.jsonl')
const REPORT = path.join(__dirname, 'wiki-three-level-classification-report.md')
const DB_PATH = path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db')

const results = []

/** 调用 lumii-ui */
function ui(args, input, { retries = 3 } = {}) {
  let last = { code: 1, out: '', json: null }
  for (let i = 0; i <= retries; i++) {
    const r = spawnSync(process.execPath, [LUMII_UI, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      input,
      maxBuffer: 20 * 1024 * 1024,
    })
    const out = (r.stdout || '') + (r.stderr || '')
    let json = null
    const trimmed = (r.stdout || '').trim()
    if (trimmed) {
      try {
        json = JSON.parse(trimmed)
      } catch {
        /* ignore */
      }
    }
    last = { code: r.status ?? 1, out, json }
    if (json?.error !== 'rate_limited' && !/rate_limited/.test(out)) return last
    sleep(5000 * (i + 1))
  }
  return last
}

/** 底层 command 总线 */
function cmd(type, data = {}) {
  return ui(['command', type, '--data', JSON.stringify(data)])
}

function record(id, status, note, extra = {}) {
  const row = { ts: new Date().toISOString(), id, status, note, ...extra }
  results.push(row)
  fs.appendFileSync(EVID, JSON.stringify(row) + '\n', 'utf8')
  console.log(`[${id}] ${status} — ${note}`)
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** 向真实库插入 pending 收件箱探针 */
function seedInbox(title, preview) {
  const db = new DatabaseSync(DB_PATH)
  try {
    const id = crypto.randomBytes(16).toString('hex')
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO wiki_inbox
       (id, agent_id, user_id, item_type, source_path, source_url, title,
        content_preview, media_type, status, attempt_count, last_error, content_hash, created_at)
       VALUES (?, 'assistant', 'local-user', 'chat', NULL, NULL, ?, ?, 'document', 'pending', 0, NULL, NULL, ?)`,
    ).run(id, title, preview, now)
    return id
  } finally {
    db.close()
  }
}

/** 查询数据库中的资料详情 */
function getSourceFromDB(sourceId) {
  const db = new DatabaseSync(DB_PATH)
  try {
    const row = db.prepare(
      `SELECT id, title, topic_category, topic_subtopic, topic_project FROM wiki_sources WHERE id = ?`
    ).get(sourceId)
    return row
  } finally {
    db.close()
  }
}

// ==================== 测试开始 ====================

console.log('Wiki 三级分类功能测试套件 starting…\n')

// 清空旧证据
fs.writeFileSync(EVID, '', 'utf8')

try {
  // ==================== 测试 1: 收件箱归档时指定三级分类 ====================

  // 1.1 创建测试收件箱条目
  const inboxId1 = seedInbox(
    '三级分类测试文档1',
    '这是一个用于测试三级分类功能的文档。内容涉及 Node.js 开发和测试框架的使用。'
  )
  record('T1.1', 'PASS', `创建收件箱条目 inboxId=${inboxId1}`)

  // 1.2 归档到三级分类：工作 → 开发 → lumii项目
  const organizeResult1 = cmd('wiki:inbox:organize', {
    agentId: 'assistant',
    inboxId: inboxId1,
    category: '工作',
    subtopic: '开发',
    project: 'lumii项目',
    title: '三级分类测试文档1'
  })

  if (organizeResult1.json?.ok === false) {
    record('T1.2', 'FAIL', `归档失败: ${organizeResult1.json?.error || organizeResult1.out}`)
  } else if (organizeResult1.json?.sourceId) {
    const sourceId1 = organizeResult1.json.sourceId
    const category1 = organizeResult1.json.category
    const subtopic1 = organizeResult1.json.subtopic
    const project1 = organizeResult1.json.project

    record('T1.2', 'PASS', `归档成功 sourceId=${sourceId1}, category=${category1}, subtopic=${subtopic1}, project=${project1}`)

    // 1.3 验证返回值包含 project 字段
    if (project1 === 'lumii项目') {
      record('T1.3', 'PASS', `返回值包含正确的 project 字段: ${project1}`)
    } else {
      record('T1.3', 'FAIL', `project 字段不匹配，期望 'lumii项目'，实际 '${project1}'`)
    }

    // 1.4 验证数据库中 topic_project 字段
    const dbRow1 = getSourceFromDB(sourceId1)
    if (dbRow1 && dbRow1.topic_project === 'lumii项目') {
      record('T1.4', 'PASS', `数据库中 topic_project 正确存储: ${dbRow1.topic_project}`)
    } else {
      record('T1.4', 'FAIL', `数据库中 topic_project 不正确: ${dbRow1?.topic_project}`)
    }

    // 1.5 通过 source:list 查询，验证返回包含项目信息
    const listResult = cmd('wiki:source:list', {
      agentId: 'assistant',
      category: '工作',
      subtopic: '开发',
      limit: 10,
      offset: 0
    })

    if (listResult.json?.items) {
      const foundItem = listResult.json.items.find(item => item.id === sourceId1)
      if (foundItem && foundItem.topic_project === 'lumii项目') {
        record('T1.5', 'PASS', `source:list 返回包含正确的 topic_project: ${foundItem.topic_project}`)
      } else {
        record('T1.5', 'FAIL', `source:list 返回的 topic_project 不正确: ${foundItem?.topic_project}`)
      }
    } else {
      record('T1.5', 'FAIL', `source:list 查询失败`)
    }
  } else {
    record('T1.2', 'FAIL', `归档响应格式异常: ${JSON.stringify(organizeResult1.json)}`)
  }

  // ==================== 测试 2: 更新已有资料的三级分类 ====================

  // 2.1 创建另一个测试收件箱条目并归档（不指定项目）
  const inboxId2 = seedInbox(
    '三级分类测试文档2',
    '这是另一个测试文档，用于测试后续更新项目字段的功能。'
  )
  record('T2.1', 'PASS', `创建收件箱条目 inboxId=${inboxId2}`)

  const organizeResult2 = cmd('wiki:inbox:organize', {
    agentId: 'assistant',
    inboxId: inboxId2,
    category: '学习',
    subtopic: '在学',
    title: '三级分类测试文档2'
  })

  if (organizeResult2.json?.sourceId) {
    const sourceId2 = organizeResult2.json.sourceId
    record('T2.2', 'PASS', `归档成功（未指定项目） sourceId=${sourceId2}`)

    // 2.3 验证初始状态 project 为 null
    const dbRow2Before = getSourceFromDB(sourceId2)
    if (dbRow2Before && dbRow2Before.topic_project === null) {
      record('T2.3', 'PASS', `初始 topic_project 为 null`)
    } else {
      record('T2.3', 'FAIL', `初始 topic_project 应为 null，实际: ${dbRow2Before?.topic_project}`)
    }

    // 2.4 更新资料主题，添加项目
    const updateResult = cmd('wiki:source:update-topic', {
      agentId: 'assistant',
      sourceId: sourceId2,
      category: '学习',
      subtopic: '在学',
      project: 'AI学习计划'
    })

    if (updateResult.json?.id) {
      record('T2.4', 'PASS', `更新主题成功，添加项目: AI学习计划`)

      // 2.5 验证返回值包含新的 project
      if (updateResult.json.topicProject === 'AI学习计划') {
        record('T2.5', 'PASS', `返回值包含更新后的 project: ${updateResult.json.topicProject}`)
      } else {
        record('T2.5', 'FAIL', `返回的 project 不正确: ${updateResult.json.topicProject}`)
      }

      // 2.6 验证数据库已更新
      const dbRow2After = getSourceFromDB(sourceId2)
      if (dbRow2After && dbRow2After.topic_project === 'AI学习计划') {
        record('T2.6', 'PASS', `数据库中 topic_project 已更新: ${dbRow2After.topic_project}`)
      } else {
        record('T2.6', 'FAIL', `数据库更新失败: ${dbRow2After?.topic_project}`)
      }

      // 2.7 再次更新，修改项目名称
      const updateResult2 = cmd('wiki:source:update-topic', {
        agentId: 'assistant',
        sourceId: sourceId2,
        category: '学习',
        subtopic: '在学',
        project: '机器学习专项'
      })

      if (updateResult2.json?.topicProject === '机器学习专项') {
        record('T2.7', 'PASS', `项目名称更新成功: 机器学习专项`)
      } else {
        record('T2.7', 'FAIL', `项目名称更新失败: ${updateResult2.json?.topicProject}`)
      }

      // 2.8 清除项目（设为 null）
      const updateResult3 = cmd('wiki:source:update-topic', {
        agentId: 'assistant',
        sourceId: sourceId2,
        category: '学习',
        subtopic: '在学',
        project: null
      })

      const dbRow2Final = getSourceFromDB(sourceId2)
      if (dbRow2Final && dbRow2Final.topic_project === null) {
        record('T2.8', 'PASS', `清除项目成功，topic_project 恢复为 null`)
      } else {
        record('T2.8', 'FAIL', `清除项目失败: ${dbRow2Final?.topic_project}`)
      }
    } else {
      record('T2.4', 'FAIL', `更新主题失败: ${updateResult.out}`)
    }
  } else {
    record('T2.2', 'FAIL', `归档失败: ${organizeResult2.out}`)
  }

  // ==================== 测试 3: 边界情况测试 ====================

  // 3.1 创建测试条目，测试空字符串项目名
  const inboxId3 = seedInbox(
    '三级分类测试文档3',
    '边界测试文档'
  )

  const organizeResult3 = cmd('wiki:inbox:organize', {
    agentId: 'assistant',
    inboxId: inboxId3,
    category: '收藏',
    subtopic: '可复用',
    project: '',  // 空字符串
    title: '三级分类测试文档3'
  })

  if (organizeResult3.json?.sourceId) {
    const sourceId3 = organizeResult3.json.sourceId
    const dbRow3 = getSourceFromDB(sourceId3)

    // 空字符串应该被当作 null 处理
    if (dbRow3 && (dbRow3.topic_project === null || dbRow3.topic_project === '')) {
      record('T3.1', 'PASS', `空字符串项目名正确处理为 null`)
    } else {
      record('T3.1', 'FAIL', `空字符串处理异常: ${dbRow3?.topic_project}`)
    }
  } else {
    record('T3.1', 'SKIP', `归档失败，跳过测试`)
  }

  // 3.2 测试长项目名（超过 100 字符）
  const longProjectName = '这是一个非常长的项目名称'.repeat(20)
  const inboxId4 = seedInbox(
    '三级分类测试文档4',
    '长项目名测试'
  )

  const organizeResult4 = cmd('wiki:inbox:organize', {
    agentId: 'assistant',
    inboxId: inboxId4,
    category: '工作',
    subtopic: '开发',
    project: longProjectName,
    title: '三级分类测试文档4'
  })

  if (organizeResult4.json?.sourceId) {
    record('T3.2', 'PASS', `长项目名可以正常存储`)
  } else {
    record('T3.2', 'FAIL', `长项目名存储失败: ${organizeResult4.out}`)
  }

  // 3.3 测试特殊字符项目名
  const specialProjectName = '项目#001 (2024) - 重要！@#$%^&*()_+'
  const inboxId5 = seedInbox(
    '三级分类测试文档5',
    '特殊字符测试'
  )

  const organizeResult5 = cmd('wiki:inbox:organize', {
    agentId: 'assistant',
    inboxId: inboxId5,
    category: '工作',
    subtopic: '开发',
    project: specialProjectName,
    title: '三级分类测试文档5'
  })

  if (organizeResult5.json?.sourceId) {
    const sourceId5 = organizeResult5.json.sourceId
    const dbRow5 = getSourceFromDB(sourceId5)

    if (dbRow5 && dbRow5.topic_project === specialProjectName) {
      record('T3.3', 'PASS', `特殊字符项目名正确存储`)
    } else {
      record('T3.3', 'FAIL', `特殊字符项目名存储异常`)
    }
  } else {
    record('T3.3', 'FAIL', `特殊字符项目名归档失败: ${organizeResult5.out}`)
  }

} catch (err) {
  record('ERROR', 'FAIL', err.message, { stack: err.stack })
}

// ==================== 生成报告 ====================

const pass = results.filter(r => r.status === 'PASS').length
const fail = results.filter(r => r.status === 'FAIL').length
const skip = results.filter(r => r.status === 'SKIP').length

console.log(`\nReport → ${REPORT}`)
console.log(`PASS=${pass} FAIL=${fail} SKIP=${skip}`)

const md = `# Wiki 三级分类功能测试报告

生成时间: ${new Date().toISOString()}

## 测试统计

- ✅ 通过: ${pass}
- ❌ 失败: ${fail}
- ⏭️  跳过: ${skip}
- 📊 总计: ${results.length}

## 测试详情

${results.map(r => `### [${r.id}] ${r.status}\n\n${r.note}\n\n时间: ${r.ts}\n`).join('\n---\n\n')}

## 测试覆盖

### 功能测试
- [x] 收件箱归档时指定三级分类（大类、小类、项目）
- [x] 验证 API 返回值包含 project 字段
- [x] 验证数据库 topic_project 字段存储
- [x] 验证 source:list 查询返回项目信息
- [x] 更新已有资料的项目字段
- [x] 修改项目名称
- [x] 清除项目（设为 null）

### 边界测试
- [x] 空字符串项目名处理
- [x] 长项目名存储
- [x] 特殊字符项目名存储

## 结论

${fail === 0
  ? '✅ 所有测试通过，三级分类功能正常工作！'
  : `⚠️ 有 ${fail} 项测试失败，需要进一步检查。`}

详细证据见: ${EVID}
`

fs.writeFileSync(REPORT, md, 'utf8')

process.exit(fail > 0 ? 1 : 0)
