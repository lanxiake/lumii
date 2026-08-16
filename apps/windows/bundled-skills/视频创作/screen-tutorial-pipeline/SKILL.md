---
name: screen-tutorial-pipeline
description: 录制本机/Lumii 操作教程、产品演示视频并自动加字幕与配音的全流程编排技能。当用户要求「录一段教程/演示视频」「录屏并配字幕配音」「把某个功能的操作过程录成视频教程」时使用。依赖 screen_record_* 与 app_* 工具，全程本地，不走 ComfyUI / 外部 API。
metadata:
  {
    "mtbot":
      {
        "emoji": "🎬",
        "requires": { "tools": ["screen_record_start", "screen_record_stop", "screen_record_mark", "screen_record_narrate", "screen_record_inspect"] }
      }
  }
---

# 录屏教程流水线（Screen Tutorial Pipeline）

把「录屏 → 打点 → 停录 → 生成字幕配音 → 验收交付」固化为一条最短路径的工作流。目标：**有效画面紧凑、字幕对齐真实操作、一次产出可交付 MP4、零次猜产物 / 零次手搓 ffmpeg**。

## 适用场景

- 为某个软件功能录制操作教程（如「模型配置」「新建定时任务」）
- 产品功能演示视频，需要旁白配音 + 字幕
- 录制本机 / Lumii 窗口的操作过程并成片

不适用：需要 AI 生成画面的创意视频（用 `video-creation-pipeline`）；纯截图说明（直接用 `app_screenshot`）。

## 核心工具

| 工具 | 用途 |
|------|------|
| `screen_record_list_sources` | 列录制源；教程用录屏，看界面细节用截图 |
| `screen_record_start` | 开始录制；教程建议 `includeMic=false`（事后 TTS 配音） |
| `screen_record_pause` / `resume` | 思考/截图/规划时 **pause**，恢复后 **resume** |
| `screen_record_mark` | 关键步骤打点，供后续生成字幕时间轴 |
| `screen_record_annotate` | （可选）笔记画圈/框选标注，写入 timeline，narrate 时烧录 |
| `screen_record_stop` | 停录，返回 `timeline`、`durationMs`、`mp4Path` |
| `screen_record_narrate` | 一次性写字幕 + TTS 配音 + 烧录 + 导出 MP4；可传 `annotations` |
| `screen_record_inspect` | 只读验收成片与字幕产物，替代目录扫盲 |
| `app_goto_and_screenshot` / `app_scroll_to_text` / `app_scroll_to_bottom` / `app_fill_form` / `app_settings_model_config_save` | 高层 UI 工具，优先于原子 `app_act` 组合 |

## 标准工作流

```
探路（不录屏）
  → start（includeMic=false）
  → [pause 思考/截图 | resume → mark → app_act 操作] × N
  → stop（拿到 timeline）
  → 由 timeline 生成 cues
  → narrate(..., exportMp4=true)
  → 读 narrate 返回字段 / inspect 验收
  → 交付
```

### 1. 探路彩排（关键，别跳过）

**开始录制前，先不录屏走一遍**：用 `app_goto` / `app_goto_and_screenshot` / `app_screenshot` / `app_act` / 高层工具确认入口、每步 UI 反应、以及每步操作的恢复方式。目的：

- 摸清界面结构，避免正式录制时边录边试错（试错过程会全录进成片）
- 提前发现「会改动用户数据」的操作并规避（见下方安全原则）
- 产出下方 **TutorialNavSpec v1**，正式录制只按手册跑，不再重复观察

**工具使用优先级（探路阶段必须遵守）**：

1. **app_goto_and_screenshot** - 跳转+截图一步完成（替代 goto → sleep → screenshot）
2. **app_scroll_to_text** - 自动查找目标并滚动到位（替代反复 scroll + screenshot 观察）
3. **app_scroll_to_bottom** - 一次滚到底部（禁止多次调用同一容器）
4. **app_fill_form** - 多字段一次填完（替代逐个 type）
5. **app_settings_model_config_save** - 模型配置页保存（业务特化，优先用）
6. **app_act** - 仅在上述工具无法覆盖时兜底

**❌ 禁止低效模式**：
- `app_screenshot` → `app_act scroll` → `app_screenshot` 反复观察 ❌ 改用 `app_scroll_to_text`
- `app_goto` → `app_screenshot` 分两步 ❌ 改用 `app_goto_and_screenshot`
- 逐字段 `app_act type` ❌ 改用 `app_fill_form` 一次完成
- 多次 `app_scroll_to_bottom` 在同一页 ❌ 一次即可到底

### 1.b 探路输出：TutorialNavSpec v1（MUST 输出代码块，不做就不算完成探路）

探路结束后、执行 `screen_record_start` 之前，**必须**在回复里输出一段 **单独的 json 代码块**，info string 为 `tutorial-nav-spec`。后续正式录制阶段**必须**用这段代码块的 `steps[i]` 作为唯一操作输入，不要回到「观察界面→猜测→再确认」的老路（若后续发现步骤错了，先 `pause` 再改 JSON，不要硬录）。

#### TutorialNavSpec v1 Schema（示例：模型配置教程）

探路结束时输出的代码块 **info string 必须是 `tutorial-nav-spec`**（不是 `json`）。内容示例：

```json
{
  "specVersion": "1.0",
  "task": "录制模型配置教程",
  "replayFromView": "dashboard",
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
#### action.kind 白名单（v1，只准用这些）

| kind | 说明 |
|------|------|
| `goto` | 等价 `app_goto` / `app_goto_and_screenshot` |
| `scroll_to_heading` | 等价 `app_scroll_to_text({kind:'heading', text:targetName})` |
| `scroll_to_bottom` | 等价 `app_scroll_to_bottom` |
| `act_type_by_field_label` | 等价 `app_fill_form({fields:[{slotHeading,label,text,...}]})` |
| `click_by_button_text` | 等价 `app_scroll_to_text({kind:'button', text})` 再 click |
| `click_by_ref` | 兜底；仅在高层工具命中不准时用 |
| `compose_new_chat` | 新建对话 + goto chat（组合操作） |

#### 探路/录制禁令（NavSpec）

- **禁止** `steps[i].action` 里写 `scroll dy=... ref=eN` 这种耦合 snapshotId 的原子指令（正式录制时 snapshotId 编号必然不同）
- **禁止** `targetName` / `slotHeading` 里写「文本对话 Agent」——必须**原样复制**探路阶段截图 refs 里 `role=heading` 的 name（通常是 `文本对话`，不带 Agent 后缀）
- **禁止** `fieldLabel` 凭记忆写——与 refs 里 `role=label` 的 name 严格一致
- 正式录制阶段若某一步 verify 失败：**先 `screen_record_pause`**，修复后再 resume + mark + 重试；录制阶段的新观察信息**不回写**到 tutorial-nav-spec（除非重新探路）

### 2. 正式录制：pause 纪律

- 正式录制阶段 **MUST** 以最后一段 `tutorial-nav-spec` JSON 的 `steps[i]` 为唯一决策输入；**禁止**再做「确认标题、确认按钮位置、来回滚动观察」——这些属于探路阶段。
- 每完成一步操作，**立刻 `pause`**，想清楚下一步再 `resume`。
- `resume` 后**先 `mark`（写这一步的 label），再按当前步骤 action 执行高层工具**（优先 `app_goto_and_screenshot` / `app_scroll_to_text` / `app_fill_form` / `app_settings_model_config_save`，少用原子 `app_act`）。
- 需要截图看界面时，先 `pause` 再截图 —— 思考和空镜不进成片；已知区域可用 `refs_filter` 精简 refs。
- `mark` 只能在 `recording` 态用；`paused` 态会返回 `not_recording`，这是提醒你先 `resume`。
- `atMs` 用活跃录制时钟：pause 期间不计时，所以停顿再久也不会把后续字幕往后推。
### 3. 由 timeline 生成 cues

`stop` 返回的 `timeline`（按 `atMs` 升序）是字幕的时间锚点，**不要凭感觉估时间**：

- 第 i 条 cue：`startMs = timeline[i].atMs`，`text` 根据该 mark 的 `label` 扩写成一句自然旁白。
- `endMs`：取下一条 mark 的 `atMs`，最后一条取成片 `durationMs`。
- 若首个 mark 的 `atMs > 1500`，可在 `startMs = 0` 补一条开场旁白。
- 相邻间隔 < 800ms 的可合并为一段。

### 4. narrate 一次成片

```jsonc
{
  "path": "<stop 返回的 mp4Path 或 path>",
  "cues": [ { "startMs": 1712, "endMs": 12000, "text": "..." } ],
  "writeSrt": true,
  "dub": true,
  "subtitleMode": "burn",
  "exportMp4": true,
  "originalAudioGain": 0
}
```

- 成片**就地覆盖**可见文件；无字幕原片自动备份在 `{stem}.lumii-subs/original.{ext}`。
- 教程/交付**务必带 `exportMp4=true`**，直接得到可发送的 MP4。
- `includeMic=false` 录的教程用 `originalAudioGain: 0`（只保留 TTS 旁白）。

### 5. 读返回字段 / inspect 验收

- **以 `narrate` 返回字段为准**：`dubbed`（是否配音）、`burned`（字幕是否烧录成功）、`bytes`、`mp4Path`、`message`。
- 需要独立复核时用 `screen_record_inspect`，读 `exists / bytes / hasSrt / hasOriginal / ttsCount / durationMs`。
- 交付前附上探路产出的 `tutorial-nav-spec` JSON（便于用户复用同系列流程）。

## 硬性禁令

- **禁止** 用 `glob` / `bash` 去猜 `*-narrated` / `*-burned` 这类产物文件名 —— 一律以工具返回字段为准。
- **禁止** 手写 ffmpeg / mix 脚本做混音、烧字幕、转封装 —— `narrate` 已一体化完成。
- **禁止** 用 `sleep` + 反复截图去等文件生成 —— narrate 返回即完成。
- **禁止** 在录制中做会**改动/重置用户配置**的操作（见安全原则）。
- **禁止** 正式录制阶段再做探路式观察（反复截图确认标题/按钮）；MUST 按 `tutorial-nav-spec` 的 steps 执行。

## 安全原则（只读演示）

教程演示默认**只读**，不得破坏用户实际数据：

- 优先演示查看性操作（进入页面、展示字段、切换只读选项）。
- 若必须演示会写入的操作（如切换服务商类型、点保存），先在探路阶段确认其副作用与恢复方式；能规避就规避。
- 一旦发现界面异常（字段被重置、错位等），**先 `pause` 再排查**，别把排查修复过程录进成片；必要时 `stop` 重录。

## 常见弯路对照（务必避免）

| 弯路 | 正确做法 |
|------|----------|
| 边想边录，成片大量空镜 | 每步做完即 pause，思考不进成片 |
| 字幕时间按比例估算，音画错位 | 用 `stop` 返回的 timeline 锚定 cues |
| glob/sleep 猜产物、误判失败后手搓 ffmpeg | 读 narrate 返回字段；inspect 验收 |
| 交付的是 webm / 忘了导出 | narrate 带 `exportMp4=true` |
| 演示中切换服务商把用户配置搞乱，再花大量操作修复 | 探路彩排 + 只读演示；异常先 pause |
