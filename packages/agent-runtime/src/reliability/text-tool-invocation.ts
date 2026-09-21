/**
 * 文本通道工具调用检测（2026-09-21 实测故障）
 *
 * ## 故障形态
 *
 * 模型把工具调用写在**推理/正文文本**里（Anthropic 风格的 `<invoke name="…">` +
 * `<parameter name="…">`），而没有作为结构化的 `tool_calls` 发出。app 侧因此看不到
 * 这次调用：没有 `tool:start`、没有 ToolRunner、**没有任何执行**。模型还会顺手把
 * 「返回」也一起编出来，下一轮就以为自己写过了。
 *
 * 实测现场（Qwen3.8-Flash-Next，`kms.sczxsc.cn` 的 OpenAI 兼容端点，思考开启）：
 * 一次会话里编了 35 次，其中 3 次编的是 `file_write`。模型自己下一轮才醒悟：
 * 「**那条 `File written` 是我在文本里写的幻觉结果**」。代价是模型先用 bash 去跑一个
 * 并不存在的脚本（`can't open file`），再花两轮才找到真正原因。
 *
 * ## 为什么判据是这个组合
 *
 * 单看「文本里有 `<invoke`」会误伤——用户完全可能让模型写一段讲 XML 调用的文档。
 * 加一个条件就基本不可能误伤：**该消息没有任何结构化工具调用**。真正想调工具的模型
 * 不会一边发结构化调用一边只在文本里写；反过来，一个既不调工具、又在推理里写
 * `<invoke name=` 的消息，几乎只可能是「调用没发出来」。
 *
 * **只看 thinking 块**：实测 XML 全部落在推理通道（三条消息正文通道合计 0 次），
 * 而纯推理内容对用户不可见，进一步压掉误判面。
 *
 * ## 与 `self-heal` 的分工
 *
 * `self-heal` 处理的是**报错**（`stopReason === "error"`）；本模块处理的是**静默**
 * ——回合好端端地结束了，只是什么都没发生。所以它挂在 `turn_end`，与 `StuckGuard`
 * 同一层。
 */

/** 判定用到的消息形状（pi-agent-core 的 AssistantMessage 子集） */
export interface TextToolInvocationMessage {
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
}

/**
 * 文本里是否出现了「XML 式工具调用」的签名。
 *
 * 要求 `<invoke name=` 与 `<parameter name=` **同时**出现：单独一个 `<invoke` 可能
 * 只是讨论中的片段，两个一起才是完整调用块的形状。
 */
function looksLikeTextToolInvocation(text: string): boolean {
  return text.includes("<invoke name=") && text.includes("<parameter name=")
}

/**
 * 判断一条助手消息是否为「工具调用只写进了推理文本、没有真正发出」。
 *
 * 三个条件缺一不可：
 * 1. 至少有一个 thinking 块（出现该故障的前提）
 * 2. thinking 里出现 XML 式调用签名
 * 3. 该消息**没有任何** `toolCall` 块
 */
export function isTextOnlyToolInvocation(message: TextToolInvocationMessage): boolean {
  const blocks = message.content
  if (!Array.isArray(blocks) || blocks.length === 0) return false

  let hasThinkingSignature = false
  let hasStructuredToolCall = false
  // 扫完再判：块的先后顺序不构成判据（thinking 与 toolCall 谁先出现都合法）
  for (const block of blocks) {
    if (block?.type === "toolCall") {
      hasStructuredToolCall = true
      continue
    }
    if (block?.type === "thinking" && typeof block.text === "string") {
      if (looksLikeTextToolInvocation(block.text)) hasThinkingSignature = true
    }
  }
  return hasThinkingSignature && !hasStructuredToolCall
}

/**
 * 注入给模型的纠正提示。
 *
 * 措辞对着实测里模型自己花三轮才悟出来的那两点：① 调用必须是结构化的；
 * ② **不要顺手编返回**——编了就会把没发生的事当成已发生。
 */
export const TEXT_TOOL_INVOCATION_HINT = [
  "你的上一条回复把工具调用写进了文本/推理内容里，而不是作为结构化的工具调用发出——",
  "因此它**没有被执行**，你也**没有收到任何结果**。写在文本里的 `<invoke>` 不会被识别。",
  "",
  "请重新发出这个工具调用：只发调用本身，不要在同一条里写任何「返回」或「已完成」。",
  "工具结果由系统在调用真正执行后返回，你写的那份不是真的。",
].join("\n")
