#!/usr/bin/env node
/**
 * 合并人工补判结果 —— 修掉「未判即假阴性」
 *
 * ## 背景
 *
 * v7 种子集每条查询只标了 1~2 个 gold（读抽屉时最明显的那条）。但本库同主题
 * 抽屉大量重复（讲 `exit 3` 的 7 条、讲 `flush-hosts` 的 57 条），只标 1 个
 * 会把"找到另一条同样正确的抽屉"误判为失败，**系统性低估所有方案**。
 * BEIR 的 Touché 重判后模型排序全变（Thakur et al., SIGIR 2024）。
 *
 * ## 判定过程（对齐 BEIR/T2Ranking 的池化做法）
 *
 * 1. `pool-candidates-for-judging.mjs` 取四路（fts/vec/convex/rrf）top-K 并集
 * 2. 聚焦**最优方案 top-2 内的未判项**（62 个候选）——它们直接决定 R@1/MRR
 * 3. 人工逐条读 head 判断，不用关键词自动判（`落盘` 命中 142 条，已验证不可靠）
 *
 * ## 本次判定中发现的两类问题（记录下来，因为它们影响结论）
 *
 * - **标注归属错误**：有些候选其实回答的是**别的**查询。如 `d60ddeb41c227e28`
 *   讲 ENOENT，被 v7-036（备份文件还在主文件没了）召回，但它该归 v7-008。
 *   这类不计入原查询的 gold。
 * - **与 gold 语义矛盾的候选**：`3666eae7dff565f4` 含机票比价的**实际方案原文**，
 *   而 v7-040 的 gold 是"我说之前没聊过机票比价"。两条互相矛盾，说明
 *   **gold 本身可能标错了**（历史上确实聊过）。标为 `disputed`，从评测中排除，
 *   不当 gold 也不当负例。
 *
 * 用法：node scripts/merge-judgments.mjs [--dry]
 */
import fs from 'node:fs'

const DRY = process.argv.includes('--dry')
const SET = 'docs/test/memory-eval/palace-eval-set-v7-seed.json'

/**
 * 人工判定结果：queryId → 追加的 gold drawer_id[]
 * 判据：该抽屉是否**独立且正确地**回答了这条查询。
 */
const ADD_GOLDS = {
  'v7-004': ['4c1fba8daf54ed39'], // 同样讲大输出落盘到 .tool-results
  'v7-005': ['c5b943c8032bd7a5'], // 同样原样执行 exit 3、未兜底
  'v7-006': ['59c6a1533eda4065'], // 同样 session_resume 不存在会话的报错
  'v7-007': ['29b73b05a1cd509c'], // 同样 oldString 三级降级失败（原被 v7-037 召回）
  'v7-008': ['698373be9b41df0c', 'd60ddeb41c227e28'], // 两条都是 ENOENT 原样抛出
  'v7-009': ['179becb6173e3518'], // 同一次「盗窃」四通道零命中
  'v7-016': ['1d28b8c7d70cedeb'], // 另一期体检，同样报出矛盾/残留条目
  'v7-018': ['c4647091e790ea97'], // 时间衰减算法排查的传话，同一件事
  'v7-021': ['95de1a2ea93390f3', '285e7ecdf58ce424'], // 都在讲补数后的认领/对账
  'v7-022': ['33cbafeb570f33b1', '8c1576c6a8690d73'], // 都完整讲了拉黑根因与 flush-hosts
  'v7-023': ['b72d4eb05feef5ea'], // 同样确认 .161 才是生产主库
  'v7-032': ['0d29f9fa61e56f12'], // 同一次讲义重排，讲了旧 B5 整篇删除
  'v7-034': ['185517215cb7c2cf'], // 同一次去 AI 味重写（白话叙事、砍表格标记）
  'v7-038': ['c5b943c8032bd7a5'], // 正是"退出码数值不透出"这个侧面
  'v7-041': ['8af95148db102da2'], // 同一条假币新闻的完整解读
  'v7-043': ['4a1ebe75113d86ca'], // 同一个「3-gram 阈值不可移植」实测发现
  'v7-046': ['6ab421f5cef806ed'], // 汇报版同样写明 12 个部署 = 5 套代码
  'v7-050': ['a04f4797e7965e15'], // 明确 159 的 tomcat8580 是 data12345
  'v7-052': ['40aeca277c3a897f'], // 同一件事：B9-B11 与 B6-B8 同内容两套编号
}

/**
 * 争议样本：候选与已标 gold **语义矛盾**，说明 gold 可能标错。
 * 从评测中排除（既不当 gold 也不当负例），而不是硬塞一边。
 */
const DISPUTED = {
  'v7-040': {
    conflicting: '3666eae7dff565f4',
    reason:
      '该抽屉含机票比价的实际方案原文（9/27 出发 + 10/1 返程 ¥902/人），' +
      '而 gold 是"我说之前根本没聊过机票比价"。两者矛盾 → 历史上确实聊过，' +
      'gold 的前提站不住。排除该查询而非二选一。',
  },
}

const set = JSON.parse(fs.readFileSync(SET, 'utf8'))
let added = 0, touched = 0, disputedN = 0

for (const q of set.queries) {
  const extra = ADD_GOLDS[q.id]
  if (extra) {
    const cur = new Set(q.golds ?? [q.gold])
    const before = cur.size
    for (const g of extra) cur.add(g)
    if (cur.size > before) {
      q.golds = [...cur]
      added += cur.size - before
      touched++
    }
  }
  if (DISPUTED[q.id]) {
    q.disputed = DISPUTED[q.id]
    disputedN++
  }
}

set._judgments = {
  pooledAt: '2026-09-19',
  method:
    '四路（fts/vec/convex α=0.6/rrf k=60）top-10 并集池化，聚焦最优方案 top-2 内未判项（62 个候选），人工逐条判。',
  addedGolds: added,
  queriesTouched: touched,
  disputed: disputedN,
  note:
    '仍未做的：top-3~10 区间的未判项（约 158 个）。按 BEIR 经验这会继续低估方案，' +
    '故当前所有指标应视为**保守下界**。',
}

const multi = set.queries.filter((q) => (q.golds ?? []).length > 1).length
console.log(`追加 gold ${added} 个，涉及 ${touched} 条查询`)
console.log(`争议样本 ${disputedN} 条（已标 disputed，评测时应排除）`)
console.log(`多 gold 查询：${multi}/${set.queries.length}（补判前 1）`)

if (DRY) {
  console.log('\n--dry 模式，未写文件')
} else {
  fs.writeFileSync(SET, JSON.stringify(set, null, 2), 'utf8')
  console.log(`\n→ 已写回 ${SET}`)
}
