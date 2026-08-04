/**
 * node:sqlite 类型声明（最小化）
 *
 * Node.js 22.5+ 实验性内建 SQLite 模块。
 * Electron 36 (Node 22.19) 已原生支持。
 *
 * 仅声明 DatabaseSync 和 StatementSync 中实际使用的方法。
 */
declare module "node:sqlite" {
  type SupportedValueType = null | number | bigint | string | Uint8Array;

  class DatabaseSync {
    constructor(location: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }

  class StatementSync {
    run(...params: SupportedValueType[]): StatementSyncRunResult;
    get(...params: SupportedValueType[]): Record<string, unknown> | undefined;
    all(...params: SupportedValueType[]): Record<string, unknown>[];
  }

  interface StatementSyncRunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }
}
