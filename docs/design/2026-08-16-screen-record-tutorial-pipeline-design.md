# 录屏教程流水线（Agent 效率优化）

> 日期：2026-08-16  
> 状态：**已实施**（P0–P3 全部完成）  
> 实施计划：`docs/plans/2026-08-16-screen-record-tutorial-pipeline-implementation.md`  
> 基线：字幕附属目录 / 就地烧录已交付，见 `docs/design/2026-08-15-screen-record-subtitle-editor-design.md`  
> 动机：运行日志（「模型配置视频教程」）显示 Agent 因契约过期、无时间轴、结果不可观测而长时间手搓 ffmpeg  
> Skill：已落地 `apps/windows/bundled-skills/视频创作/screen-tutorial-pipeline/SKILL.md`（独立于 H3 管线）

---

## 0. 结论摘要

| 问题 | 结论 |
|------|------|
| 选哪条路 | **方案 C：教程流水线**（契约止血 + mark/timeline + 富返回 + inspect） |
| 时间基准 | 标记与字幕用**活跃录制时钟**（与 `elapsedMs` 一致；paused 不计） |
| 打点 | 新工具 `screen_record_mark`；仅 `recording` 可打；`stop` 带回 `timeline` |
| narrate | 描述与类型改为「就地覆盖」；成功返回 `dubbed/burned/bytes/...`；教程建议 `exportMp4=true` |
| 验收 | 只读 `screen_record_inspect`；禁止 glob 猜 `*-narrated` / `*-burned` |
| 录制节奏 | 工具描述约定：思考/截图先 `pause`，操作前 `resume` + `mark` |
| Skill | **本期不做**；管线调通后新增 sibling skill（建议名 `screen-tutorial-pipeline`） |

---

## 1. 背景与目标

### 1.1 日志中的弯路

「使用录屏功能为当前程序录制模型配置的视频教程，需要字幕和配音」一次任务中：

1. **边想边录**：录中途多次 `sleep` + `app_screenshot`，有效操作约 20s，成片 59s，后段大量空镜。  
2. **字幕时间靠猜**：无操作时间戳，cues 按比例估算，音画易错位。  
3. **契约过期**：`screen_record_narrate` 仍写「返回 `*-narrated.webm`」，实现已是就地覆盖；Agent 反复 glob/sleep，误判失败后手写 ffmpeg 合成脚本。  
4. **结果不可观测**：成功只回 `path` + `srtPath`，看不出是否已配音/烧录；交付 MP4 未走 `exportMp4`。

### 1.2 目标

| 维度 | 目标态 |
|------|--------|
| 速度 | 有效画面紧凑；思考不进成片 |
| 准确 | cues 对齐真实操作时刻 |
| 质量 | narrate 一次出可交付 MP4；结果自解释 |
| 工具耗时 | 零次「猜产物 / 手搓 ffmpeg」 |

### 1.3 目标工作流（Agent）

```
探路（不录）
  → start
  → [pause 思考/截图 | resume → mark → 操作]×N
  → stop（含 timeline）
  → 由 timeline 生成 cues
  → narrate(..., exportMp4=true)
  → 读返回字段 / inspect 验收
  → 交付
```

### 1.4 明确不做（本期）

- 不写 bundled Skill（调试后再写）  
- 不做实时旁白 / ASR 自动字幕  
- 不做完整精剪 UI / 时间轴可视化编辑  
- 不把 `app_act` 强绑自动 mark（可二期可选 `autoMark`）  
- mark 不往画面烧水印  

---

## 2. Timeline / Mark

### 2.1 时间基准

所有 `atMs` 使用**活跃录制时钟**（与现有 `elapsedMs` 一致）：仅在 `recording` 累计，`paused` 不计。pause 思考不会把后续字幕往后推。

### 2.2 数据模型

```ts
/** 录制会话内的操作/旁白打点 */
interface ScreenRecordMarker {
  id: string
  atMs: number
  label: string
  kind?: 'beat' | 'action' | 'note' // 默认 beat
}
```

- 会话态：`state.timeline: ScreenRecordMarker[]`  
- `start` 成功时清空  
- `stop` 成功时按 `atMs` 升序随结果返回  
- 可选：写入 sidecar 备查（非必须；首版可不落盘）

### 2.3 工具 `screen_record_mark`

| 项 | 约定 |
|----|------|
| 入参 | `label: string`（必填）；`kind?: 'beat' \| 'action' \| 'note'` |
| 允许态 | 仅 `recording`；`paused` → `not_recording`（逼 Agent 先 resume 再打点） |
| 返回 | `{ ok: true, marker: { id, atMs, label, kind }, elapsedMs }` |
| 描述要点 | 「教程配音前先 mark；stop 后用 timeline 生成 cues，禁止凭感觉估时间」 |

### 2.4 `screen_record_stop` 增量

成功结果增加：

```ts
timeline: ScreenRecordMarker[]
```

既有字段保持：`path`、`durationMs`、`bytes`、`mp4Path?`、`warning?`。

### 2.5 cues 生成约定（写进工具描述；Skill 以后照抄）

- 第 i 条：`startMs = timeline[i].atMs`；`text` 由 Agent 根据 `label` 扩写成旁白句  
- `endMs`：下一条 `atMs`，或成片 `durationMs`；若间隔 &lt; 800ms 可与下一段合并  
- 若首 mark 的 `atMs` &gt; 1500，可在 `startMs=0` 补一条开场旁白  

---

## 3. narrate 契约与可观测性

### 3.1 工具描述必须改准

当前错误文案（须删除）：「原片保留，返回新 path（*-narrated.webm）」。

改为：

- 成片**就地覆盖**可见文件；无字幕原片在 `{stem}.lumii-subs/original.{ext}`  
- 默认：`writeSrt=true`、`dub=true`、`subtitleMode=burn`  
- 教程/交付建议：`exportMp4=true`  
- **禁止**用 glob/bash 猜测 `*-narrated` / `*-burned`；以返回字段为准  

### 3.2 成功返回（富化）

```ts
type ScreenRecordNarrateResult =
  | {
      ok: true
      path: string              // 当前可见成片（可能已是 mp4）
      originalPath?: string     // 原片备份
      projectDir?: string       // *.lumii-subs
      srtPath?: string
      mp4Path?: string
      bytes: number
      durationMs?: number
      dubbed: boolean
      burned: boolean           // burn 成功 true；降级 soft 则为 false
      ttsCount?: number
      warning?: 'subtitle_burn_failed' | 'mp4_failed'
      message?: string          // 一句人话说明
    }
  | { ok: false; error: ScreenRecordErrorCode; message?: string }
```

共享类型注释同步去掉「原片保留、返回新 path」。

### 3.3 失败 / 降级语义

| 情况 | 行为 |
|------|------|
| TTS/混音硬失败 | `ok: false` + `error` + `message` |
| 烧录失败、配音成功 | `ok: true`，`burned: false`，`warning: 'subtitle_burn_failed'`，仍写 srt |
| MP4 失败 | `ok: true`，保留 webm，`warning: 'mp4_failed'` |

勿让 Agent 把「有 warning 的成功」当成「完全没产出」。

### 3.4 工具 `screen_record_inspect`（只读）

| 项 | 约定 |
|----|------|
| 入参 | `path`（成片，须在 recordings/） |
| 返回 | `exists`、`bytes`、`mtimeMs`、`hasOriginal`、`hasSrt`、`hasProject`、`ttsCount`、`originalPath?`、`projectDir?`、`durationMs?` |
| 用途 | 验收替代目录扫盲；不读帧内容 |

---

## 4. Pause 教程约定（描述层，不改状态机）

状态机保持：`recording ⇄ paused`（活跃时长已正确）。

强化工具描述即可：

| 工具 | 追加约定 |
|------|----------|
| `screen_record_pause` | 教程模式：思考、截图、规划脚本时先 pause，避免空镜进成片 |
| `screen_record_resume` | 恢复后立刻 `mark`，再执行 `app_act` |
| `screen_record_list_sources` | 保持现有：「演示/教程用录屏；看界面细节用截图」 |
| `screen_record_start` | 可提示：教程场景建议 `includeMic=false`（事后 TTS），除非要录真实人声 |

**不做自动 pause**（例如截图时自动暂停）——避免隐式行为难调试；首版靠描述 + 后续 Skill 约束。

---

## 5. 模块落点

| 层 | 文件 | 改动 |
|----|------|------|
| shared | `apps/windows/src/shared/screen-record.ts` | `ScreenRecordMarker`；stop/narrate/inspect 结果类型；命令联合类型 |
| service | `screen-record-service.ts` | `state.timeline`；`mark()`；`stop` 附带 timeline；`getElapsedMs()` 复用 |
| narrate | `narrate-service.ts` | 富化返回字段（`dubbed/burned/bytes/...`） |
| subtitle | `subtitle-project.ts` | inspect 所需路径探测（可抽 `inspectRecording(path)`） |
| tools | `bridge-screen-record-tools.ts` | 注册 `mark` / `inspect`；改 narrate/stop/pause/resume 描述与返回透传 |
| ipc/preload | 若 UI 也要 mark：可选；**首版 Agent 工具足够，UI 可不暴露 mark** |
| 测试 | service / narrate / bridge 单测 | mark 时钟、paused 拒绝、stop 含 timeline、narrate 富返回、inspect |
| 文档 | 本设计；phase2 / subtitle-editor 设计可加「参见教程流水线」交叉链接 | |
| Skill（后期） | `bundled-skills/视频创作/screen-tutorial-pipeline/SKILL.md` | 固化工作流；**不**改现有 H3 `video-creation-pipeline` |

---

## 6. Agent 目标调用序列（验收剧本）

```
1. app_goto / app_screenshot          # 探路，不录
2. screen_record_list_sources
3. screen_record_start                # includeMic=false
4. screen_record_mark label=开场
5. （可选短暂停留）
6. screen_record_pause                # 思考/截图
7. app_screenshot …
8. screen_record_resume
9. screen_record_mark label=获取模型列表
10. app_act click …
11. … 重复 6–10
12. screen_record_stop                # 读 timeline + durationMs
13. screen_record_narrate             # cues←timeline，exportMp4=true
14. 断言返回 dubbed=true；优先 burned=true；有 mp4Path 或 path 为 .mp4
15. （可选）screen_record_inspect
16. 交付；禁止 bash ffmpeg 合成
```

成功标准：同类任务不再出现「等待 burned 文件 / 手写 mix.sh」。

---

## 7. 实施分期

| 阶段 | 内容 | 优先级 |
|------|------|--------|
| P0 | narrate 描述修正 + 富返回；类型注释同步 | 立刻止血 |
| P1 | `mark` + session timeline + `stop.timeline` | 准确字幕 |
| P1 | `inspect` | 防弯路 |
| P1 | pause/resume/start 描述强化教程约定 | 压缩空镜 |
| P2 | 单测与 bridge 注册测试 | 质量 |
| P3 | ✅ bundled skill `screen-tutorial-pipeline`（已落地） | 固化 Agent 行为 |

预估代码量：P0–P2 约 1～2 个工作日内可落地（含测试），不触及采集底层。

---

## 8. 风险与兼容

| 风险 | 处理 |
|------|------|
| 旧 Agent/对话仍按 `*-narrated` 找文件 | 描述 + 返回 `message` 明示就地覆盖；inspect 给正确路径 |
| mark 过多导致 cues 碎 | 描述建议每关键演示一步一个 beat；过短合并规则 |
| pause 后忘记 resume | mark 在 paused 失败，错误信息提示先 resume |
| 富返回字段变多占 token | 字段短小；`message` 单行 |
| Skill 过早写入 | 明确 P3，避免未调通的流程写进内置技能 |

---

## 9. 后期 Skill 落点（备忘，本期不实施）

路径建议：

`apps/windows/bundled-skills/视频创作/screen-tutorial-pipeline/SKILL.md`

与现有 `video-creation-pipeline`（H3/ComfyUI）并列，description 触发词示例：

> 当用户要求录制本机/Lumii 操作教程、产品演示视频且需要字幕与配音时使用。依赖 screen_record_* 与 app_* 工具，不走 ComfyUI。

Skill 正文照抄 §1.3 工作流 + §2.5 cues 规则 + 「禁止手搓 ffmpeg / 禁止猜 burned 文件名」。

---

## 10. 已确认决策记录

| 项 | 选择 |
|----|------|
| 路线 | C（完整教程流水线代码） |
| Skill | 调试通过后再写；放在 `视频创作/` 下独立 skill |
| §1 目标/非目标 | 已确认 |
| §2 timeline/mark | 已确认 |
| §3 narrate/inspect | 已确认（用户要求合并输出完整方案） |
