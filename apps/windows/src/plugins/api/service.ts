/**
 * 核心 ↔ 插件**唯一的运行期通路**：服务访问器。
 *
 * 规则（写进守卫与规范）：
 * - 插件在 `apply(ctx)` 里 `ctx.provide(S.xxx, impl)`，服务随作用域来去；
 * - 核心只认访问器：`getXxxService()?.… `，拿不到就是「功能关闭」，不写兜底分支；
 * - `index.ts` 在宿主建好后注入一次 resolver，之后每次现取容器里的值。
 *
 * 为什么不让核心直接 import 插件实现：那样禁用插件只是让它不 activate，
 * 核心的 import 还在、代码还在跑 —— 「关掉了但还在工作」比要求重启更糟。
 *
 * 服务接口类型定义在插件目录（`service.ts`），核心 **type-only** 引用即可：
 * 编译期擦除，不产生运行期依赖（守卫 ⑪ 不计 type-only）。
 */
export interface ServiceAccessor<T> {
  /** 由 `index.ts` 注入：`() => pluginHost?.container.get(S.xxx) ?? null` */
  setResolver(fn: (() => T | null) | null): void
  /** 每次现取；resolver 抛错时返回 null 并记一行告警（不让插件故障带崩核心） */
  get(): T | null
}

export function defineServiceAccessor<T extends object>(name: string): ServiceAccessor<T> {
  let resolver: (() => T | null) | null = null

  return {
    setResolver(fn) {
      resolver = fn
    },
    get() {
      if (!resolver) return null
      try {
        return resolver()
      } catch (error) {
        console.warn(`[plugin] 服务 ${name} 解析失败`, error)
        return null
      }
    },
  }
}
