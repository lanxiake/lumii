#!/usr/bin/env node
/**
 * 探路：能否用 `memory_segments` 的硬链路重建一个判据正确的评测集？
 *
 * ## 思路
 *
 * `memory_segments.palace_drawer_id` 是**段 → 抽屉 1:1** 的硬链路（实测 0 个
 * 一对多），且段带 `start_message_id`/`end_message_id` 消息区间。于是可以精确
 * 反推"哪些消息进了哪个抽屉"，判据落在 `drawer_id` 上——不用子串匹配，
 * 从根上避免 v6 那类判据泄漏（见 eval-criteria-contrast.mjs）。
 *
 * 查询取"该段结束之后、同会话的下一条用户提问"，因果方向天然正确
 * （提问在归档之后，不可能泄漏）。
 *
 * ## 结论：样本不够，且类型不对
 *
 * - 有 `palace_drawer_id` 的段仅 **77/276**，可用 **71** 条
 * - 能构造候选 **38** 条
 * - 但仍以**动作指令**为主（"将完成后的html发送到微信"、"继续输出后续课程内容"），
 *   不是回忆型检索——和 v6 同一个病根
 *
 * 即：本机数据里天然缺回忆型查询，靠挖掘拿不到合格评测集，必须换标注策略。
 *
 * 用法：node scripts/probe-hard-linked-eval.mjs
 */
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db'))
// 硬链路：段 -> 抽屉，段内消息区间已知
const segs=db.prepare(`SELECT s.id sid, s.palace_drawer_id did, s.conversation_id cid,
    s.start_message_id sm, s.end_message_id em, s.closed_at, s.turn_count tc, d.char_count dc
  FROM memory_segments s JOIN palace_drawers d ON d.drawer_id=s.palace_drawer_id
  WHERE d.deleted_at IS NULL AND s.end_message_id IS NOT NULL`).all()
const tsOf=db.prepare('SELECT timestamp t FROM messages WHERE id=?')
// 对每个段，找该段**结束之后**、同会话的下一条用户提问 —— 这才是"回头找这段"的真场景
const nextQ=db.prepare(`SELECT id, content_json cj, timestamp ts FROM messages
  WHERE conversation_id=? AND role='user' AND timestamp > ? ORDER BY timestamp LIMIT 6`)
let ok=0, cand=[]
for(const s of segs){
  const e=tsOf.get(s.em); if(!e) continue
  const qs=nextQ.all(s.cid, e.t)
  for(const q of qs){
    let text=''; try{ const o=JSON.parse(q.cj); text=typeof o.text==='string'?o.text.trim():'' }catch{continue}
    if(!text||text.length<10||text.length>120) continue
    if(/^\[语音|^@|^\//.test(text)) continue
    cand.push({q:text, gold:s.did, seg:s.sid, cid:s.cid, segEnd:e.t, askedAt:q.ts, dc:s.dc, tc:s.tc})
    break
  }
}
console.log('硬链路段数', segs.length, '→ 可构造候选', cand.length)
console.log('\n前 12 条：')
for(const c of cand.slice(0,12)) console.log(`  [抽屉${c.dc}字 ${c.tc}轮] ${c.q.slice(0,56)}`)
