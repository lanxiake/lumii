# 声音克隆麦克风录制 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在设置页「我的音色」支持用麦克风朗读固定文案，录成临时 WAV 作为克隆参考样本，再走现有保存流程。

**Architecture:** Renderer 采麦收集 PCM → 编码 16-bit mono WAV → IPC `voice:profiles:save-temp-ref` 写入 `os.tmpdir()` → 自动填 `refPath` + 固定 `refText` → 用户点「保存音色」走现有 upsert。不改 sidecar / 克隆推理。

**Tech Stack:** Electron + React + TypeScript、Web Audio API、vitest

**Design:** `docs/plans/2026-08-08-voice-clone-mic-record-design.md`

---

### Task 1: 固定文案常量 + WAV 编码纯函数（TDD）

**Files:**
- Create: `apps/windows/src/renderer/pages/SettingsPage/components/VoiceProfilesPanel/clone-ref-prompt.ts`
- Create: `apps/windows/src/renderer/pages/SettingsPage/components/VoiceProfilesPanel/encode-wav.ts`
- Create: `apps/windows/src/renderer/pages/SettingsPage/components/VoiceProfilesPanel/encode-wav.test.ts`

**Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { encodePcmToWav } from './encode-wav'
import { CLONE_REF_PROMPT_ZH, MIN_CLONE_RECORD_MS } from './clone-ref-prompt'

describe('encodePcmToWav', () => {
  it('写出合法 RIFF/WAVE 头且数据长度正确', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1])
    const buf = encodePcmToWav(samples, 48000)
    const view = new DataView(buf)
    expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe('RIFF')
    expect(String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11))).toBe('WAVE')
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(48000)
    expect(view.getUint16(34, true)).toBe(16) // bits
    expect(buf.byteLength).toBe(44 + samples.length * 2)
  })
})

describe('clone-ref-prompt', () => {
  it('导出非空中文文案与 3 秒阈值', () => {
    expect(CLONE_REF_PROMPT_ZH.length).toBeGreaterThan(10)
    expect(MIN_CLONE_RECORD_MS).toBe(3000)
  })
})
```

**Step 2: 运行确认失败**

Run: `cd apps/windows && npx vitest run src/renderer/pages/SettingsPage/components/VoiceProfilesPanel/encode-wav.test.ts`

**Step 3: 实现**

`clone-ref-prompt.ts`:
- `CLONE_REF_PROMPT_ZH = '你好，我是灵栖。今天天气不错，我们一起聊聊吧。'`
- `MIN_CLONE_RECORD_MS = 3000`
- `MAX_CLONE_RECORD_MS = 30000`

`encode-wav.ts`:
- `encodePcmToWav(samples: Float32Array, sampleRate: number): ArrayBuffer`
- 标准 44 字节 PCM WAV 头，Float32 clamp 到 Int16

**Step 4: 测试通过后提交**

```bash
git add apps/windows/src/renderer/pages/SettingsPage/components/VoiceProfilesPanel/clone-ref-prompt.ts \
  apps/windows/src/renderer/pages/SettingsPage/components/VoiceProfilesPanel/encode-wav.ts \
  apps/windows/src/renderer/pages/SettingsPage/components/VoiceProfilesPanel/encode-wav.test.ts \
  docs/plans/2026-08-08-voice-clone-mic-record-design.md \
  docs/plans/2026-08-08-voice-clone-mic-record-implementation.md
git commit -m "$(cat <<'EOF'
feat(voice): 添加克隆录制文案常量与 PCM→WAV 编码

EOF
)"
```

---

### Task 2: IPC `voice:profiles:save-temp-ref`（TDD）

**Files:**
- Modify: `apps/windows/src/shared/voice-commands.ts`
- Modify: `apps/windows/src/main/voice/voice-ipc.ts`
- Create: `apps/windows/src/main/voice/voice-profiles-save-temp.test.ts`（测纯写盘 helper，或抽 `saveTempRefAudio`）

**Step 1:** 抽出 `saveTempCloneRefAudio(audioBase64, ext?)` 到 `voice-profile-store.ts` 旁或 `voice-temp-ref.ts`，写测试：base64 → 文件存在且内容匹配。

**Step 2:** 命令类型加入 `VoiceCommand` union。

**Step 3:** `voice-ipc` case 调用 helper，返回 `{ ok, filePath }`。

**Step 4:** Commit

```bash
git commit -m "$(cat <<'EOF'
feat(voice): 支持将克隆参考音频写入临时目录

EOF
)"
```

---

### Task 3: VoiceProfilesPanel 录制 UI 与流程

**Files:**
- Modify: `apps/windows/src/renderer/pages/SettingsPage/components/VoiceProfilesPanel/index.tsx`
- Optional CSS: 复用 `VoiceModelsPanel.module.css` / 参考 `AsrLiveTestPanel.module.css` 音量条

**行为：**
1. 展示只读朗读稿 `CLONE_REF_PROMPT_ZH`
2. 「开始录制」：`getUserMedia({ audio: true })` → AudioContext → 收集 PCM（ScriptProcessor 或复用 worklet；优先简单：`AudioWorklet` 若加载成本高可用 `createScriptProcessor(4096,1,1)` 仅本设置页）
3. 音量条 + 时长；≥ `MAX_CLONE_RECORD_MS` 自动 stop
4. 「停止」：若 `< MIN` 报错不落盘；否则 `encodePcmToWav` → base64 → `voice:profiles:save-temp-ref` → 设 `refPath`、`refText=CLONE_REF_PROMPT_ZH`、`sampleSource='record'`
5. 预听：停止前保留 `Blob` URL；重录清空
6. 「选择参考音频」：`sampleSource='file'`，转写 Input 可编辑
7. `handleCreate`：录制来源强制用常量作 refText

**Step: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(voice): 设置页支持麦克风朗读录制克隆样本

EOF
)"
```

---

### Task 4: 组件/集成测试与验收

**Files:**
- Create: `apps/windows/src/test/components/VoiceProfilesPanel.test.tsx`（mock electronAPI + getUserMedia 可选）

至少覆盖：
- 渲染含固定文案
- 保存时录制路径使用固定 refText（可测导出 helper `resolveRefText(source, input)`）

Run:
```bash
cd apps/windows && npx vitest run src/renderer/pages/SettingsPage/components/VoiceProfilesPanel src/main/voice/voice-profiles-save-temp.test.ts src/test/components/VoiceProfilesPanel.test.tsx
```

手工验收清单见 design 文档。

**Final commit** if tests added separately.

---

## 执行备注

- Worktree: `.worktrees/voice-clone-mic-record`，分支 `feat/voice-clone-mic-record`
- preload：若 `voice.sendCommand` 已透传任意 command，无需改 ElectronAPI
- 注释：函数级中文注释
