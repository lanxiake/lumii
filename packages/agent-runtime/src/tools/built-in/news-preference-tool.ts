/**
 * news_preference — 资讯偏好的结构化读写
 *
 * stub 实现，由平台集成层（bridge-maintenance-tools.ts）覆盖 execute。
 *
 * 情报每轮都要按用户偏好筛选，此前只能去 user-memory.md 里翻自由文本：偏好写在哪、
 * 写成什么形状全靠当轮发挥，下一轮读的时候又得重新理解一遍——「越用越准」因此落不了地。
 * 这个工具给它一个**固定位置 + 固定字段**（user-memory.md 的 `## 资讯偏好` 四行）。
 */

import { Type, type Static } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

const NEWS_PREF_FIELDS = ["关注", "少推", "来源偏好", "推送时段"] as const;

const NewsPreferenceParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("read"),
      Type.Literal("add"),
      Type.Literal("remove"),
    ],
    { description: "read 读当前偏好；add 记一条；remove 撤一条（add 自带去重）" },
  ),
  field: Type.Optional(
    Type.Union(
      NEWS_PREF_FIELDS.map((f) => Type.Literal(f)),
      {
        description:
          "add / remove 必填。关注=想看的领域；少推=反感的内容类型；来源偏好=常看的站点；推送时段=希望什么时候收到",
      },
    ),
  ),
  value: Type.Optional(
    Type.String({
      description:
        "add / remove 必填，一条一项（如「端侧推理」「标题党」）。" +
        "用户一句话里提了多项就分多次调用，不要用顿号拼成一条。",
    }),
  ),
});

type NewsPreferenceInput = Static<typeof NewsPreferenceParams>;

export const newsPreferenceToolConfig: MtBotToolConfig<typeof NewsPreferenceParams> = {
  name: "news_preference",
  label: "News Preferences",
  description:
    "Read or update the user's news curation preferences, stored in a fixed section of user memory. " +
    "Call read at the START of every curation run; call add the moment the user expresses a preference " +
    "('少推 X' / '多看看 Y') — say so in your reply so they know it took effect.",
  parameters: NewsPreferenceParams,
  category: "agent",
  isReadOnly: false,
  needsPermission: false,
  async execute(_toolCallId: string, _params: NewsPreferenceInput): Promise<AgentToolResult<unknown>> {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "not_implemented",
            message: "news_preference requires platform integration layer.",
          }),
        },
      ],
      details: undefined,
    };
  },
};
