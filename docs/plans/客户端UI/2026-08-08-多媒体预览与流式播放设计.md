# Windows 客户端多媒体预览与流式播放设计

> 日期：2026-08-08  
> 范围：`FilePreviewModal` 音视频预览、会话/工作区入口对齐、本地媒体流式协议  
> 状态：设计已确认，待实施计划

## 目标

让 Windows 客户端能**可靠预览并播放常见音视频**，且**大文件走流式**，不再受现有预览通道「整文件 ≤10MB + base64」限制。

成功标准：

1. 工作区文件树、会话文件列表、聊天附件 chip、独立预览窗均可打开同一套预览。
2. 常见格式（mp3 / wav / ogg / m4a、mp4 / webm 等 Chromium 可解码格式）可应用内播放，支持进度条拖拽 seek。
3. 数十 MB～数百 MB 级本地媒体可播，不把整文件读入渲染进程内存。
4. 播不了的格式有明确提示，并可一键「用系统应用打开」。

## 非目标

- ffmpeg / 外挂解码 / 转码（mkv、avi、部分 flac 等仍依赖系统播放器）。
- 聊天气泡内联播放器。
- 新建独立 FilesPage。
- 改动 A2UI 的 `AudioPlayer` / `VideoPlayer`（本阶段不抽共享组件；若 UI 需对齐可后置）。
- 提高文本 / Office / PDF 的 10MB 预览上限（仅媒体走新通道）。

## 方案选择

采用 **自定义特权协议 `lumii-media:` + 统一 `FilePreviewModal`（方案 1）**。

| 方案 | 做法 | 结论 |
|------|------|------|
| **1. 自定义协议（选用）** | 主进程 `protocol.handle('lumii-media', …)`，支持 Range；`<audio>`/`<video>` 直接用协议 URL | 真正流式、可 seek、边界可控 |
| 2. 本机 HTTP 服务 | localhost 吐媒体 | 端口冲突与生命周期成本高，不采用 |
| 3. IPC 分块拼 Blob | 渲染层拼 Blob URL | 大文件仍吃内存，seek 差，不采用 |

用户确认的约束：

- 能力档位：**B**（入口打通 + 大文件流式）。
- 入口范围：**A**（只增强现有预览通路，不内联气泡）。
- 失败回退：**A**（提示 + 系统应用打开）。

---

## 1. 架构总览

```
┌─ Renderer ──────────────────────────────────────────────┐
│  SessionFileList / WorkspaceFilePanel / ChatMessage     │
│  / FilePreviewWindowApp                                 │
│                         │                               │
│                         ▼                               │
│                  FilePreviewModal                       │
│         ┌───────────────┴───────────────┐               │
│         │ audio/video                   │ 其它类型      │
│         ▼                               ▼               │
│  lumii-media://preview?...     files:read-preview-*     │
│  <audio>/<video controls>      (≤10MB，现有逻辑)         │
└─────────┬───────────────────────────────────────────────┘
          │
          ▼
┌─ Main ──────────────────────────────────────────────────┐
│  protocol.handle('lumii-media')                         │
│    1. 解析 fileId | path                                │
│    2. 解析真实路径 + 授权校验（workspace / FileRepo）     │
│    3. 支持 Range → 返回 206 + 文件流                     │
│  files:open / 新增 path 打开 → shell.openPath           │
└─────────────────────────────────────────────────────────┘
```

原则：

- **媒体与文档分流**：音视频只走 `lumii-media:`；图片/PDF/Office/代码仍走 `files:read-preview-content` / `files:read-preview-by-path`。
- **单一预览壳**：不新增页面；所有入口继续打开 `FilePreviewModal`（含 `variant=window`）。
- **安全默认拒绝**：协议只服务已授权本地路径，禁止任意盘符直读。

---

## 2. 协议设计：`lumii-media:`

### 2.1 注册时机与特权

- 在 `app.whenReady()` **之前**调用 `protocol.registerSchemesAsPrivileged`：
  - `scheme: 'lumii-media'`
  - `privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }`
    - `bypassCSP` 仅用于让 `<video>`/`<audio>` 能加载自定义协议资源；协议 handler 自身仍做路径鉴权。
- 在 `app.whenReady()` **之后** `protocol.handle('lumii-media', handler)`。
- 落点建议：新建 `apps/windows/src/main/media-protocol.ts`，由 `main/index.ts` 引入注册；避免继续膨胀入口文件。

### 2.2 URL 形态

```
lumii-media://preview?fileId=<id>&agentId=<agentId>
lumii-media://preview?path=<urlencoded-abs-or-rel-path>&agentId=<agentId>
```

约定：

| 参数 | 说明 |
|------|------|
| `fileId` | FileRepo 中的文件 ID；与 `path` 二选一，优先 `fileId` |
| `path` | workspace 相对路径或绝对路径（须通过边界检查） |
| `agentId` | 可选；用于解析对应 bridge 的 cwd / FileRepo。缺省时用当前默认 Agent 实例 |

渲染层拼 URL 时对 `path` 做 `encodeURIComponent`。独立预览窗与主窗共用同一协议。

### 2.3 Handler 行为

1. **解析**：从 `request.url` 取 query；非法参数 → `400`。
2. **解析真实路径**：
   - `fileId` → `bridge.fileRepo.findById` → `path.resolve(cwd, localPath)`；缺失则 `404` 并 markMissing。
   - `path` → resolve 后校验位于 `cwd` 内（与 `files:read-preview-by-path` 相同规则）。
3. **类型与存在性**：目录 / 不存在 → `404`；非常规文件 → `400`。
4. **MIME**：复用 / 抽出 `inferPreviewMimeFromFileName`（与 IPC 预览表一致）；未知则 `application/octet-stream`。
5. **Range**：
   - 无 `Range` → `200`，`Content-Type`、`Content-Length`、`Accept-Ranges: bytes`，body 为可读流。
   - 有 `Range: bytes=start-end` → `206`，`Content-Range`，按区间 `createReadStream({ start, end })`。
   - 非法 Range → `416`。
6. **并发**：允许多个 Range 请求（拖拽 seek）；流在请求 abort 时 destroy。

### 2.4 安全边界

- 仅 `fileId`（经 FileRepo）或 workspace 内 `path`；禁止 `..` 逃逸出 cwd。
- 不开放 `~/.lumii` 任意路径，除非该路径恰好是当前 Agent cwd / FileRepo 已登记文件。
- 不在协议 URL 中携带 secret；`agentId` 仅为实例路由，不做鉴权令牌。
- CSP：若现有 CSP 拦截媒体，在 `setupContentSecurityPolicy` 中为 `media-src` 增加 `lumii-media:`（精确到该 scheme，不放宽 `*`）。

### 2.5 大小策略

| 通道 | 上限 |
|------|------|
| `files:read-preview-*`（文档/图等） | 维持 **10MB** |
| `lumii-media:` | **无应用层硬上限**；受磁盘与 Chromium 解码能力约束。可选软提示：例如 >2GB 时 Modal 文案建议用系统播放器（不强制拦截） |

---

## 3. 渲染层：`FilePreviewModal` 改造

### 3.1 加载分流

当前：凡预览都 `sendCommand(files:read-preview-*)`，音视频再 `buildMediaBlobUrl`。

改为：

1. 打开 Modal 时已知 `fileName` / 扩展名（及可选 mime）。
2. 若判定为 **audio / video**：
   - **不调用** `files:read-preview-*` 拉内容。
   - 可选轻量元数据：文件名、size（可从列表已有字段，或新增极轻量 `files:stat-preview`；**首版可用列表侧已有 size，缺省则播放器不显示大小**）。
   - `mediaSrc = buildLumiiMediaUrl({ fileId, filePath, agentId })`。
   - 渲染 `<audio controls src={mediaSrc}>` 或 `<video controls src={mediaSrc}>`。
3. 其它类型：保持现有 `files:read-preview-*` 流程。

路由判定：抽出与主进程一致的扩展名/MIME 表（或 shared 常量），避免仅依赖 IPC 返回的 mime（会话文件常为 `null`）。

### 3.2 UI

- 继续使用原生 `controls`（首版不重做播放器皮肤）。
- 布局：视频居中、最大高度适配 Modal；音频全宽进度条。
- 加载态：媒体用 `onWaiting` / 首帧前 skeleton，避免误用「读文件 loading」整页转圈过久。
- 删除 `buildMediaBlobUrl` 在预览主路径上的使用（可保留短暂兼容或直接移除）。

### 3.3 播放失败回退

监听 `onError`（及必要时 `MEDIA_ERR_SRC_NOT_SUPPORTED`）：

1. 展示文案：「当前格式无法在应用内播放，请使用系统应用打开。」
2. 主按钮：**用系统应用打开**（见 §4）。
3. 次要：在资源管理器中显示（若已有 `showItemInFolder` 能力则复用）。

对**明确低成功率**扩展名（如 `.mkv` / `.avi` / `.flac`，以实测 Electron 版本为准）可在进入播放前显示弱提示「可能无法应用内播放」，但仍先尝试；失败再走强提示。不做黑名单直接禁播（避免误杀可播封装）。

### 3.4 独立预览窗

`FilePreviewWindowApp` 已复用 Modal：只要 Modal 改用协议 URL，独立窗自动受益。确认预览窗 `webPreferences` 与主窗一样能加载 `lumii-media:`（同源特权注册为 app 级即可）。

---

## 4. 「用系统应用打开」补齐

现状：`handleOpen` 仅 `fileId` → `files:open`；`filePath` 模式留空。

改造：

| 模式 | 行为 |
|------|------|
| `fileId` | 保持 `files:open` → `shell.openPath` |
| `filePath` | 新增命令或扩展现有命令，例如 `files:open-by-path`：workspace 边界校验后 `shell.openPath(absPath)` |

错误时把失败原因展示给用户（路径无效 / 系统无关联程序等）。

---

## 5. 入口对齐

### 5.1 `SessionFileList.isPreviewable`

扩展白名单，与预览路由一致：

- MIME：`audio/*`、`video/*`
- 扩展名：`mp3` `wav` `ogg` `flac` `aac` `m4a` `opus` `weba` `mp4` `webm` `mkv` `avi` `mov` `m4v` `ogv` `3gp` 等（与 `inferPreviewMimeFromFileName` 对齐）

可预览时打开 `FilePreviewModal`（`fileId`）；不可预览仍走系统打开。

### 5.2 其它入口

| 入口 | 现状 | 动作 |
|------|------|------|
| Workspace 文件树 | 已可开 Modal | 无逻辑变更；受益于流式 |
| 聊天附件 chip | 已 `onPreview` → Modal | 确认扩展名可路由到 audio/video |
| 独立预览窗 | 复用 Modal | 自动受益 |
| MIME 推断 | IPC 已含音视频映射 | 抽出 shared，供 SessionFileList / Modal / 协议共用，消除漂移 |

### 5.3 可选：导入/元数据

`file-memory-handler.guessMimeType` 等若仍缺音视频，按同一张表补全，避免会话列表 `mimeType=null` 仅靠扩展名（扩展名已是兜底）。**非阻塞**；首版以扩展名白名单为准即可。

---

## 6. Shared 常量与类型

建议新增（或并入现有 shared）：

- `apps/windows/src/shared/media-preview.ts`（命名可调整）
  - `MEDIA_AUDIO_EXTS` / `MEDIA_VIDEO_EXTS`
  - `inferMediaMimeFromFileName(fileName): string | null`
  - `isMediaPreviewable(mime, fileName): boolean`
  - `isAudioPreviewRoute` / `isVideoPreviewRoute`

主进程协议与 IPC 的 `inferPreviewMimeFromFileName` **应调用同一来源**（IPC 内现有大表可逐步委托 shared，至少音视频段与 shared 同步）。

Preload：**协议 URL 由渲染层直接拼字符串即可**，一般不必新增 IPC；若需 token 化路径可后置，首版不做。

---

## 7. 数据流（典型场景）

### 7.1 会话中的 mp4（fileId，200MB）

1. 用户在 SessionFileList 点击预览 → `canPreview=true`。
2. Modal 判定 video → `src=lumii-media://preview?fileId=...`。
3. Chromium 请求协议；可能带 `Range: bytes=0-`。
4. 主进程 FileRepo 解析路径，返回 206/200 流。
5. 用户拖拽进度条 → 新的 Range 请求 → seek 成功。

### 7.2 工作区 wav（filePath）

1. 文件树打开 Modal（`filePath`）。
2. `src=lumii-media://preview?path=...`。
3. Handler 校验 cwd 边界后流式返回。

### 7.3 不支持的 avi

1. Modal 仍尝试 `<video src=lumii-media://...>`。
2. `onError` → 提示 +「用系统应用打开」→ `files:open` / `files:open-by-path`。

---

## 8. 错误处理

| 场景 | 表现 |
|------|------|
| 路径越界 / 无 fileId | 协议 `403`/`404`；Modal 显示「无法预览该文件」 |
| 文件已删 | `404` + 文案；FileRepo markMissing |
| 解码失败 | 应用内提示 + 系统打开 |
| 协议未注册（开发态失误） | Modal 捕获 media error，提示重启/升级 |
| 文档类超 10MB | **不变**：truncated 提示（与媒体分流无关） |

---

## 9. 测试计划

### 单元 / 组件

- `isMediaPreviewable` / 扩展名 MIME 表：音视频正例、文档负例。
- `SessionFileList`：`mp3`/`mp4` 显示预览入口。
- URL 拼装：path 含中文与空格时 encode 正确。

### 主进程

- 协议 handler：无 Range / 有 Range / 非法 Range / 越界 path / 缺失 fileId。
- `files:open-by-path`：cwd 内成功、cwd 外拒绝。

### 手工 / 集成（Windows）

| 用例 | 期望 |
|------|------|
| <10MB mp3 | 应用内可播 |
| >50MB mp4 | 可播、可 seek，内存无明显整文件尖峰 |
| webm / wav / m4a | 可播 |
| mkv 或 avi（本机 Chromium 不支持时） | 提示 + 系统打开成功 |
| 工作区路径预览 | 与 fileId 行为一致 |
| 独立预览窗 | 可播 |
| 关闭 Modal | 媒体停止（卸载 DOM 即可；无需强制 revoke blob） |

---

## 10. 实施顺序（建议）

1. **Shared 媒体表 + SessionFileList 白名单**（立刻打通入口；短时仍可走旧 base64，仅小文件）。
2. **注册 `lumii-media:` + Range handler + CSP `media-src`**。
3. **FilePreviewModal 媒体分流**到协议 URL；移除媒体 base64 路径。
4. **`files:open-by-path` + Modal 失败回退 UI**。
5. **测试与手工验收**；按需整理 MIME 推断到 shared。

每步可独立验证；第 2–3 步是流式能力的关键路径。

---

## 11. 风险与对策

| 风险 | 对策 |
|------|------|
| Electron/Chromium 编码覆盖有限 | 文档与 UI 明确「常见格式」；失败回退系统播放器 |
| CSP / webview 拦截自定义协议 | 注册特权 + 精确放宽 `media-src` |
| 路径鉴权漏洞 | 与现有 preview-by-path 同一套 resolve + prefix 检查；单测覆盖 `..` |
| 超大文件拖垮解码 | 可选 >2GB 软提示；不做转码 |
| IPC mime 表与 UI 漂移 | shared 单一来源 |

---

## 12. 代码落点清单

| 区域 | 路径（预期） | 变更 |
|------|----------------|------|
| 协议 | `main/media-protocol.ts`（新）+ `main/index.ts` 注册 | 特权 scheme + handler |
| CSP | `main/index.ts` `setupContentSecurityPolicy` | `media-src` 含 `lumii-media:` |
| IPC | `agent-runtime-ipc.ts` + `agent-runtime-commands.ts` | `files:open-by-path`；MIME 可委托 shared |
| Shared | `shared/media-preview.ts`（新） | 扩展名/MIME/可预览判定 |
| Modal | `FilePreviewModal.tsx` (+ css) | 媒体分流、错误回退、系统打开 |
| 入口 | `SessionFileList/index.tsx` | `isPreviewable` 对齐 |
| Preload | 通常无强制变更 | 若 open-by-path 走 agentRuntime.sendCommand 则类型已随 commands 更新 |
| 测试 | `src/test/...`、主进程单测 | 白名单、协议 Range、越界 |

---

## 附录：已确认决策摘要

| 项 | 决策 |
|----|------|
| 能力档位 | B：入口 + 流式大文件 |
| 入口 | A：统一 FilePreviewModal |
| 失败 | A：提示 + 系统应用打开 |
| 传输 | 自定义 `lumii-media:` + Range |
| 不做 | 转码、气泡内联、FilesPage、抬高非媒体 10MB 上限 |
