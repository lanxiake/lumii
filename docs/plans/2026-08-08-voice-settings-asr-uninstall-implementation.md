# 语音设置 ASR / 卸载 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** ASR 仅手动开测并显示麦量；可下载项支持卸载；合成测试输入去套娃框。

**Architecture:** 复用 `AsrLiveTestPanel` / `VoiceModelsPanel`；主进程新增 `voice:models:uninstall`，删除模型目录并对 PyTorch 走 pip 卸载。

**Tech Stack:** Electron + React + TypeScript；AudioContext AnalyserNode；现有 voice IPC。

---

### Task 1: ASR 手动测试 + 音量条

**Files:**
- Modify: `apps/windows/src/renderer/pages/SettingsPage/components/AsrLiveTestPanel/index.tsx`
- Modify: `apps/windows/src/renderer/pages/SettingsPage/components/AsrLiveTestPanel/AsrLiveTestPanel.module.css`

### Task 2: 卸载命令与主进程

**Files:**
- Modify: `apps/windows/src/shared/voice-commands.ts`
- Modify: `apps/windows/src/main/voice/model-manager.ts`
- Modify: `apps/windows/src/main/voice/qwen3-tts-client.ts`
- Modify: `apps/windows/src/main/voice/voice-ipc.ts`

### Task 3: VoiceModelsPanel 卸载 UI

**Files:**
- Modify: `apps/windows/src/renderer/pages/SettingsPage/components/VoiceModelsPanel/index.tsx`

### Task 4: 合成测试输入单层化

**Files:**
- Modify: `apps/windows/src/renderer/pages/SettingsPage/SettingsPage.tsx`
- Modify: `apps/windows/src/renderer/pages/SettingsPage/SettingsPage.module.css`
