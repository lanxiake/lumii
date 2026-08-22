import { useRef } from 'react'

/**
 * 按 id 缓存映射结果：若某项的源对象引用未变，复用上一次的映射结果对象；
 * 若整体内容（顺序 + 每项输出）都未变，连返回的数组本身也复用同一引用。
 * 避免每次父状态更新都为全部条目生成新对象/新数组，从而让下游 useMemo/React.memo
 * 能命中浅比较、跳过未变化条目的重渲染。
 *
 * 前提：源数组里未变化的条目必须保持同一对象引用（由上游 store/reducer 保证），
 * 否则退化为每次都重新映射，不会报错但也不会有缓存收益。
 */
export function useStableMapById<TIn, TOut>(
  items: readonly TIn[],
  getId: (item: TIn) => string,
  map: (item: TIn) => TOut,
): TOut[] {
  const cacheRef = useRef(new Map<string, { input: TIn; output: TOut }>())
  const resultRef = useRef<TOut[]>([])
  const nextCache = new Map<string, { input: TIn; output: TOut }>()
  const prevResult = resultRef.current
  let sameAsPrev = prevResult.length === items.length
  const result: TOut[] = new Array(items.length)

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    const id = getId(item)
    const cached = cacheRef.current.get(id)
    const output = cached && cached.input === item ? cached.output : map(item)
    nextCache.set(id, { input: item, output })
    result[i] = output
    if (sameAsPrev && prevResult[i] !== output) sameAsPrev = false
  }

  cacheRef.current = nextCache
  if (sameAsPrev) return prevResult
  resultRef.current = result
  return result
}

