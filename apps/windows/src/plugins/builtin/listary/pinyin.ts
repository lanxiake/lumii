/**
 * 拼音索引 — 中文文件名的全拼与首字母。
 *
 * 设计：`docs/design/逆向与复刻/2026-11-14-Listary复刻启动器插件设计.md` §6.4
 *
 * 复刻 Listary 的中文体验。Listary 用一张 `cnmatch.bin` 音节表做同样的事，
 * 历史实证：`youdao` → 有道云笔记.lnk、`2r` → v2rayn.exe。
 *
 * ## 为什么用 pinyin-pro 而不是自写映射表
 *
 * 一张全量 CJK → 拼音的映射表不是"几行代码"能覆盖的（两万多字符 + 多音字），
 * 自写既大又易错。这是 `pinyin-pro` 这类库的既有解。
 *
 * ## 索引什么
 *
 * 每个文件名写两份拼音，都作为**独立的 FTS5 token**：
 * - `pinyinFull`：无分隔全拼，`豆包` → `doubao`
 * - `pinyinInitials`：首字母，`豆包` → `db`
 *
 * 查询侧靠 FTS5 的**前缀语法** `"dou"*` 实现模糊 —— 这样不用把 `doubao` 的所有前缀
 * （d/do/dou/doub/...）都存进去，省一大截索引体积。
 *
 * 副作用（正向）：P0 实测发现"单字 CJK 查询落空"（bigram 索引里没有单字 token）。
 * 走拼音这条路，查 `豆` → `dou` → `"dou"*` 就能命中 `豆包`，顺带把它补上了。
 */

import { pinyin } from 'pinyin-pro'

/**
 * 取全拼（无分隔、小写）。
 *
 * 非中文部分原样保留（`Listary逆向` → `listarynixiang`），因为用户可能
 * 只记得"那个 Listary 什么的"里的英文部分。
 */
export function pinyinFull(text: string): string {
  if (!text) return ''
  try {
    return pinyin(text, { toneType: 'none', separator: '', type: 'string' }).toLowerCase()
  } catch {
    return ''
  }
}

/**
 * 取首字母（无分隔、小写）。非中文部分整段保留。
 *
 * `Listary逆向笔记` → `Listarynxbj`（pinyin-pro 保留拉丁段原文）
 */
export function pinyinInitials(text: string): string {
  if (!text) return ''
  try {
    return pinyin(text, { pattern: 'first', toneType: 'none', separator: '', type: 'string' }).toLowerCase()
  } catch {
    return ''
  }
}

/** 中文（CJK）判定，与 scanner/segmentation 用的是同一区间 */
const CJK_RE = /[㐀-䶿一-鿿]/

/** 串里有没有中文 */
export function hasCjk(text: string): boolean {
  return CJK_RE.test(text)
}

/**
 * 索引侧：把文件名转成要写进 FTS5 的拼音 token 串（空格分隔）。
 *
 * 全拼与首字母都放进去，且**互为补充**：`豆包` 写 `doubao db`。
 * 两者都不是中文时（纯英文文件名）返回空 —— 不必给 `readme.md` 存一遍 `readme.md`。
 */
export function buildPinyinTokens(name: string): string {
  if (!name || !hasCjk(name)) return ''
  const full = pinyinFull(name)
  const initials = pinyinInitials(name)
  const set = new Set<string>()
  if (full) set.add(full)
  if (initials && initials !== full) set.add(initials)
  return [...set].join(' ')
}

/**
 * 由**中文转换而来**的拼音词最小长度。
 *
 * 为什么只卡转换来的、不卡用户直接输入的：
 * - `db` / `dou` 是用户**亲手打的**，他就是要那个 —— 再短也得认（需求明确要求 `db` → 豆包）
 * - `wd` 是从「文档」**转出来的**。用户没想搜"wd"，是系统替他做的主。这种替用户做主
 *   的产物门槛该高一点，否则查「文档」会把所有首字母以 `wd` 开头的条目全带出来
 *   （实测：`我的设计稿` → `wdsjg`，被 `wd` 前缀命中）
 *
 * 取 3：两字母的中文转换噪声太大；三字母（如 `xms`）已能指向具体词。
 */
export const MIN_CONVERTED_PINYIN_LEN = 3

/**
 * 查询侧：把用户输入转成**拼音前缀查询片段**。
 *
 * - 输入含中文 → 转成全拼与首字母，各自加 `*` 做前缀（`豆` → `"dou"*`）
 * - 输入纯拉丁 → 原样做前缀（`dou` → `"dou"*`，`db` → `"db"*`）
 *
 * 纯拉丁一律放行（含短串）—— 那是用户的直接意图，见 `MIN_CONVERTED_PINYIN_LEN`。
 */
export function buildPinyinQuery(input: string): string[] {
  const q = input.trim().toLowerCase()
  if (!q) return []

  const out = new Set<string>()
  if (hasCjk(q)) {
    const full = pinyinFull(q)
    const initials = pinyinInitials(q)
    // 中文转换来的词要过长度门槛
    if (full.length >= MIN_CONVERTED_PINYIN_LEN) out.add(full)
    if (initials.length >= MIN_CONVERTED_PINYIN_LEN) out.add(initials)
  } else {
    out.add(q)
  }
  return [...out]
}

/**
 * 把拼音词转成 FTS5 前缀查询片段：`"dou"*`。
 *
 * 加引号是为了挡住 FTS5 语法字符（与 `query.ts` 的 `ftsQuery` 同一考虑），
 * 引号外的 `*` 才是前缀运算符。
 */
export function pinyinMatchClause(words: readonly string[]): string {
  return words
    .filter((w) => w.length > 0)
    .map((w) => `"${w.replace(/"/g, '""')}"*`)
    .join(' OR ')
}
