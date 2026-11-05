/**
 * 页缓存对 LIKE 扫描的影响（2026-11-05）。
 *
 * 背景：给 messages 加 text 列只把 300ms 降到 170ms——瓶颈是**每行都要读盘页**
 * （真实行里躺着 content_json 溢出页）。库 500MB、默认页缓存只有 2MB，
 * 每敲一个字都在做随机 IO。
 *
 * 用法：node verify/conversation-search/bench-cache.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'

const db = new DatabaseSync(path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db'), {
  readOnly: true,
})
const q = db.prepare(
  `SELECT id FROM messages WHERE content_json LIKE ? ESCAPE '\\' ORDER BY timestamp DESC LIMIT 60`,
)

function bench(label, n = 5) {
  const times = []
  for (let i = 0; i < n; i++) {
    const s = process.hrtime.bigint()
    q.all('%微信%')
    times.push(Number(process.hrtime.bigint() - s) / 1e6)
  }
  times.sort((a, b) => a - b)
  console.log(`${label.padEnd(18)} med ${times[Math.floor(n / 2)].toFixed(1)}ms  min ${times[0].toFixed(1)}ms`)
}

console.log('page_size', db.prepare('PRAGMA page_size').get())
console.log('默认 cache_size', db.prepare('PRAGMA cache_size').get())
bench('默认')

for (const mb of [16, 64, 256]) {
  db.exec(`PRAGMA cache_size = -${mb * 1024}`)
  bench(`cache ${mb}MB · 首扫`)
  bench(`cache ${mb}MB · 再扫`)
}

// mmap：让 SQLite 直接映射文件，省掉一次页缓存拷贝
try {
  db.exec('PRAGMA mmap_size = 268435456')
  bench('mmap 256MB')
} catch (e) {
  console.log('mmap 不可用：', e.message)
}
