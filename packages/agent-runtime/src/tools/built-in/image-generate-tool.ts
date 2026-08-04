/**
 * image_generate 工具 — 通过 AI 模型根据文字描述生成图片
 *
 * 接口文档：https://docs.right.codes/docs/rc_extension/draw
 * 所有模型均走流式 POST /v1/chat/completions（stream=true），避免 Cloudflare 60s 与非流式连接超时。
 *
 * 支持模型：
 *   gpt-image-2-vip — OpenAI 最新画图，官方直连，1K/2K/4K
 *   gpt-image-2     — OpenAI 最新画图特价版，1K（默认）
 *   nano-banana     — gemini-2.5-flash-image 封装
 *   nano-banana-2   — 第二代，综合效果更好，1K/2K/4K
 *   nano-banana-pro — 第二代专业档，1K/2K/4K
 *
 * 生成结果保存到 workspace/outputs/YYYYMMDD/<filename>_<YYYYMMDD>_<uuid>.<ext>
 * 未传 filename 时回退为 generated_<uuid>.<ext>
 *
 * 迭代修改：将上一次返回的 revisedPrompt 与用户修改指令合并后传入 prompt，
 * 不要只传修改片段，否则模型会丢失上下文。
 */

/** Right Code 绘图接口文档（供工具描述与错误提示引用） */
export const IMAGE_DRAW_API_DOCS = "https://docs.right.codes/docs/rc_extension/draw"

import { Type, type Static } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { buildImageModelSelectionGuideForAgent } from "./image-models.js";

const IMAGE_MODEL_SELECTION_GUIDE = buildImageModelSelectionGuideForAgent();

const ImageGenerateParams = Type.Object({
  prompt: Type.String({
    description:
      "图片描述，越详细越好。" +
      "迭代修改时，请将上一次返回的 revisedPrompt 与用户的修改指令合并后传入，" +
      "不要只传修改片段（否则模型会丢失整体画面上下文）。",
  }),
  filename: Type.Optional(
    Type.String({
      description:
        "图片文件名（不含扩展名和时间戳），用于标识图片内容。" +
        "例如传入 'cover' 则实际文件名为 cover_20260611_a1b2.png。" +
        "若不传则自动使用 generated_<uuid>.<ext>。",
    }),
  ),
  modelId: Type.Optional(
    Type.String({
      description:
        "生图模型 id，可选；不传时默认 gpt-image-2（流式）。" +
        "日常简单图可不传或传 gpt-image-2；高清/4K 用 gpt-image-2-vip；" +
        "若 right.codes 不稳定可试 nano-banana-2（Draw 流式）；快速草稿 nano-banana；专业艺术风 nano-banana-pro。" +
        `详见工具描述中的选型指南。接口文档：${IMAGE_DRAW_API_DOCS}`,
    }),
  ),
  width: Type.Optional(
    Type.Number({
      description: "图片宽度（像素），默认 1024。仅支持 1024 或 1536（横版）。",
    }),
  ),
  height: Type.Optional(
    Type.Number({
      description: "图片高度（像素），默认 1024。仅支持 1024 或 1536（竖版）。",
    }),
  ),
  referenceImagePath: Type.Optional(
    Type.String({
      description: "【预留，暂未实现】参考图的 workspace 相对路径，用于图生图局部修改。",
    }),
  ),
});

type ImageGenerateInput = Static<typeof ImageGenerateParams> & { filename?: string };

export interface ImageGenerateResult {
  /** workspace 相对路径，如 outputs/20260517/generated_a1b2.png */
  filePath: string;
  width: number;
  height: number;
  /** 实际使用的模型 id */
  model: string;
  /**
   * 模型优化后的完整 prompt。
   * 迭代修改时请将此值与用户的修改指令合并后传入下一次调用的 prompt 参数。
   */
  revisedPrompt: string;
}

export const imageGenerateToolConfig: MtBotToolConfig<typeof ImageGenerateParams> = {
  name: "image_generate",
  label: "生成图片",
  description:
    "使用 AI 模型根据文字描述生成图片，保存到 workspace/outputs/ 目录并返回文件路径。\n" +
    `【接口文档】${IMAGE_DRAW_API_DOCS}\n` +
    IMAGE_MODEL_SELECTION_GUIDE +
    "\n" +
    "【重要】调用时请务必传入 filename 参数（如 'cover'、'banner'、'k8s-arch'），" +
    "文件将以 filename_YYYYMMDD_uuid.ext 格式保存，方便后续引用时识别对应哪张图。\n" +
    "【关键】返回的 filePath 是图片的唯一有效路径，引用/预览/发送/写入文档时必须原样使用，" +
    "严禁根据语义自行编造文件名（如 cover.png / k8s-01.png）。\n" +
    "返回的 revisedPrompt 是模型优化后的完整描述——用户要求修改时，" +
    "请将其与修改指令合并后传入下一次调用，而不是只传修改片段。\n" +
    "【失败处理】生成失败时平台会直接返回错误信息，不会自动重试；" +
    "请将错误原样告知用户，不要自行再次调用本工具除非用户明确要求。" +
    "禁止在失败后换用不同 modelId 重复调用（每次调用都会向上游计费）。",
  parameters: ImageGenerateParams,
  category: "filesystem",
  isReadOnly: false,
  needsPermission: false,
  execute: async (
    _toolCallId: string,
    _params: ImageGenerateInput,
  ): Promise<AgentToolResult<ImageGenerateResult | null>> => {
    // 默认实现：由宿主平台（如 Electron bridge）在 registerToolOverrides 中覆盖此方法。
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "not_implemented",
            message: "图片生成功能需要平台层注入，当前环境不支持",
          }),
        },
      ],
      details: null,
    };
  },
};
