/**
 * DatabaseAdapter（同步 prepare/run）转成异步形状的客户端。
 *
 * 从自主进化里提出来：宠物几条链（经验/人格/任务）都要用，不该为了一个适配器
 * 去 import 插件的实现——那会让「停用自主进化」连带动到宠物。
 */
import type { DatabaseAdapter } from '@mtbot/agent-runtime'

export function toAsyncClient(db: DatabaseAdapter) {
  return {
    async execute(sql: string, params: unknown[] = []) {
      return db.prepare(sql).run(...params)
    },
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...params) as T[]
    },
  }
}
