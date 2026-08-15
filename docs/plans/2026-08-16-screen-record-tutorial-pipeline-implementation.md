# 录屏教程流水线 — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 Agent 能高效完成「本机 UI 教程录屏 + 字幕 + 配音」：契约自解释、活跃时钟打点、stop 带回 timeline、narrate 富返回、inspect 验收，消除手搓 ffmpeg / 猜 `*-narrated` 弯路。

**Architecture:** 在现有 ScreenRecordService 会话态增加 `timeline[]`；新增 `mark()`（活跃时钟）；stop/narrate 结果富化；`inspectRecording` 读 sidecar 元数据；Agent 工具层改描述并注册 `screen_record_mark` / `screen_record_inspect`。不改采集底层、不做 UI mark、不写 bundled Skill。

**Tech Stack:** TypeScript、Electron 主进程、Vitest、现有 narrate/ffmpeg/TTS、ToolRegistry（`bridge-screen-record-tools.ts`）。

**Design:** `docs/design/2026-08-16-screen-record-tutorial-pipeline-design.md`

---

## 范围锁与执行顺序

**严格按 Task 0 → 1 → 2 → 3 → 4 → 5。** 每 Task：写失败测试 → 跑红 → 最小实现 → 跑绿 → 提交。

| Task | 交付 | 依赖 |
|------|------|------|
| 0 | shared 类型：Marker / stop.timeline / narrate 富返回 / inspect 结果 | — |
| 1 | narrate-service 富返回 + 工具描述修正（P0 止血） | 0 |
| 2 | Service `mark` + timeline + stop 带回 timeline | 0 |
| 3 | `inspectRecording` + 工具 `screen_record_inspect` | 0 |
| 4 | bridge 注册 mark/inspect + pause/start/stop/narrate 描述强化 | 1–3 |
| 5 | 交叉文档链接；手工验收清单 | 4 |

**本期不做：** bundled Skill、UI mark、app_act 自动 mark、IPC/preload 暴露 mark（Agent 工具足够）。

建议分支：当前 `main` 或 `feat/screen-record-tutorial-pipeline`。

验证命令（均在 `apps/windows`）：

```bash
npx vitest run src/main/screen-record src/main/agent-runtime/bridge-screen-record-tools.test.ts
```

---

### Task 0：shared 类型扩展

**Files:**
- Modify: `apps/windows/src/shared/screen-record.ts`
- 若存在: `apps/windows/src/shared/screen-record.test.ts`（无则跳过独立 shared 测，靠下游测覆盖）

**Step 1: 扩展类型（可先写再让下游测驱动）**

在 `screen-record.ts` 增加：

```ts
/** 录制会话内打点（活跃时钟 atMs，与 elapsedMs 同基准） */
export interface ScreenRecordMarker {
  id: string
  atMs: number
  label: string
  kind?: 'beat' | 'action' | 'note'
}

export type ScreenRecordMarkParams = {
  label: string
  kind?: 'beat' | 'action' | 'note'
}

export type ScreenRecordMarkResult =
  | {
      ok: true
      marker: ScreenRecordMarker
      elapsedMs: number
    }
  | { ok: false; error: ScreenRecordErrorCode; message?: string }
```

修改 `ScreenRecordStopResult` 成功分支增加：

```ts
timeline?: ScreenRecordMarker[]
```

（首版成功时**总是**返回数组，含空数组；用必填 `timeline: ScreenRecordMarker[]` 更清晰，推荐必填。）

替换 `ScreenRecordNarrateResult` 成功分支为设计 §3.2 字段：`originalPath?`、`projectDir?`、`bytes`、`durationMs?`、`dubbed`、`burned`、`ttsCount?`、`message?`；注释去掉「原片保留、返回新 path」。

新增：

```ts
export type ScreenRecordInspectResult =
  | {
      ok: true
      path: string
      exists: boolean
      bytes?: number
      mtimeMs?: number
      durationMs?: number
      hasOriginal: boolean
      hasSrt: boolean
      hasProject: boolean
      ttsCount: number
      originalPath?: string
      projectDir?: string
      srtPath?: string
    }
  | { ok: false; error: ScreenRecordErrorCode; message?: string }
```

`ScreenRecordCommand` 增加（若 IPC 日后复用；Agent 工具可不经此联合，但仍建议同步）：

```ts
| { readonly type: 'screen-record:mark'; params: ScreenRecordMarkParams }
| { readonly type: 'screen-record:inspect'; path: string }
```

**Step 2: Commit**

```bash
git add apps/windows/src/shared/screen-record.ts
git commit -m "$(cat <<'EOF'
feat(screen-record): 教程流水线 shared 类型（mark/timeline/inspect/narrate 富返回）

EOF
)"
```

---

### Task 1：narrate 富返回 + 描述修正（P0）

**Files:**
- Modify: `apps/windows/src/main/screen-record/narrate-service.ts`
- Modify: `apps/windows/src/main/screen-record/narrate-service.test.ts`
- Modify: `apps/windows/src/main/agent-runtime/bridge-screen-record-tools.ts`（仅 narrate description，可与 Task 4 合并；本 Task 至少改 service）

**Step 1: 写失败测试**

在 `narrate-service.test.ts` 现有 soft/burn 成功用例中断言：

```ts
expect(r).toMatchObject({
  ok: true,
  dubbed: true,
  burned: false, // soft 用例
  bytes: expect.any(Number),
  originalPath: expect.stringContaining('original.'),
  projectDir: expect.stringContaining('.lumii-subs'),
  ttsCount: 1, // 按用例 cues 数
})
expect(r.ok && r.message).toMatch(/就地|覆盖|成片/)
```

burn 成功用例：`burned: true`。  
烧录失败降级用例（若已有）：`burned: false` + `warning: 'subtitle_burn_failed'`。

**Step 2: 跑测确认红**

```bash
cd apps/windows && npx vitest run src/main/screen-record/narrate-service.test.ts
```

Expected: FAIL（缺字段）。

**Step 3: 最小实现**

在 `narrate()` 成功 `return` 前：

- `bytes = fs.statSync(finalPath).size`
- `dubbed = dub && 混音成功`
- `burned = subtitleMode === 'burn' && warning !== 'subtitle_burn_failed' && writeSrt`（soft 模式 `burned: false`）
- `ttsCount = resolvedCues.filter(c => c.audioPath).length`
- `originalPath = resolveOriginalVideoPath(finalPath) ?? undefined`（或 `buildProjectPaths` 的 original）
- `projectDir = buildProjectPaths(finalPath).assetDir`
- `durationMs`：可选 `probe(finalPath)`，失败则省略
- `message`：例如 `成片已就地更新；原片备份在 *.lumii-subs/original.*；勿再查找 *-narrated 文件`

**Step 4: 跑绿 → Commit**

```bash
git add apps/windows/src/main/screen-record/narrate-service.ts \
  apps/windows/src/main/screen-record/narrate-service.test.ts
git commit -m "$(cat <<'EOF'
feat(screen-record): narrate 成功返回 dubbed/burned/bytes 等可观测字段

EOF
)"
```

---

### Task 2：Service mark + timeline

**Files:**
- Modify: `apps/windows/src/main/screen-record/screen-record-service.ts`
- Modify: `apps/windows/src/main/screen-record/screen-record-service.test.ts`

**Step 1: 写失败测试**

参考现有 pause 测试的假时钟/`nowMs` 注入模式，新增：

1. `recording` 下 `mark({ label: '获取模型列表' })` → `ok`，`marker.atMs` ≈ 当前活跃时长，`kind` 默认 `beat`  
2. 假时钟：录 1000ms → pause → 墙钟再过 5000ms → resume → mark → `atMs` 约为 1000（暂停不计）  
3. `paused` / `idle` 下 mark → `not_recording`，`message` 含「先 resume」类提示  
4. `label` 空串 → `usage` 或 `invalid`（建议 `usage` + message）  
5. `stop` 成功结果含 `timeline` 数组（按 atMs 升序），且与 mark 一致  
6. 新 `start` 清空上一会话 timeline  

**Step 2: 跑红**

```bash
cd apps/windows && npx vitest run src/main/screen-record/screen-record-service.test.ts
```

**Step 3: 最小实现**

`InternalState` 增加：`timeline: ScreenRecordMarker[]`

在 reset-to-idle / start 成功进入 recording 时：`timeline = []`

```ts
function mark(params: ScreenRecordMarkParams): Promise<ScreenRecordMarkResult> | ScreenRecordMarkResult {
  const label = params?.label?.trim()
  if (!label) return { ok: false, error: 'usage', message: 'label required' }
  if (state.status !== 'recording') {
    return {
      ok: false,
      error: 'not_recording',
      message: state.status === 'paused'
        ? '当前已暂停：请先 screen_record_resume，再 mark'
        : '仅 recording 态可打点',
    }
  }
  const atMs = computeActiveElapsedMs()
  const marker: ScreenRecordMarker = {
    id: `m_${atMs}_${state.timeline.length}`,
    atMs,
    label,
    kind: params.kind ?? 'beat',
  }
  state.timeline.push(marker)
  return { ok: true, marker, elapsedMs: atMs }
}
```

在 `stopInternal` 成功返回对象中加入：

```ts
timeline: [...state.timeline].sort((a, b) => a.atMs - b.atMs)
```

（push 已有序则可直接拷贝。）导出接口增加 `mark`。

**Step 4: 跑绿 → Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(screen-record): 会话 mark 打点与 stop 返回 timeline

EOF
)"
```

---

### Task 3：inspectRecording

**Files:**
- Modify: `apps/windows/src/main/screen-record/subtitle-project.ts`
- Modify: `apps/windows/src/main/screen-record/subtitle-project.test.ts`
- 可选薄封装：若希望 ACL 在 service/工具层，可在工具 execute 里直接调 `inspectRecording` + `isPathUnderDir`

**Step 1: 写失败测试**

```ts
it('inspectRecording 汇总 sidecar', () => {
  // 准备 video + assetDir/project.json + srt + original + tts/ 下 2 个 wav
  const r = inspectRecording(video)
  expect(r).toMatchObject({
    ok: true,
    exists: true,
    hasOriginal: true,
    hasSrt: true,
    hasProject: true,
    ttsCount: 2,
  })
  expect(r.ok && r.projectDir).toContain('.lumii-subs')
})

it('文件不存在 → exists:false 仍 ok:true（或 ok:false source_unavailable——推荐 exists:false + ok:true 便于 Agent）')
```

**推荐语义：** 路径合法且在 recordings 下 → `ok: true` + `exists: false|true`；路径越界 → `ok: false, error: 'source_not_in_recordings'`（越界检查可放工具层，纯函数只看磁盘）。

**Step 2–4: TDD 实现**

```ts
/** 检查成片与 *.lumii-subs 附属状态（不读帧） */
export function inspectRecording(videoPath: string): Omit<Extract<ScreenRecordInspectResult, { ok: true }>, 'ok'> & { ok: true }
```

用 `buildProjectPaths` / `fs.existsSync` / `fs.readdirSync(ttsDir)` 计数；`bytes`/`mtimeMs` 来自 `fs.statSync`。

**Commit:**

```bash
git commit -m "$(cat <<'EOF'
feat(screen-record): inspectRecording 汇总成片与字幕附属元数据

EOF
)"
```

---

### Task 4：bridge 工具注册与描述

**Files:**
- Modify: `apps/windows/src/main/agent-runtime/bridge-screen-record-tools.ts`
- Modify: `apps/windows/src/main/agent-runtime/bridge-screen-record-tools.test.ts`
- Modify: `RegisterScreenRecordToolsDeps`：无需新 dep（mark 走 getService；inspect 可直接 import `inspectRecording` + `resolveRecordingsDir`——若 service 无 resolve，从 deps 或现有 narrate deps 取。**最简：inspect 在工具内用 getService 没有则** 给 deps 增加可选 `resolveRecordingsDir?: () => string`，或把 `inspect` 挂到 ScreenRecordService。

**推荐：** `ScreenRecordService.inspect(path)` 薄包装（ACL + 调 `inspectRecording`），与 list-recordings 模式一致。若 list 已在 service，照抄。

查看 `listRecordings` 是否在 service：若在 IPC 而非 service，则 tools 层：

```ts
getNarrateService / getService
resolveRecordingsDir from deps
```

检查 `registerScreenRecordTools` 调用点（`main/index.ts` / agent bridge）是否已有 `resolveRecordingsDir`；有则扩展 deps，无则从 getService 侧加 `inspect` 方法。

**Step 1: 测试**

- 工具名列表含 `screen_record_mark`、`screen_record_inspect`（原「七工具」改为九工具）  
- mark 透传 `not_recording`  
- inspect 透传结果  
- **narrate description** 字符串断言（可选）：`toContain('就地')` 且 `not.toContain('*-narrated.webm')`

**Step 2: 实现工具**

`screen_record_mark` description 要点：

> 在活跃录制时钟上打点。仅 recording 可用。教程：resume 后先 mark 再操作；stop 后用 timeline 生成 cues（startMs=atMs），禁止凭感觉估时间。

`screen_record_narrate` description 替换为：

> 对 recordings/ 内成片做字幕+TTS。成片就地覆盖；原片在 `{stem}.lumii-subs/original.*`。默认 writeSrt/dub/burn。教程交付请 exportMp4=true。返回含 dubbed/burned/bytes/originalPath；禁止 glob 查找 *-narrated/*-burned。长文本控制 cues 数量。cues：优先用 stop 返回的 timeline 转 startMs+旁白文案。

`screen_record_stop`：补充「成功含 timeline[]」。

`screen_record_pause` / `resume` / `start`：按设计 §4 追加教程约定一句。

**Step 3: 跑测**

```bash
cd apps/windows && npx vitest run src/main/agent-runtime/bridge-screen-record-tools.test.ts src/main/screen-record
```

**Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(screen-record): 注册 mark/inspect 并修正教程相关工具描述

EOF
)"
```

---

### Task 5：文档交叉链接 + 验收清单

**Files:**
- Modify: `docs/design/2026-08-16-screen-record-tutorial-pipeline-design.md` — 状态改为「实施中/已实施」  
- Modify: `docs/design/2026-08-15-screen-record-phase2-design.md` — 文末加「参见教程流水线设计」  
- Modify: `docs/design/2026-08-15-screen-record-subtitle-editor-design.md` — 同上（可选）

**手工验收（dev 下 Agent 或人工工具调用）：**

1. start → mark「A」→ pause →（等待）→ resume → mark「B」→ stop  
2. 断言 `timeline[0].atMs < timeline[1].atMs`，且 pause 间隙未拉大 B  
3. narrate(cues from timeline, exportMp4=true)  
4. 返回 `dubbed: true`，`path`/`mp4Path` 存在，`message` 可读；**不要**再搜 `*-narrated`  
5. inspect(path) 显示 hasOriginal / ttsCount  

**Commit:**

```bash
git commit -m "$(cat <<'EOF'
docs(screen-record): 教程流水线设计状态与交叉链接

EOF
)"
```

---

## 明确延后（勿在本计划实施）

- `apps/windows/bundled-skills/视频创作/screen-tutorial-pipeline/SKILL.md`  
- UI / preload 暴露 mark  
- `app_act` autoMark  

调通并完成 Task 5 手工验收后，另开设计/计划写 Skill。

---

## 手工验收清单（Task 5）

开发环境重启后（或热重载工具注册）：

1. `screen_record_start` → `mark(label=A)` → `pause` → 等待 → `resume` → `mark(label=B)` → `stop`  
2. 断言 `timeline[0].atMs < timeline[1].atMs`，且 pause 间隙未拉大 B 的 atMs  
3. `screen_record_narrate(cues from timeline, exportMp4=true)`  
4. 返回 `dubbed: true`；优先 `burned: true`；有 `mp4Path` 或 `path` 为 `.mp4`；`message` 可读  
5. `screen_record_inspect(path)` 显示 `hasOriginal` / `ttsCount`  
6. **不要**再搜 `*-narrated` / 手写 ffmpeg  

成功标准：同类「录本机教程+字幕配音」任务不再出现「等 burned / 写 mix.sh」。

---

## 执行交接

Plan complete and saved to `docs/plans/2026-08-16-screen-record-tutorial-pipeline-implementation.md`.

**两种执行方式：**

1. **Subagent-Driven（本会话）** — 每 Task 开新子代理，Task 间复查，迭代快  
2. **Parallel Session（新会话）** — 新开会话用 executing-plans，按检查点批量推进  

你更想用哪一种？
