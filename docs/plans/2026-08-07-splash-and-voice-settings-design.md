# 启动 Splash 优化与语音设置下载（2026-08-07）

## 背景

1. 有开机视频时，窗口 `ready-to-show` 后 React 才挂 Splash，视频首帧前整屏深色底，体感黑屏过长。
2. 语音模型下载原先只在聊天页对话框触发，无法分项管理，也无暂停/续传。

## 本期实现

### 开机画面

- `early-splash.ts` 在 React 前注入海报 + 视频并开始播放
- `BrowserWindow.backgroundColor = #070d18`
- `SplashOverlay` 接管 early splash 的 ended/error，或回退自管视频
- `prepare-splash.cjs` 同步产出 `splash-poster.jpg`

### 语音模型下载（设置 → 语音设置）

- VAD / ASR(Paraformer) / TTS(VITS) 分项下载
- 进度、暂停、继续、取消；HTTP Range 断点续传（`.partial`）
- Edge TTS 通话仅需 VAD+ASR；本地 VITS 需先下载才可选
- 聊天缺模型：toast「请先在设置中下载语音模型」+「去设置」

### ASR 实时测试

- `voice:asr:test:start|stop`，不拉起 Agent
- 设置页试麦：伪流式中间结果 + VAD 端点最终句

## 后续规划（未实现）

- **Qwen3-TTS**：用户可选模型变体下载，与现有 VITS/Edge 并列切换
- **声音克隆**：基于选定离线 TTS 引擎的克隆流程与素材管理
- 可选：增加魔搭（ModelScope）作为国内优先下载源

## 关键路径

- Splash：`early-splash.ts`、`SplashOverlay`、`index.html`、`main/index.ts`、`prepare-splash.cjs`
- 下载：`model-manager.ts`、`voice-ipc.ts`、`voice-commands.ts`、`voice-events.ts`
- UI：`VoiceModelsPanel`、`AsrLiveTestPanel`、`SettingsPage`
- 引导：`useVoiceCall`、`App.tsx`、移除 `VoiceModelDownloadDialog`
