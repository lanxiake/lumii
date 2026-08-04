/**
 * petStateMachine — 融合宠物状态机（pet-core，9 态）
 *
 * 融合 Windows 语音管线（含 recognizing 识别态）与 kids-mobile 儿童安全态
 * （safety_blocked / offline_fallback / network_error），成统一 9 态超集。
 * 纯函数 reducer，无副作用，可单测。各端不用的态自然不触发。
 *
 * 设计：.qoder/design/pet-core-shared-package/pet-core-公共包设计.md §3
 *
 * 9 态：idle / listening / recognizing / thinking / tts_converting /
 *       speaking / safety_blocked / offline_fallback / network_error
 *
 * 语音路径分两种：
 *  - Windows（含 STT 识别态）：listening --RECOGNIZING--> recognizing --RECOGNIZED--> thinking
 *  - kids-mobile MVP（按住说话，无独立识别态）：listening --MIC_STOP--> thinking 直达
 */

export type PetState =
  | "idle"
  | "listening"
  | "recognizing"
  | "thinking"
  | "tts_converting"
  | "speaking"
  | "safety_blocked"
  | "offline_fallback"
  | "network_error";

export type PetEvent =
  // 用户交互
  | { readonly type: "USER_SEND" } // 文本输入已发送
  | { readonly type: "MIC_START" } // 按住说话开始
  | { readonly type: "MIC_STOP" } // 松开：kids-mobile 直达 thinking
  | { readonly type: "MIC_CANCEL" } // 取消录音
  | { readonly type: "RECOGNIZING" } // 进入 STT 识别（Windows 语音管线）
  | { readonly type: "RECOGNIZED" } // 识别完成 → thinking
  // Agent 事件（由 agentEventMapper 从事件流转来）
  | { readonly type: "AGENT_DELTA" } // 流式 token（停留 thinking）
  | { readonly type: "AGENT_FINAL" } // 最终文本就绪，准备 TTS
  // TTS / 音频
  | { readonly type: "TTS_READY" } // 音频就绪，开始播放
  | { readonly type: "TTS_FAILED" } // TTS 失败，不阻塞文本
  | { readonly type: "AUDIO_END" } // 播放结束
  // 安全 / 错误
  | { readonly type: "SAFETY_BLOCKED" }
  | { readonly type: "NETWORK_ERROR" }
  | { readonly type: "OFFLINE" }
  | { readonly type: "ONLINE" }
  // 控制
  | { readonly type: "ACK" } // 用户确认提示（从阻塞态回 idle）
  | { readonly type: "RETRY" } // 从错误态重试
  | { readonly type: "ABORT" } // 中止当前活跃流程
  | { readonly type: "RESET" }; // 重置会话

/** 初始状态 */
export const initialPetState: PetState = "idle";

/** 活跃态（可被 ABORT 打断回 idle） */
const ACTIVE_STATES: ReadonlySet<PetState> = new Set<PetState>([
  "listening",
  "recognizing",
  "thinking",
  "tts_converting",
  "speaking",
]);

/**
 * 逐态转移表：仅列合法转移，未列出的 (state,event) 视为非法并保持原状态。
 */
const TRANSITIONS: Readonly<Record<PetState, Partial<Record<PetEvent["type"], PetState>>>> = {
  idle: {
    USER_SEND: "thinking",
    MIC_START: "listening",
  },
  listening: {
    MIC_STOP: "thinking", // kids-mobile MVP：无独立识别态，直达 thinking
    RECOGNIZING: "recognizing", // Windows：进入 STT 识别态
    MIC_CANCEL: "idle",
  },
  recognizing: {
    RECOGNIZED: "thinking",
    MIC_CANCEL: "idle",
  },
  thinking: {
    AGENT_DELTA: "thinking",
    AGENT_FINAL: "tts_converting",
    SAFETY_BLOCKED: "safety_blocked",
  },
  tts_converting: {
    TTS_READY: "speaking",
    TTS_FAILED: "idle",
  },
  speaking: {
    AUDIO_END: "idle",
  },
  safety_blocked: {
    ACK: "idle",
  },
  offline_fallback: {
    ONLINE: "idle",
  },
  network_error: {
    RETRY: "idle",
    ACK: "idle",
  },
};

/**
 * 状态转移。全局事件先处理，其余走逐态转移表；非法事件保持原状态。
 */
export function petTransition(state: PetState, event: PetEvent): PetState {
  switch (event.type) {
    case "RESET":
      return "idle";
    case "OFFLINE":
      return "offline_fallback";
    case "NETWORK_ERROR":
      return "network_error";
    case "ABORT":
      return ACTIVE_STATES.has(state) ? "idle" : state;
    default:
      break;
  }

  const next = TRANSITIONS[state][event.type];
  return next ?? state;
}
