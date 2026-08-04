/**
 * @mtbot/pet-core — Windows 与 kids-mobile 共用的宠物逻辑公共包
 *
 * 设计：.qoder/design/pet-core-shared-package/pet-core-公共包设计.md
 *
 * 约束（务必保持）：本包为纯 TS，禁止 import react / react-native / electron /
 * pixi / DOM 类型。渲染通过 PetRendererProvider 抽象接口注入，各端自实现。
 *
 * 子模块（随阶段 B–D 逐步填充并在此再导出）：
 *  - state/       宠物状态机（融合 9 态）
 *  - mapping/     Agent 事件 → 状态；流式表情标签解析
 *  - expression/  状态 → 表情/动作策略
 *  - lipsync/     口型驱动（真实音量 + fake 脉冲）
 *  - model/       模型配置类型 + 注册表加载
 *  - render/      PetRendererProvider 抽象接口
 */

/** 包版本（与 package.json 同步，供宿主诊断用） */
export const PET_CORE_VERSION = "0.1.0";

// 阶段 B：零依赖资产
export * from "./model/pet-model-types.js";
export * from "./lipsync/mouth-waveform.js";
export * from "./mapping/emotion-tag-parser.js";

// 阶段 C：融合状态机 + Agent 语义信号映射
export * from "./state/petStateMachine.js";
export * from "./mapping/agentSignalMapper.js";

// 阶段 D：渲染后端语义接口（DOM 无关，各端 implements/extends）
export * from "./render/pet-renderer.js";

// 阶段 E：WebView 渲染适配（指令协议 + postMessage 实现）
export * from "./render/webview-command.js";
export * from "./render/webview-renderer.js";

// 表情/动作策略（状态 → 表情语义 → expression 索引）
export * from "./expression/state-expression-policy.js";
