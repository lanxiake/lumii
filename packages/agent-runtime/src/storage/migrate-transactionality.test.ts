/**
 * 迁移的事务性 —— 守住 `LocalDatabase.migrate()` 把整批迁移包在一个事务里这一条。
 *
 * 为什么需要这层：单个迁移是「RENAME → 建新 → 拷 → DROP」多语句序列，
 * 进程若死在 `CREATE TABLE … channel` 之后、`INSERT SELECT` 之前，库会变成
 * **既不是旧形态也不是新形态**的半成品；而 `isMigrationAlreadyApplied` 靠
 * 「列是否存在」判断，半成品恰好带着新列 ⇒ 下次启动**跳过**迁移 ⇒
 * 数据永久留在 `tool_usage_stats_v55` 里，且日志里一句错都没有。
 *
 * 实测过这条路径（见 schema-v56.test.ts 的「迁移是原子的」用例）：不做事务时，
 * 340 行统计会静默消失。所以本用例检查的是**代码结构**而不是运行结果——
 * 注入"迁移中途失败"需要一个可控的坏迁移，那会把生产代码为测试开缝。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(fileURLToPath(new URL('./local-database.ts', import.meta.url)), 'utf-8')

/** 取出 migrate() 的函数体（从 `private migrate()` 到下一个同类缩进的方法） */
function migrateBody(): string {
  const start = SRC.indexOf('private migrate()')
  expect(start, '找不到 migrate()').toBeGreaterThan(-1)
  const next = SRC.indexOf('\n  private ', start + 10)
  return SRC.slice(start, next > 0 ? next : SRC.length)
}

describe('migrate() 的事务性', () => {
  it('迁移循环被 withTransaction 包住', () => {
    const body = migrateBody()
    const wrapAt = body.indexOf('withTransaction(db,')
    const loopAt = body.indexOf('for (const [version, sql] of MIGRATIONS)')
    expect(wrapAt).toBeGreaterThan(-1)
    expect(loopAt).toBeGreaterThan(wrapAt)
  })

  it('版本号写入也在同一个事务内（否则「DDL 成功、版本没写」会导致下一轮重放）', () => {
    const body = migrateBody()
    const wrapAt = body.indexOf('withTransaction(db,')
    // 找**写入**那条语句，不是上面读 currentVersion 的 SELECT
    const versionWrite = body.indexOf("VALUES ('schemaVersion'")
    expect(versionWrite).toBeGreaterThan(-1)
    expect(versionWrite).toBeGreaterThan(wrapAt)
  })

  it('withTransaction 本身确实 BEGIN/COMMIT/ROLLBACK（这个 helper 是全局共用的，别被改坏）', () => {
    const start = SRC.indexOf('export function withTransaction')
    expect(start).toBeGreaterThan(-1)
    const body = SRC.slice(start, start + 800)
    expect(body).toMatch(/db\.exec\(begin\)/)
    expect(body).toMatch(/db\.exec\("COMMIT"\)/)
    expect(body).toMatch(/db\.exec\("ROLLBACK"\)/)
  })
})
