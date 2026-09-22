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
export * from "./model/sprite-manifest.js";
// 一次性动作的首末帧锚到待机（Idle Pin）：让「播完接回待机」不跳
export * from "./model/idle-pin.js";
export * from "./lipsync/mouth-waveform.js";
export * from "./mapping/emotion-tag-parser.js";

// 阶段 C：融合状态机 + Agent 语义信号映射
export * from "./state/petStateMachine.js";
export * from "./mapping/agentSignalMapper.js";

// 阶段 D：渲染后端语义接口（DOM 无关，各端 implements/extends）
export * from "./render/pet-renderer.js";

// 程序化动画原语（呼吸/摇摆/眨眼/浮动/点头）—— 让静态部件动起来，
// 是「AI 出静态部件 + 代码做动画」路线的基础
export * from "./render/procedural-motion.js";

// 宠物自制系统基础设施（P0-a）：两段式注册表合并 / 图集索引解析 / 安装包校验与安装计划。
// 纯函数、零依赖，客户端运行时与构建期工具链（packages/pet-asset）共用同一份实现。
export * from "./model/pet-registry.js";
export * from "./model/atlas-index.js";
export * from "./model/pet-package.js";

// 抓取/投掷物理（场景 A）：抛物线积分、落地判定、释放速度估计。纯函数，可脱离 DOM 单测。
export * from "./interaction/throw-physics.js";
export * from "./interaction/gaze.js";
// 闲置感知（P2-c）：用户离开多久 → 宠物打盹/睡着。系统闲置秒数的纯换算。
export * from "./interaction/idle-stage.js";

// 自主行为（R9）：空闲时的活动决策与地面行走运动学。
// 决策与运动分离——前者可整表替换（后续接 Agent 真实状态驱动时换的是数据不是逻辑）。
export * from "./behavior/ambient.js";
export * from "./behavior/locomotion.js";
// 攀附程序主窗口（R9 进阶）：吸附判定、沿墙爬升、天花板爬行、松手时机
export * from "./behavior/perch.js";

// Agent 状态可见化（R5/R6）：Agent 活动状态机 + 姿态调制（L1 表达层）。
// 与 R9 的 ambient 是**不同维度**——那个是「宠物自己溜达到哪一步」，这个是「Agent 在做什么」；
// 故命名一律用 agentActivity，别与 AmbientActivity 混。
export * from "./state/agent-activity.js";
export * from "./state/agent-activity-announce.js";
export * from "./render/agent-activity-modulation.js";

// 精灵后端运行时（P0-b）：帧增量归一、槽位状态、口型取档、缩放吸附、多边形命中。
// 同样零依赖、可脱开 WebGL 单测；客户端只负责把解析结果画出来。
export * from "./render/sprite-runtime.js";
export * from "./render/sprite-playback.js";
export * from "./render/hit-polygon.js";

// 阶段 E：WebView 渲染适配（指令协议 + postMessage 实现）
export * from "./render/webview-command.js";
export * from "./render/webview-renderer.js";

// 表情/动作策略（状态 → 表情语义 → expression 索引）
export * from "./expression/state-expression-policy.js";
