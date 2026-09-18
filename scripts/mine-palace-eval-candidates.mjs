#!/usr/bin/env node
/**
 * 宫殿侧对照集候选挖掘（只读）
 *
 * 目的：找**宫殿语料里真有 gold 的**条目——即「用户会这样问、但库里那样写」的真实案例。
 * T1 集子用了工作记忆的 gold，6 条在宫殿 0 命中，不能直接复用（见 check-eval-set-in-palace.mjs）。
 *
 * 判据：对每条候选，算它以「用户口语措辞」查询时的 bigram 排名——**排名靠后或 MISS 的
 * 才是有价值的对照样本**（语义检索要救的就是这类）。排名本来就在前 5 的没有对照价值。
 *
 * 用法：node scripts/mine-palace-eval-candidates.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync(path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db'), {
  readOnly: true,
})
const docs = db
  .prepare('SELECT drawer_id AS id, wing, room, content FROM palace_drawers WHERE deleted_at IS NULL')
  .all()

// bigram（与 PalaceRepo 同口径）
const CJK = /[㐀-䶿一-鿿]/
const SEG = /[㐀-䶿一-鿿]+|[a-z0-9]+/g
const toks = (t) => {
  const o = new Set()
  for (const x of t.toLowerCase().match(SEG) ?? []) {
    if (CJK.test(x[0])) {
      if (x.length === 1) o.add(x)
      else for (let i = 0; i < x.length - 1; i++) o.add(x.slice(i, i + 2))
    } else o.add(x)
  }
  return o
}
const docToks = docs.map((d) => toks(d.content))
function bigramRank(query, goldId) {
  const q = [...toks(query)]
  if (!q.length) return -1
  const ranked = docs
    .map((d, i) => ({ id: d.id, hits: q.filter((t) => docToks[i].has(t)).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
  return ranked.findIndex((x) => x.id === goldId)
}

/**
 * 候选：从语料里挑**主题明确**的条目，配上「用户会怎么问」的口语措辞。
 *
 * 措辞纪律（踩过两次的坑）：必须含**关键线索**，不能是含糊指代。
 * s04 初版写成「那个工具服务起不来是什么原因」→ 向量 #118，那是运气不是检索。
 */
const CANDIDATES = [
  {
    id: 'p01-book-no-regen',
    cat: '同义词错配',
    // 库里写「不要重新生图，使用代码合成」，用户会说「图片是代码拼的」
    query: '绘本那个图是用代码拼出来的那套做法',
    expect: ['不要重新生图，使用代码合成'],
  },
  {
    id: 'p02-blocked-host',
    cat: '同义词错配',
    // 库里是 MySQL 原文 Host is blocked，用户说「连不上数据库被拉黑」
    query: '数据库把我这边 IP 拉黑了连不上',
    expect: ['is blocked because of many connection errors'],
  },
  {
    id: 'p03-docker-logs',
    cat: '语义改写',
    // 库里是 docker logs 原始输出，用户问「服务器日志里报错」
    query: '生产服务器日志里反复报错的那批',
    expect: ['docker logs -t --tail 500 e9e01399c40e'],
  },
  {
    id: 'p04-feishu-deliver',
    cat: '同义词错配',
    // 库里写 Feishu / open_id，用户说「飞书上发给我」
    query: '课程做完用飞书发我',
    expect: ['二十四史系统读史'],
  },
  {
    id: 'p05-restart-service',
    cat: '语义改写',
    // 库里结论是「不需要重启」，用户问「要不要重启服务」
    query: '接收服务要不要重启一下',
    expect: ['不需要重启，重启也解决不了这个问题'],
  },
  {
    id: 'p06-picture-book-skill',
    cat: '同义词错配',
    // 库里写 skill 名 picture-book-studio，用户说「用那个做绘本的技能」
    query: '用做绘本的那个技能生成',
    expect: ['picture-book-studio'],
  },
  {
    id: 'p07-tunnel-machine',
    cat: '精确主题',
    query: '堡垒机的地址和账号',
    expect: ['堡垒机信息'],
  },
  {
    id: 'p08-shiji-lecture',
    cat: '精确主题',
    query: '平准书那一课的讲义',
    expect: ['平准书'],
  },
  {
    id: 'p09-mysql-unlock',
    cat: '同义词错配',
    // 库里写「解锁命令」「黑名单」，用户说「数据库连不上要解封」
    query: '数据库连不上要解封的命令',
    expect: ['解锁命令如下'],
  },
  {
    id: 'p10-ods-stuck',
    cat: '精确主题',
    query: 'ODS 同步卡住的那件事',
    expect: ['ODS 同步卡点'],
  },
]

console.log(`宫殿语料 ${docs.length} 条\n`)
console.log('id'.padEnd(24) + '类别'.padEnd(12) + 'gold条数  bigram排名')
const usable = []
for (const c of CANDIDATES) {
  const golds = docs.filter((d) => c.expect.every((e) => d.content.includes(e)))
  const pos = golds.length ? bigramRank(c.query, golds[0].id) : -1
  console.log(
    c.id.padEnd(24) +
      c.cat.padEnd(12) +
      String(golds.length).padEnd(8) +
      (golds.length === 0 ? '—(gold 不存在)' : pos < 0 ? 'MISS' : `#${pos + 1}`),
  )
  if (golds.length) usable.push({ ...c, gold: golds[0].id })
}

fs.writeFileSync(
  'docs/test/memory-eval/palace-eval-candidates.json',
  JSON.stringify({ minedAt: new Date().toISOString(), candidates: usable }, null, 2),
  'utf8',
)
console.log(`\n可用候选 ${usable.length} 条 → docs/test/memory-eval/palace-eval-candidates.json`)
db.close()
