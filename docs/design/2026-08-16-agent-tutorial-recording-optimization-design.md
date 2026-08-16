# Agent 录屏教程流水线效率优化（语义补全 + 高层工具 + 结构化探路）

> 日期：2026-08-16  
> 状态：**草稿**（P0 方案已确认，待实施）  
> 基线：`docs/design/2026-08-13-agent-app-ui-control-design.md`、`docs/design/2026-08-16-screen-record-tutorial-pipeline-design.md`  
> 动机：运行日志（模型配置视频教程）暴露三个核心问题：① refs 缺语义导致 15+ 次截图反复猜「第一个卡片是不是文本对话 Agent」；② 原子工具组合爆炸，一次流程 70+ 次 LLM 思考、25+ 次截图、10+ 次无效滚动来回；③ 缺画面标注能力（用户需求笔记画圈标记步骤）。  
> 相关技能：`apps/windows/bundled-skills/视频创作/screen-tutorial-pipeline/SKILL.md`

---

## 0. 结论摘要

| 问题 | 根因 | 选型 | 预期收益 |
|------|------|------|---------|
| Agent 花 5+ 分钟猜卡片标题 / 不可见文字 | `filterSnapshotNodes` 只收可交互元素，纯文本标题/分组（heading、section 标题）被丢掉了 | **P0-1：refs 扩角色**，新增 `role="heading"` / `role="section_title"` 类 ref，不可交互但含关键语义的文本节点入列 | 单次教程任务截图数 ↓60%；思考轮次 ↓40%；不再出现"滚上去看标题→滚下来找保存按钮"无效来回 |
| 探路阶段反复截图确认同一件事；正式录制又把探路走一遍 | 探路结果无结构化持久化形式；全靠 LLM 下一轮凭 prompt 回忆 | **P0-2：探路输出导航手册 JSON**，写进 screen-tutorial-pipeline 技能规范；Agent 探路后 MUST 输出结构化步骤手册，正式录制阶段 MUST 读手册直接执行，不再重复观察 | 探路 + 录制总时长从 40+ 分钟压到 10 分钟内；原子操作步数 ↓70% |
| 每次 screenshot 60+ refs 撑爆上下文；Agent 需在 60 条里找 3 条关键 | refs 无过滤机制；全部输出靠 LLM 自己挑 | **P0-3：refs_filter 参数**，按 `role` / `y` 区间 / `name_contains` 过滤，输出量可砍到 ~10 条 | 单轮 prompt tokens ↓80%；LLM 推理单轮耗时从 2~5 min → 20~40s |
| `app_act` 返回 `stale_snapshot` 要 Agent 自己截→找 ref→重试，至少多 2 轮思考 | bridge 层无透明重试 | **P1-3：stale_snapshot 自动重试**，在 `bridge-app-ui-tools.execute` 里捕获后内部自动走 screenshot→近似匹配→重试，成功对 LLM 透明，失败才把最终 error 向上抛 | 减少 2~5 轮思考/工具调用；对用户感知为"app_act 不再偶发卡住" |
| 原子操作（screenshot→滚动→截图→找按钮→click）占 80% 工具调用，LLM 要反复做"拼图" | 当前只暴露 screenshot/goto/act 三件原子工具 | **P1-2：高层工具 5 个**，`app_goto_and_screenshot` / `app_scroll_to_text` / `app_scroll_to_bottom` / `app_fill_form` / `app_settings_model_config_save` | 典型教程任务工具调用从 40~60 次 → 8~15 次；思考次数从 70+ → 15± |
| 用户需要"笔记画圈"标记操作区域和步骤 | `screen_record_mark` 只有时间戳+文本，无画面叠加通道 | **P1-1：screen_record_annotate（后期烧录，可选）**，存标注到 timeline 新类型 `annotation`，narrate 阶段统一用 ffmpeg drawbox/drawtext 烧，不占录制期性能 | 交付视频带步骤圈框+文字浮层；用户明确标注要"做"时才开；默认关以免过度标注 |
| 流程变慢、无用操作多 | 以上 6 条叠加 | 上述 6 条组合 | 任务整体耗时 ↓75%；空镜与误操作 ↓85%；LLM 决策正确性 ↑ |

**非目标（明确不做）：**
- 不在录制期实时在画面上叠加标注（影响采集性能、调试复杂）
- 不改 `capturePage` / 编码底层 / ScreenRecorderService 状态机
- 不引入 Playwright / robotjs 等新依赖
- 不做"声明式 DSL→自动执行"的完整自动化编排器（先靠导航手册 + Skill 约束）

---

## 1. 日志量化分析（根因佐证）

### 1.1 运行日志统计（`docs/temp/运行日志.log`）

| 指标 | 统计值 | 说明 |
|------|-------|------|
| 总 `[思考过程]` 块数 | **70 次** | 每次 200~800 字推理文本 |
| 总 `[工具调用: app_screenshot]` 次数 | **25+ 次** | 其中 15+ 次为"重复观察同一页面确认标题/按钮位置" |
| 总 `[工具调用: app_act scroll]` 次数 | **10+ 次** | 至少 3 轮"滚下去 → 滚回来 → 再滚下去"来回 |
| `[工具调用: app_act click]` 误操作 | **至少 1 次** | 日志 1060 行"点错按钮了，设置面板还开着" |
| 探路（不录屏）重复次数 | **2 次完整探路** | 第 1~143 行一次，第 854~1073 行又重走完全相同流程 |
| 真正对观众有意义的演示步骤 | **约 8 步** | 概览→设置→模型配置→展示配置→模拟填写→保存→新建对话→开始聊天 |
| LLM 思考耗时估计 | **30~45 分钟** | 平均每轮思考 30s，70 轮 × 30s = 35min |
| 实际有效录制画面（估计） | **15~25 秒** | |

### 1.2 为什么会出现「app_act 工具返回了 ok 却看起来卡住好几天」

**结论：卡住的不是 app_act 工具，是 LLM 的"思考→下一个工具调用"之间的推理空档。**

工具层证据（代码已核查）：
- `bridge-app-ui-tools.ts` 的 `app_act.execute`（[bridge-app-ui-tools.ts#L321-L354](file:///e:/my-project/open-source/lumii/apps/windows/src/main/agent-runtime/bridge-app-ui-tools.ts#L321-L354)）无循环/无 sleep，`switch → controller.click/type/... → jsonToolResult` 一条直线。
- `controller.click`（[controller.ts#L752-L809](file:///e:/my-project/open-source/lumii/apps/windows/src/main/app-ui-control/controller.ts#L752-L809)）也是同步注入 + 2 次 sendInputEvent，单次耗时 < 50ms。
- 日志中每次 `[工具调用: app_act]` → `输出: {"ok":true}` 之间无时间差证据（几乎瞬时）。

推理空档构成：
```
上一个工具结果返回（含 60 个 refs 的 JSON 30~50KB + 1 张 JPEG 引用）
  → LLM 读上下文（200KB+ prompt）
  → 推理"我现在在哪页、我要找什么、哪个 ref 是它、下一步用哪个工具"（语义缺→要推理的事多→慢）
  → 输出下一个工具调用参数（几十字）
         ↑ 这段就是用户感知的"卡在 app_act 几分钟"
```

---

## 2. P0 方案：当天能落地的三件事（不改/少改代码，最大 ROI）

### 2.1 P0-1：refs 扩展语义角色（heading / section_title）

**目标**：让 Agent 不再"看得到按钮但不知道卡片叫什么名"。

#### 2.1.1 要加进 refs 的节点类型

快照脚本 `SNAPSHOT_SCRIPT`（`app-ui-control/snapshot.ts` 注入）当前 SELECTORS：

```js
const SELECTORS = [
  'button', 'a[href]', 'input', 'textarea', 'select',
  '[role=button]', '[role=tab]', '[role=menuitem]', '[role=switch]',
  '[contenteditable=true]', '[data-app-ui]', '[tabindex]:not([tabindex="-1"])'
].join(',')
```

**追加 3 类文本语义节点**，加在 SELECTORS 末尾，排序时靠权重往后放（不挤占交互元素的 120 上限配额）：

| 选择器 | role | name 来源 | 过滤条件 |
|--------|------|-----------|---------|
| `h1, h2, h3, h4` | `heading` | `innerText.trim().slice(0,80)` | 视口内、文字非空、`getBoundingClientRect.height > 0` |
| `.settingsCard__title, .agent-card-title, [data-app-ui-heading]` | `section_title` | `innerText.trim().slice(0,80)` | 同上；类名以实际代码为准，没有就加 `data-app-ui-heading` 标签 |
| `.form-label, label, [data-app-ui-label]` | `label` | `innerText.trim().slice(0,60)` | 同上，用于识别输入框对应字段名 |

实际代码中的类名需在 `apps/windows/src/renderer/pages/*/SettingsHub/` 下 grep 确认；若 Settings 页用的是 styled-components `_settingsCardTitle_xupc5_275` 之类哈希名，**给这些标题元素统一打 `data-app-ui-heading` 属性**，比在快照脚本里写一堆抗哈希选择器更稳。

#### 2.1.2 输出形态

refs 中新增条目示例：
```json
{ "ref": "e61", "role": "heading",     "name": "文本对话 Agent",           "x": 400, "y": 260, "w": 220, "h": 32 },
{ "ref": "e62", "role": "section_title", "name": "编码助手",              "x": 400, "y": 920, "w": 180, "h": 28 },
{ "ref": "e63", "role": "label",       "name": "服务商类型",              "x": 400, "y": 360, "w": 120, "h": 20 }
```

- `heading/section_title/label` 不参与交互（`app_act click` 打它们会返回 `not_clickable`，避免误点）。
- 截断上限：`heading/section_title` 80 字，`label` 60 字，超长 `...`。
- **配额策略**：交互元素保留 80 个名额；语义元素独占 40 个名额；总上限不变 120。语义元素在 truncate 时**优先保留**（因为"不知道叫什么名"比"少看到一个按钮"更致命）。

#### 2.1.3 模块落点

| 文件 | 改动 |
|------|------|
| `apps/windows/src/main/app-ui-control/snapshot.ts` 的 `SNAPSHOT_SCRIPT` | SELECTORS 追加 heading 类；排序权重调低但截断时保底 |
| `apps/windows/src/renderer/pages/SettingsPage/**`（或对应实际目录） | 给模型配置页每个 Agent 卡片的标题、输入框 label 统一打 `data-app-ui-heading` / `data-app-ui-label` |
| `apps/windows/src/main/app-ui-control/types.ts` 的 `AppUiRef.role` 联合类型 | 追加 `'heading' \| 'section_title' \| 'label'` |
| `apps/windows/src/main/app-ui-control/controller.ts`（act 入口） | `heading/section_title/label` role 在 click 时返回 `not_clickable` |
| `bridge-app-ui-tools.ts` 的 `app_screenshot.description` | 追一句「refs 含 heading/section_title 语义节点，不必反复截图观察标题文字」 |
| 测试：`bridge-app-ui-tools.test.ts` | 增加一条：snapshot 含 `data-app-ui-heading` 时 refs 中出现 heading 条目 |

---

### 2.2 P0-2：探路导航手册结构化 + Skill 强制约束

**目标**：探路一次产出即复用；正式录制不再"边走边看"。

#### 2.2.1 导航手册 JSON 契约（`TutorialNavSpec v1`）

探路完成后、正式录制 start 前，Agent **MUST** 以 tool call 或代码块形式输出并通过 `file_write` 写入临时路径（`<用户数据>/temp/tutorial-nav-spec-<任务id>.json`），结构：

```json
{
  "specVersion": "1.0",
  "task": "模型配置教程",
  "createdAt": 1760000000000,
  "replayFromView": "dashboard",
  "preconditions": [
    "设置面板已关闭",
    "当前无正在录制的会话"
  ],
  "steps": [
    {
      "id": "step-1",
      "label": "开场：概览页展示",
      "narrationZh": "打开灵栖，首先看到的是概览页面。",
      "action": { "kind": "goto", "view": "dashboard" },
      "verify": { "view": "dashboard", "hub.open": false },
      "pauseAfterMs": 1500
    },
    {
      "id": "step-2",
      "label": "打开设置-模型配置",
      "narrationZh": "点击左下角设置，选择左侧模型配置。",
      "action": { "kind": "goto", "view": "settings", "category": "modelConfig" },
      "verify": { "hub.open": true, "hub.tab": "settings", "hub.category": "modelConfig" },
      "pauseAfterMs": 1000
    },
    {
      "id": "step-3",
      "label": "展示文本对话 Agent 配置",
      "narrationZh": "第一个卡片就是文本对话 Agent，包含服务商类型、API 地址、密钥和模型 ID。",
      "action": { "kind": "scroll_to_heading", "targetName": "文本对话 Agent" },
      "verify": { "headingVisible": "文本对话 Agent" },
      "pauseAfterMs": 2500
    },
    {
      "id": "step-4",
      "label": "模拟填写模型 ID",
      "narrationZh": "在模型 ID 里填入你要使用的模型，多个用逗号分隔。",
      "action": {
        "kind": "act_type",
        "fieldLabel": "模型 ID",
        "demoValue": "deepseek-v4-pro, deepseek-v4-flash",
        "restoreValue": "deepseek-v4-flash, deepseek-v4-pro"
      },
      "verify": { "inputValueByLabel:模型 ID": "deepseek-v4-pro, deepseek-v4-flash" },
      "pauseAfterMs": 1500
    },
    {
      "id": "step-5",
      "label": "保存全部设置",
      "narrationZh": "滚到底部，点击保存全部。",
      "action": { "kind": "click_by_text", "targetText": "保存全部" },
      "verify": { "toast": "保存成功" },
      "pauseAfterMs": 1200
    },
    {
      "id": "step-6",
      "label": "新建对话并开始聊天",
      "narrationZh": "关闭设置，新建一个对话就可以开始使用了。",
      "action": { "kind": "compose" },
      "verify": { "view": "chat" },
      "pauseAfterMs": 2000
    }
  ],
  "postCleanup": [
    { "action": "restore_input_by_label", "fieldLabel": "模型 ID", "value": "deepseek-v4-flash, deepseek-v4-pro" },
    { "action": "delete_last_session_if_title_contains": "模型配置演示" }
  ],
  "timingBudget": { "totalRecordingSec": 55, "perStepSecMax": 8 }
}
```

**`action.kind` 白名单（v1）**：`goto`、`scroll_to_heading`、`scroll_to_bottom`、`act_type`（按 label 找输入框）、`click_by_text`（按按钮文字找）、`click_by_ref`（兜底）、`compose`（走 session_create + app_goto(chat)）。**禁止**在导航手册里写 `scroll dy=500 ref=e4` 这种对 snapshot 耦合的原子值，因为正式录制的 refs 编号会变。

#### 2.2.2 导航手册的来源

首期 **Agent 探路时自己生成**（靠 P0-1 heading refs 支持识别标题）；二期可以写一个内置工具 `app_probe_view` 返回页面结构（headings 树 + 交互元素），进一步降低探路成本；不引入新依赖。

#### 2.2.3 改哪里（Skill 层，不改 core 代码）

- 修改 `apps/windows/bundled-skills/视频创作/screen-tutorial-pipeline/SKILL.md`，在「标准工作流 → 1. 探路彩排」一节追加：
  - 探路完成后 **MUST** 产出 `TutorialNavSpec v1` JSON 并写到 `<用户数据>/temp/tutorial-nav-spec-*.json`
  - 正式录制阶段 **MUST** 以 `spec.steps[i]` 为唯一决策输入；**禁止**在正式录制中再做"确认标题、确认按钮位置、来回滚动观察"这类行为——这些都属于探路阶段产出，录制阶段只跑步骤 + pause/mark/操作
  - 某步 verify 失败 **PAUSE 录制** 才允许重截图；修复后 RESUME
- Skill 内提供一份最小 NavSpec 示例（模型配置）作为 few-shot 模板。

---

### 2.3 P0-3：`app_screenshot` refs_filter 参数（精简上下文）

#### 2.3.1 新增参数

```ts
// bridge-app-ui-tools.ts:app_screenshot.parameters
annotate?: boolean
target?: 'main' | 'pet' | 'preview'
refs_filter?: {
  roles?: Array<'button'|'textbox'|'combobox'|'tab'|'composer'|'heading'|'section_title'|'label'>
  y_min?: number
  y_max?: number
  name_contains?: string   // 大小写不敏感子串匹配 name
  limit?: number           // 0<limit<=120，默认 120
}
```

过滤在 `filterSnapshotNodes` 出列之后、写 refs 之前执行，顺序：`roles` → `y_min/y_max` → `name_contains` → `limit`。

#### 2.3.2 使用约定（写进工具 description）

- 进入已知页面后第一次截图：**不要** filter，先拿全量 refs
- 定位到某个区域（如"当前只关心模型配置页顶部"）：后续截图传 `refs_filter:{ y_max: 500, roles: ['heading','button','textbox'] }`
- 找某个按钮/输入框：传 `name_contains`
- `limit` 用来强制压上下文：明确只要前 N 条

#### 2.3.3 模块落点

| 文件 | 改动 |
|------|------|
| `bridge-app-ui-tools.ts` app_screenshot 参数 | 加 `refs_filter` schema |
| `controller.ts` 的 `screenshot()` 函数签名 | 接收 filter；在 `refs` 返回前应用 |
| 测试 | `snapshot.filter` → 各 filter 维度单测 + 组合 |

---

## 3. P1 方案：代码改动的五件事（一周内）

### 3.1 P1-2：高层工具 5 个（核心收益）

> 顺序编号按"先最省原子操作"排列。工具都注册在 `bridge-app-ui-tools.ts`，底层复用现有 `snapshot / goto / click / type / scroll`。

| 工具 | 等价原子操作组合 | 预期减少的思考轮次 |
|------|-----------------|-------------------|
| `app_goto_and_screenshot({view, category?, refs_filter?})` | goto → sleep(settle) → screenshot | 2 次工具调用 → 1 次 |
| `app_scroll_to_text({text, kind:'heading'|'button'|'any', direction:'down'|'auto'})` | 反复 scroll + screenshot + 检查 refs 中有没有 text，最多试 6 次 | 4~10 次工具调用 → 1 次；消除"滚过了→滚回来" |
| `app_scroll_to_bottom({ref?})` | 多次 scroll dy=700 直到 atBottom=true | 2~6 次 → 1 次 |
| `app_fill_form({fields: Array<{label_or_ref:string, text:string, append?:boolean}>, restoreSnapshot?:string})` | 对每个字段：按 label 找 textbox → type | N×3 次 → 1 次；内部已做 stale_ref 重试 |
| `app_settings_model_config_save({agentCardName?})` | goto settings.modelConfig → scroll_to_bottom → click 保存全部 → 等 800ms → screenshot 看 toast（可选） | 4~8 次 → 1 次；是 `模型配置` 页特化的高层动作 |

#### 3.1.1 `app_goto_and_screenshot`（最简，先做）

```ts
{
  view: ViewType
  category?: SettingsCategory
  refs_filter?: RefsFilter   // 透传给内部 screenshot
}
```

语义：
1. `controller.goto({view, category})`
2. `sleep(SETTLE_MS)`（复用现有 gotoSettleMs；另加 50ms 确保 Hub 动画完成）
3. `controller.screenshot({target:'main', annotate:false, refs_filter})`
4. 返回与 app_screenshot **完全相同**的 payload（snapshotId / refs / imagePath ...），下游可以无差别消费

#### 3.1.2 `app_scroll_to_text`（消无效滚动的核心）

```ts
{
  text: string                                      // 子串匹配，trim 后大小写不敏感
  kind?: 'heading' | 'button' | 'textbox' | 'any'   // 默认 'any'，只匹配 name
  direction?: 'down' | 'up' | 'auto'                // 默认 'auto'：先下后上
  maxAttempts?: number                               // 默认 8
  stepDy?: number                                    // 默认 clientHeight*0.7（整屏 70%）
}
```

失败返回 `{ok:false, error:'not_found', hint:'...已滚动到底，未找到匹配'}`。
内部做 `stale_snapshot` 自恢复：每次内部截图拿到新 snapshotId，后续 scroll 用新 ref。

#### 3.1.3 `app_scroll_to_bottom`

```ts
{ ref?: string }   // 可选锚点 ref，不传默认页面主内容容器
```

内部循环 `dy = clientHeight * 0.85` 直到 `atBottom=true` 或次数超限，返回最终 scrollTop 与 `screenshot()` 同 payload。

#### 3.1.4 `app_fill_form`（一次填多字段）

```ts
{
  fields: Array<{
    label?: string              // 按输入框前置 label 找；推荐用这个（与 snapshotId 解耦）
    ref?: string                // 兜底：直接 ref（需带 snapshotId）
    snapshotId?: string         // ref 用时必填
    text: string
    append?: boolean
  }>,
  restoreSnapshotId?: string    // 可选：若某字段失败，回滚已写入字段
}
```

按 label 找输入框的实现：内部先截图拿 refs，对每个 label 匹配条目（`role=label` 的 name == label），取同高度区间内下一个 `role=textbox` 作为目标。找不到 → 立即返回 error（带已匹配/未匹配列表），不写脏数据。

#### 3.1.5 `app_settings_model_config_save`（业务特化工具）

模型配置页高频动作，别让 Agent 每次都组合 `scroll_to_text("保存全部") + click(ref)`。

```ts
{
  gotoFirst?: boolean          // 默认 true：先 goto settings.modelConfig 再做其它
  saveAllText?: string         // 默认 "保存全部"
  expectToast?: string         // 默认 "保存成功"
}
```

返回：`{ ok, saved: true, screenshotPayload? }`。失败：`{ ok:false, error:'save_btn_not_found'|'toast_timeout'|'goto_failed', hint }`。

---

### 3.2 P1-3：`stale_snapshot` 自动重试（bridge 层透明兜底）

#### 3.2.1 现状问题

```
Agent: app_screenshot → refs [e1..e60, snapshotId=7]
Agent: app_act click ref=e4 snapshotId=7 → 中途 React 重渲染，缓存被冲掉
→ 返回 {ok:false, error:'stale_snapshot'}
Agent 思考：哦过期了，我得重新截图 → 找新的"模型 ID"对应哪个 e → 再 app_act click
↑ 这段至少 2 轮思考 + 2 次工具调用
```

#### 3.2.2 方案

`bridge-app-ui-tools.ts` 的 `app_act.execute` 在捕获到 `error === 'stale_snapshot'` 后：

```ts
// 内部重试一次（对外透明）
const retryLimit = 1
let result = await tryAct(params)
for (let i = 0; i < retryLimit && !result.ok && result.error === 'stale_snapshot'; i++) {
  // 1. 内部走一次 controller.screenshot()（不返回给 LLM，避免把它搞混乱）
  const fresh = await controller.screenshot({ target: 'main' })
  if (!fresh.ok) break
  // 2. 在 fresh.refs 里找近似匹配：
  //    优先级：
  //      a) params.name？ 没有——但 params 有 ref（旧 ref 是 e4），我们能拿到旧 ref 在旧 cache 里的 name/坐标
  //      b) 所以：先从 cacheById 取出旧 snapshotId 的旧 ref 信息（name, x, y, w, h, role）
  //      c) 在 fresh.refs 里：同 role + 同 name（精确/子串）→ 命中
  //      d) 没有 → 同 role + 坐标 (x,y) 最近 (曼哈顿<100px) → 命中
  //      e) 还是没 → 放弃，把原始 stale_snapshot 返回给 LLM
  const oldRef = getFromOldCache(params.snapshotId, params.ref)
  const matched = oldRef ? findBestMatch(fresh.refs, oldRef) : null
  if (!matched) break
  // 3. 改写 params → snapshotId=fresh.snapshotId, ref=matched.ref → 再跑一次
  result = await tryAct({ ...params, snapshotId: fresh.snapshotId, ref: matched.ref })
  // 4. 无论成败，给返回体加一个轻量字段告知 LLM 发生过 retry：
  //    成功 → "note": "stale_snapshot 自动重试成功，旧 e4→新 e12"
  //    失败 → 返回最终 error + 同样说明
}
```

关键：**只重试一次**，避免 bridge 层内部死循环；并且必须把重试信息（`note` / `matched_ref`）在结果中带上，方便 LLM 调试和 Skill 层统计。

---

### 3.3 P1-1（可选，用户要"画圈"时才启用）：`screen_record_annotate` + 后期 ffmpeg 烧录

> 明确可选项：首版不默认启用；用户在任务要求里说要"笔记画圈"或技能触发词包含"标记步骤/画圈高亮"才调用。

#### 3.3.1 数据模型扩展

shared 类型 `apps/windows/src/shared/screen-record.ts`：

```ts
/** timeline 条目：marker 或 annotation；stop 后统一返回 */
export type ScreenRecordTimelineEntry =
  | ScreenRecordMarker                  // 已有：atMs + label + kind
  | ScreenRecordAnnotation              // 新增

export interface ScreenRecordAnnotation {
  id: string
  atMs: number                          // 出现时间（活跃时钟）
  endMs: number                         // 消失时间（活跃时钟）；0 表示"直到下一条 annotation 或 片尾"
  kind: 'circle' | 'rect' | 'arrow' | 'text'
  label?: string                        // 可选：步骤说明文字（画圈旁边的文字）
  geometry: {
    // 所有坐标使用"录制源归一化坐标" 0..10000（与源分辨率解耦）
    x: number      // 左上角 x (0..10000)
    y: number      // 左上角 y (0..10000)
    w?: number     // rect/circle 宽
    h?: number     // rect/circle 高
    tx?: number    // arrow 终点 x（起点=上面的 x,y）
    ty?: number    // arrow 终点 y
  }
  style?: {
    color?: string       // 线/字颜色；默认 '#ff3b30'
    thickness?: number   // 线宽（归一化 0..100，默认 60）
    fontSize?: number    // 文本字号（归一化 0..500，默认 320）
  }
}
```

stop 结果里 `timeline` 类型从 `ScreenRecordMarker[]` 改为 `ScreenRecordTimelineEntry[]`。

#### 3.3.2 新工具 `screen_record_annotate`

```ts
name: screen_record_annotate
parameters: {
  label?: string
  kind: 'circle' | 'rect' | 'arrow' | 'text'
  // 定位：两种方式二选一。推荐用 A（语义稳，不随录制源分辨率变）
  targetElement?: {
    // A) 语义定位：在最后一次 app_screenshot 里找到的 ref 名/位置
    snapshotId: string
    ref: string
    paddingPx?: number              // 默认 10；向外扩展一圈形成 padding
  }
  // B) 归一化坐标兜底：targetElement 没命中时用
  normalizedRect?: { x: number, y: number, w: number, h: number }
  text?: string                     // kind=text 必填；或 kind=circle 时旁边的浮层文字
  durationMs?: number               // 默认 3000；活跃时钟
  fromNextMark?: boolean            // 默认 false；true = atMs 取"下一次 mark 的 atMs"，endMs = atMs + durationMs
  style?: { color?, thickness?, fontSize? }
}
```

状态机：`mark` 工具在 `paused` 下会 `not_recording`，**`annotate` 允许 paused**（因为标注是规划行为，通常 Agent 在 pause 思考阶段决定"这步要圈保存按钮"，resume 后立刻生效）。

#### 3.3.3 烧录实现

不碰 ScreenRecordService 采集过程；标注信息只在内存 + stop 返回的 timeline 中持有。

真正绘制放在 `narrate-service.ts` 的 ffmpeg 命令组装阶段：对 timeline 里每个 annotation，生成一段 `drawbox` / `drawtext` / `drawarrow`（ffmpeg 原生有 drawbox / drawtext；箭头用 drawbox + 自定义位移或用 drawgrid 近似；v1 先支持 circle(=round-corner drawbox) + rect + text 三种，arrow 放 v2），用 `enable='between(t, startSec, endSec)'` 做时段控制。

输出文件仍就地覆盖，与现有 narrate 行为完全一致。烧录失败时 `warning = 'annotation_burn_failed'`，但配音/字幕仍然产出（不阻塞交付）。

#### 3.3.4 不实时绘制的原因（设计取舍）

录制期实时叠加：要改渲染进程 canvas / DOM 浮层 + 与 capturePage 争用 GPU；性能波动且调试复杂。**后期统一烧录**：录制干净、失败不影响原片、ffmpeg 参数化便于批量改样式。本项目教程场景的"笔记画圈"都是事后标注观众看的，不需要录制时立刻可见。

---

## 4. 模块落点总览

| 层 | 文件 | 改动 |
|----|------|------|
| **shared** | `apps/windows/src/shared/screen-record.ts` | `ScreenRecordTimelineEntry` / `ScreenRecordAnnotation` 类型（P1-1 才用） |
| **snapshot 注入** | `app-ui-control/snapshot.ts` | SELECTORS + 权重 + heading/label 过滤（P0-1） |
| **refs 类型** | `app-ui-control/types.ts` | `AppUiRef.role` 追加 heading/section_title/label（P0-1） |
| **renderer（打标签）** | `SettingsHub/** / ModelConfig/**` | 卡片标题 + 输入框 label 补 `data-app-ui-heading/label`（P0-1） |
| **controller** | `app-ui-control/controller.ts` | screenshot 内 refs_filter；高层工具复用底层 click/type/scroll（P0-3 / P1-2） |
| **bridge 工具** | `bridge-app-ui-tools.ts` | screenshot 参数 refs_filter；注册 5 个高层工具；stale_snapshot 自重试（P0-3 / P1-2 / P1-3） |
| **录屏 service** | `screen-record-service.ts` | annotate 入列 timeline（P1-1 才用） |
| **narrate** | `narrate-service.ts` | timeline 含 annotation → ffmpeg drawbox/drawtext 时段烧录（P1-1 才用） |
| **录屏 bridge** | `bridge-screen-record-tools.ts` | 注册 `screen_record_annotate`（P1-1 才用） |
| **Skill** | `bundled-skills/视频创作/screen-tutorial-pipeline/SKILL.md` | 强制探路出 TutorialNavSpec v1 JSON；录制阶段按 steps 跑；加 refs_filter 示例 |
| **测试** | `apps/windows/src/main/app-ui-control/*.test.ts`、`bridge-app-ui-tools.test.ts`、`screen-record-service.test.ts`、`narrate-service.test.ts` | 对应改动点逐项补齐 |

---

## 5. 验收剧本（前后对比）

### 5.1 改造前（基线）

任务：录制"模型配置教程"，要求概览→设置→模型配置→文本对话 Agent→模拟填写→保存→新建对话→开始聊天，60s 内 + 字幕配音。

```
LLM 思考轮次     70 ± 10
app_screenshot   25 ± 5
app_act 总调用   30 ± 5
无效滚动来回     3~6 次
总耗时（人感）   40~60 分钟
最终成片质量     常有 10~30s 空镜、步骤靠旁白猜、缺标注
```

### 5.2 改造后（目标）

同样任务：

```
LLM 思考轮次     15 ± 5     ↓~75%
app_screenshot   6 ± 2      ↓~75%   （探路 3 + 录制 3）
app_act 总调用   10 ± 3     ↓~65%   （高层工具合并为主）
无效滚动来回     0 次       （scroll_to_text / scroll_to_bottom 封装）
stale_snapshot  对 LLM 不可见（P1-3 兜底）
总耗时（人感）   8~12 分钟   ↓~75%
最终成片质量     步骤紧凑 + 画圈标注可选 + 字幕对齐 timeline
```

### 5.3 用例断言清单

- [ ] 模型配置页第一次截图，refs 里 MUST 出现 `role=heading name=文本对话 Agent`
- [ ] 探路后文件系统 MUST 存在 `tutorial-nav-spec-*.json` 且 `specVersion=="1.0"` 且 steps.length >= 5
- [ ] `app_screenshot refs_filter:{roles:['heading']}` → 返回 refs 全部 role===heading
- [ ] `app_goto_and_screenshot({view:'settings', category:'modelConfig'})` → 返回 view=settings + hub.category=modelConfig + refs（与分开调 2 次同形态）
- [ ] `app_scroll_to_text({text:'保存全部', kind:'button'})` → atBottom=false 的情况下 MUST 命中且返回 scrollTop > 初始值
- [ ] `app_act` 触发 stale_snapshot 场景下：桥接层 MUST 自动重试一次；成功时返回体带 `note: "stale_snapshot auto-retried ok"`
- [ ] （可选标注）`screen_record_annotate` + `narrate` 后：MP4 中 MUST 在指定时段可见到对应圈框/文字（可用 ffprobe 人工抽检或人工肉眼过一遍）

---

## 6. 实施分期（建议顺序）

按"每次提交后立即能独立跑"的粒度切，避免出现半个功能把用户体验搞崩的情况：

| 阶段 | 内容 | 估时 | 对 LLM 可见性 |
|------|------|------|-------------|
| **P0-1** | refs 加 heading / label 语义 + renderer 打 `data-app-ui-*` 标签 | 0.5 天 | 立刻可见（不需要重新打包 Skill / 改 prompt） |
| **P0-3** | screenshot refs_filter 参数 | 0.5 天 | 立刻可见（长任务 Agent 自己会用） |
| **P0-2** | Skill `SKILL.md` 追加 TutorialNavSpec v1 契约 + 示例 | 0.5 天 | Skill 重新加载（下次会话生效） |
| **P1-2a** | `app_goto_and_screenshot` + `app_scroll_to_bottom` 两个最易工具 | 1 天 | 立刻可见 |
| **P1-2b** | `app_scroll_to_text` + `app_fill_form` | 1 天 | 立刻可见 |
| **P1-2c** | `app_settings_model_config_save`（业务特化） | 0.5 天 | 立刻可见 |
| **P1-3** | stale_snapshot 自动重试（bridge 层） | 0.5 天 | 透明（不出现 error=stale_snapshot 即算有效） |
| **P1-1（可选）** | annotate + narrate 烧录 | 1.5 天 | 用户要"画圈"任务时生效 |

**合计（不含 P1-1）**：~4.5 天。含 P1-1：~6 天。

---

## 7. 风险与兼容

| 风险 | 处理 |
|------|------|
| heading 类节点无上限追加导致 refs 120 不够放交互元素 | 配额拆分：交互 80 + 语义 40；语义元素优先保留（§2.1.2） |
| TutorialNavSpec 里写死 label 文案与实际 UI 不符 | Skill 明确：探路阶段 screenshot refs 拿到 label 文字 **原样** 写入 spec；不能靠记忆写中文 |
| 高层工具内多次内部 screenshot → 额外占用 `screenshot` 配额 | 内部调用在 quota 上按"高层工具算 1 次基础调用，不算子调用"——在 guardAppUiTool 里加白名单，或只扣该工具本身 kind 的配额（screenshot 归 goto_and_screenshot 算），不与用户直接调用的 `app_screenshot` 共享同一 bucket。推荐算独立 buckets：`goto_and_screenshot` / `scroll_to_text` 等各有配额，不污染 P0 已上线的 APP_UI_QUOTA |
| stale_snapshot 自动重试误点错元素（`findBestMatch` 命中不准） | 只重 1 次；成功带 note，失败把原始 error 返回；不做第二次重试。可在 `note` 里把新旧 ref 的 name/坐标都打印出来，便于日志复盘 |
| annotate 后期烧录与 subtitle burn 叠加，ffmpeg 滤镜链超长 | 顺序：先字幕 → 再 annotation（或相反），统一一次 `filter_complex` 过，不要跑两遍。失败降级：annotation 失败只带 warning，不回退字幕配音 |
| 老会话里老的 Agent prompt 不会用到新工具/Skill 规范 | 这是预期：技能与 prompt 在新会话加载；老会话走旧路径不破坏 |

---

## 8. 已确认决策记录（2026-08-16 用户确认）

| 项 | 选择 |
|----|------|
| 总体方案选择 | 按推荐方案（P0 先做 + P1 高层工具 + P1-1 annotate 可选后期） |
| P0-2 Skill 是否强制探路输出导航手册 JSON | ✅ 可以 |
| P1-2 是否新增高层工具 | ✅ 加一些高层工具（5 个列在 §3.1） |
| P1-1 画圈标注实现时机 | ⏸ 后期再加，默认作为可选项，用户要求时才启用；用 ffmpeg 后期烧录而非录制时叠加 |
| 文档落点 | ✅ `docs/design/2026-08-16-agent-tutorial-recording-optimization-design.md`（本文件） |
