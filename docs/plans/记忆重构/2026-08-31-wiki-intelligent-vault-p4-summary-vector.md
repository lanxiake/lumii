# Wiki 智能资料库 P4（摘要与向量语料）Implementation Plan

> **For agentic workers:** 按 Task 顺序实施，每个 Task 走「先写失败测试 → 跑失败 → 实现 → 跑通 → 提交」。
> 规格：`docs/design/记忆设计/2026-08-31-wiki-intelligent-vault-design.md` v1.1 §5.7 / §5.8
> 前置：**P1 已落地**（V26 新增 `summary`/`summary_hash`/`summary_level` 三列）、**P3 已落地**（页面向量已删，只剩 `wiki_source_embeddings`）

**Goal:** 让「摘要」成为四方共用的持久派生资产（编目轮 2、AI 重命名、向量语料、UI 列表副标题），并把向量语料从「title + 全量正文」收缩到「title + 摘要 + 主题路径」。这是 P5 编目与 P7 重命名的共同前置。

**Architecture:** 两条线。**(1) 摘要线**——新建 `wiki-summary.ts`，单入口 `getOrBuildSummary(source, { allowLlm })` 三层降级（heuristic → extractive → llm），按 `content_hash` 失效并持久化到 V26 新增的三列，LLM 层惰性触发（只在消费者索取且正文 > 2000 字时）。**(2) 向量线**——改 `wiki-source-vector.ts` 的语料构造函数，从 `title + extracted_text` 改为 `title + summary + 主题路径`（硬上限 300 字），配合 `summary_hash` 让增量重建可跳过。

**Tech Stack:** TypeScript、SQLite、`packages/agent-runtime`、Vitest

---

## 0. 实施前必读：已核实的现状

### 0.1 向量层现状（已读代码确认）

`packages/agent-runtime/src/wiki/wiki-source-vector.ts`：

```ts
// L32-39：语料构造就在 upsertSource 内联，没有独立函数
/** 语料 = title + extracted_text；content_hash 未变且模型一致时跳过 */
async upsertSource(
  source: Pick<WikiSource, "id" | "agent_id" | "user_id" | "title" | "extracted_text">,
): Promise<void> {
  if (!this.embedder) return;
  const corpus = `${source.title}\n\n${source.extracted_text ?? ""}`.trim();
  if (!corpus) return;
  const contentHash = hashContent(corpus);
  // ...
}
```

**三个已确认的缺陷**（设计 §5.8）：
1. 全量 `extracted_text` 无截断、无分块 → 长文压成单向量、语义被平均；embedder 面对超长输入实际只编码开头
2. 编进 OCR 残字、票据数字、页眉页脚等噪声
3. 高信噪比字段（title、主题路径）被长正文淹没

`hashContent(corpus)` 当前哈希的是**语料**而非 `content_hash` 列，注释说的「content_hash 未变则跳过」实际是「语料未变则跳过」——语义等价但要注意改语料后所有行都会失效一次（需要一次全量 rebuild）。

`rebuild(sources)`（L76-87）：`DELETE FROM wiki_source_embeddings` 后逐条 upsert。

`mergeSourceHybridRanks`（L118-142）：FTS ids 与 vector ids 做 RRF，再按 `use_count` 轻微加权（`0.01 * useCount`）。**本 Task 不改这里**——分工正是「向量管语义、FTS 管精确与长文」，收缩语料后这个分工才真正成立。

### 0.2 依赖的 wiki-vector.ts 导出

`wiki-source-vector.ts` 从 `./wiki-vector.js` import：`bufferToFloat32`、`cosineSimilarity`、`float32ToBuffer`、`hashContent`、`reciprocalRankFusion`、`type WikiEmbedder`。

**P3 删页面向量时必须保留这些通用工具函数**（见 P3 计划）。本计划假定 P3 已正确保留。

### 0.3 可复用的中文分词能力

`packages/agent-runtime/src/wiki/wiki-index.ts` 有 `wikiBigramJoin(text)`（L109 处被 `rebuildSourceFts` 调用），把中文文本切成 bigram token 串。**extractive 层复用它做关键句打分**，不引入新依赖。

### 0.4 V26 新增列（P1 交付）

```
summary        TEXT
summary_hash   TEXT
summary_level  TEXT CHECK (summary_level IN ('heuristic','extractive','llm'))
```

---

## 1. 关键设计决定

### D1：摘要层级按正文长度分档，不按 media_type

正文长度是唯一可靠的分档依据。`media_type` 只用于「有没有正文」的判断（无正文走 P5 的 §6.4 路径，不进摘要管线）。

| 层 | 触发 | 方法 | 成本 |
|---|---|---|---|
| `heuristic` | 正文 < 800 字 | 首个 Markdown 标题 + 去样板后前若干非空行；正文本身够短即摘要 | 0 |
| `extractive` | 800–2000 字 | bigram/TF-IDF 选 3 个关键句（复用 `wikiBigramJoin`） | 0 |
| `llm` | > 2000 字 **且** `allowLlm=true` **且** 无有效摘要 | 首 3000 字 + 尾 500 字 → ≤120 字 | 1 次小调用 |

### D2：LLM 层惰性，不在摄入时批量生成

摄入时只跑 `heuristic`/`extractive`（零成本）。`llm` 层只在消费者显式索取（`allowLlm=true`）时触发，即：P5 编目内容轮、P7 重命名、用户手动点「生成摘要」。**UI 列表副标题一律用 `allowLlm=false`**，避免滚动列表触发几百次 LLM 调用。

### D3：摘要不写回正文

`summary` 只用于分类判断与列表展示。**绝不写回 `content_md` 或 `extracted_text`**，避免 LLM 幻觉污染原始资料（设计 §13 风险表）。

### D4：失效判据用 content_hash 而非语料 hash

`summary_hash` 存生成摘要时 `wiki_sources.content_hash` 的值。`summary_hash != content_hash` → 失效重算。这样文件内容不变时永久复用，**第二次跑全库编目的摘要成本为 0**。

`content_hash` 为 NULL 的行（无正文）不产摘要。

---

## Task 1: 摘要模块 heuristic + extractive 两层

**Owner:** backend
**Files:** 新建 `packages/agent-runtime/src/wiki/wiki-summary.ts`、新建 `wiki-summary.test.ts`

### 1.1 接口

```ts
export const SUMMARY_MAX_CHARS = 120;
export const HEURISTIC_MAX_TEXT = 800;
export const EXTRACTIVE_MAX_TEXT = 2000;
export const LLM_HEAD_CHARS = 3000;
export const LLM_TAIL_CHARS = 500;

export type SummaryLevel = "heuristic" | "extractive" | "llm";

export interface SummaryResult {
  readonly summary: string;
  readonly level: SummaryLevel;
}

/** 纯函数，零成本，无 LLM。正文 < 800 字走此层。 */
export function buildHeuristicSummary(title: string, text: string): SummaryResult | null;

/** 纯函数，零成本，复用 wikiBigramJoin 打分选 3 句。800–2000 字走此层。 */
export function buildExtractiveSummary(title: string, text: string): SummaryResult | null;
```

### 1.2 heuristic 实现要点

1. 若正文首行是 Markdown 标题（`# xxx`）→ 取标题 + 后续首个非空段落
2. 去样板：连续空行、纯符号行、`---` 分隔线、页码行（纯数字行）、明显的页眉页脚重复行
3. 取去样板后前 N 个非空行，拼接截断到 `SUMMARY_MAX_CHARS`
4. 正文本身 ≤ `SUMMARY_MAX_CHARS` 时直接返回正文（此时正文即摘要）
5. 去样板后为空 → 返回 `null`（交由上层降级或放弃）

### 1.3 extractive 实现要点

1. 按中文句读（`。！？；\n`）切句，过滤长度 < 8 的碎句
2. 用 `wikiBigramJoin` 得到每句的 bigram token 集合
3. 打分：句子 token 与「全文高频 token（去掉全局停用 bigram）」的重合度，标题 token 命中加权
4. 取 Top3，按原文顺序拼接，截断到 `SUMMARY_MAX_CHARS`
5. 句子数 < 3 时降级到 `buildHeuristicSummary`

### 1.4 测试

```ts
describe('buildHeuristicSummary', () => {
  test('短正文直接作摘要', () => {
    const r = buildHeuristicSummary('周报', '本周完成了登录改造。');
    expect(r).toEqual({ summary: '本周完成了登录改造。', level: 'heuristic' });
  });

  test('Markdown 标题 + 首段', () => { /* ... */ });
  test('去掉页码行与分隔线', () => { /* ... */ });
  test('去样板后为空返回 null', () => {
    expect(buildHeuristicSummary('x', '---\n\n1\n\n2\n')).toBeNull();
  });
  test('截断到 120 字', () => { /* ... */ });
});

describe('buildExtractiveSummary', () => {
  test('选出含标题关键词的句子', () => { /* ... */ });
  test('过滤 < 8 字碎句', () => { /* ... */ });
  test('句子数不足 3 时降级 heuristic', () => {
    const r = buildExtractiveSummary('t', '短句一。短句二。');
    expect(r?.level).toBe('heuristic');
  });
  test('输出保持原文顺序', () => { /* ... */ });
});
```

---

## Task 2: LLM 层 + getOrBuildSummary 单入口

**Owner:** backend
**Files:** `packages/agent-runtime/src/wiki/wiki-summary.ts`、`wiki-summary.test.ts`

### 2.1 LLM 提示词

```ts
export function buildSummaryPrompt(title: string, text: string): string {
  const head = text.slice(0, LLM_HEAD_CHARS);
  const tail = text.length > LLM_HEAD_CHARS + LLM_TAIL_CHARS
    ? `\n\n……（中间省略）……\n\n${text.slice(-LLM_TAIL_CHARS)}`
    : "";
  return [
    "用一句话概括这份资料讲什么，供分类归档用。",
    "",
    "要求：",
    "- 不超过 120 字，一句话",
    "- 说清「这是什么类型的东西」和「关于什么」，不要复述细节",
    "- 不要写「这份文件」「本文档」这类废话开头",
    "- 只依据给出的内容，不要推测补充",
    "",
    `标题：${title}`,
    "内容：",
    head + tail,
  ].join("\n");
}
```

### 2.2 单入口

```ts
export class WikiSummarizer {
  constructor(
    private readonly repo: WikiRepo,
    private readonly callLLM: ((prompt: string) => Promise<string>) | null,
  ) {}

  /**
   * 摘要单入口。allowLlm=false 时最多降级到 extractive，绝不静默调用 LLM。
   * summary_hash === content_hash 时直接返回缓存。
   */
  async getOrBuildSummary(
    source: WikiSource,
    opts: { allowLlm: boolean },
  ): Promise<SummaryResult | null> {
    // 1) 缓存命中
    if (source.summary && source.summary_hash && source.summary_hash === source.content_hash) {
      return { summary: source.summary, level: source.summary_level ?? 'heuristic' };
    }
    // 2) 无正文 / 无 content_hash → null（交 P5 §6.4 路径）
    const text = source.extracted_text ?? source.content_md ?? '';
    if (!text.trim() || !source.content_hash) return null;

    // 3) 按长度分档
    let result: SummaryResult | null;
    if (text.length < HEURISTIC_MAX_TEXT) {
      result = buildHeuristicSummary(source.title, text);
    } else if (text.length < EXTRACTIVE_MAX_TEXT) {
      result = buildExtractiveSummary(source.title, text);
    } else if (opts.allowLlm && this.callLLM) {
      result = await this.buildLlmSummary(source.title, text);   // 失败降级 extractive
    } else {
      result = buildExtractiveSummary(source.title, text);       // allowLlm=false 的降级路径
    }
    if (!result) return null;

    // 4) 持久化
    this.repo.updateSourceSummary(source.id, result.summary, source.content_hash, result.level);
    return result;
  }
}
```

### 2.3 repo 方法

`wiki-repo.ts` 新增：

```ts
updateSourceSummary(sourceId: string, summary: string, contentHash: string, level: SummaryLevel): void {
  this.db.prepare(
    `UPDATE wiki_sources SET summary = ?, summary_hash = ?, summary_level = ? WHERE id = ?`
  ).run(summary, contentHash, level, sourceId);
}
```

`WikiSource` 类型（`types.ts`）补三个字段。

### 2.4 测试

```ts
test('缓存命中不重算', async () => {
  const source = { ..., summary: '已有摘要', summary_hash: 'h1', content_hash: 'h1' };
  const spy = vi.fn();
  const r = await summarizer.getOrBuildSummary(source, { allowLlm: true });
  expect(r?.summary).toBe('已有摘要');
  expect(spy).not.toHaveBeenCalled();   // callLLM 未被调
});

test('content_hash 变化则重算', async () => { /* summary_hash='h1', content_hash='h2' */ });

test('allowLlm=false 时长正文降级到 extractive，不调 LLM', async () => {
  const callLLM = vi.fn();
  const r = await new WikiSummarizer(repo, callLLM).getOrBuildSummary(longSource, { allowLlm: false });
  expect(callLLM).not.toHaveBeenCalled();
  expect(r?.level).toBe('extractive');
});

test('LLM 调用失败降级 extractive 而非抛错', async () => {
  const callLLM = vi.fn().mockRejectedValue(new Error('timeout'));
  const r = await summarizer.getOrBuildSummary(longSource, { allowLlm: true });
  expect(r?.level).toBe('extractive');
});

test('无正文返回 null 且不写库', async () => {
  const r = await summarizer.getOrBuildSummary(imageSource, { allowLlm: true });
  expect(r).toBeNull();
});

test('摘要不写回正文', async () => {
  await summarizer.getOrBuildSummary(longSource, { allowLlm: true });
  const after = repo.findSourceById(longSource.id);
  expect(after.extracted_text).toBe(longSource.extracted_text);  // 未被改动
  expect(after.content_md).toBe(longSource.content_md);
});
```

---

## Task 3: 向量语料收缩

**Owner:** backend
**Files:** `packages/agent-runtime/src/wiki/wiki-source-vector.ts`、`wiki-source-vector.test.ts`

### 3.1 实现

抽出独立的语料构造函数（当前是内联在 `upsertSource` 里的）：

```ts
export const VECTOR_CORPUS_MAX_CHARS = 300;

/**
 * 向量语料 = title + summary + 主题路径，硬上限 300 字。
 *
 * 不再编码全量 extracted_text：长文压成单向量会让语义被平均，且吸入 OCR 残字、
 * 票据数字、页眉页脚等噪声，反而污染全库余弦相似度。长文关键词命中交给 FTS
 * （BM25 本就强于单向量），二者在 mergeSourceHybridRanks 里做 RRF —— 向量管
 * 语义改写查询，FTS 管精确匹配与长文。
 *
 * 设计：2026-08-31-wiki-intelligent-vault-design.md §5.8
 */
export function buildVectorCorpus(
  source: Pick<WikiSource, "title" | "summary" | "topic_category" | "topic_subtopic">,
): string {
  const topicPath = [source.topic_category, source.topic_subtopic].filter(Boolean).join(" / ");
  return [source.title, source.summary ?? "", topicPath]
    .filter((s) => s.trim())
    .join("\n")
    .slice(0, VECTOR_CORPUS_MAX_CHARS)
    .trim();
}
```

`upsertSource` 的 `Pick` 类型随之改为 `"id" | "agent_id" | "user_id" | "title" | "summary" | "topic_category" | "topic_subtopic"`，`corpus` 改调 `buildVectorCorpus(source)`。

**注意**：`hashContent(corpus)` 的短路机制天然适配——语料变短后所有存量行 hash 都变，**首次运行会全量重算一次**（这是预期的，见 Task 4）。

### 3.2 测试

```ts
test('语料 = title + summary + 主题路径', () => {
  expect(buildVectorCorpus({ title: '周报', summary: '本周登录改造', topic_category: '工作', topic_subtopic: '例行' }))
    .toBe('周报\n本周登录改造\n工作 / 例行');
});

test('无摘要时只用 title + 主题路径', () => { /* ... */ });
test('小类为空时主题路径只有大类', () => {
  expect(buildVectorCorpus({ title: 't', summary: null, topic_category: '工作', topic_subtopic: null }))
    .toBe('t\n工作');
});
test('收件箱资料（无主题）只用 title + summary', () => { /* ... */ });
test('硬截断 300 字', () => { /* ... */ });

test('语料未变时跳过 embed', async () => {
  const embed = vi.fn().mockResolvedValue(new Float32Array(4));
  await index.upsertSource(source);
  await index.upsertSource(source);
  expect(embed).toHaveBeenCalledTimes(1);
});

test('摘要变化触发重新 embed', async () => { /* ... */ });
```

---

## Task 4: 摄入链路接摘要 + 一次全量重建

**Owner:** backend
**Files:** `packages/agent-runtime/src/wiki/wiki-organizer.ts`、`apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts`、`packages/agent-runtime/src/wiki/bridge.ts`（惰性 summarizer）

### 4.1 摄入时生成零成本摘要

`WikiOrganizer` 的 `takeAndEnrich` / `intakeBatch` 路径在建 source 后调：

```ts
await this.summarizer.getOrBuildSummary(source, { allowLlm: false });  // 零成本层
await this.sourceVectorIndex.upsertSource(source);                     // 语料已含摘要
```

**顺序很重要**：先摘要后向量，否则向量语料里 `summary` 为空。

### 4.2 `wiki:vector:rebuild` 一次全量

P3 已删页面向量分支。本 Task 让 rebuild 在 embed 前先补摘要：

```ts
// handleWikiVectorRebuild
const sources = bridge.wikiRepo.listSources({});
for (const s of sources) {
  await summarizer.getOrBuildSummary(s, { allowLlm: false });   // 补零成本摘要
}
const n = await sourceVectorIndex.rebuild(bridge.wikiRepo.listSources({}));  // 重读带摘要的行
```

返回结构补 `summarized: number` 字段，UI 显示「已生成 N 条摘要、重建 M 条向量」。

### 4.3 新增内部 IPC `wiki:source:summary`

供 P5/P7 索取 `allowLlm=true` 的摘要：

```ts
// 入参 { sourceId: string, allowLlm?: boolean }
// 出参 { summary: string | null, level: SummaryLevel | null }
```

加入 `command-allowlist.ts`（与其他 `wiki:*` 一致）。

### 4.4 测试

```ts
test('摄入后 source 带零成本摘要', async () => { /* organizer.intakeBatch → summary 非空、level != 'llm' */ });
test('摄入不触发 LLM 摘要', async () => { /* callLLM 未被调 */ });
test('rebuild 先补摘要再 embed，返回 summarized 计数', async () => { /* ... */ });
test('wiki:source:summary allowLlm=true 对长正文走 llm 层', async () => { /* ... */ });
```

---

## Task 5: UI 列表副标题用摘要

**Owner:** frontend
**Files:** `apps/windows/src/renderer/pages/MemoriesPage/components/WikiFileList.tsx`

### 5.1 实现

列表行副标题优先级：`summary` → `extracted_text` 前 60 字 → 无副标题。

**不在渲染时触发摘要生成**（`allowLlm=false` 也不调）——滚动列表触发几百次同步调用会卡 UI。摘要只在摄入与 rebuild 时生成；列表只读已有值。

### 5.2 测试

```ts
test('有摘要时显示摘要', () => { /* @testing-library/react */ });
test('无摘要时回退正文前 60 字', () => { /* ... */ });
test('渲染不触发任何 IPC', () => { /* ... */ });
```

---

## 6. 验收

- [ ] `pnpm test` 全绿（`packages/agent-runtime` + `apps/windows`）
- [ ] `pnpm build` 通过
- [ ] 手动：一份 3000 字长文摄入 → `summary_level='extractive'`、`summary` 非空、`callLLM` 未被调
- [ ] 手动：对该资料调 `wiki:source:summary { allowLlm: true }` → `summary_level='llm'`、摘要 ≤120 字
- [ ] 手动：改动该文件内容重新摄入 → `summary_hash` 变化、摘要重算
- [ ] 手动：`wiki:vector:rebuild` → 返回 `summarized` 与向量条数，第二次跑 `summarized` 不变（缓存生效）
- [ ] 手动：检索「报销流程」这类同义改写查询，确认收缩语料后召回不劣化（与迁移前对比记录一次）

---

## 7. 风险

| 项 | 处理 |
|---|---|
| 语料改变导致全量向量失效 | 预期行为；Task 4.2 的 rebuild 一次补齐，UI 提示「首次重建耗时较长」 |
| extractive 中文选句质量不稳 | Task 1.4 用真实中文样本测；质量不达标时 heuristic 兜底（宁可短而准） |
| LLM 摘要幻觉 | D3：不写回正文，只用于分类与展示 |
| 收缩语料后长文召回下降 | 长文由 FTS 承担（`mergeSourceHybridRanks` 已有 RRF）；验收项含召回对比 |
| `summary_level` CHECK 约束 | 三个值与 `SummaryLevel` 类型必须一致，模块内加断言测试 |
