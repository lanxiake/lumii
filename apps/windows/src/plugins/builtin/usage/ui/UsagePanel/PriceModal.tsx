/**
 * 模型价格编辑（用量与花费 › 模型价格）
 *
 * 为什么要有：内置价目表只收「厂商官网价」，而用户实际走的多半是中转/自建网关，
 * 单价跟官网不一样（折扣、包月、加价）。没有这一层，花费数字就是个跟真实账单对不上的数。
 *
 * 口径与内置表一致：**按模型前缀匹配**（大小写不敏感的最长前缀），自定义优先于内置。
 * 「恢复官方价」= 删掉该前缀的自定义条目，让内置表重新生效。
 *
 * 输入的模型前缀默认取自「本区间出现过的模型」，也可手填一个（比如想给还没用过的模型定价）。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '../../../../../renderer/components/ui/Button/Button'
import { Input } from '../../../../../renderer/components/ui/Input/Input'
import { Modal } from '../../../../../renderer/components/ui/Modal'
import { hasBuiltinPrice, listBuiltinPrices } from '../../../../../shared/model-pricing'
import type { UsageModelStat } from '../../store'
import styles from './PriceModal.module.css'

/** 一行编辑态；字符串存是因为输入框允许中间态（空、`0.`） */
interface PriceRow {
  prefix: string
  input: string
  output: string
  cacheRead: string
  cacheWrite: string
  perCall: string
  /** 内置表里有没有这个前缀（决定「恢复官方价」提示与占位文案） */
  builtin: boolean
  /** 内置价（元/1M 或 元/次），只用来做输入框占位提示 */
  builtinHint?: { input: string; output: string; cacheRead: string; cacheWrite: string; perCall: string }
  /** 是否来自用户自定义（决定删除时要同步清掉自定义价） */
  custom: boolean
}

interface PriceModalProps {
  open: boolean
  onClose: () => void
  /** 本区间出现过的模型；用它做默认行，省得用户手打前缀 */
  models: UsageModelStat[]
  /** 保存成功后让外层重算花费 */
  onSaved: () => void
}

/** 从服务端返回的自定义价里安全取数 */
function num(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : ''
}

/**
 * 内置价（最长前缀匹配，与 `estimateCostYuan` 同口径）。
 *
 * 拿它做输入框的占位数字：留空时用户能直接看到「现在按什么价算」，
 * 不用去翻代码或官网——这是「自定义价覆盖内置价」这个模型能自解释的关键。
 */
const BUILTIN_PRICES = listBuiltinPrices()
function builtinHintFor(model: string): PriceRow['builtinHint'] {
  const id = model.toLowerCase()
  let hit: (typeof BUILTIN_PRICES)[number] | undefined
  let hitLen = 0
  for (const entry of BUILTIN_PRICES) {
    if (id.includes(entry.prefix) && entry.prefix.length > hitLen) {
      hit = entry
      hitLen = entry.prefix.length
    }
  }
  if (!hit) return undefined
  const p = hit.price
  const fmt = (v: number | undefined) => (v === undefined || v === 0 ? '' : String(v))
  return {
    input: fmt(p.inputYuanPerMTok),
    output: fmt(p.outputYuanPerMTok),
    cacheRead: fmt(p.cacheReadYuanPerMTok),
    cacheWrite: fmt(p.cacheWriteYuanPerMTok),
    perCall: fmt(p.perCallYuan),
  }
}

export const PriceModal: React.FC<PriceModalProps> = ({ open, onClose, models, onSaved }) => {
  const [rows, setRows] = useState<PriceRow[]>([])
  const [extraPrefix, setExtraPrefix] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  // 用户点垃圾桶删掉的行：同一会话内重开弹窗不再从「本区间用过的模型」里捡回来。
  // 只活内存（离开设置页就忘），因为「本区间出现过的模型」本来就是每次查询重新算的；
  // 真要长期不看某个模型，给它留空价即可（空价 = 用内置价，不产生花费噪音）。
  const removedRef = useRef<Set<string>>(new Set())
  // models 每次查询都是新数组，放进 useCallback 依赖会让 reload 一直换身份 → 打开弹窗就重载死循环。
  // 用 ref 取最新值，reload 只需要在「打开」时跑一次。
  const modelsRef = useRef(models)
  modelsRef.current = models

  const reload = useCallback(async () => {
    setLoading(true)
    setErrorMsg(null)
    try {
      const res = await window.electronAPI.usage.getPrices()
      const custom = (res?.data ?? {}) as Record<string, Record<string, unknown>>
      setRows((prev) => {
        // 本区间出现过的模型前缀 ∪ 已有自定义条目（自定义但本区间没用过的也要能改）
        const prefixes = new Set<string>(modelsRef.current.map((m) => m.model))
        for (const key of Object.keys(custom)) prefixes.add(key)
        const next: PriceRow[] = []
        for (const model of prefixes) {
          if (removedRef.current.has(model.toLowerCase())) continue
          const hitKey = Object.keys(custom).find((k) => model.toLowerCase().includes(k))
          const c = hitKey ? custom[hitKey] : undefined
          const prevRow = prev.find((r) => r.prefix === model)
          next.push({
            prefix: model,
            input: c ? num(c.inputYuanPerMTok) : (prevRow?.input ?? ''),
            output: c ? num(c.outputYuanPerMTok) : (prevRow?.output ?? ''),
            cacheRead: c ? num(c.cacheReadYuanPerMTok) : (prevRow?.cacheRead ?? ''),
            cacheWrite: c ? num(c.cacheWriteYuanPerMTok) : (prevRow?.cacheWrite ?? ''),
            perCall: c ? num(c.perCallYuan) : (prevRow?.perCall ?? ''),
            // 「内置表里有没有这个模型」——决定输入框的占位提示（与「有无自定义价」是两件事）
            builtin: hasBuiltinPrice(model),
            builtinHint: builtinHintFor(model),
            custom: c !== undefined,
          })
        }
        return next.sort((a, b) => a.prefix.localeCompare(b.prefix))
      })
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setExtraPrefix('')
    void reload()
  }, [open, reload])

  const patch = useCallback((prefix: string, p: Partial<PriceRow>) => {
    setRows((prev) => prev.map((r) => (r.prefix === prefix ? { ...r, ...p } : r)))
  }, [])

  const addRow = useCallback(() => {
    const prefix = extraPrefix.trim()
    if (!prefix) return
    // 手加的模型也要能立刻看到它的内置价占位（比如给没用过的 claude-opus-5-5 定价）
    removedRef.current.delete(prefix.toLowerCase())
    setRows((prev) =>
      prev.some((r) => r.prefix === prefix)
        ? prev
        : [...prev, {
            prefix,
            input: '',
            output: '',
            cacheRead: '',
            cacheWrite: '',
            perCall: '',
            builtin: hasBuiltinPrice(prefix),
            builtinHint: builtinHintFor(prefix),
            custom: false,
          }].sort((a, b) => a.prefix.localeCompare(b.prefix)),
    )
    setExtraPrefix('')
  }, [extraPrefix])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setErrorMsg(null)
    try {
      // 只有「填了输入+输出」或者「填了按次价」的行才落盘；空行等于没改
      const payload: Record<string, Record<string, number>> = {}
      for (const r of rows) {
        const prefix = r.prefix.trim().toLowerCase()
        if (!prefix) continue
        const perCall = r.perCall.trim() ? Number(r.perCall) : undefined
        const input = r.input.trim() ? Number(r.input) : 0
        const output = r.output.trim() ? Number(r.output) : 0
        const isBlank =
          !r.input.trim() && !r.output.trim() && !r.cacheRead.trim() && !r.cacheWrite.trim() && perCall === undefined
        if (isBlank) continue
        if ([input, output, perCall].some((n) => n !== undefined && (!Number.isFinite(n) || n < 0))) {
          throw new Error(`「${r.prefix}」里有非法数字（要 ≥ 0）`)
        }
        payload[prefix] = {
          inputYuanPerMTok: input,
          outputYuanPerMTok: output,
          ...(r.cacheRead.trim() ? { cacheReadYuanPerMTok: Number(r.cacheRead) } : {}),
          ...(r.cacheWrite.trim() ? { cacheWriteYuanPerMTok: Number(r.cacheWrite) } : {}),
          ...(perCall !== undefined ? { perCallYuan: perCall } : {}),
        }
      }
      const res = await window.electronAPI.usage.setPrices(payload)
      if (!res?.success) throw new Error(res?.error ?? '保存失败')
      onSaved()
      onClose()
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }, [rows, onSaved, onClose])

  /**
   * 删除一行。
   *
   * 两种含义要分清（用户报的就是这里没做区分）：
   * - **有自定义价**的行：真正的「删掉这个模型的定价」——清空它在本机价格表里的条目，
   *   让它回到内置价（或价格未知）。得立刻落盘，否则下次打开又冒出来。
   * - **只是本区间用过、没有自定义价**的行：删掉的只是这行显示，不动任何定价。
   *   这种行如果允许永久隐藏也没意义（下次查询又会算出来），所以只在本弹窗生命周期内记住。
   *
   * 这比「删除」= 清空输入框更符合直觉：清空输入框本来就是「用内置价」的表达方式。
   */
  const removeRow = useCallback(
    async (prefix: string) => {
      const key = prefix.toLowerCase()
      removedRef.current.add(key)
      const row = rows.find((r) => r.prefix === prefix)
      setRows((prev) => prev.filter((r) => r.prefix !== prefix))
      // 没有自定义价 = 只是列表里的展示行，删掉它不影响任何定价，不必落盘
      if (!row?.custom) return
      try {
        // syncPrices 的语义是「删掉含该前缀的自定义条目」，正好就是这里的需要
        const res = await window.electronAPI.usage.syncPrices(prefix)
        if (res?.success) onSaved()
        else setErrorMsg(res?.error ?? '删除失败')
      } catch (e: unknown) {
        setErrorMsg(e instanceof Error ? e.message : String(e))
      }
    },
    [rows, onSaved],
  )

  const handleSyncAll = useCallback(async () => {
    setSaving(true)
    try {
      const res = await window.electronAPI.usage.syncPrices()
      if (res?.success) {
        setRows((prev) => prev.map((r) => ({ ...r, input: '', output: '', cacheRead: '', cacheWrite: '', perCall: '', custom: false, builtin: true })))
        onSaved()
      }
    } finally {
      setSaving(false)
    }
  }, [onSaved])

  const dirtyCount = useMemo(
    () => rows.filter((r) => r.input.trim() || r.output.trim() || r.perCall.trim()).length,
    [rows],
  )

  const footer = (
    <>
      <Button variant="ghost" onClick={onClose} disabled={saving}>
        取消
      </Button>
      <Button variant="primary" onClick={() => void handleSave()} loading={saving} disabled={loading || saving}>
        保存（{dirtyCount}）
      </Button>
    </>
  )

  return (
    <Modal open={open} title="模型价格" onClose={onClose} width={760} layer="aboveHub" footer={footer}>
      <div className={styles.wrap}>
        <p className={styles.hint}>
          留空 = 用内置价目表（官方价）。填了就以你填的为准，<b>历史记录也会按新价重算</b>——
          走中转/自建网关时把实际单价填进来，花费才对得上账单。
          <br />
          单价口径：<b>元 / 百万 token</b>；生图这类按次计费的模型填最右一列（元 / 次）。
        </p>

        {errorMsg && <div className={styles.error}>{errorMsg}</div>}

        <div className={styles.toolbar}>
          <Input
            value={extraPrefix}
            onChange={(e) => setExtraPrefix(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addRow()
            }}
            placeholder="加一个模型前缀，如 claude-sonnet-5"
          />
          <Button size="sm" variant="secondary" onClick={addRow} disabled={!extraPrefix.trim()}>
            添加
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void handleSyncAll()} disabled={saving || loading}>
            <RotateCcw size={12} />
            全部恢复官方价
          </Button>
        </div>

        <div className={styles.table}>
          <div className={styles.thead}>
            <span>模型前缀</span>
            <span>输入</span>
            <span>输出</span>
            <span>缓存读</span>
            <span>缓存写</span>
            <span>元/次</span>
            <span title="删除">删</span>
          </div>
          {rows.length === 0 && !loading && (
            <div className={styles.empty}>
              本区间还没有调用记录。上面填一个模型前缀就能给它定价。
            </div>
          )}
          {rows.map((r) => (
            <div key={r.prefix} className={styles.trow}>
              <span className={styles.tname} title={r.prefix}>
                {r.prefix}
                {r.custom && <em className={styles.tag}>自定义</em>}
              </span>
              <Input
                aria-label={`${r.prefix} 输入价`}
                value={r.input}
                onChange={(e) => patch(r.prefix, { input: e.target.value })}
                placeholder={r.builtinHint?.input ?? '官方未知'}
                inputMode="decimal"
              />
              <Input
                aria-label={`${r.prefix} 输出价`}
                value={r.output}
                onChange={(e) => patch(r.prefix, { output: e.target.value })}
                placeholder={r.builtinHint?.output ?? '官方未知'}
                inputMode="decimal"
              />
              <Input
                aria-label={`${r.prefix} 缓存读价`}
                value={r.cacheRead}
                onChange={(e) => patch(r.prefix, { cacheRead: e.target.value })}
                placeholder={r.builtinHint?.cacheRead || '0'}
                inputMode="decimal"
              />
              <Input
                aria-label={`${r.prefix} 缓存写价`}
                value={r.cacheWrite}
                onChange={(e) => patch(r.prefix, { cacheWrite: e.target.value })}
                placeholder={r.builtinHint?.cacheWrite || '0'}
                inputMode="decimal"
              />
              <Input
                aria-label={`${r.prefix} 按次价`}
                value={r.perCall}
                onChange={(e) => patch(r.prefix, { perCall: e.target.value })}
                placeholder={r.builtinHint?.perCall || '—'}
                inputMode="decimal"
              />
              <span className={styles.tactions}>
                <button
                  type="button"
                  className={styles.iconBtn}
                  title={
                    r.custom
                      ? '删除这个模型的自定义定价（回到内置官方价）'
                      : '从列表里移除这一行（不影响定价）'
                  }
                  onClick={() => void removeRow(r.prefix)}
                >
                  <Trash2 size={13} />
                </button>
              </span>
            </div>
          ))}
        </div>

        <p className={styles.foot}>
          价格只存在本机 <code>~/.lumii/usage/prices.json</code>，不上传。估算仅供对账参考，不作账单依据。
        </p>
      </div>
    </Modal>
  )
}
