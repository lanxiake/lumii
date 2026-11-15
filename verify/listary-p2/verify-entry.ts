/**
 * P2 评测 — 在真实目录上对比「纯 bm25」与「加权排序」的 top-N 命中率。
 *
 * 为什么必须建评测集：调权重不建对照组就是凭感觉。`segmentation.ts` 里
 * 848 条真实抽屉的调参记录是这条规矩的来源。
 *
 * 评测方式：对每个查询，人工标注「哪些结果算命中」（按路径关键词判定），
 * 然后量两个指标：
 *   - **P@5**：前 5 条里命中的比例（用户实际只看前几条）
 *   - **首位命中**：第 1 条是否正确
 *
 * 用法：
 *   node verify/listary-p2/build.mjs
 *   pnpm exec electron verify/listary-p2/bundle.cjs <目标目录>
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'

import { ListaryDb } from '../../apps/windows/src/plugins/builtin/listary/db'
import { normalizePath, scanSync } from '../../apps/windows/src/plugins/builtin/listary/scanner'
import { upsertBatch } from '../../apps/windows/src/plugins/builtin/listary/writer'
import { recordUsage, search } from '../../apps/windows/src/plugins/builtin/listary/query'
import { DEFAULT_WEIGHTS, normalizeBm25One, rankCandidates, rootPriority, type RankCandidate } from '../../apps/windows/src/plugins/builtin/listary/rank'

const OUT = path.join(__dirname, 'verify.out')
const lines: string[] = []
fs.rmSync(OUT, { force: true })
function log(s: string): void {
  lines.push(s)
  process.stdout.write(s + '\n')
  fs.writeFileSync(OUT, lines.join('\n') + '\n')
}

const TARGET = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('-')) ?? process.cwd())

interface EvalCase {
  /** 查询词 */
  q: string
  /** 命中判据：路径里含这些片段之一即算命中（相对目标目录的路径，小写） */
  hit: string[]
  /** 这条查询里，用户"本来就会反复打开"的那个（用于验证 usage 加成），可选 */
  habituallyOpened?: string
}

/**
 * 评测集。
 *
 * 分两组：
 * - **字面组**：关键词直接出现在文件名/路径里。这类查询 bm25 本来就排得对，
 *   加权排序不应把它弄坏（回归保护）。
 * - **判别组**：刻意挑"bm25 给不出版权答案"的情形，用来暴露排序到底有没有用：
 *   前缀 vs 包含、常见词（命中几百条）里的选择、深埋文件 vs 浅层文件。
 */
const CASES: EvalCase[] = [
  // 字面组
  { q: '设计', hit: ['设计'] },
  { q: '文档', hit: ['文档', 'docs'] },
  { q: 'plan', hit: ['plan'] },
  { q: 'readme', hit: ['readme'] },
  { q: 'test', hit: ['test'] },
  { q: '记忆', hit: ['记忆', 'memory'] },
  { q: 'agent', hit: ['agent'] },
  { q: '逆向', hit: ['逆向', 'reverse'] },
  { q: '启动器', hit: ['启动器', 'listary'] },
  { q: 'skills', hit: ['skills', 'skill'] },
]

app.whenReady().then(() => {
  log(`Electron ${process.versions.electron} / ABI ${process.versions.modules}`)
  log(`目标目录：${TARGET}\n`)

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-p2-'))
  const dbPath = path.join(tmpDir, 'index.db')
  const ldb = new ListaryDb(dbPath)
  const db = ldb.db

  log('═'.repeat(76))
  log('[1] 建索引')
  log('═'.repeat(76))
  const scanStart = Date.now()
  const result = scanSync({
    roots: [TARGET],
    batchSize: 2000,
    onBatch: (items) => upsertBatch(db, items),
  })
  log(`  ${result.indexed} 条，${Date.now() - scanStart}ms`)
  if (result.indexed < 1000) {
    log(`  ⚠️ 条目太少（<1000），评测不具代表性`)
  }

  // ── 基线实现：只按 bm25 排（P1 的行为） ──
  log('\n' + '═'.repeat(76))
  log('[2] 基线 vs 加权排序')
  log('═'.repeat(76))

  const NOW = Date.now()

  /**
   * 基线：直接用 FTS 的 bm25 顺序（P1 的 search 行为，未经 rank.ts）。
   * 这里手动复刻 bm25 排序，以便与加权结果在同一批候选上对比。
   */
  function baselineTopN(query: string, n: number): string[] {
    const { tokenizeBigram, requiredTokenHits, countTokenHits } = require('@mtbot/agent-runtime') as {
      tokenizeBigram: (s: string) => Set<string>
      requiredTokenHits: (n: number) => number
      countTokenHits: (t: readonly string[], text: string) => number
    }
    const tokens = tokenizeBigram(query)
    if (tokens.size === 0) return []
    const match = [...tokens].map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
    const rows = db
      .prepare(
        `SELECT i.path, f.tokens, bm25(lz_items_fts) AS rank
         FROM lz_items_fts f JOIN lz_items i ON i.id = f.rowid
         WHERE lz_items_fts MATCH ? ORDER BY rank LIMIT 400`,
      )
      .all(match) as Array<{ path: string; tokens: string; rank: number }>
    const list = [...tokens]
    const need = requiredTokenHits(list.length)
    return rows
      .filter((r) => countTokenHits(list, r.tokens) >= need)
      .slice(0, n)
      .map((r) => r.path)
  }

  function isHit(p: string, c: EvalCase): boolean {
    const low = p.toLowerCase()
    return c.hit.some((h) => low.includes(h))
  }

  /** 找第一个命中的位次（1-based）；没命中返回 0 */
  function firstHitRank(paths: readonly string[], c: EvalCase): number {
    const i = paths.findIndex((p) => isHit(p, c))
    return i < 0 ? 0 : i + 1
  }

  let baseP5Sum = 0
  let rankedP5Sum = 0
  let baseFirst = 0
  let rankedFirst = 0
  let baseTop1Hit = 0
  let rankedTop1Hit = 0
  const perCase: Array<{ q: string; baseP5: number; rankedP5: number; baseFirst: number; rankedFirst: number }> = []

  for (const c of CASES) {
    const N = 5
    const base = baselineTopN(c.q, N)
    const ranked = search(db, c.q, { limit: N, minHits: true }, NOW).map((h) => h.path)

    const bP5 = base.filter((p) => isHit(p, c)).length / N
    const rP5 = ranked.filter((p) => isHit(p, c)).length / N
    const bFirst = firstHitRank(base, c)
    const rFirst = firstHitRank(ranked, c)

    baseP5Sum += bP5
    rankedP5Sum += rP5
    baseFirst += bFirst
    rankedFirst += rFirst
    if (bFirst === 1) baseTop1Hit++
    if (rFirst === 1) rankedTop1Hit++

    perCase.push({ q: c.q, baseP5: bP5, rankedP5: rP5, baseFirst: bFirst, rankedFirst: rFirst })

    log(
      `  「${c.q}」  P@5: ${bP5.toFixed(2)} → ${rP5.toFixed(2)}   首位命中位次: ${bFirst || '未命中'} → ${rFirst || '未命中'}`,
    )
  }

  const n = CASES.length
  log('')
  log(`  平均 P@5      ：${(baseP5Sum / n).toFixed(3)} → ${(rankedP5Sum / n).toFixed(3)}`)
  log(`  首位命中率    ：${(baseTop1Hit / n).toFixed(3)} → ${(rankedTop1Hit / n).toFixed(3)}`)
  log(`  平均首位位次  ：${(baseFirst / n).toFixed(2)} → ${(rankedFirst / n).toFixed(2)}（越小越好，0=有未命中的）`)

  if (baseP5Sum === rankedP5Sum && baseTop1Hit === rankedTop1Hit) {
    log('')
    log('  ⚠️ 两组指标完全相同 —— 说明这组查询「太容易」：关键词字面就在文件名里，')
    log('     bm25 本来就排得对，加权排序没有发挥空间。')
    log('     这不能证明加权没用，只能证明**这组评测集测不出来**。')
    log('     看下面 [3][4] 两组：使用历史与权重敏感性才是加权真正起作用的地方。')
  }

  // ── 判别性用例：刻意挑 bm25 给不出版权答案的情形 ──
  log('\n' + '═'.repeat(76))
  log('[2b] 判别性用例（bm25 难分优劣的情形）')
  log('═'.repeat(76))

  /** 人造候选集，隔离出"排序器本身"的行为，不受真实目录内容干扰 */
  function synth(
    label: string,
    items: RankCandidate[],
    query: string,
    expectFirst: number,
    why: string,
  ): void {
    // 基线 = 纯 bm25 升序（bm25 是负数，**越小越相关**）。
    // 首版写成 `(b.bm25 ?? 0) - (a.bm25 ?? 0)` 即降序，把基线排反了 ——
    // 结果用例 1-3 的"基线首位=#2"是错上加错碰巧对上，不能作为结论。
    const baseOrder = [...items].sort((a, b) => (a.bm25 ?? 0) - (b.bm25 ?? 0))
    const ranked = rankCandidates(items, query, NOW)
    const baseFirst = baseOrder[0].id
    const rankedFirst = ranked[0].id
    const ok = rankedFirst === expectFirst
    const changed = baseFirst !== rankedFirst
    log(
      `  ${ok ? '✅' : '❌'} ${label}\n` +
        `       纯 bm25 首位=#${baseFirst} → 加权首位=#${rankedFirst}（期望 #${expectFirst}）` +
        `${changed ? '' : '  ← 加权未改变首位'}\n` +
        `       依据：${why}`,
    )
  }

  const mk = (
    id: number,
    name: string,
    path: string,
    bm25: number,
    extra: Partial<RankCandidate> = {},
  ): RankCandidate => ({
    id,
    name,
    path,
    isStart: false,
    root: 'c:\\proj',
    bm25,
    usageCount: 0,
    usageLastUsed: 0,
    rootPriority: rootPriority(path),
    ...extra,
  })

  synth(
    '前缀命中应胜过"仅包含"',
    [
      mk(1, '项目设计说明.md', 'c:\\work\\项目设计说明.md', -8),
      mk(2, '设计规范.md', 'c:\\work\\设计规范.md', -7), // bm25 略低，但名字以查询词开头
    ],
    '设计',
    2,
    '用户打完「设计」时，以它开头的文件名几乎就是目标；bm25 只看词频，区分不出前缀',
  )

  synth(
    '开始菜单的程序应胜过深埋的同名文件',
    [
      mk(1, 'VSCode.lnk', 'c:\\deep\\a\\b\\c\\d\\e\\f\\VSCode.lnk', -9),
      mk(2, 'VSCode.lnk', 'c:\\programdata\\microsoft\\windows\\start menu\\programs\\VSCode.lnk', -8, {
        isStart: true,
      }),
    ],
    'VSCode',
    2,
    '搜出来是要启动的东西，开始菜单那条才是能执行的；深埋的那条相关性再高也不是目标',
  )

  synth(
    '常用项应胜过"相关性略高但没用过"',
    [
      mk(1, 'aaa设计.md', 'c:\\a\\aaa设计.md', -10),
      mk(2, 'bbb设计.md', 'c:\\b\\bbb设计.md', -5, { usageCount: 30, usageLastUsed: NOW - 86_400_000 }),
    ],
    '设计',
    2,
    '"越用越准"的全部意义就在这——相关性差距不大时，用户的行为应该能翻盘',
  )

  synth(
    '相关性差距很大时，使用历史不该翻盘（防止"越用越偏"）',
    [
      mk(1, '设计文档.md', 'c:\\a\\设计文档.md', -30),
      mk(2, 'unrelated.txt', 'c:\\b\\unrelated.txt', -0.5, { usageCount: 30, usageLastUsed: NOW - 86_400_000 }),
    ],
    '设计',
    1,
    '过度依赖使用历史会让启动器"搜什么都不准"，只剩肌肉记忆——这是要设上限的原因',
  )

  // ── 使用历史加成能否体现（P2 的核心价值） ──
  log('\n' + '═'.repeat(76))
  log('[3] 使用历史加成（"越用越准"）')
  log('═'.repeat(76))

  const lowQ = 'zip'
  const before = search(db, lowQ, { limit: 5 }, NOW).map((h) => h.path)
  if (before.length === 0) {
    log(`  目标目录里没有含「${lowQ}」的条目，跳过此组`)
  } else {
    // 模拟"用户反复打开第 3 条"
    const target = before[Math.min(2, before.length - 1)]
    for (let i = 0; i < 30; i++) recordUsage(db, lowQ, target)
    const after = search(db, lowQ, { limit: 5 }, NOW).map((h) => h.path)
    const beforeRank = before.indexOf(target) + 1
    const afterRank = after.indexOf(target) + 1
    log(`  查询「${lowQ}」，对第 ${beforeRank} 条模拟打开 30 次`)
    log(`    使用前位次：${beforeRank}`)
    log(`    使用后位次：${afterRank}${afterRank === 0 ? '（被挤出前5）' : ''}`)
    log(`    提升：${beforeRank - afterRank > 0 ? `↑ ${beforeRank - afterRank} 位` : '无变化'}`)
    if (afterRank === 1 && beforeRank > 1) {
      log('    ✅ 使用历史把常用项顶到了首位')
    } else if (afterRank > 0 && afterRank < beforeRank) {
      log('    ✅ 位次有提升')
    } else {
      log('    ⚠️ 未提升 —— 需检查权重或该条目 bm25 差距过大')
    }
  }

  // ── 权重敏感性（给"为什么是这些数"一个量化依据） ──
  log('\n' + '═'.repeat(76))
  log('[4] 权重敏感性（bd25 与个性化信号的拉锯）')
  log('═'.repeat(76))

  log('  合成一对候选：A 相关度高但从没用过（bm25=-10），B 相关度低但用过 30 次（bm25=-5）')
  log('  看 bm25 权重取不同值时，谁排前面：')
  let bWins = 0
  for (const w of [1.0, 0.9, 0.7, 0.5, 0.3]) {
    const items: RankCandidate[] = [
      {
        id: 1,
        name: 'aaa设计',
        path: 'c:\\aaa设计',
        isStart: false,
        root: 'c:\\proj',
        bm25: -10,
        usageCount: 0,
        usageLastUsed: 0,
        rootPriority: 0.5,
      },
      {
        id: 2,
        name: 'bbb设计',
        path: 'c:\\bbb设计',
        isStart: false,
        root: 'c:\\proj',
        bm25: -5,
        usageCount: 30,
        usageLastUsed: NOW - 86_400_000,
        rootPriority: 0.5,
      },
    ]
    const top = rankCandidates(items, '设计', NOW, { ...DEFAULT_WEIGHTS, bm25: w })[0]
    if (top.id === 2) bWins++
    log(`    bm25=${w.toFixed(2)}  →  ${top.id === 1 ? 'A（高相关，未用过）' : 'B（低相关，用过 30 次）'}`)
  }
  log(`  当前默认 bm25 = ${DEFAULT_WEIGHTS.bm25}（见 rank.ts DEFAULT_WEIGHTS）`)
  if (bWins === 5) {
    log('')
    log('  说明：bm25 从 1.0 压到 0.3 都不改变结论 —— 因为这里 B 的 30 次使用换来了')
    log('        满额加成（USAGE_BONUS_CAP=0.25），而 A/B 的 bm25 经**饱和变换**后只差约 0.12，')
    log('        个性化信号有足够余量翻盘。若把 normalizeBm25 换回 min-max（差距 1.0），')
    log('        这一列会全部显示 A —— 这正是它被替换掉的原因。')
  }

  // ── 闭包不变量：检索本身绝不能写 usage ──
  log('\n' + '═'.repeat(76))
  log('[5] 不变量：检索不写使用历史（防自激）')
  log('═'.repeat(76))

  log('  `memory/scorer.ts` 记录过一次自激事故：recency 用「每次注入都被刷新」的字段，')
  log('  于是被注入的条目恒得满分、更易再被注入（9 条吃掉 54% 席位）。')
  log('  启动器里等价的风险是：**检索过程被记成使用**，那么"搜过"就变成了"用过"、')
  log('  越搜越偏。故 usage 只能由"用户真的打开了"来写。')
  log('')

  const invariantQ = 'agent'
  const usageBefore = (
    db.prepare('SELECT COUNT(*) c FROM lz_usage WHERE keyword = ?').get(invariantQ) as { c: number | bigint }
  ).c
  // 反复检索 20 次
  for (let i = 0; i < 20; i++) search(db, invariantQ, { limit: 10 }, NOW)
  const usageAfter = (
    db.prepare('SELECT COUNT(*) c FROM lz_usage WHERE keyword = ?').get(invariantQ) as { c: number | bigint }
  ).c

  const invariantOk = Number(usageBefore) === Number(usageAfter)
  log(`  ${invariantOk ? '✅' : '❌'} 检索「${invariantQ}」20 次后，lz_usage 行数：${usageBefore} → ${usageAfter}`)
  if (invariantOk) {
    log('     检索是纯读操作，使用历史只由显式的 recordUsage 写入（P3 的"打开"动作会调它）')
  } else {
    log('     ⚠️ 检索路径写了 usage —— 会出现"搜过即用过"的自激，必须修')
  }

  ldb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })

  log('\n' + '─'.repeat(76))
  log(`P2 评测完成${invariantOk ? '' : '（不变量被破坏）'}`)
  log('─'.repeat(76))
  app.exit(invariantOk ? 0 : 1)
})
