# 语音通话实时转写修复验证

## 修复内容

### 1. 问题描述
- **症状**:用户在语音通话中说话时,转写文字不会实时显示,只有停止说话后才一次性显示
- **根因**:ASR 引擎使用的是 `LocalOfflineParaformerAsr`(离线模式),不支持流式中间结果输出

### 2. 修复方案
将 ASR provider 从离线模式切换到流式模式:

**修改文件**:`apps/windows/src/main/voice/asr-engine.ts`

**改动**:
```typescript
// 修改 createAsrProvider 工厂函数
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

### 3. 行为变化

**修复前**:
- 用户说话时:`partialTranscript` 始终为空,`VoiceCallPanel` 不显示实时转写
- 用户停止说话:VAD 检测完整语音段 → ASR 识别 → 一次性显示 `finalTranscript` 并发送给 Agent

**修复后**:
- 用户说话时:`partialTranscript` 实时更新,`VoiceCallPanel` 显示边说边识别的文字(可能不完整或有误)
- 用户停止说话:实时文字消失,`finalTranscript` 显示最终识别结果并发送给 Agent

## 验证步骤

### 1. 构建与启动
```bash
cd E:/my-project/open-source/lumii
pnpm install
pnpm dev
```

### 2. 验证实时转写
1. 打开应用,进入聊天页面
2. 点击输入框右侧的"通话"按钮,启动语音通话
3. 等待状态变为"你可以说话了"(listening)
4. **对着麦克风说一句话**(如"今天天气怎么样")
5. **观察 VoiceCallPanel 的字幕区**:
   - ✅ **预期行为**:说话过程中,字幕区应该实时显示识别出的文字(可能边说边变化,这是正常的)
   - ❌ **失败表现**:说话时字幕区完全空白,停止说话后才一次性显示

### 3. 验证最终发送
1. 停止说话,保持静音
2. 观察:
   - 字幕区最终识别文字应该固定下来(不再变化)
   - 状态应该从 `recognizing` → `thinking` → `speaking`(AI 回复)
   - 聊天界面应该显示一条用户消息(内容为识别的文字 + "（语音输入）"标记)
   - 随后应该收到 Agent 的回复

### 4. 验证模型文件
如果启动通话时报错"语音模型未就绪",需要:
1. 进入"设置 → 语音设置"
2. 检查"语音识别模型"是否已下载
3. 如果未下载,点击"下载本地模型"按钮
4. 等待下载完成后重新尝试通话

## 回退方案

如果流式模式出现问题(如识别准确率下降、崩溃等),可以临时回退到离线模式:

```typescript
// apps/windows/src/main/voice/asr-engine.ts
case 'local-paraformer':
  if (!config.modelDir) throw new Error('local-paraformer 需要 modelDir')
  return new LocalOfflineParaformerAsr(config.modelDir)  // ← 改回离线版
```

或在配置中明确指定:
```typescript
// voice-service.ts
asr: {
  provider: 'local-paraformer-offline',  // ← 显式使用离线模式
  language: 'zh',
}
```

## 已知限制

1. **流式识别准确率**:流式模式的中间结果(partial)可能不如最终结果(final)准确,这是正常现象
2. **模型文件**:流式和离线模式使用的是不同的 ONNX 模型文件(encoder.int8.onnx vs model.int8.onnx),如果模型目录中只有一种,需要重新下载
3. **性能开销**:流式模式需要持续解码音频帧,CPU 占用略高于离线模式(但差异不大)

## 相关日志

修复后,控制台应该输出:
```
[AsrEngine] 加载 Streaming Paraformer: <model-dir>
[AsrEngine] Streaming Paraformer 初始化完成
[VoiceService] 语音引擎全部就绪
```

如果看到以下日志,说明仍在使用离线模式:
```
[AsrEngine] 加载 Offline Paraformer: <model-dir>
```
