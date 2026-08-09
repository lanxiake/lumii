# 语音通话实时转写问题诊断

## 问题描述
用户反馈:在对话中点击通话按钮后,用户说话时应该实时显示语音识别的文字,用户停止说话后发送给 Agent,但现在这个功能失效了。

## 诊断结果

### 1. 实时转写(Partial Transcript)功能失效原因

**根本原因:当前 ASR 配置不支持流式中间结果输出**

- 当前配置:`config.asr.provider = 'local-paraformer'` (离线模式)
- 代码位置:`apps/windows/src/main/voice/voice-service.ts:117-119`
- 行为:`LocalOfflineParaformerAsr.getPartialText()` 恒返回空字符串 (asr-engine.ts:190-192)
- 注释明确说明:"离线模式无中间结果"

**实时转写的代码路径(当前失效):**
```typescript
// voice-service.ts:518-530
if (isSpeaking && this.asrStream && this.stateMachine.isOneOf('listening', 'recognizing')) {
  const partial = this.asrStream.getPartialText()  // ← 离线模式返回 ''
  if (partial && partial !== this._lastPartial) {
    this._lastPartial = partial
    this.pushVoiceEvent({
      type: 'voice:transcript',
      callId: this.callId,
      text: partial,
      isFinal: false,  // ← 前端应该显示这个 partial 文字
    })
  }
}
```

由于 `getPartialText()` 始终返回空字符串,`voice:transcript`(isFinal=false)事件永远不会推送到前端,所以 `useVoiceCall.ts:177-179` 的 `partialTranscript` 状态永远不会更新。

### 2. 最终识别与发送功能(正常工作)

**"用户停止说话后发送给 Agent"的功能仍然正常:**

- VAD 检测到完整语音段(静音后)→ ASR 调用 `resetAndGetResult()` 获取最终文本 → 推送 `voice:transcript`(isFinal=true)事件 → 调用 `submitToAgent()` 发送给 Agent
- 代码路径:`voice-service.ts:533-560`
- 这个功能依赖的是完整段识别,不依赖流式中间结果,所以不受影响

### 3. 最近改动分析

**最近提交 `3aacd52`(实时朗读改用右上角静默持续播报)未触及 ASR 核心逻辑:**

改动内容:
- 实时朗读 UI 从输入框开关迁移到标题栏音量按钮
- 增加 `silent`/`persistent` 参数支持静默持续朗读
- `useVoiceCall.ts` 增加 `silentRef`/`readAloudActive`/`readAloudSpeaking` 状态管理
- **未修改**:ASR 引擎选择、VAD 处理流程、转写文字推送机制

其他改动:
- `main/index.ts`, `preload/index.ts` 的 Provider 槽配置改动(增加 `draftCfg` 参数)仅影响设置页模型列表加载,与语音通话无关

**结论:实时转写失效不是最近改动导致的回退,而是当前 ASR 配置(离线 Paraformer)就不支持流式中间结果。**

## 解决方案

### 方案 1:切换到流式 Paraformer(推荐)

修改 ASR provider 配置,使用 `LocalStreamingParaformerAsr`:

```typescript
// voice-service.ts 或配置文件
asr: {
  provider: 'local-paraformer-streaming',  // ← 改为流式版本
  language: 'zh',
}
```

需要同步修改 `createAsrProvider` 工厂函数添加新 case:
```typescript
