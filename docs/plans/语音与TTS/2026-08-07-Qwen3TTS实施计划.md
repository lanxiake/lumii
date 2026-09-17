# Qwen3-TTS 一期 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 一期落地魔搭下载 Tokenizer + 0.6B-Base、Python sidecar 合成/克隆、设置页音色档案，与 Edge/VITS 并列。

**Architecture:** ModelScope snapshot 下载到 `clientDataRoot/models/voice/tts/qwen3/`；主进程 `Qwen3Tts` 经 stdio JSON-RPC 调 sidecar；克隆档案在 `clientDataRoot/voice/profiles/`。

**Tech Stack:** Electron main、ModelScope SDK、`qwen-tts`、现有 voice IPC

---

### Task 1: 扩展 VoiceTtsConfig 类型

**Files:** `apps/windows/src/shared/voice-events.ts`, `voice-commands.ts`

- provider 增加 `'qwen3'`
- 增加 `qwen3Variant`, `qwen3ProfileId`, `language`（TTS）
- 增加 profile CRUD 命令类型与事件（如需）

### Task 2: ModelScope snapshot + catalog

**Files:** `modelscope_voice_download.py`, `modelscope-downloader.ts`, `model-manager.ts`

- snapshot 整库下载
- 条目：tokenizer + 0.6b-base（1.7b 可 catalog 预留但 UI 二期）
- `baseDir` → `resolveWindowsClientDataRoot()/models/voice`，旧 userData 路径兼容检测
- `isTtsReady` / `areRequiredModelsReady` 支持 qwen3

### Task 3: 克隆档案 store

**Files:** `voice-profile-store.ts` + 单测

- CRUD meta + ref.wav 路径

### Task 4: Sidecar + Qwen3Tts

**Files:** `qwen3_tts_sidecar.py`, `qwen3-tts-client.ts`, `tts-engine.ts`, `voice-service.ts`

- JSON-RPC：load / synthesize / health
- createTtsProvider case `qwen3`

### Task 5: IPC + preload + Settings UI

**Files:** `voice-ipc.ts`, preload, `SettingsPage`, 可选 `VoiceProfilesPanel`

### Task 6: 缺模型引导与验证

- micless/通话/预览对 qwen3 就绪判断
- vitest 覆盖 catalog 就绪与 profile store
