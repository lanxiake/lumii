# Agent 录屏教程流程优化 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 Agent 录制本机/Lumii 操作教程时 **LLM 思考轮次 ↓75%、工具调用 ↓65%、任务总耗时 ↓75%**，并提供画面标注（笔记画圈）能力作为可选后期功能。核心抓手：refs 语义补全 + 结构化探路手册 + 高层工具合并 + stale_snapshot 透明兜底。

**Architecture:**
- **P0 基础层（不引入新工具，见效最快）**：`app-ui-control/snapshot.ts` SELECTORS 扩 `[data-app-ui-heading]`/`[data-app-ui-label]`；SettingsPage.tsx 给关键标题与字段名打属性；`filterSnapshotNodes` 两阶段配额截断；`app_screenshot` 加 `refs_filter` 过滤参数；Skill `SKILL.md` 追加 TutorialNavSpec v1 契约。
- **P1 高层工具与稳定性层**：新增 5 个高层工具（`app_goto_and_screenshot` / `app_scroll_to_text` / `app_scroll_to_bottom` / `app_fill_form` / `app_settings_model_config_save`）统一消费独立的 `high` quota bucket；`controller.click/type/select/scroll` 在 `stale_snapshot` 时内部自重试一次；act.ts 新增 `NON_INTERACTIVE_ROLES` → `not_interactive` 错误码。
- **P2 可选画圈标注（用户要"笔记画圈"任务时才启用）**：`screen-record-service.ts` 扩 `timeline` 类型接受 annotation；`screen_record_annotate` 新工具；narrate 阶段先 ffmpeg 烧 annotation 中间文件，再烧 subtitle 到最终交付 MP4（两步串行，调试与失败降级方便）。

**Tech Stack:** TypeBox Schema、Electron `executeJavaScript` + `sendInputEvent`、ffmpeg `drawbox`/`drawtext` 滤镜（annotation 用）、Vitest + mock controller、现有 `resizeImageIfNeeded`

**设计文档：** `docs/design/2026-08-16-agent-tutorial-recording-optimization-design.md`

**前置依赖：** `feat-screen-record-tutorial-pipeline` 特性已合并到主分支（`screen_record_mark/timeline` 已交付；`screen-tutorial-pipeline` SKILL.md 已存在）。

---

## Part 0：修正前的代码核查清单（实施前必须过一遍）

| 核查项 | 路径 | 预期结果 | 若不匹配怎么办 |
|--------|------|---------|--------------|
| snapshot.ts 的 SELECTORS 有哪些角色 | `apps/windows/src/main/app-ui-control/snapshot.ts:21-34` | 无 heading/section_title/label | 正常 |
| SettingsPage 模型配置卡片标题是否为 h3 | `SettingsPage.tsx:1257` renderSlotCard → `<span>` 非 h3 | 打 `data-app-ui-heading` 属性 | 实施 Task 2 |
| CAPABILITY_SLOT_LABEL.chat 文案 | `model-config-service.ts:82` | "文本对话"（不是"文本对话 Agent"） | 后面的示例注意修正 |
| "保存全部"按钮是否真的存在 | `SettingsPage.tsx:1514-1518` renderModelConfigSettings | `<Button>保存全部</Button>` | 正常 |
| CLICK_BLOCK_ROLES 只有哪些 | `act.ts:4` | composer, runtime（缺 heading） | Task 3 扩 NON_INTERACTIVE_ROLES |
| validateRefAct 返回 stale_snapshot 位置 | `controller.ts:476-507` | cacheById 是 controller 内部 Map | 重试放 controller 层（Task 7） |
| APP_UI_QUOTA 现有 kind | `bridge-app-ui-tools.ts:26-30` | screenshot/act/goto（缺 high） | Task 5 扩 kind |
| SKILL.md 探路节是否要求结构化输出 | `bundled-skills/.../SKILL.md:51-57` | 只说"先不录屏走一遍" | Task 4 扩契约 |
| screen-record timeline 类型 | `screen-record-service.ts:140` | `ScreenRecordMarker[]`（缺 annotation） | Task 9 扩联合类型 |

以上清单全部人工 grep 确认一遍，不要凭记忆。

```bash
# 一键核查（Windows PowerShell）
cd e:\my-project\open-source\lumii
Select-String -Path "apps\windows\src\main\app-ui-control\snapshot.ts" -Pattern "SELECTORS" -Context 0,15
Select-String -Path "apps\windows\src\renderer\services\model-config-service.ts" -Pattern "CAPABILITY_SLOT_LABEL.*chat"
Select-String -Path "apps\windows\src\main\app-ui-control\act.ts" -Pattern "CLICK_BLOCK_ROLES"
Select-String -Path "apps\windows\src\main\agent-runtime\bridge-app-ui-tools.ts" -Pattern "APP_UI_QUOTA" -Context 0,5
```

**核查全部匹配预期后，开始 Part A。若有任一项不匹配，先记在文档末尾 Deviations 节，再按实际情况调整 Task。**

---

## Part A：P0 基础层（Task 1–4，最快见效，约 2.5 天可独立交付）

---

### Task 1: 扩 snapshot SELECTORS + heading/label 语义 + 两阶段配额截断

**Files:**
- Modify: `apps/windows/src/main/app-ui-control/snapshot.ts`
  - SELECTORS 加两行：`'[data-app-ui-heading]'`, `'[data-app-ui-label]'`
  - `getRole()` 函数加 heading/label 属性优先（第 81-95 行附近）
  - `nodePriority()`（第 189-195 行）新增语义角色优先级
  - `filterSnapshotNodes()` 扩：接受 `FilterSnapshotOptions` 的新增字段 + 两阶段配额截断
- Modify: `apps/windows/src/main/app-ui-control/types.ts`
  - `FilterSnapshotOptions`（第 73-77 行）扩 fields
  - `RawSnapshotNode` 不改（已是 `role: string` 开放）
- Test: `apps/windows/src/main/app-ui-control/snapshot.test.ts`
  - 补 role=heading/label 的过滤与优先级测试
  - 补 refs_filter 各维度测试
  - 补两阶段配额截断测试

**Step 1: 写失败测试**

在 snapshot.test.ts 追加 4 个 describe：

```ts
// (a) heading/label 角色注入
it('data-app-ui-heading 属性节点 role=heading', () => {
  const raw: RawSnapshotNode[] = [
    { role: 'button', name: '点我', x: 0, y: 0, w: 10, h: 10 },
    { role: 'heading', name: '文本对话', x: 0, y: 20, w: 10, h: 10, appUi: 'slot-title' },
  ]
  const { refs } = filterSnapshotNodes(raw)
  expect(refs.find(r => r.role === 'heading')?.name).toBe('文本对话')
})

// (b) 两阶段配额：语义 1 个 + 交互 1 个，truncated=true，总量=2（限制 limit=2）
it('two-phase truncation: reserves semantic and interactive slots', () => {
  const raw: RawSnapshotNode[] = [
    // 2 个语义节点
    { role: 'heading', name: '标题A', x: 0, y: 0, w: 10, h: 10, appUi: 'heading' },
    { role: 'label',   name: '字段A', x: 0, y: 20, w: 10, h: 10 },
    // 2 个交互节点
    { role: 'button',  name: '按钮A', x: 0, y: 40, w: 10, h: 10 },
    { role: 'textbox', name: '输入A', x: 0, y: 60, w: 10, h: 10, value: '' },
  ]
  const { refs, truncated } = filterSnapshotNodes(raw, { limit: 2 })
  expect(truncated).toBe(true)
  // limit=2 → 语义 1 + 交互 1 都要命中
  expect(refs.some(r => r.role === 'heading' || r.role === 'label')).toBe(true)
  expect(refs.some(r => ['button','textbox'].includes(r.role))).toBe(true)
})

// (c) refs_filter.roles 过滤
it('refs_filter.roles only includes heading', () => {
  const raw: RawSnapshotNode[] = [
    { role: 'heading', name: '文本对话', x: 0, y: 0, w: 10, h: 10 },
    { role: 'button',  name: '保存',   x: 0, y: 20, w: 10, h: 10 },
  ]
  const { refs } = filterSnapshotNodes(raw, { roles: ['heading'] })
  expect(refs.length).toBe(1)
  expect(refs[0].role).toBe('heading')
})

// (d) refs_filter y_min/y_max 过滤
it('refs_filter y_min/y_max window', () => {
  const raw: RawSnapshotNode[] = [
    { role: 'heading', name: '顶', x: 0, y: 10,  w: 10, h: 10 },
    { role: 'button',  name: '中', x: 0, y: 110, w: 10, h: 10 },
    { role: 'button',  name: '底', x: 0, y: 210, w: 10, h: 10 },
  ]
  const { refs } = filterSnapshotNodes(raw, { y_min: 100, y_max: 120 })
  expect(refs.map(r => r.name)).toEqual(['中'])
})
```

**Step 2: 跑测试确认失败**

```bash
cd e:\my-project\open-source\lumii
npx vitest run apps/windows/src/main/app-ui-control/snapshot.test.ts
```

预期：4 个新增用例 FAIL（`filterSnapshotNodes` 还不支持 `roles`，SELECTORS 还没加属性选择器，两阶段截断还没做）。

**Step 3: 最小实现**

3a) **snapshot.ts 的 getRole 扩属性优先**（第 75-95 行的 getRole 函数，在显式 role=attribute 之后、tag 推断之前插入）：

```ts
// getRole 函数第 81 行附近（在 explicit role check 之后插入）：
var attrHeading = el.getAttribute('data-app-ui-heading');
if (attrHeading === '') return 'heading';           // 仅做标记，文案走 name=innerText
if (attrHeading) return 'section_title';            // 如果有值表示 section 级标题（值通常空，就 '' 即 heading，section_title 仅用于显式带 section_title 值的情况，预留）
var attrLabel = el.getAttribute('data-app-ui-label');
if (attrLabel !== null) return 'label';
// ... 保留现有显式 role / tag 推断
```

更简单实现（避免 attribute 有歧义）：
```
[data-app-ui-heading]           → role=heading
[data-app-ui-section-title]     → role=section_title
[data-app-ui-label]             → role=label
```
即三个独立的 attribute，直接 1:1 映射。推荐这个版本，避免 attr 值字符串带来的分支复杂度。Task 2 会在渲染层分别打三种属性。所以 SELECTORS 追加：

```
'[data-app-ui-heading]',
'[data-app-ui-section-title]',
'[data-app-ui-label]',
```

3b) **snapshot.ts nodePriority 扩语义角色优先级（两阶段第一阶段"分组"用）**

```ts
// nodePriority 开头先判定是否语义角色：
const SEMANTIC_ROLES = new Set(['heading', 'section_title', 'label'])
function semanticTier(node: RawSnapshotNode): number {
  return SEMANTIC_ROLES.has(node.role) ? 0 : 1  // 0=语义层，1=交互层；两阶段截断按这个分层
}
```
现有优先级 0..4 保持不变（在层内排序用）。

3c) **filterSnapshotNodes 扩 FilterSnapshotOptions + 两阶段配额 + refs_filter**

```ts
// types.ts 先改 FilterSnapshotOptions
export interface FilterSnapshotOptions {
  limit?: number
  // 新增：
  roles?: string[]
  y_min?: number
  y_max?: number
  name_contains?: string
  semantic_limit?: number  // 不提供时：默认 limit/3 向下取整（2 个交互：1 个语义的比例）
}

// snapshot.ts filterSnapshotNodes 实现：
export function filterSnapshotNodes(
  raw: RawSnapshotNode[],
  options: FilterSnapshotOptions = {},
): FilterSnapshotResult {
  // 第 0 步：先跑原有的 eligibility（隐藏/遮挡剔除）
  let eligible = raw.filter((n) => !shouldExcludeNode(n))

  // 第 1 步：refs_filter（用户显式过滤，必在截断之前，避免被截断过滤了再被用户又过滤一遍 -> 浪费配额）
  if (options.roles) {
    const set = new Set(options.roles)
    eligible = eligible.filter(n => set.has(n.role))
  }
  if (typeof options.y_min === 'number') {
    eligible = eligible.filter(n => n.y + n.h >= options.y_min!)
  }
  if (typeof options.y_max === 'number') {
    eligible = eligible.filter(n => n.y <= options.y_max!)
  }
  if (options.name_contains) {
    const q = options.name_contains.toLowerCase()
    eligible = eligible.filter(n => n.name.toLowerCase().includes(q))
  }

  // 第 2 步：两阶段配额截断
  const totalLimit = options.limit ?? DEFAULT_SNAPSHOT_NODE_LIMIT    // 默认 120
  const defaultSemantic = Math.max(10, Math.floor(totalLimit / 3))  // 默认语义配额 40
  const semLimit = Math.min(options.semantic_limit ?? defaultSemantic, totalLimit)
  const intLimit = totalLimit - semLimit

  // 按语义层/交互层切开，每层内部按原优先级 + 阅读顺序排
  const semSorted = eligible
    .filter(n => semanticTier(n) === 0)
    .sort((a, b) => compareReadingOrder(a, b))
  const intSorted = eligible
    .filter(n => semanticTier(n) === 1)
    .sort((a, b) => {
      const priorityDelta = nodePriority(a) - nodePriority(b)
      return priorityDelta !== 0 ? priorityDelta : compareReadingOrder(a, b)
    })

  const keptSem = semSorted.slice(0, semLimit)
  const keptInt = intSorted.slice(0, intLimit)
  const totalKeptBefore = eligible.length
  const kept = [...keptSem, ...keptInt]
  const truncated = totalKeptBefore > keptSem.length + keptInt.length

  // 第 3 步：分配 ref（保持语义在前，交互在后，便于 LLM 一眼看到标题）
  const refs: AppUiRef[] = kept.map((node, index) => {
    const ref: AppUiRef = {
      ref: `e${index + 1}`,
      role: node.role,
      name: node.name,
      x: node.x, y: node.y, w: node.w, h: node.h,
    }
    if (node.value !== undefined) ref.value = node.value
    if (node.placeholder) ref.placeholder = node.placeholder
    if (node.options?.length) ref.options = node.options
    return ref
  })
  return { refs, truncated }
}
```

**Step 4: 跑测试确认通过**

```bash
npx vitest run apps/windows/src/main/app-ui-control/snapshot.test.ts
```

预期：全部 PASS（含原有测试，因为 semanticTier 只把 heading 挪到前，原有交互节点排序不变）。

**Step 5: 提交**

```bash
git add apps/windows/src/main/app-ui-control/snapshot.ts apps/windows/src/main/app-ui-control/types.ts apps/windows/src/main/app-ui-control/snapshot.test.ts
git commit -m "feat(app-ui): snapshot refs 加 heading/label 语义角色 + refs_filter 用户侧过滤 + 两阶段配额截断"
```

---

### Task 2: SettingsPage.tsx 打 `data-app-ui-heading/section-title/label` 属性

**Files:**
- Modify: `apps/windows/src/renderer/pages/SettingsPage/SettingsPage.tsx`
  - renderSlotCard 函数（line 1246-1488）：slot 标题、字段 label、按钮旁边的文本
  - renderModelConfigSettings（line 1493-1521）：页面级 `h3` + section h4 等
  - 其他 render*Settings 函数：页面级 h3 打 section-title、setting-label 打 label
- （可选）通用组件包装：
  - `components/ui/Card/Card.tsx`：如果 Settings 页 slot 卡片都是 `<Card>`（line 1254/1538/...），标题 header 如果有统一 API，也可以在 Card 组件里统一 `data-app-ui-heading`，但为了不影响非 Settings 页的 Card 结构，**建议直接在 SettingsPage 局部打属性，不污染通用组件**。
- Test: 无单测（纯 JSX 属性）；跑 `typecheck` 即可

**Step 1: 找出所有需要打属性的点**

SettingsPage.tsx 的 renderXxxSettings 共 10+ 个函数，按以下规则逐条 grep 定位：

```bash
# 定位所有 slot 卡片标题 span（<span>{CAPABILITY_SLOT_LABEL[slot]}</span>）
Select-String -Path "apps\windows\src\renderer\pages\SettingsPage\SettingsPage.tsx" -Pattern "CAPABILITY_SLOT_LABEL\[slot\]" -Context 2,2
# 定位所有 setting-label 字段名（<div className={styles['setting-label']}><span>字段</span>）
Select-String -Path "apps\windows\src\renderer\pages\SettingsPage\SettingsPage.tsx" -Pattern "styles\['setting-label'\]" -Context 1,3
# 定位所有页面级 h3
Select-String -Path "apps\windows\src\renderer\pages\SettingsPage\SettingsPage.tsx" -Pattern "<h3>" -Context 1,1
```

**Step 2: 逐条打属性（三种类别严格区分）**

示例（按上面 grep 的命中点逐个改）：

```tsx
// 2a) Slot 卡片标题（CAPABILITY_SLOT_LABEL）
// 修改前：line 1256-1258
<div className={styles['setting-label']}>
  <span>{CAPABILITY_SLOT_LABEL[slot]}</span>
  <span className={styles['setting-desc']}>{CAPABILITY_SLOT_DESC[slot]}</span>
</div>
// 修改后：
<div className={styles['setting-label']}>
  <span data-app-ui-heading>{CAPABILITY_SLOT_LABEL[slot]}</span>
  <span className={styles['setting-desc']}>{CAPABILITY_SLOT_DESC[slot]}</span>
</div>

// 2b) Slot 展开后的字段名（Provider 类型 / Base URL / API Key / 模型 ID）
// 例：line 1298-1300
<div className={styles['setting-label']}>
  <span data-app-ui-label>Provider 类型</span>
</div>
// line 1325
<div className={styles['setting-label']}>
  <span data-app-ui-label>接口地址（Base URL）</span>
  <span className={styles['setting-desc']}>...</span>
</div>
// line 1344-1348 API Key
<div className={styles['setting-label']}>
  <span data-app-ui-label>API Key</span>
  {isLocalProvider && <span ...>...</span>}
</div>
// line 1374-1384 模型 ID
<div className={styles['setting-label']}>
  <span data-app-ui-label>模型 ID</span>
  <span className={styles['setting-desc']}>...</span>
</div>

// 2c) 页面级 h3 → section_title（工作空间、ACP、通知等整页分类标题）
// line 555 通用 → <h3 data-app-ui-section-title>通用</h3>
// line 591 工作空间 → <h3 data-app-ui-section-title>工作空间 ...</h3>
// line 665 ACP 设置 → <h3 data-app-ui-section-title>ACP 设置</h3>
// line 679 通知设置 → 同上
// line 751 隐私与数据 → 同上
// line 1503 模型能力槽 → <h3 data-app-ui-section-title>模型能力槽</h3>
// 其它 renderXxxSettings 里的 <h3> 全部打 data-app-ui-section-title
// 子分区 <h4 className={styles['panel-card-title']}>（line 761 等）→ heading（或 label，这里取 section_title 下一级，用 heading）
// line 761: <h4 className={styles['panel-card-title']} data-app-ui-heading>Agent 界面控制</h4>
// line 779: <h4 ... data-app-ui-heading>录屏</h4>
// 其他 panel-card-title 同理
```

**注意事项：**
- 属性不要带任何值（空 attribute），避免多余字符污染 refs JSON。
- 只对 Settings 页生效，别在其他组件里改。
- 已有 `role=heading` 原生语义标签的 `<h3>`/`<h4>` 不用额外打？**仍要打**：因为 snapshot SELECTORS 现在没收录 h1-h6（Task 1 只加了 `[data-app-ui-*]` 属性），为了保持实现统一（防止 h3 被 `shouldExcludeNode` 因 hidden/occluded 误排除但没被选中），还是显式打 attribute。Task 1 的 SELECTORS 同步加 `'h1, h2, h3, h4, h5, h6'` 作为兜底。

**Step 3: typecheck 确保没改坏**

```bash
cd e:\my-project\open-source\lumii
pnpm --filter @mtbot/windows typecheck
```

预期：0 errors。（加属性不影响 TS 类型，肯定过。如不过，是 className 拼写问题，直接修正。）

**Step 4: 手工冒烟（必要！因为是纯 UI 属性，单测没法跑 DOM）**

```bash
pnpm dev
# 打开后在 Lumii 内发：「帮我截一张设置-模型配置页」
# 在 ToolCallCard 打开的 JSON/result 里找 refs：
#   - 应该出现 role=heading name=文本对话/视觉/生图 三个条目
#   - 应该出现 role=label name=Provider 类型、接口地址、API Key、模型 ID 四个条目
#   - 应该出现 role=section_title name=模型能力槽
#   - 若没出现，打开 DevTools F12 Elements 面板检查节点是否真的有 data-app-ui-* 属性
```

**Step 5: 提交**

```bash
git add apps/windows/src/renderer/pages/SettingsPage/SettingsPage.tsx
git commit -m "feat(app-ui): Settings 页模型配置与通用设置打 heading/label 数据属性，供 snapshot 识别"
```

---

### Task 3: act.ts 新增 `NON_INTERACTIVE_ROLES` + `not_interactive` 错误码 + controller 校验失败

**Files:**
- Modify: `apps/windows/src/main/app-ui-control/act.ts`
  - 新增导出常量 `NON_INTERACTIVE_ROLES`
  - 扩 `ClickAllowedError`（line 26）和 `AppUiActError`（line 44）联合类型
  - 修改 `assertClickAllowed` 函数（line 60-81）：在 blockRoles 检查前先判是否语义角色
- Modify: `apps/windows/src/main/app-ui-control/controller.ts`
  - click/type/select/scroll 在 validateRefAct 之前就判 role（或者把 NON_INTERACTIVE_ROLES 传进 assertClickAllowed），**推荐在 assertClickAllowed 内统一改**，因为 controller 所有 act 入口都走它
- Modify: `apps/windows/src/main/agent-runtime/bridge-app-ui-tools.ts`
  - APP_ACT_DESCRIPTION（line 127-136）里的「失败码含义」追加 `not_interactive=该 ref 是标题/字段名等纯文本，请换交互 ref`
- Test: `act.test.ts` 补 not_interactive 用例

**Step 1: 写失败测试**

act.test.ts 追加：
```ts
it('assertClickAllowed 拒绝 heading/label 角色，返回 not_interactive', () => {
  const result = assertClickAllowed({
    ref: 'e1',
    snapshotId: '7',
    current: {
      snapshotId: '7',
      refs: [{ ref: 'e1', role: 'heading', name: '文本对话', x: 0, y: 0, w: 10, h: 10 }],
    },
    blockRoles: CLICK_BLOCK_ROLES,
  })
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.error).toBe('not_interactive')
  }
})
```

跑：`npx vitest run apps/windows/src/main/app-ui-control/act.test.ts` → 预期 FAIL（not_interactive 还没在联合类型里，assert 也没这个分支）。

**Step 2: 最小实现**

```ts
// act.ts line 4 附近
export const NON_INTERACTIVE_ROLES = ['heading', 'section_title', 'label'] as const

// act.ts line 26
export type ClickAllowedError =
  | 'missing_ref' | 'stale_snapshot' | 'blocked_composer'
  | 'not_interactive'     // 新增

// act.ts line 44
export type AppUiActError = AppUiClickError | ActUsageError | ActInjectError | 'not_interactive'

// act.ts assertClickAllowed 在 blockRoles 判断前插入（line 76 前）
export function assertClickAllowed(params): AssertClickAllowedResult {
  // ... 现有 missing_ref、snapshotId mismatched、find matched 的判断保持不变 ...

  // 新增：matched 找到后，先判是不是纯语义角色
  if ((NON_INTERACTIVE_ROLES as readonly string[]).includes(matched.role)) {
    return { ok: false, error: 'not_interactive' }
  }

  if (blockRoles.includes(matched.role)) {
    return { ok: false, error: 'blocked_composer' }
  }
  return { ok: true, ref: matched }
}
```

另外，因为 AppUiTypeSuccess 和 AppUiSelectSuccess 各自还有失败回读路径（type/select 也可能在语义节点上被调用），在 controller 层调用前做一次 guard（最简单）：在 `validateRefAct` 后拿到 `validated.ref.role` 时立即判：

```ts
// controller.ts click（line 758-761 后）
const validated = validateRefAct(actInput, cacheById, deps.getWindow)
if (!validated.ok) return validated
if ((NON_INTERACTIVE_ROLES as readonly string[]).includes(validated.ref.role)) {
  return { ok: false, error: 'not_interactive', hint: `该 ref 是${validated.ref.role}（${validated.ref.name}），纯文本不支持点击/输入，请换 button/textbox 等交互 ref` }
}
```

同理，`type/select/scroll` 在 `validated.ok === true` 后立即加相同 guard（因为 scroll 也是通过 validateRefAct）。

**Step 3: 测试通过 + 类型检查 + APP_ACT_DESCRIPTION 追加失败码**

```bash
npx vitest run apps/windows/src/main/app-ui-control/act.test.ts
pnpm --filter @mtbot/windows typecheck
```

**Step 4: 提交**

```bash
git add apps/windows/src/main/app-ui-control/act.ts apps/windows/src/main/app-ui-control/act.test.ts apps/windows/src/main/app-ui-control/controller.ts apps/windows/src/main/agent-runtime/bridge-app-ui-tools.ts
git commit -m "fix(app-ui): 语义角色(heading/label)操作拒绝 not_interactive，避免 Agent 点标题点了没反应还死循环"
```

---

### Task 4: 扩 screen-tutorial-pipeline SKILL.md 加 TutorialNavSpec v1 契约

**Files:**
- Modify: `apps/windows/bundled-skills/视频创作/screen-tutorial-pipeline/SKILL.md`
  - 在 §1 探路彩排后加「1.b 探路输出：TutorialNavSpec v1（MUST 输出 JSON 代码块）」
  - 提供完整示例（确保 `文本对话` 不是「文本对话 Agent」）
  - 在「硬性禁令」加一条：正式录制阶段 MUST 以最后一段 `tutorial-nav-spec` JSON 为唯一决策输入，禁止再做探路式观察

**Step 1: 找要插入的位置并追加内容**

SKILL.md 现有 §1 探路彩排（line 51-57）。插入新 §1.b：

```markdown
### 1.b 探路输出：TutorialNavSpec v1（MUST 输出代码块，不做就不算完成探路）

探路结束后、执行 `screen_record_start` 之前，**必须**在回复里输出一段 **单独的```json 代码块**，info string 为 `tutorial-nav-spec`。后续正式录制阶段**必须**用这段代码块的 `steps[i]` 作为唯一操作输入，不要回到"观察界面→猜测→再确认"的老路（若后续发现步骤错了，先 `pause` 再改 JSON，不要硬录）。

#### TutorialNavSpec v1 Schema

```json
{
  "specVersion": "1.0",
  "task": "<用户任务，如 录制模型配置教程>",
  "replayFromView": "dashboard" | "settings" | "chat" | ...,
  "preconditions": [
    "设置面板未打开",
    "模型配置页当前无未保存修改（或已知恢复方式）"
  ],
  "steps": [
    {
      "id": "step-1",
      "label": "开场：概览页展示",
      "narrationZh": "打开灵栖，首先看到的是概览页面。",
      "action": { "kind": "goto", "view": "dashboard" },
      "verify": { "view": "dashboard" },
      "pauseAfterMs": 1500
    },
    {
      "id": "step-2",
      "label": "打开设置-模型配置",
      "narrationZh": "点击左下角设置，选择模型配置。",
      "action": { "kind": "goto", "view": "settings", "category": "modelConfig" },
      "verify": { "hub.open": true, "hub.tab": "settings", "hub.category": "modelConfig" },
      "pauseAfterMs": 1000
    },
    {
      "id": "step-3",
      "label": "展示文本对话槽配置",
      "narrationZh": "第一个卡片是文本对话，包含服务商类型、接口地址、API Key 和模型 ID。",
      "action": { "kind": "scroll_to_heading", "targetName": "文本对话" },
      "verify": { "headingVisible": "文本对话" },
      "pauseAfterMs": 2500
    },
    {
      "id": "step-4",
      "label": "（可选）模拟填写模型 ID",
      "narrationZh": "在模型 ID 里填入要使用的模型，多个用逗号分隔。",
      "action": {
        "kind": "act_type_by_field_label",
        "slotHeading": "文本对话",
        "fieldLabel": "模型 ID",
        "demoValue": "deepseek-v4-pro, deepseek-v4-flash",
        "restoreValue": "deepseek-v4-flash, deepseek-v4-pro"
      },
      "verify": { "inputValueByFieldLabel模型ID": "deepseek-v4-pro, deepseek-v4-flash" },
      "pauseAfterMs": 1500
    },
    {
      "id": "step-5",
      "label": "保存",
      "narrationZh": "滑到底部，点击保存全部。",
      "action": { "kind": "click_by_button_text", "targetText": "保存全部" },
      "verify": { "toast": "保存成功" },
      "pauseAfterMs": 1200
    }
  ],
  "postCleanup": [
    { "action": "restore_field_by_label", "slotHeading": "文本对话", "fieldLabel": "模型 ID", "value": "deepseek-v4-flash, deepseek-v4-pro" }
  ]
}
```

#### action.kind 白名单（v1，只准用这些，用了新的先更新探路 JSON schema）

| kind | 说明 |
|------|------|
| `goto` | 等价 app_goto |
| `scroll_to_heading` | 用 `headingVisible` 作为验收，等价高层工具 `app_scroll_to_text({kind:'heading', text:targetName})` |
| `scroll_to_bottom` | 滚到当前页面主内容到底部，等价 `app_scroll_to_bottom` |
| `act_type_by_field_label` | 按 slotHeading + fieldLabel 定位输入框，等价高层工具 `app_fill_form({fields:[{label,text,...}]})` |
| `click_by_button_text` | 按按钮文字定位，等价高层工具 `app_scroll_to_text({kind:'button', text})` 再 click |
| `click_by_ref` | 兜底；仅在高层工具命中不准时用 |
| `compose_new_chat` | 新建对话 + goto chat（组合操作） |

#### 禁令

- **禁止** `steps[i].action` 里写 `scroll dy=... ref=eN` 这种耦合 snapshotId 的原子指令（正式录制时 snapshotId 编号必然不同）
- **禁止** `targetName` / `slotHeading` 里写「文本对话 Agent」——必须**原样复制**探路阶段截图 refs 里 role=heading 的 name（通常是 `文本对话`，且不带 Agent 后缀）
- **禁止** `fieldLabel` 凭记忆写——与 `refs` 里 role=label 的 name 严格一致
- 正式录制阶段若某一步 verify 失败：**先 `screen_record_pause`**，修复 JSON 后再 resume + mark + 重试，录制阶段的新观察信息**不回写到 tutorial-nav-spec 代码块里**（除非重新开始探路）
```

**Step 2: 一致性检查**

- 找 `§2 正式录制：pause 纪律` 里 line 58-65，把 `app_act 操作` 改为「按 tutorial-nav-spec 的当前步骤 action 执行高层工具」。
- 在「§5 读返回字段 / inspect 验收」后加一条：交付前要附 tutorial-nav-spec JSON（便于用户后续复用流程做同系列视频）。

**Step 3: 提交**

```bash
git add apps/windows/bundled-skills/视频创作/screen-tutorial-pipeline/SKILL.md
git commit -m "doc(skill): screen-tutorial-pipeline 强制探路输出 TutorialNavSpec v1 JSON 代码块，录制阶段直接按步骤跑"
```

> **P0 结束独立验收点：** 此时不用等 P1/P2，已经能看到 `role=heading/label` 出现在 refs，以及 Agent 探路会输出 JSON。跑一次原任务：「录制模型配置教程」，对照设计文档 §5 的「改造后目标」，看截图次数是否从 25+ → ≤6；思考次数是否明显下降。没达到 → 回头看 Task 2 属性是不是打漏了（尤其模型 ID 字段名，录屏里最常出错）。

---

## Part B：P1 高层工具 + stale_snapshot 自重试（Task 5–7，1 周内落地）

---

### Task 5: bridge-app-ui-tools 扩独立 `high` quota 与高层工具注册脚手架

**Files:**
- Modify: `apps/windows/src/main/agent-runtime/bridge-app-ui-tools.ts`
  - APP_UI_QUOTA 扩 `high` bucket（定义在 line 26-30）
  - consumeAppUiQuota 的 kind 类型 `AppUiToolKind` 扩 'high'
  - 新增 `guardHighLevelAppUiTool()`（复用 consume + high kind）
  - 新增 5 个高层工具的 `reg(...)` 空壳，`execute` 暂直接返回 `{ok:false, error:'not_implemented'}` —— 占位即可，Task 6 填实现
- Test: 无单测（占位）；跑 typecheck 确保 schema 合法

**Step 1: 扩 high quota**

```ts
// line 26-30 APP_UI_QUOTA：
export const APP_UI_QUOTA = {
  screenshot: { base: 40, refillPerMinute: 20, max: 300 },
  act:        { base: 120, refillPerMinute: 60, max: 900 },
  goto:       { base: 60, refillPerMinute: 20, max: 300 },
  // 新增：高层工具独立 bucket，不挤占 screenshot/act/goto 的基础额度
  high:       { base: 30, refillPerMinute: 20, max: 300 },
} as const
type AppUiToolKind = keyof typeof APP_UI_QUOTA   // 自动包含 'high'
```

**Step 2: 5 个高层工具的注册脚手架**

在 registerAppUiTools 函数内（line 144-360），现有 `reg(app_screenshot)` / `reg(app_goto)` / `reg(app_act)` 之后，追加：

```ts
/**
 * 高层工具：内部直接调用 controller.* 方法，不重复走 guardAppUiTool 的 screenshot/act/goto 配额
 * （否则一次 goto_and_screenshot 会消耗 1 goto + 1 screenshot + 1 high = 3 次消耗）
 * 高层工具统一只扣一次 high quota。
 */
reg(createMtBotTool({
  name: 'app_goto_and_screenshot',
  label: 'App Goto and Screenshot (High-Level)',
  category: 'channel',
  description:
    '声明式进入指定视图并立即截一张图，合并 app_goto + sleep(settle) + app_screenshot 三步。' +
    '教程任务/导航后需要看一眼界面的场景直接用，省掉一次 LLM 思考。返回形态与 app_screenshot 完全相同（snapshotId/refs/imagePath/view/hub/...）。',
  parameters: Type.Object({
    view: Type.String({ description: '目标视图：dashboard|chat|skills|settings|memories|agents|cron|plugins|mcp' }),
    category: Type.Optional(Type.String({
      description: 'Settings Hub 分类：general|workspace|modelConfig|voice|channels|codingDev|pet|usage|privacy|aboutAndUpdate'
    })),
    refs_filter: Type.Optional(Type.Object({
      roles: Type.Optional(Type.Array(Type.String())),
      y_min: Type.Optional(Type.Number()),
      y_max: Type.Optional(Type.Number()),
      name_contains: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
    }, { description: '（推荐）只返回我关心的 refs，砍上下文 token 量' })),
    annotate: Type.Optional(Type.Boolean()),
  }),
  isReadOnly: false,
  needsPermission: false,
  execute: async (_id, rawParams) => {
    const blocked = await guardHighLevelAppUiTool()  // 新增函数（下面写）
    if (blocked) return jsonToolResult(blocked)
    // TODO: Task 6 填充
    return jsonToolResult({ ok: false, error: 'not_implemented', message: 'app_goto_and_screenshot: filling in Task 6' })
  }
}, ctx))

reg(createMtBotTool({
  name: 'app_scroll_to_text',
  description:
    '按子串文字滚动：在当前视口逐屏滚动直到找到含指定文字的 heading/button/textbox/any 元素。' +
    '默认 direction=auto（先下后上），最多 8 次 dy=0.7clientHeight 的单步。命中即回滚 50px 让元素居中可见。' +
    '内部走内部 quota 不扣 act/screenshot。返回最终 scrollTop + 命中元素名/坐标 + 最新 snapshot（同 app_screenshot 形态但不返回 imagePath）。',
  parameters: Type.Object({
    text: Type.String({ description: '要匹配的文字子串（大小写不敏感，trim）' }),
    kind: Type.Optional(Type.String({ description: 'heading|button|textbox|any，默认 any；heading/label 只看 name' })),
    direction: Type.Optional(Type.String({ description: 'down|up|auto，默认 auto（先下 8 次再上 2 次）' })),
    maxAttempts: Type.Optional(Type.Number({ description: '默认 10（下 8+上 2）' })),
  }),
  isReadOnly: false, needsPermission: true,
  execute: async () => jsonToolResult({ ok: false, error: 'not_implemented' })
}, ctx))

reg(createMtBotTool({
  name: 'app_scroll_to_bottom',
  description: '滚到当前页面主内容底部；等价若干 app_act scroll。返回 atBottom=true/false + scrollTop，供保存按钮位置确认用。',
  parameters: Type.Object({
    maxAttempts: Type.Optional(Type.Number({ description: '默认 6 次 0.85clientHeight' }))
  }),
  isReadOnly: false, needsPermission: false,
  execute: async () => jsonToolResult({ ok: false, error: 'not_implemented' })
}, ctx))

reg(createMtBotTool({
  name: 'app_fill_form',
  description:
    '一次填多个输入框：按「字段 label 名」或直接 ref 指定目标；单个字段写入失败立即中止并返回未写入列表，不脏写部分字段。' +
    '写入后返回每个字段写入后的值（与 app_act type 同，已脱敏），省掉一次确认截图。',
  parameters: Type.Object({
    fields: Type.Array(Type.Object({
      label: Type.Optional(Type.String({ description: '按字段 label 名（role=label 的 name 子串）查找对应输入框' })),
      slotHeading: Type.Optional(Type.String({ description: 'label 在某个槽的卡片里时可提供，缩小查找范围，先按 heading 再按 label 定位' })),
      ref: Type.Optional(Type.String({ description: '兜底：直接 ref（需 snapshotId）' })),
      snapshotId: Type.Optional(Type.String()),
      text: Type.String(),
      append: Type.Optional(Type.Boolean()),
    })),
  }),
  isReadOnly: false, needsPermission: true,
  execute: async () => jsonToolResult({ ok: false, error: 'not_implemented' })
}, ctx))

reg(createMtBotTool({
  name: 'app_settings_model_config_save',
  description:
    '（模型配置页专用高层工具）进入设置→模型配置（可选）→ 滚动到底 → 点击「保存全部」→（可选）等"保存成功"toast。' +
    '等价 4~8 次原子操作；失败时返回 save_btn_not_found / toast_timeout / goto_failed 带明确 hint，下次重试路径清楚。',
  parameters: Type.Object({
    gotoFirst: Type.Optional(Type.Boolean({ description: '默认 true；false 时假定已经在模型配置页' })),
    saveButtonText: Type.Optional(Type.String({ description: '默认 "保存全部"；若日后改文案可通过此参数兼容' })),
    expectToast: Type.Optional(Type.String({ description: '默认 "保存成功"；空字符串表示不检测 toast' })),
  }),
  isReadOnly: false, needsPermission: true,
  execute: async () => jsonToolResult({ ok: false, error: 'not_implemented' })
}, ctx))
```

**Step 3: guardHighLevelAppUiTool 实现 + log.info 追加注册名**

```ts
async function guardHighLevelAppUiTool() {
  if (!(await isAppUiControlEnabled(readSettingsJson))) {
    return { ok: false, error: 'disabled' }
  }
  return consumeAppUiQuota('high')  // 只扣 high 一次
}

// register 末尾
log.info('[registerAppUiTools] app_screenshot, app_goto, app_act registered')
// 新增：
log.info('[registerAppUiTools] high-level: goto_and_screenshot, scroll_to_text, scroll_to_bottom, fill_form, settings_model_config_save registered')
```

**Step 4: typecheck 确认 schema + 注册没语法错**

```bash
pnpm --filter @mtbot/windows typecheck
```

**Step 5: 提交**

```bash
git add apps/windows/src/main/agent-runtime/bridge-app-ui-tools.ts
git commit -m "feat(app-ui): 5 个高层工具注册脚手架 + high quota 独立 bucket（不挤占基础配额）"
```

---

### Task 6: 5 个高层工具填实现

> 拆成 5 个子任务（A–E），每个子任务完成后立即跑对应单测 + typecheck。为了让工程能独立推进，你可以每个子任务单独 commit。每个子任务都遵循：先写 controller 层的方法 → 再在 bridge 层填充 `execute` 调用它。因为 controller 是 app-ui-control 的纯逻辑层，更容易写单测（不用走 agent runtime 的 TypeBox schema 解析）。

---

#### Sub-Task 6A: controller.gotoAndScreenshot + bridge 填充

**Files:**
- Modify: `apps/windows/src/main/app-ui-control/types.ts` — `AppUiController` 接口（line 213-229）加 `gotoAndScreenshot(...)`
- Modify: `apps/windows/src/main/app-ui-control/controller.ts` — createAppUiController 内实现
- Modify: `apps/windows/src/main/agent-runtime/bridge-app-ui-tools.ts` — `app_goto_and_screenshot.execute` 填充

**Step 1: 定义 AppUiScreenshotOptions 先扩 refs_filter（Task 1 没动 controller 的参数？再确认一次）**

实际上 Task 1 的 refs_filter 只加给了 `filterSnapshotNodes(options: FilterSnapshotOptions)`，还没透传到 controller.screenshot。**这里一起做**：

```ts
// types.ts AppUiScreenshotOptions（line 99-105）
export interface AppUiScreenshotOptions {
  annotate?: boolean
  target?: AppUiScreenshotTarget
  // 新增：
  refs_filter?: Omit<FilterSnapshotOptions, 'limit'> & { limit?: number }
}

// controller.ts screenshot() 内的 filter 调用（line 689）：
const { refs, truncated } = filterSnapshotNodes(rawNodes, options?.refs_filter ?? {})
// 原行是 filterSnapshotNodes(rawNodes)，改了以后 Task 1 的 refs_filter 才能对用户暴露！
```

**Step 2: controller 新增 gotoAndScreenshot**

```ts
// types.ts AppUiController 接口追加（line 227 附近）
export interface AppUiController {
  // ... 原有 6 个方法不变 ...
  gotoAndScreenshot(input: {
    view: AppUiViewType
    category?: AppUiSettingsCategory
    refs_filter?: AppUiScreenshotOptions['refs_filter']
    annotate?: boolean
  }): Promise<AppUiGotoResult | AppUiScreenshotSuccess>
}

// controller.ts createAppUiController 内加：
async function gotoAndScreenshot(input: any) {
  const gotoRes = await goto(input)
  if (!gotoRes.ok) return gotoRes         // goto 失败就不截图了
  const waitMs = Math.max(gotoSettleMs, 150)   // 多 50ms 确保 Hub 动画落定
  await sleep(waitMs)
  const ss = await screenshot({
    target: 'main',
    annotate: input?.annotate === true,
    refs_filter: input?.refs_filter,
  })
  return ss
}
// 然后在 controller 对象字面量里加 gotoAndScreenshot
return { screenshot, getSnapshotCache, goto, click, type, select, key, scroll, gotoAndScreenshot }
```

**Step 3: bridge app_goto_and_screenshot.execute 填充**

```ts
execute: async (_id, rawParams) => {
  const blocked = await guardHighLevelAppUiTool()
  if (blocked) return jsonToolResult(blocked)
  try {
    const p = rawParams as Record<string, any>
    const result = await (controller as any).gotoAndScreenshot?.(p)
    if (!result) return jsonToolResult({ ok: false, error: 'not_implemented' })
    if (!result.ok) return jsonToolResult(result)
    // 成功时与 app_screenshot.execute 同形态（带 view/hub/refs/imagePath）
    const payload = {
      ok: true as const,
      snapshotId: result.snapshotId,
      view: result.viewState.view,
      hub: result.viewState.hub,
      width: result.width, height: result.height,
      truncated: result.truncated, refs: result.refs,
      imagePath: result.previewPath,
      note: `高层工具：goto(${p.view}${p.category ? ',' + p.category : ''}) + 截图合并完成，imagePath="${result.previewPath}"`,
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      details: { previewPath: result.previewPath },
    }
  } catch {
    return jsonToolResult({ ok: false, error: 'goto_and_screenshot_failed' })
  }
}
```

**Step 4: 测试 + 提交**

```bash
npx vitest run apps/windows/src/main/app-ui-control
pnpm --filter @mtbot/windows typecheck

git add apps/windows/src/main/app-ui-control/types.ts apps/windows/src/main/app-ui-control/controller.ts apps/windows/src/main/agent-runtime/bridge-app-ui-tools.ts
git commit -m "feat(app-ui): 高层工具 app_goto_and_screenshot 实现"
```

---

#### Sub-Task 6B: app_scroll_to_text + app_scroll_to_bottom 两工具实现

（实现类似，放一个 Task 里做，因为都依赖 scroll、循环、内部 screenshot）

**核心要点：**
- **内部 screenshot 不扣用户可见 quota**：直接 `controller.screenshot()` 而不是走 guardAppUiTool('screenshot')，因为 scroll_to_text 已经扣了 high quota。
- **snapshotId 对用户返回的 refs 是最新一轮的 id**，不是 scroll_to_text 调用前的快照。
- `app_scroll_to_bottom` 通过 `app_scroll({ dy=0.85 * clientHeight, ref=第一可滚动容器 })` 循环实现。

实现细节略写（避免 plan 文档太长），遵循 4 步：
1. 先在 controller 接口扩 `scrollToText / scrollToBottom`
2. 在 controller 里实现（内部用 screenshot 找 refs；命中判定：name 子串匹配 + role 过滤；内部直接调用 deps 的 scroll 函数）
3. 在 bridge.execute 填逻辑，并返回与 screenshot 相同的 payload（refs + snapshotId，但 imagePath 可省略或给最终位置截图的 path）
4. 单测 + commit

**注意 scroll ref 的来源**：现有 `app_act scroll({ref, dy})` 要求 ref 是 snapshotId 中的元素（因为要定位它所在的可滚动容器）。所以内部每次 screenshot 拿到 `refs` 后需要选一个**合理的锚点 ref**传给 scroll：优先选择 `role=heading` 或 `role=section_title`（通常在内容流里，父容器就是可滚动容器），找不到的话用第一个 `appUi === 'hub-category'` 元素。

**提交：**

```bash
git commit -m "feat(app-ui): 高层工具 app_scroll_to_text / app_scroll_to_bottom 实现（内部循环 + 内部截图，不扣基础 quota）"
```

---

#### Sub-Task 6C: app_fill_form 实现

**关键复杂度：label → ref 的定位。** 流程：

1. 先内部 screenshot（不扣基础 quota）拿最新 refs
2. 对每个 field：
   a. 若提供 slotHeading（推荐）：先找 role=heading name 子串匹配 slotHeading → 记它的 y1=y, y2=y+h
   b. 找 role=label name 子串匹配 field.label，且在 slotHeading 的 y 范围内（同一个卡片）
   c. 在 label 的同一 y 范围内，找到下一个 role=textbox（按 x/y 阅读顺序）→ 这是目标输入框，记为 targetRef
   d. 若 a/b/c 有任何一步没命中 → 立即中止并返回错误（`field_not_found`，附带当前字段名 + 候选 heading/label 列表），成功写入的字段**不回滚**（除非所有字段都没写才回滚；v1 先不做事务回滚以简单优先）
   e. 否则 `controller.type({ ref:targetRef.ref, snapshotId:newSnapshotId, text, append })`
3. 返回按字段写入结果数组

**提交：**

```bash
git commit -m "feat(app-ui): 高层工具 app_fill_form：按 slotHeading+label 定位输入框，批量写入，命中不准时立即中止并给出明确候选"
```

---

#### Sub-Task 6D: app_settings_model_config_save 实现

组合高层工具（goto_and_screenshot + scroll_to_bottom + scroll_to_text(button, "保存全部") + click + 等 toast）。

**流程：**
1. gotoFirst=true 时：`gotoAndScreenshot({view:'settings', category:'modelConfig'})`
2. `scrollToBottom` 让底部的「保存全部」可见
3. `scrollToText({text:'保存全部', kind:'button'})` 精确定位到按钮（避免在其它卡片里误点了"获取模型列表"的按钮，它们也在卡片底部出现）
4. 通过内部 screenshot 拿到按钮 ref，然后 `controller.click`
5. expectToast 非空：等 800ms 后内部再 screenshot 一次 + 注入脚本查 toast（页面 toast 常由 portal 渲染到 body；若抓不到就不校验，warning `toast_not_verified`）

**提交：**

```bash
git commit -m "feat(app-ui): 业务特化高层工具 app_settings_model_config_save 组合实现"
```

---

### Task 7: controller 内 click/type/select/scroll 的 stale_snapshot 自动重试

**Files:**
- Modify: `apps/windows/src/main/app-ui-control/controller.ts`
  - 抽出通用 `withAutoRetryStaleSnapshot<T>(fn, actInput)` 包装函数
  - `click / type / select / scroll` 都包一层
  - 返回成功体 `note` 字段，失败体 `hint` 字段告知发生了重试但最终没命中
- Test: `controller.test.ts`（若没有则新建）mock cacheById：让第一次 click 返回 stale，第二次内部自动重截 + 坐标近似匹配成功

**Step 1: 抽包装函数**

```ts
// 在 createAppUiController 作用域内（cacheById 在其内部）
async function withAutoRetryStaleSnapshot<T extends { ok: boolean; error?: string }>(
  actInput: { ref?: string; snapshotId?: string },
  executeOnce: () => Promise<T>,
): Promise<T & { note?: string }> {
  let first = await executeOnce()

  // 只重试一次；且仅当错误明确是 stale_snapshot 且提供了 snapshotId+ref
  if (first.ok === false && (first as any).error === 'stale_snapshot'
      && actInput.snapshotId && actInput.ref) {

    const oldRef = cacheById.get(actInput.snapshotId)?.refs.find(r => r.ref === actInput.ref)
    if (oldRef) {
      // 内部重新截图（不扣用户 quota：直接调 controller.screenshot，不是通过 bridge）
      const fresh = await screenshot({ target: 'main' })
      if (fresh.ok) {
        // 近似匹配：先 exact role+name，再 fallback 曼哈顿最近（阈值 100px 内）
        const sameName = fresh.refs.find(r => r.role === oldRef.role && r.name === oldRef.name)
        const near = !sameName ? fresh.refs
          .filter(r => r.role === oldRef.role)
          .map(r => ({ r, d: Math.abs(r.x - oldRef.x) + Math.abs(r.y - oldRef.y) }))
          .sort((a, b) => a.d - b.d)[0] : null
        const target = sameName ?? near?.r

        if (target) {
          // 改写 actInput（mutate 是安全的，因为 click/type/select/scroll 各自内部都会 parse 入参后用 validated 里的新值；这里我们在重试前重传）
          const patchedInput: any = { ...(actInput as any), snapshotId: fresh.snapshotId, ref: target.ref }
          const retryFn = () => {
            switch ((actInput as any).action) {
              case 'click':  return click(patchedInput) as any
              case 'type':   return type(patchedInput) as any
              case 'select': return select(patchedInput) as any
              case 'scroll': return scroll(patchedInput) as any
            }
            return Promise.resolve({ ok: false, error: 'usage' })
          }
          const second = await retryFn()
          if (second.ok) {
            (second as any).note = `stale_snapshot 自动重试成功：旧 ${actInput.ref}@${actInput.snapshotId} → 新 ${target.ref}@${fresh.snapshotId}（匹配方式：${sameName ? 'role+name 精确' : `role+坐标最近 d=${near!.d}px`}）`
            return second as any
          }
          (first as any).hint = `stale_snapshot 内部重试过，但目标元素没找到（role=${oldRef.role}, name=${oldRef.name}，最新截图里没有同 role+name 或坐标最近 >100px 的项），请重新截图后再操作`
          return first as any
        }
      }
    }
  }
  return first as any
}
```

然后给 click/type/select/scroll 包一层（**替换原来直接 return 的语句**）：

```ts
// click:
return withAutoRetryStaleSnapshot(actInput, () => {
  const validated = validateRefAct(actInput, cacheById, deps.getWindow)
  // ... 整个 click 实现原封不动搬进来
})

// type/select/scroll 同理：把 validateRefAct + executeOnce 的逻辑整块搬进去
```

**Step 2: 测试 + 提交**

```bash
npx vitest run apps/windows/src/main/app-ui-control/controller.test.ts
pnpm --filter @mtbot/windows typecheck
git commit -m "fix(app-ui): click/type/select/scroll stale_snapshot 在 controller 内自动重试 1 次，成功对 LLM 透明，失败返回明确 hint"
```

> **Part B 结束独立验收：** 运行模型配置任务，用 `app_fill_form` 填完模型 ID 后故意触发一次 React 重渲染（比如点别的地方）再 `app_settings_model_config_save`，日志里应该看不到 `stale_snapshot` 错误（被内部吞了并成功写 note），或只看到一次然后成功。

---

## Part C：P2 可选 annotation（Task 8–10，用户要"笔记画圈"时才启用，可延后实施）

> 本 Part 可在 P0+P1 上线且稳定 1 周后再做，不阻塞主优化效果。

---

### Task 8: shared/screen-record.ts 扩 ScreenRecordTimelineEntry 联合类型

**Files:**
- Modify: `apps/windows/src/shared/screen-record.ts`
  - 新增 `ScreenRecordAnnotation` 接口
  - 新增 `ScreenRecordTimelineEntry = ScreenRecordMarker | ScreenRecordAnnotation`
  - 把 `ScreenRecordStopResult.timeline` 从 `ScreenRecordMarker[]` 改为此联合类型
- Test: `shared/screen-record.test.ts`（无则略；仅类型变更）

**参考字段（对应设计 §3.3）：**
```ts
export interface ScreenRecordAnnotation {
  id: string
  atMs: number        // 出现时间（活跃时钟，与 marker 一致）
  endMs: number       // 消失时间；0 = 到下一条 annotation 或片尾
  kind: 'circle' | 'rect' | 'arrow' | 'text'
  label?: string      // 画圈旁的文字说明，可直接当文字浮层
  geometry: {
    x: number         // 归一化 0..10000（源分辨率无关）
    y: number
    w?: number
    h?: number
    tx?: number       // arrow 终点
    ty?: number
  }
  style?: { color?: string; thickness?: number; fontSize?: number }
}

export type ScreenRecordTimelineEntry = ScreenRecordMarker | ScreenRecordAnnotation

// 然后去修改 ScreenRecordStopResult / state.timeline 的类型：
timeline: ScreenRecordTimelineEntry[]
```

**提交：**
```bash
git commit -m "feat(screen-record): timeline 扩 annotation 联合类型，为后期画圈标注铺路"
```

---

### Task 9: screen-record-service 扩 state + mark() 旁新增 annotate() + bridge 工具注册

**Files:**
- Modify: `apps/windows/src/main/screen-record/screen-record-service.ts`
  - `InternalState.timeline: ScreenRecordTimelineEntry[]`（line 140 已更新类型）
  - `createIdleState` 初始化 `timeline: []`（ok）
  - 接口 `ScreenRecordService` 加 `annotate(params)` 方法
  - 实现：内部校验 status（**允许 paused**，因为标注是规划型动作，paused 思考阶段更常见），atMs 用 `computeActiveElapsedMs()`，endMs 算好；推到 state.timeline；返回 marker 同形态结果
- Modify: `apps/windows/src/main/agent-runtime/bridge-screen-record-tools.ts`
  - 注册 `screen_record_annotate` 工具，TypeBox 参数对应设计文档 §3.3.2
  - `targetElement(snapshotId+ref)` 定位：先从 controller.getSnapshotCache 找（若取不到，给 hint"请先截图再标注"），然后按 ref.x/y/w/h 转归一化 geometry
  - `fromNextMark` 模式：记录为 `{..., pending_from_next_mark: true}`，下次 `screen_record_mark` 执行时扫 timeline 里 pending 的 annotation 并把它的 atMs 替换掉（实现简单：`mark()` 结束前 `state.timeline.forEach(t => { if (t.kind==='annotation' && t.pending) t.atMs = atMs_of_this_mark })`）

**提交：**
```bash
git commit -m "feat(screen-record): screen_record_annotate 新工具 + timeline 存 annotation 条目（paused 也允许打标注）"
```

---

### Task 10: narrate-service 两步串行烧 annotation 后再烧 subtitle

**Files:**
- Modify: `apps/windows/src/main/screen-record/narrate-service.ts`
  - `narrate` 主流程在 subtitle burn 之前先插一个阶段：`preBurnAnnotations(srcPath, timeline): intermediatePath`
  - 两个阶段都失败降级：annotation 烧录失败 → warning `annotation_burn_failed` 但继续烧字幕；字幕失败返回 `subtitle_burn_failed`（现有）

**preBurnAnnotations 伪代码：**
```ts
async function preBurnAnnotations(srcPath: string, timeline: ScreenRecordTimelineEntry[]): Promise<{
  outputPath: string        // 中间产物路径
  warnings: string[]        // 'annotation_burn_failed' 若有任何失败
}> {
  const annotations = timeline.filter(t => (t as any).kind === 'annotation' || (t as any).geometry) as unknown as ScreenRecordAnnotation[]
  if (annotations.length === 0) return { outputPath: srcPath, warnings: [] }

  // 1. 生成 ffmpeg drawbox / drawtext 字符串（每条 annotation 一段滤镜）
  const filters: string[] = []
  const vw = 10000, vh = 10000  // 归一化
  for (const a of annotations) {
    const start = a.atMs / 1000
    const end   = a.endMs / 1000
    const enable = `enable='between(t,${start},${end})'`
    // 先把归一化坐标转源视频尺寸需要在 drawbox/drawtext 里用 (w/10000)*x、(h/10000)*y 表达式
    const xExpr = `(w*${a.geometry.x})/${vw}`
    const yExpr = `(h*${a.geometry.y})/${vh}`
    const wExpr = a.geometry.w ? `(w*${a.geometry.w})/${vw}` : undefined
    const hExpr = a.geometry.h ? `(h*${a.geometry.h})/${vh}` : undefined
    const color = a.style?.color ?? '#ff3b30'
    const thick = Math.max(1, Math.round((a.style?.thickness ?? 60) * (480/10000)))   // 线宽估计

    if (a.kind === 'rect' || a.kind === 'circle') {
      filters.push(`drawbox=x=${xExpr}:y=${yExpr}:w=${wExpr}:h=${hExpr}:color=${color}:t=${thick}:${enable}`)
    } else if (a.kind === 'text' || a.label) {
      const text = a.kind === 'text' ? (a as any).text : a.label
      if (text) {
        const fontSize = (a.style?.fontSize ?? 320) * 480 / 10000
        filters.push(`drawtext=fontfile=Arial.ttf:fontcolor=${color}:fontsize=${fontSize}:x=${xExpr}:y=${yExpr}:text='${escapeFfmpegText(text)}':${enable}`)
      }
    }
  }

  // 2. 两步：生成 intermediate.{ext} 文件路径，ffmpeg -vf filters 串烧
  //    任何一步失败 → warning，outputPath 回到 srcPath
  //    drawtext 在 Windows 需要字体文件，若 Arial.ttf 找不到则 fallback 到只画框（warning 提示）
}
```

**注意 Windows ffmpeg drawtext 字体：** Windows 下 ffmpeg 常缺默认 fontconfig 配置。narrate-service 要先探测 `C:\Windows\Fonts\msyh.ttc`（微软雅黑）或 `C:\Windows\Fonts\arial.ttf`，若找不到 → annotation text 整项降级为仅 rect 不写字，warning `annotation_font_missing_text_skipped`。

**提交：**
```bash
git commit -m "feat(screen-record): narrate 阶段两步串行烧录 annotation→subtitle；失败降级 warning 不阻塞交付"
```

---

## Part D：整体验收 + 回归（Task 11）

### Task 11: 全链路手工验收 + 类型检查 + 全量测试

**Step 1: 类型检查 + 全量单测**

```bash
cd e:\my-project\open-source\lumii
pnpm typecheck
npx vitest run apps/windows/src/main/app-ui-control apps/windows/src/main/agent-runtime/bridge-app-ui-tools.test.ts apps/windows/src/main/screen-record
```

预期 **0 errors、0 failing tests**。

**Step 2: 真实任务跑 2 次（冷运行 + 热运行）**

发两段一样的用户请求，看第二次 Skill 能否复用第一次的探路 JSON：
- 「请为当前程序录制一段模型配置的视频教程，带字幕和配音，**步骤要清楚，可给观众标注关键区域**（第二次不加这句，验证画圈可选）」

**验收对照（设计文档 §5.2）：**

| 指标 | 阈值 | 不达标时的处理建议 |
|------|------|------------------|
| 思考轮次 | ≤ 20 | 检查 TutorialNavSpec 是否真的在正式录制阶段生效（读对话历史代码块）；没生效 → 把 JSON 放得更靠近正式录制步骤；检查 heading/label refs 是否真的被 Agent 用了（日志里出现 heading 名称即命中） |
| app_screenshot 调用（含高层工具内部调用不计入用户侧） | ≤ 8 | 若超限：检查 P0-3 refs_filter 是否默认没有传 → 在 Skill 里给每个高层工具示例都加 refs_filter 作为 few-shot |
| 无效滚动来回 | 0 次 | 若还出现：检查 scroll_to_text 的槽标题（文本对话）是否真的匹配（若 Agent 仍写成「文本对话 Agent」，在 SKILL.md 禁令位置再强调一次，或者 TutorialNavSpec schema 里加 slotHeading 允许值枚举白名单，不合法直接在探路阶段报错） |
| `stale_snapshot` 错误对外出现 | ≤ 1 次 | 超限 → 检查 retry 逻辑是否真的被包了（Task 7 里 click/type/select/scroll 可能漏掉了某一个入口） |
| `not_interactive` 错误对外出现 | ≤ 3 次 | 若更多：说明 Agent 倾向于点 title 而不是按钮 → 在高层工具 scroll_to_text 里命中后不返回 heading ref 给用户，直接内部用 |

**Step 3: 结果与基准日志（docs/temp/运行日志.log）对比**

新日志保存到 `docs/temp/运行日志-优化后.log`，统计：
- `[思考过程]` 行数百分比
- `[工具调用: app_screenshot]` 次数
- `[工具调用: app_act scroll]` 次数
- `stale_snapshot` 次数

与基线比 ↓65% 即可。没达标 → 在 Deviations 节记录原因并调整 Task 数。

**Step 4: 最终提交（可独立 commit）**

```bash
git add docs/temp/运行日志-优化后.log   # 可选，不强制 commit 日志
git commit -m "docs(log): 优化后模型配置教程录制运行日志（对照基线）"
```

---

## 附录：Deviations 模板（实施时真实修改了这里再填）

| 假设 | 实际情况 | 调整动作 | Task 影响 |
|------|---------|---------|----------|
| slot 卡片用 `<Card>` 包容器 | （例：实际使用了 `<Panel>`） | heading 属性打到 `<Panel title>` 上 | Task 2 |
| narrate 里 ffmpeg 支持 `drawtext` 单行多 `enable` | （例：Windows 下 ffmpeg 版本 drawtext 带 enable 语法报错） | 改为每条 annotation 单独 ffmpeg 命令，链式处理文件 | Task 10 |
| 高层工具内部 screenshot 会写 `~/.lumii/temp/screenshots`，大量写盘 | 实际没压力（20 次也只是 20 张 JPG） | 保持现状，不用加内存临时文件 | 无 |

---

## 版本历史（本计划）

| 版本 | 日期 | 说明 |
|------|------|------|
| v1.0 | 2026-08-16 | 初始发布（P0 + P1 + P2 完整 11 Task，修正了设计阶段 8 处与实际代码不匹配的问题：heading 用 attribute、文案修正、重试下沉 controller、not_interactive 新码、high quota、NavSpec 不落盘、quota 两阶段、annotate 两步烧录） |
