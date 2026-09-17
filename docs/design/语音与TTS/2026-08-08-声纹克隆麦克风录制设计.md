# 声音克隆：麦克风朗读录制样本（2026-08-08）

## 背景

设置页「我的音色（声音克隆）」目前只支持通过系统对话框选择本地参考音频，并手填转写文本（`VoiceProfilesPanel`）。Qwen3 Base 克隆需要约 ≥3 秒清晰人声 + 对应 `refText`（ICL）。用户希望在应用内用麦克风照着固定文案朗读，把录音保存为克隆样本，再走现有「保存音色」入库流程。

既有能力：

- 档案存储：`VoiceProfileStore.upsert` 接受绝对路径 `refAudioPath`，拷贝到 `~/.lumii/voice/profiles/<id>/`
- 开麦先例：`AsrLiveTestPanel` / `useVoiceCall` 已用 `getUserMedia` + AudioWorklet；本功能**不**走 ASR，只采样本文件
- 主进程已有 `os.tmpdir()` 写文件先例（如 `voice:tts:generate-file`）

## 目标与非目标

### 目标

- 在「创建音色」区增加「麦克风录制」入口：展示固定推荐文案 → 开麦 → 用户朗读 → 手动停止 → 写入临时音频文件
- 停止后自动填入 `refPath` 与 `refText`（固定文案），用户可预听 / 重录，再点「保存音色」走现有 upsert
- 保留现有「选择参考音频」文件入口，二者互斥覆盖同一组表单字段
- 最短约 3 秒提示；录音中显示音量条与时长；权限失败有明确文案

### 非目标

- 自定义 / 多段可选朗读书（本期固定一段）
- 录完一键入库（仍需「保存音色」）
- 静音自动停、倒计时强制停
- 主进程系统级录音、改动 Qwen3 sidecar / 克隆推理
- 用 ASR 校验用户是否念对（信任固定文案 = refText）

## 产品约定（已确认）

| 项 | 选择 |
|----|------|
| 参考文本 | 固定推荐文案，自动作为 `refText` |
| 落盘时机 | 录完写临时文件，填路径；用户再点保存 |
| 结束方式 | 手动「停止」；最短约 3 秒提示 |

### 固定文案

建议中文一句，朗读自然时长约 4–8 秒：

> 你好，我是灵栖。今天天气不错，我们一起聊聊吧。

常量放在 renderer 侧（如 `CLONE_REF_PROMPT_ZH`），创建档案时直接写入 `refText`，用户不可编辑该字段在「录制路径」下（文件上传路径仍可手填转写，见下方 UI）。

## 架构

```
VoiceProfilesPanel
  ├─ 选文件：dialog → refPath；用户填 refText
  └─ 录制：getUserMedia + MediaRecorder
           → stop → Blob → base64/IPC
           → main voice:profiles:save-temp-ref
           → os.tmpdir()/lumii-voice-clone-*.{webm|wav}
           → 返回 path → 填 refPath + 固定 refText
                ↓
         现有 voice:profiles:upsert（拷贝入库）
```

### 技术方案（已选）

**Renderer `MediaRecorder` → IPC 写临时文件**，不复用 ASR PCM 管线，不引入主进程录音。

- MIME：优先 `audio/webm;codecs=opus`，其次 `audio/webm`；若均不可用则回退采集 PCM 并在 renderer 封装简易 WAV（16-bit mono），保证有一条可行路径
- `VoiceProfileStore` 已按扩展名拷贝（`ref.webm` / `ref.wav`）；Qwen3 sidecar 若仅稳吃 wav，则在 **save-temp 或 upsert 前** 用现有能力转 wav（优先：MediaRecorder 不可用时走 WAV；若 sidecar 实测吃 webm，则无需转码）。实现期以 sidecar 输入约束为准，默认目标产出 **wav**（PCM 回退或录完用 ffmpeg/现有解码转——YAGNI：先 wav PCM 路径最稳）

**推荐落地细化（实现默认）：**

1. 用 `AudioContext` + 已有 PCM Worklet（或 `ScriptProcessor` 仅作最后手段）收集 Float32 PCM
2. 停止时在 renderer 编码为 **16-bit mono WAV**（采样率取 AudioContext 实际值，常见 48k/44.1k）
3. 经 IPC 写入临时 `.wav`
4. 音量条复用 ASR 试麦同款 RMS→0–100 逻辑

理由：克隆样本格式与主进程 TTS/ASR 临时 wav 一致，避免 webm 依赖 sidecar 解码。

## UI（`VoiceProfilesPanel`）

在「音色名称」下方增加样本来源切换或并列操作：

1. **推荐朗读稿**（只读卡片）：展示固定文案 + 提示「请用自然语速朗读，建议不少于 3 秒」
2. **开始录制 / 停止录制**
   - 录制中：禁用选文件与保存；显示时长 `mm:ss`、麦克风音量条；文案「正在录音…」
   - 时长 &lt; 3s 点停止：toast/行内错误「录音太短，请至少录制 3 秒」，不写文件、保持可继续录或重开
3. **录制完成态**：显示文件名（如 `lumii-voice-clone-xxx.wav`）+「预听」「重录」
   - 预听：`new Audio(file://…)` 或读回 blob URL（若仅有磁盘路径，可用 `file://` 或主进程读 base64；Electron 下优先已有文件预览能力，简单方案：停止前保留 blob URL 供预听，路径仅给 upsert）
4. **选择参考音频**：保持不变；选文件后清空录制 blob/预听状态，并恢复可编辑的转写输入
5. **转写文本**
   - 来源=录制：只读展示固定文案（或隐藏输入、保存时注入）
   - 来源=文件：保持现有可编辑 Input
6. 提示文案更新：补充「也可对着麦克风朗读下方文案录制样本」

样式：复用 `VoiceModelsPanel.module.css` / ASR 试麦音量条样式模式，避免新建设计体系。

## 数据与 IPC

### 新增命令

`voice-commands.ts`：

```ts
/** 将克隆参考音频写入临时目录，返回绝对路径 */
export type VoiceProfilesSaveTempRefCommand = {
  readonly type: 'voice:profiles:save-temp-ref'
  /** 原始音频字节的 base64 */
  audioBase64: string
  /** 扩展名，默认 wav */
  ext?: 'wav' | 'webm'
}
```

返回：`{ ok: true, filePath: string }` 或 `{ error: string }`。

### 主进程

`voice-ipc.ts`：`Buffer.from(audioBase64, 'base64')` 写入  
`path.join(os.tmpdir(), \`lumii-voice-clone-${randomUUID()}.${ext}\`)`。  
不做格式校验以外的业务；可选校验最小字节数防空文件。

### 表单状态

| 状态 | 说明 |
|------|------|
| `sampleSource: 'file' \| 'record'` | 当前样本来源 |
| `refPath` | 临时或用户所选绝对路径 |
| `refText` | 录制时锁定为常量；文件时用户输入 |
| `recording` / `elapsedMs` / `micLevel` | 录制中 UI |
| `previewUrl` | 可选，本地 blob URL，卸载时 revoke |

保存成功后：清空临时预览、重置录制态；临时文件可留在 tmp（OS 清理），不强制删。

## 错误处理

| 场景 | 处理 |
|------|------|
| 麦克风权限拒绝 | 「麦克风权限被拒绝，请在系统设置中允许后重试」 |
| 无输入设备 | 「未检测到麦克风」 |
| &lt;3s 停止 | 不落盘，提示过短 |
| 软上限（建议 30s） | 到达后自动 stop 并落盘（仍算手动流程的安全阀，非倒计时产品） |
| IPC 写盘失败 | 展示 error，保留可重录 |
| 保存时无路径 / 无文案 | 沿用现有校验 |

## 测试

- **单元**：WAV 编码工具函数（header + PCM 长度）；不足 3s 不调用 save-temp（可用 vitest 测纯函数）
- **组件**：`VoiceProfilesPanel` — 录制路径下 refText 为固定文案；选文件后转写可编辑（mock `getUserMedia` / electronAPI）
- **主进程**：`voice:profiles:save-temp-ref` 写出可读文件且 upsert 可拷贝（扩展现有 `voice-profile-store.test.ts` 或 ipc 测）
- **手工**：设置页开录 → 念稿 → 停 → 预听 → 保存 → 启用克隆出声试听

## 文件改动面（预估）

| 文件 | 变更 |
|------|------|
| `VoiceProfilesPanel/index.tsx` (+ 可选 css) | 录制 UI 与流程 |
| 可选 `encode-wav.ts` / `clone-ref-prompt.ts` | WAV 编码 + 固定文案常量 |
| `voice-commands.ts` | 新命令类型 |
| `voice-ipc.ts` | save-temp-ref 处理 |
| `preload` / `ElectronAPI` | 若 voice 已是通用 `sendCommand`，可能无需改 preload |
| 测试文件 | 如上 |

## 风险与缓解

- **采样率**：克隆对 16k/24k/48k 通常可接受；若 sidecar 有硬性要求，在 upsert 或 sidecar 侧重采样（本期先原样 wav）
- **环境噪声**：文案提示安静环境；不做 DSP
- **与通话同时开麦**：设置页录制时若正在语音通话，提示先结束通话或直接 getUserMedia 冲突时报错（实现时检测简单：捕获 Overconstrained/NotReadable）

## 验收标准

1. 用户可不选文件，仅靠麦克风朗读固定文案完成「保存音色」
2. 录制样本 ≥3s 才可写入临时路径；保存后档案 `refText` 等于固定文案
3. 文件上传路径行为与现网一致
4. 权限失败、过短、写盘失败均有可见错误，不产生坏档案
