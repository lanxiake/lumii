# 语音通话实时转写失效 —— 诊断与修复

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-09 |
| 功能域 | 语音交互（voice） |
| 症状 | 通话中说出的文字不实时显示，停止说话后才一次性出现 |
| 根因 | ASR provider 配置为离线模式，不支持流式中间结果 |
| 状态 | 已修复并验证 |

## 一、问题描述

用户反馈：在对话中点击通话按钮后，**说话时**应实时显示语音识别的文字（partial transcript），停止说话后发送给 Agent。实际表现为说话期间字幕区完全空白，只有停止说话后才一次性显示最终结果。

### 复现步骤

1. `pnpm dev` 启动应用，进入聊天页
2. 点击输入框右侧「通话」按钮，等待状态变为「你可以说话了」（listening）
3. 对麦克风说一句话，观察 `VoiceCallPanel` 字幕区
4. **实际**：说话过程中字幕区空白；**预期**：边说边显示识别文字

## 二、根因分析

**根本原因：当前 ASR 配置不支持流式中间结果输出。**

- 当前配置：`config.asr.provider = 'local-paraformer'`（离线模式）
- 行为：`LocalOfflineParaformerAsr.getPartialText()` 恒返回空字符串（`apps/windows/src/main/voice/asr-engine.ts:190-192`），代码注释明确写着「离线模式无中间结果」

失效的代码路径（`apps/windows/src/main/voice/voice-service.ts:518-530`）：

```typescript
if (isSpeaking && this.asrStream && this.stateMachine.isOneOf('listening', 'recognizing')) {
  const partial = this.asrStream.getPartialText()  // ← 离线模式恒返回 ''
  if (partial && partial !== this._lastPartial) {
    this._lastPartial = partial
    this.pushVoiceEvent({
      type: 'voice:transcript',
      callId: this.callId,
      text: partial,
      isFinal: false,  // ← 前端应显示这个 partial 文字
    })
  }
}
```

由于 `getPartialText()` 始终返回空串，`voice:transcript`（`isFinal=false`）事件永远不会推送，`useVoiceCall.ts:177-179` 的 `partialTranscript` 状态也就永远不会更新。

### 不受影响的部分

「停止说话后发送给 Agent」的功能正常：VAD 检测到完整语音段（静音后）→ ASR 调用 `resetAndGetResult()` 取最终文本 → 推送 `voice:transcript`（`isFinal=true`）→ 调用 `submitToAgent()`。该链路依赖完整段识别，不依赖流式中间结果（`voice-service.ts:533-560`）。

### 排除回退可能

最近提交 `3aacd52`（实时朗读改用右上角静默持续播报）**未触及 ASR 核心逻辑** —— 改动仅涉及朗读 UI 位置迁移、`silent`/`persistent` 参数、`useVoiceCall.ts` 的朗读状态管理；未修改 ASR 引擎选择、VAD 处理流程、转写推送机制。因此**这不是回归，而是离线配置本就不支持流式输出**。

## 三、修复方案

将 ASR provider 的默认实现从离线切换为流式。

**修改文件**：`apps/windows/src/main/voice/asr-engine.ts` 的 `createAsrProvider` 工厂函数

```typescript
case 'local-paraformer':
  // 默认使用流式版本以支持实时转写
  return new LocalStreamingParaformerAsr(config.modelDir)

// 新增流式模式显式配置项
case 'local-paraformer-streaming':
  return new LocalStreamingParaformerAsr(config.modelDir)

// 保留离线模式作为备选
case 'local-paraformer-offline':
  return new LocalOfflineParaformerAsr(config.modelDir)
```

### 行为变化

| 阶段 | 修复前 | 修复后 |
| --- | --- | --- |
| 用户说话中 | `partialTranscript` 恒空，字幕区无显示 | `partialTranscript` 实时更新，边说边显示（可能不完整或有误） |
| 用户停止说话 | VAD 切段 → ASR 识别 → 一次性显示 `finalTranscript` 并发送 | 实时文字消失，`finalTranscript` 固定并发送给 Agent |

## 四、验证

### 1. 启动

```bash
pnpm dev
```

### 2. 验证实时转写

1. 进入聊天页，点击「通话」按钮，等待 listening 状态
2. 说一句话（如「今天天气怎么样」）
3. 观察字幕区：说话过程中应实时显示识别文字（边说边变化属正常）；若说话时完全空白、停止后才一次性显示，则修复未生效

### 3. 验证最终发送

1. 停止说话并保持静音
2. 字幕区最终文字应固定；状态经 `recognizing` → `thinking` → `speaking`
3. 聊天界面出现一条用户消息（识别文字 +「（语音输入）」标记），随后收到 Agent 回复

### 4. 期望日志

```
[AsrEngine] 加载 Streaming Paraformer: <model-dir>
[AsrEngine] Streaming Paraformer 初始化完成
[VoiceService] 语音引擎全部就绪
```

若仍看到 `[AsrEngine] 加载 Offline Paraformer`，说明仍在用离线模式。

### 5. 模型文件检查

启动通话若报「语音模型未就绪」：进入「设置 → 语音设置」，确认「语音识别模型」已下载，未下载则点击「下载本地模型」后重试。

## 五、回退方案

流式模式若出现识别准确率下降或崩溃，可临时回退：

```typescript
// apps/windows/src/main/voice/asr-engine.ts
case 'local-paraformer':
  if (!config.modelDir) throw new Error('local-paraformer 需要 modelDir')
  return new LocalOfflineParaformerAsr(config.modelDir)  // ← 改回离线版
```

或在配置中显式指定：

```typescript
// voice-service.ts
asr: {
  provider: 'local-paraformer-offline',  // ← 显式使用离线模式
  language: 'zh',
}
```

## 六、已知限制

1. **准确率**：流式中间结果（partial）可能不如最终结果（final）准确，属正常现象
2. **模型文件**：流式与离线使用不同的 ONNX 模型（`encoder.int8.onnx` vs `model.int8.onnx`）；模型目录若只有其一，需重新下载
3. **性能开销**：流式模式需持续解码音频帧，CPU 占用略高于离线模式（差异不大）
