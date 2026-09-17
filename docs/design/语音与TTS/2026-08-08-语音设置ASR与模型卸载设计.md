# 语音设置：ASR 手动测试、麦克风音量与模型卸载（2026-08-08）

## 背景

1. 语音设置中 ASR 识别测试在 VAD+ASR 模型就绪后会**自动开麦**，进入页面即开始识别，干扰用户、也浪费权限/资源。
2. 缺少麦克风音量反馈，难以判断麦克风是否正常收音。
3. 模型与依赖支持下载/暂停/取消，但**已就绪项无法卸载**，无法释放磁盘或强制重装。
4. 合成语音「测试文案」输入使用带外层容器的 `Input`，视觉上出现「框中框」。

## 目标

- ASR 测试仅在用户点击「开始 ASR 测试」后启动；离开或停止时释放麦克风与会话。
- 测试进行中显示实时麦克风音量条，用于判断收音是否正常。
- 所有可下载项（模型 + 运行时依赖，含 PyTorch）在已就绪时可卸载。
- 合成测试文案输入改为单层输入框。

## 方案（已确认）

采用**最小改动、复用现有面板**（方案 1），不新建独立试麦页或安装管理中心。

### 1. ASR 识别测试交互

**行为**

- 进入语音设置 / 模型就绪后**不再自动开麦**（移除 `AsrLiveTestPanel` 中基于 `autoStartTriedRef` 的自动 `start()`）。
- 仅点击「开始 ASR 测试」才：`voice:asr:test:start` → `getUserMedia` → Worklet 推 PCM。
- 测试中显示「停止」；点停止或面板卸载时 `stop()`，释放麦与主进程会话。
- 提示文案改为：需手动点击后才开始识别。

**按钮文案**

| 状态 | 文案 |
|------|------|
| 未测过 / 已停止且未测过 | 开始 ASR 测试 |
| 测过后停下 | 重新开始 |
| 进行中 | 停止 |

**麦克风音量（仅测试进行中，选项 A）**

- 在现有采麦 `AudioContext` 上串联 `AnalyserNode`，按 RMS/峰值映射 0–100。
- 测试中在工具栏旁显示水平音量条（可带数值）。
- 未测试时不占麦、不显示音量条。
- 有环境声/说话时条走动，可判断麦克风是否正常。

**主要改动文件**

- `apps/windows/src/renderer/pages/SettingsPage/components/AsrLiveTestPanel/index.tsx`
- `apps/windows/src/renderer/pages/SettingsPage/components/AsrLiveTestPanel/AsrLiveTestPanel.module.css`

### 2. 模型 / 依赖卸载

**范围（选项 C）**

语音设置里所有可下载项均可卸载，包括：

- `asr-core`：Silero VAD、Paraformer ASR
- `tts-synth`：VITS、Qwen3 Tokenizer、CustomVoice、PyTorch CUDA 运行时等
- `tts-clone`：Qwen3 Base 等克隆模型

克隆音色档案仍走现有 `voice:profiles:delete`，不与模型卸载混用。

**UI**

- `VoiceModelsPanel`：已就绪卡片增加「卸载」按钮。
- 二次确认：「确定卸载 xxx？将删除本地文件，可稍后重新下载。」
- 卸载中禁用同卡片其它操作，文案如「卸载中…」；完成后回到「未下载」。

**主进程**

新增命令 `voice:models:uninstall`（经现有 `voice.sendCommand`）：

1. 若正在下载 → 先取消再删。
2. 删除模型目录及临时/断点文件（含 `.partial`、不完整目录）。
3. 运行时类（如 `runtime-pytorch-cu121`）走对应卸载（如 `pip uninstall` + 清本地标记/目录）。
4. 广播 `voice:models:status`，UI 刷新。

**安全**

- 若正用于 ASR 测试 / TTS 预览：先停会话再卸，或提示「请先停止测试」。
- 卸载失败返回可读错误，不静默吞掉。

**主要改动文件**

- Shared：`voice-commands.ts`、必要时 `voice-events.ts`
- Main：`model-manager.ts`、`voice-ipc.ts`
- UI：`VoiceModelsPanel/index.tsx`（及样式）
- Preload：若仍走统一 `sendCommand`，通常无需改

### 3. 合成测试输入「框中框」

- 位置：设置 → 语音设置 → 语音合成 →「测试文案（最多 100 字）」。
- 原因：`Input` 组件外层 `.input-container` 有边框，叠加内层原生 `input` 的视觉层次，呈套娃感。
- 修复：该处改为单层控件（原生 `input`/`textarea` + 设置页样式，或去掉双层边框），保留 `maxLength={100}` 与预览逻辑。

**主要改动文件**

- `apps/windows/src/renderer/pages/SettingsPage/SettingsPage.tsx`
- 必要时 `SettingsPage.module.css`

## 非目标

- 不单独做「试麦」页或全局麦克风监测（未点 ASR 测试不开麦）。
- 不重构整个语音下载架构；不新建安装管理中心。
- 不改变克隆档案 CRUD 协议。

## 验收标准

1. 进入语音设置且模型已就绪时**不开麦**；点击「开始 ASR 测试」后才识别，并出现音量条；停止后麦释放、音量条消失。
2. 各已就绪可下载项（含运行时）有「卸载」；确认后删除本地文件，状态回未下载，可再次下载。
3. 合成测试文案输入视觉上只有一层框，字数限制与预览仍正常。

## 实现顺序建议

1. ASR：去自动开麦 + 测试中音量条  
2. 卸载：命令类型 → `model-manager.uninstall` → IPC → UI 按钮与确认  
3. 合成测试输入单层化  
4. 手工验收上述三条  

详细任务拆分见同主题 implementation 计划（实现前另行编写）。
