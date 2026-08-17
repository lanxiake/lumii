# DeepSeek 提供商与 Responses API 支持

## 概述

灵栖 v0.1.1+ 支持：

1. **DeepSeek 独立提供商**：简化配置，只需填写 API Key
2. **OpenAI Responses 接口**：支持 prompt caching，降低成本

## DeepSeek 配置

### 设置步骤

1. 打开「设置」→ 对应能力槽（如「文本对话」）
2. 服务商类型选择 **DeepSeek**
3. 接口地址自动填充为 `https://api.deepseek.com`（固定，无需修改）
4. 填写 API Key
5. 选择模型（如 `deepseek-v4-flash` / `deepseek-v4-pro`）
6. API 格式默认为 **Responses（推荐）**

### 价格

客户端按「空闲时段 + cache miss」估算（实际费用以官方账单为准）：

| 模型 | 输入（元/M tokens） | 输出（元/M tokens） |
|------|-------------------|-------------------|
| deepseek-v4-flash | 1.5 | 4.5 |
| deepseek-v4-pro | 4.5 | 13.5 |

*缓存命中时成本更低（空闲 0.05 元/M，高峰 0.10 元/M）。*

## Responses vs Completions 接口

### 默认配置策略

灵栖根据提供商类型智能选择默认 API 格式：

- **DeepSeek**：默认 `responses`（官方支持，享受缓存优惠）
- **OpenAI 兼容**：默认 `completions`（通用中转通常不支持 responses）
- **自定义中转**：如果你的中转支持 `/v1/responses`，可手动切换为 `responses`

### Responses 接口（推荐）

- **优势**：支持 prompt caching，重复对话成本降低 90%+
- **端点**：`/v1/responses`（Anthropic 格式）
- **适用**：
  - DeepSeek 官方 API
  - OpenAI 官方 API（gpt-4o 等）
  - 明确支持 Anthropic Responses API 的中转

### Completions 接口（传统）

- **特点**：OpenAI 原生格式，兼容性最好
- **端点**：`/v1/chat/completions`
- **适用**：
  - 通用 OpenAI 兼容中转
  - 不支持 responses 的服务

### 如何判断中转是否支持 Responses

尝试切换为 `responses` 格式后：
- ✅ 对话正常 → 支持，可继续使用
- ❌ 报 403/404/500 错误 → 不支持，切回 `completions`
- 💡 模型测试成功但对话失败 → 说明测试用的是 completions，对话用的是 responses

### 配置位置

设置 → 文本对话 → API 格式：

- **Responses（推荐，支持缓存）** ← 默认
- **Completions（传统）**

## 技术细节

- `packages/agent-runtime/src/llm/direct-stream.ts` 根据 `apiFormat` 选择 `openai-responses` 或 `openai-completions`
- `apps/windows/src/main/provider-config.ts` 存储配置并加密 API Key
- DeepSeek baseUrl 自动规范化为 `https://api.deepseek.com/v1`

## 迁移旧配置

旧版用 OpenAI 兼容方式配置的 DeepSeek（手填 baseUrl）仍可用，建议迁移到新的独立提供商：

1. 记下当前的 API Key 和模型 ID
2. 切换服务商类型为 **DeepSeek**
3. 重新填写 API Key 和模型
4. API 格式选 **Responses**

---

*更新日期：2026-08-17*
