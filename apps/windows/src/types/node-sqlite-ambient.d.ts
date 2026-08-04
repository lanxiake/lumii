/**
 * `moduleResolution: bundler` 下对 `node:sqlite` 的补充声明（与 @types/node 运行时一致）
 */
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string)
    exec(sql: string): void
    prepare(sql: string): unknown
    close(): void
  }
}
