/**
 * ocr_image 工具 — 对图片做文字识别，**返回每个词的坐标**。
 *
 * 为什么需要它（多模态模型不能替代）：
 * 视觉模型能"看懂"图，但说不清"第三个按钮在图上什么位置"。用户问
 * 「点哪里」「这个元素在哪个坐标」时，需要的是**可度量的框**，不是描述。
 * 本地 PP-OCR 的每一行都带 `[left, top, width, height]`，正好补这一块。
 *
 * 默认实现是 stub，由宿主（Electron bridge）在 registerToolOverrides 里覆盖。
 */

import { Type, type Static } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

const OcrImageParams = Type.Object({
  imagePath: Type.String({
    description:
      "要识别的图片路径：workspace 相对路径（如 uploads/20261116/a.png）或绝对路径。" +
      "必须是真实存在的图片文件，不得编造。",
  }),
  maxSide: Type.Optional(
    Type.Number({
      description: "长边上限（像素），默认 1600。图片很大时可调小以加快速度；文字很小时可调大。",
    }),
  ),
});

type OcrImageInput = Static<typeof OcrImageParams>;

export interface OcrImageLine {
  text: string;
  /** 轴对齐框：[left, top, width, height]，单位是像素 */
  box: [number, number, number, number];
  score: number;
}

export interface OcrImageResult {
  /** 全部文字按行拼接 */
  text: string;
  lines: OcrImageLine[];
  /** 行置信度均值 */
  confidence: number;
  backend: "dml" | "cpu";
}

export const OCR_IMAGE_TOOL_NAME = "ocr_image";

export const ocrImageToolConfig: MtBotToolConfig<typeof OcrImageParams> = {
  name: OCR_IMAGE_TOOL_NAME,
  label: "识别图片文字与坐标",
  description:
    "对图片做 OCR，返回识别出的文字**以及每一行的像素坐标框** [left, top, width, height]。\n" +
    "什么时候用：\n" +
    "- 用户问「这个按钮/文字在图的什么位置」「点哪里」「坐标是多少」——视觉描述给不出可度量的位置，必须用本工具；\n" +
    "- 需要精确定位界面上某个元素、或要把识别结果映射成点击坐标；\n" +
    "- 图片里文字很密、视觉模型容易漏读时。\n" +
    "什么时候不用：只是「图里大概是什么内容」这类描述性问题，直接看图片即可，不必多跑一次 OCR。\n" +
    "坐标系：左上角为原点，x 向右、y 向下；坐标是**原图缩放后**的像素值（见返回的 imageSize）。",
  parameters: OcrImageParams,
  category: "filesystem",
  isReadOnly: true,
  needsPermission: false,
  execute: async (
    _toolCallId: string,
    _params: OcrImageInput,
  ): Promise<AgentToolResult<OcrImageResult | null>> => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "not_implemented",
            message: "OCR 需要平台层注入，当前环境不支持",
          }),
        },
      ],
      details: null,
    };
  },
};
