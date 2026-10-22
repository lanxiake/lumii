/**
 * 本次启动真正激活的插件 id 快照。
 *
 * 为什么要这一层：P2 阶段只有「注册函数被搬进插件文件」，调用点仍留在核心模块
 * （`ipc-handlers-registry.ts` / `bridge-tool-registrar.ts` / `index.ts`）。
 * 那些位置拿不到 `pluginHost`（bridge 在 index 之外构造，反向 import 会成环），
 * 于是「禁用插件」只跳过了 `host.register()`，功能照旧接线——文档上的「可禁用」是假的。
 *
 * 由 `startExtensions()` 在外部扩展加载完之后写一次；扩展开关本来就是「重启后生效」
 * （见 control.ts），所以这里是快照而不是实时查询。
 */
const KEY = Symbol.for('lumii.extensions.active')

const shared = ((globalThis as Record<symbol, unknown>)[KEY] ??= {
  ids: new Set<string>(),
  ready: false,
  resolve: null as ((id: string) => boolean) | null,
}) as { ids: ReadonlySet<string>; ready: boolean; resolve: ((id: string) => boolean) | null }

/** 快照式：启动时算一次，运行期不变。 */
export function setActiveExtensionIds(ids: ReadonlySet<string>): void {
  shared.ids = ids
  shared.ready = true
}

/**
 * 实时式：直接问宿主「这个插件现在是 active 吗」。
 *
 * 运行期启停（设置页开关不再重启）之后，启动快照会过期——插件已经停了，
 * 快照还说它开着。装配阶段的一次性消费方无所谓，但**运行期还会再读的地方**
 * （如 bridge 播种盯梢任务）必须拿到实时状态。
 */
export function setExtensionActiveResolver(resolve: ((id: string) => boolean) | null): void {
  shared.resolve = resolve
}

/**
 * 插件当前是否生效。
 *
 * **既没解析器也没快照时一律当作启用**：空集合若被当成「全都禁用」，任何在
 * `startExtensions()` 之前跑的消费方（单测里直接构造 bridge、启动早期阶段）都会悄悄把
 * 功能关掉，而症状是「功能没了」——比「禁用了没关掉」难查得多。
 */
export function isExtensionActive(id: string): boolean {
  if (shared.resolve) return shared.resolve(id)
  return !shared.ready || shared.ids.has(id)
}
