/**
 * 本次启动真正激活的插件 id 快照。
 *
 * 为什么要这一层：P2 阶段只有「注册函数被搬进插件文件」，调用点仍留在核心模块
 * （`ipc-handlers-registry.ts` / `bridge-tool-registrar.ts` / `index.ts`）。
 * 那些位置拿不到 `pluginHost`（bridge 在 index 之外构造，反向 import 会成环），
 * 于是「禁用插件」只跳过了 `host.register()`，功能照旧接线——文档上的「可禁用」是假的。
 *
 * 由 `startExtensions()` 在外部扩展加载完之后写一次；扩展开关本来就是「重启后生效」
 * （见 extension-control.ts），所以这里是快照而不是实时查询。
 */
const KEY = Symbol.for('lumii.extensions.active')

const shared = ((globalThis as Record<symbol, unknown>)[KEY] ??= {
  ids: new Set<string>(),
  ready: false,
}) as { ids: ReadonlySet<string>; ready: boolean }

export function setActiveExtensionIds(ids: ReadonlySet<string>): void {
  shared.ids = ids
  shared.ready = true
}

/**
 * 插件本次启动是否激活（禁用项不在集合里）。
 *
 * **快照还没写时一律当作启用**：空集合若被当成「全都禁用」，任何在 `startExtensions()`
 * 之前跑的消费方（单测里直接构造 bridge、启动早期阶段）都会悄悄把功能关掉，
 * 而症状是「功能没了」——比「禁用了没关掉」难查得多。
 */
export function isExtensionActive(id: string): boolean {
  return !shared.ready || shared.ids.has(id)
}
