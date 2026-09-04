/**
 * 数据库适配器
 * 将 execute/query 接口适配为 findOne/find/insert/upsert
 */

import type { DatabaseClient } from './meta-cognition-engine';

/**
 * 扩展的数据库客户端接口
 */
export interface ExtendedDatabaseClient extends DatabaseClient {
  findOne<T = any>(table: string, where: Record<string, any>): Promise<T | null>;
  find<T = any>(table: string, where: Record<string, any>, options?: { limit?: number; orderBy?: Record<string, 'ASC' | 'DESC'> }): Promise<T[]>;
  insert(table: string, data: Record<string, any>): Promise<void>;
  upsert(table: string, where: Record<string, any>, data: Record<string, any>): Promise<void>;
}

/**
 * 创建扩展的数据库客户端
 */
export function createExtendedDbClient(db: DatabaseClient): ExtendedDatabaseClient {
  return {
    execute: db.execute.bind(db),
    query: db.query.bind(db),

    async findOne<T = any>(table: string, where: Record<string, any>): Promise<T | null> {
      const whereClause = Object.keys(where).map(k => `${k} = ?`).join(' AND ');
      const values = Object.values(where);
      const sql = `SELECT * FROM ${table} WHERE ${whereClause} LIMIT 1`;
      const rows = await db.query<T>(sql, values);
      return rows[0] || null;
    },

    async find<T = any>(table: string, where: Record<string, any>, options?: { limit?: number; orderBy?: Record<string, 'ASC' | 'DESC'> }): Promise<T[]> {
      const whereClause = Object.keys(where).map(k => `${k} = ?`).join(' AND ');
      const values = Object.values(where);
      let sql = `SELECT * FROM ${table} WHERE ${whereClause}`;

      if (options?.orderBy) {
        const orderClause = Object.entries(options.orderBy).map(([col, dir]) => `${col} ${dir}`).join(', ');
        sql += ` ORDER BY ${orderClause}`;
      }

      if (options?.limit) {
        sql += ` LIMIT ${options.limit}`;
      }

      return await db.query<T>(sql, values);
    },

    async insert(table: string, data: Record<string, any>): Promise<void> {
      const columns = Object.keys(data).join(', ');
      const placeholders = Object.keys(data).map(() => '?').join(', ');
      const values = Object.values(data);
      const sql = `INSERT INTO ${table} (${columns}) VALUES (${placeholders})`;
      await db.execute(sql, values);
    },

    async upsert(table: string, where: Record<string, any>, data: Record<string, any>): Promise<void> {
      // 尝试查找现有记录
      const existing = await this.findOne(table, where);

      if (existing) {
        // 更新现有记录
        const setClause = Object.keys(data).map(k => `${k} = ?`).join(', ');
        const whereClause = Object.keys(where).map(k => `${k} = ?`).join(' AND ');
        const values = [...Object.values(data), ...Object.values(where)];
        const sql = `UPDATE ${table} SET ${setClause} WHERE ${whereClause}`;
        await db.execute(sql, values);
      } else {
        // 插入新记录
        const allData = { ...where, ...data };
        await this.insert(table, allData);
      }
    },
  };
}
