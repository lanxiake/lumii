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
- **下载源优先级**（国内加速）：
  1. VAD/ASR：ModelScope 官方 Python SDK（`model_file_download`，见 [魔搭下载文档](https://www.modelscope.cn/docs/models/download)）
  2. TTS：hf-mirror 多文件直链（`csukuangfj/vits-zh-aishell3`）
  3. 回退：GitHub Releases + `gh.ddlc.top` / `gh-proxy.com` 等镜像
- 辅助脚本：`assets/scripts/modelscope_voice_download.py`（随包；首次会 pip 安装 `modelscope`）
- Edge TTS 通话仅需 VAD+ASR；本地 VITS 需先下载才可选
- 聊天缺模型：toast「请先在设置中下载语音模型」+「去设置」

### ASR 实时测试

- `voice:asr:test:start|stop`，不拉起 Agent
- 设置页试麦：伪流式中间结果 + VAD 端点最终句

## 后续规划

Qwen3-TTS / 声音克隆的调研与设计已单独成文，见：

- [2026-08-07-qwen3-tts-voice-clone-design.md](./2026-08-07-qwen3-tts-voice-clone-design.md)

要点：魔搭优先下载；一期落地 `0.6B-Base` + Python sidecar；模型与克隆档案存 `clientDataRoot`；与 VITS/Edge 并列；1.7B / 量化轻量档为二期。

## 关键路径

- Splash：`early-splash.ts`、`SplashOverlay`、`index.html`、`main/index.ts`、`prepare-splash.cjs`
- 下载：`model-manager.ts`、`voice-ipc.ts`、`voice-commands.ts`、`voice-events.ts`
- UI：`VoiceModelsPanel`、`AsrLiveTestPanel`、`SettingsPage`
- 引导：`useVoiceCall`、`App.tsx`、移除 `VoiceModelDownloadDialog`
