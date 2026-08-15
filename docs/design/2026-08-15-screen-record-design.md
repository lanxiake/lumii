# 客户端录屏（AI 可控）— 设计

> 日期：2026-08-15  
> 状态：v0.1，设计已评审待实施  
> 产出目录约定：`docs/design/`  
> 相关：`bridge-app-ui-tools.ts`、`desktopCapturer`、`MediaRecorder`（语音克隆麦克风路径）、`client-data-root.ts`、`docs/design/2026-08-13-agent-app-ui-control-design.md`（曾将录屏标为 YAGNI，本设计单独立项覆盖）

---

## 0. 结论摘要

| 问题 | 结论 |
|------|------|
| 主目标 | **A**：产出可回放视频（教程/演示/存档）；B（AI 持续观察）、C（视频创作素材）留扩展位 |
| 录制范围 | **整屏 + 任意窗口**（含非 Lumii）；Lumii 自身只是窗口列表中的一项 |
| 音频 | 最终目标：画面 + 麦 + 系统声；**MVP 先做画面 + 麦克风** |
| 操作面 | **AI 工具 + 简易手动 UI**（非完整录屏工作台） |
| 确认策略 | 默认每次确认，可「始终允许」；**录 Lumii 自身免确认** |
| 落盘 | `~/.lumii/recordings/`（或 `LUMII_CLIENT_DATA_DIR` 下同名目录），**WebM**；MP4 转码二期 |
| 技术路线 | **方案 1**：主进程会话编排 + 渲染进程 `desktopCapturer` 源 ID + `MediaRecorder`；会话/工具 API 可换原生后端 |

---

## 1. 背景与范围

### 1.1 现状

| 已有 | 能做 | 做不到 |
|------|------|--------|
| `app_screenshot` | 截 Lumii 本窗 | 连续视频 |
| `browser_screenshot` | 截外部网页 | 系统任意窗口视频 |
| 语音克隆 `MediaRecorder` | 麦克风短音频 | 桌面/窗口画面 |
| App UI 控制设计 | 显式 YAGNI：录屏 | — |

### 1.2 MVP 必须交付

1. 列出显示器与窗口源，可开录、停录，得到本地 WebM。
2. 可选混入麦克风。
3. AI 通过四个工具全流程控制；人手可用简易面板/托盘救急。
4. 非自身源默认确认；自身免确认；可「始终允许」。

### 1.3 MVP 明确不做

- 系统声音、MP4、多路并发录制
- 无窗口后台长录 / 原生 Graphics Capture / ffmpeg 主路径
- 完整录屏历史库、时间线内嵌播放器（工具结果带路径即可）
- Computer Use 式实时看流（B 场景二期）

---

## 2. 架构

采用 **主进程会话编排 + 渲染进程采集编码**，与现有麦克风录音路径一致。

```
AI / 简易 UI
    │
    ▼
ScreenRecordService（main）
  · 状态机 · 源列表 · 确认策略 · 写盘 · IPC
    │
    ├─ desktopCapturer.getSources
    ├─ 监听 renderer webContents crashed/destroyed → 自动 finalize
    └─ 通知 renderer ScreenRecordCapture
            · getUserMedia(desktop sourceId)
            · getUserMedia(mic) 可选混轨（AudioContext 混流）
            · MediaRecorder → 分片 IPC 追加写文件
            · stream.ended → IPC 通知主进程 stream_ended
```

### 2.1 主进程 `ScreenRecordService`

- 单一活跃会话状态机：`idle → pending_confirm → recording → stopping → idle`
- `desktopCapturer.getSources({ types: ['screen', 'window'] })` 列源
- 识别 Lumii 自身：**主要依赖** `webContents.getMediaSourceId()` 与已知窗口 ID 比对，标题匹配仅作 fallback，源上标注 `isLumii: true`
- 落盘：`{getClientDataRoot()}/recordings/recording-<yyyyMMdd-HHmmss>.webm`（不含 sessionId，文件名简洁可读；sessionId 记录在内部日志）
- `start` 时预检磁盘可用空间，< 500 MB 直接返回 `insufficient_disk_space`，不开流
- 主进程持有 `fs.WriteStream` 文件句柄；监听 renderer `webContents.on('crashed')` / `destroyed`，确保 renderer 崩溃时仍能 finalize 已有分片
- 权限与设置：`alwaysAllow`、`includeMicDefault`、`confirmTimeoutSec`、可选总开关 `enabled`
- AI 工具与 UI **只调用 Service**，不直接碰 `MediaRecorder`

### 2.2 渲染进程 `ScreenRecordCapture`

- `start`：桌面流 `chromeMediaSource: 'desktop'` + `chromeMediaSourceId`；麦克风另开后用 `AudioContext.createMediaStreamSource` 混轨；`MediaRecorder`（webm，VP8 + Opus）
- 分片通过 IPC **流式追加**写文件（不在内存攒完整视频）；chunk interval 建议 2–5 s；单 chunk > 2 MB 时拆分再发，避免 IPC 阻塞
- 监听 `MediaStream` 的 `ended` 事件（目标窗口关闭时触发），通过 IPC 通知主进程触发 finalize，错误码 `stream_ended`
- 两路混轨存在轻微时间偏移（< 500 ms），MVP 接受此已知限制
- `stop`：finalize，回报 `path` / `durationMs` / `bytes`

### 2.3 AI 层

- 新建 `bridge-screen-record-tools.ts`（模式对齐 `bridge-app-ui-tools.ts`）
- 工具不感知采集实现，二期可换方案 2（主进程原生抓帧）而不改工具名

### 2.4 可替换边界

会话状态、确认、落盘路径、工具契约为稳定面；`ScreenRecordCapture` 为可替换实现。

---

## 3. AI 工具与权限

### 3.1 工具一览（MVP 四个）

| 工具 | 参数 / 返回 | 作用 |
|------|------------|------|
| `screen_record_list_sources` | 可选 `includeThumbnail?: boolean`（默认 **false**）；返回 `sourceId`、名称、类型、`isLumii` | 列出 screen/window；缩略图按需取，避免消耗大量 token（Base64 图片每张 10–50 KB） |
| `screen_record_start` | `sourceId`；可选 `includeMic`（默认 true）；可选 `maxDurationSec`（默认 1800，最大 7200；超过 7200 截断为 7200） | 开始录制；内部先重新验证 sourceId 仍然有效，再预检磁盘空间 |
| `screen_record_stop` | 无参数；返回 `{ ok, path, durationMs, bytes }` | 结束当前会话；在 `idle` 状态调用返回 `{ ok: false, error: 'no_active_session' }`（幂等，不视为异常） |
| `screen_record_status` | 返回 `{ status, sourceId, sourceName, elapsedMs, sessionId, pendingConfirm, confirmTimeoutSec }` | 查询当前状态，`pendingConfirm` 时 `confirmTimeoutSec` 告知 Agent 还剩多少秒可操作 |

### 3.2 确认策略

| 目标 | 行为 |
|------|------|
| Lumii 自身窗口 | **免确认**，直接进入 `recording` |
| 其他 screen/window | 默认弹确认（源名称 + 可选缩略图） |
| 用户勾选「始终允许录屏」 | 跳过确认（仍尊重总开关与系统麦克风权限） |
| 确认超时（默认 **120s**，可配置 `confirmTimeoutSec`） | `confirmation_timeout`，会话结束 |

AI 在 `pending_confirm` 时：`start` 返回 `{ ok: true, status: 'needs_confirmation', sessionId, confirmTimeoutSec }`，不无限阻塞 Agent。用户点允许后**同一 session 自动开录**；Agent 可用 `status` 轮询，或监听 IPC 事件。

### 3.3 安全与配额

- 同时仅一路录制；重复 `start` → `already_recording`
- 可选总开关，关闭后四工具一律 `disabled`
- 文件仅落在 `recordings/`；工具只返回本地路径，不上传
- `before-quit` 时若在录：flush finalize，避免坏文件

### 3.4 与截图工具的分工（系统提示）

- 演示/存档/教程素材 → 录屏工具
- 看界面细节、点选闭环 → 仍用 `app_screenshot` / `browser_screenshot`
- **禁止**用录屏代替截图观察

---

## 4. 简易 UI

不做完整录屏工作台。

### 4.1 入口

- 主窗口顶栏或设置旁录屏图标；录制中红点 + 计时
- 托盘：开始录屏 / 停止录屏；点「开始录屏」时若尚未选择源，**打开轻量面板**让用户先选源，不静默失败

### 4.2 轻量面板（Popover / 小抽屉）

- 源选择：显示器 + 窗口（可搜索）；Lumii 自身置顶并标注
- 「包含麦克风」开关（默认跟 `includeMicDefault`）
- 开始 / 停止；录制中显示时长
- 最近一条成片：路径 + 打开文件夹
- 「始终允许录屏」开关（与 AI 确认共用设置）

### 4.3 AI 触发确认弹窗

- 文案：AI 请求录制「{源名称}」
- 缩略图（若有，`list_sources` 时已按需拉取）
- 允许 / 拒绝；勾选「始终允许」
- 倒计时显示剩余秒数（`confirmTimeoutSec`）；超时未操作 → 拒绝，`status` 可见 `confirmation_timeout`

### 4.4 聊天时间线

MVP 不强制把视频嵌进气泡；`screen_record_stop` 工具结果带路径即可（后续可接多媒体预览）。

### 4.5 设置键

| 键 | 含义 |
|----|------|
| `screenRecord.enabled` | 总开关（默认 true） |
| `screenRecord.alwaysAllow` | 始终允许非自身源（默认 false） |
| `screenRecord.includeMicDefault` | 默认是否录麦（默认 true） |
| `screenRecord.confirmTimeoutSec` | AI 触发录屏的确认超时秒数（默认 120） |

---

## 5. 数据流（开录）

```
list_sources → 用户/AI 选 sourceId
     → start
         → 重新验证 sourceId 仍有效（重调 getSources）→ 失效则 source_unavailable
         → 磁盘预检（可用 < 500 MB）→ 不足则 insufficient_disk_space
         → 若需确认且未 alwaysAllow → pending_confirm → UI 弹窗（倒计时）
         → 允许或免确认 → 建 fs.WriteStream 文件句柄 → IPC 通知 renderer 开流
         → recording（分片追加，chunk 2–5s，单块 > 2 MB 自动拆分）
     → stop / maxDuration / quit / stream_ended（目标窗口关闭）/ renderer crash
         → stopping → finalize → idle
         → 返回 { path, durationMs, bytes }
```

---

## 6. 错误处理

工具统一返回 `{ ok: false, error, message }`（成功为 `{ ok: true, ... }`）。

| 场景 | error | 处理 |
|------|-------|------|
| 总开关关闭 | `disabled` | 直接返回 |
| 已有录制 | `already_recording` | 提示先 stop |
| stop 时无活跃会话 | `no_active_session` | 幂等返回，不视为异常 |
| sourceId 重验证失败 | `source_unavailable` | 重新 list_sources |
| 磁盘可用空间 < 500 MB | `insufficient_disk_space` | start 前即拒绝，不开流 |
| 麦克风被拒/占用 | `mic_unavailable` | **降级无声继续录**并提示，不整体失败 |
| 用户拒绝确认 | `permission_denied` | 结束会话 |
| 确认超时 | `confirmation_timeout` | 结束会话 |
| 目标窗口关闭（stream ended） | `stream_ended` | renderer IPC 通知主进程，自动 finalize 已有分片 |
| renderer 崩溃 | `capture_failed` | 主进程监听 `webContents crashed`，自动 finalize |
| 写盘失败 | `write_failed` | 停止并报错 |
| 停录后文件大小为 0 | `capture_failed` | 报错，删除空文件 |

**已知限制（MVP 文档化）**：
- 窗口最小化可能导致黑屏；用户说明中注明「录窗口时尽量保持可见」
- 多显示器下 `list_sources` 返回多个 screen 源，命名约定为 Electron 默认的 `Screen 1`/`Screen 2`；AI 应通过名称区分
- 两路混轨（画面 + 麦）存在 < 500 ms 的轻微时间偏移，MVP 接受此限制

---

## 7. 文件与模块落点（建议）

| 位置 | 职责 |
|------|------|
| `apps/windows/src/main/screen-record/screen-record-service.ts` | 状态机、源、确认、写盘 |
| `apps/windows/src/main/screen-record/screen-record-ipc.ts` | IPC 注册 |
| `apps/windows/src/main/agent-runtime/bridge-screen-record-tools.ts` | 四工具注册 |
| `apps/windows/src/shared/screen-record.ts` | 命令/事件/类型常量 |
| `apps/windows/src/preload/...` | ElectronAPI 同步暴露 |
| `apps/windows/src/renderer/.../ScreenRecordCapture` | MediaRecorder 采集 |
| `apps/windows/src/renderer/.../ScreenRecordPanel` | 简易 UI + 确认弹窗 |

三处同步原则：main handler、preload `ElectronAPI`、renderer 调用点。

---

## 8. 分期

| 期 | 交付 |
|----|------|
| **MVP** | 方案 1；整屏+窗口；画面+麦；四工具；简易 UI；确认策略；WebM → `recordings/` |
| **二期** | 暂停/继续；系统声；时间线预览；可选 MP4；窗口捕获体验加固（B1）；停录后 SRT+TTS 配音（默认烧字幕）。详见 `docs/design/2026-08-15-screen-record-phase2-design.md` |
| **三期** | 方案 2 原生后端（可替换采集）；服务 B（观察流）/ C（创作流水线深集成）；成片自动 ASR 转写字幕 |

---

## 9. 测试与验收

### 9.1 单测

- `screen-record-service.test.ts`：
  - 状态机基础流转（idle → recording → idle）
  - 重复 `start` 返回 `already_recording`
  - 两个快速 `start` 调用（并发保护）
  - `stop` 在 `pending_confirm` 状态：取消确认并回 idle
  - `stop` 在 `idle` 状态：返回 `no_active_session`（幂等）
  - 自身免确认 vs 需确认
  - 总开关关闭时四工具均 `disabled`
  - 确认超时（`confirmTimeoutSec` 后自动结束）
  - `before-quit` flush finalize
  - `webContents crashed` 触发自动 finalize
  - 磁盘预检（mock 返回 < 500 MB 时 start 拒绝）
  - sourceId 重验证（start 时源已消失 → `source_unavailable`）
- `screen-record-permission.test.ts`：`alwaysAllow`；Lumii 自身识别（主要靠 mediaSourceId，标题 fallback）
- `bridge-screen-record-tools.test.ts`：四工具名/参数/错误透传（mock Service）；`list_sources` includeThumbnail 默认 false；`start` maxDurationSec 超出 7200 截断

### 9.2 采集层

依赖浏览器媒体 API → mock；真实录制靠手测 / 后续 e2e。

### 9.3 MVP 验收清单

- [ ] 能录整屏与指定非 Lumii 窗口，得到可播放 WebM
- [ ] 能录 Lumii 自身且不弹确认
- [ ] 非自身源默认弹确认；始终允许生效；可撤销
- [ ] 麦克风开/关；麦失败时无声降级
- [ ] AI 四工具可完成 list → start → stop → 拿到路径
- [ ] list_sources 默认不返回缩略图；传 includeThumbnail: true 时返回
- [ ] start 时 sourceId 已失效立即返回 source_unavailable
- [ ] 磁盘空间不足时 start 前拒绝并提示
- [ ] 目标窗口录制中关闭时自动 finalize 并返回 stream_ended
- [ ] renderer 崩溃时主进程自动 finalize，文件可播放
- [ ] 简易 UI / 托盘可开始停止；录制中有状态指示
- [ ] 托盘点「开始录屏」无预选源时打开面板
- [ ] 文件落在 `{dataRoot}/recordings/`，文件名格式 `recording-<yyyyMMdd-HHmmss>.webm`
- [ ] stop 在 idle 状态幂等（不报错）

---

## 10. 开放扩展（非 MVP / 非二期）

- 区域裁剪 / 摄像头画中画（暂停与 TTS 旁白已升入二期）
- Agent 边录边根据关键帧做摘要（B）
- 成片自动进入视频创作 pipeline（C）
- 成片自动 ASR 转写字幕
- `recordings/` 自动清理策略（按文件数量上限或总目录大小阈值），避免长期使用占满磁盘
