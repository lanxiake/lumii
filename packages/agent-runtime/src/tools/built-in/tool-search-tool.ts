/**
 * tool_search — 把折叠进 deferred 的工具一次检索取回（P2 能力面裁剪的兜底）。
 *
 * 设计依据：`docs/design/能力面治理/…设计.md` §5.6.4 规则 3、「折叠的工具必须一次检索就能拿回」。
 * 没有它，裁剪就是把能力对模型藏起来；有了它，Recall 从 100% 掉到 ~93.5% 才是唯一代价。
 *
 * **检索源是「已注册但未装载」的工具**，不是全量注册表：已装载的模型本来就看得见，
 * 再列一遍既费 token 又让模型以为需要重新加载。
 *
 * **fail-open（C8）不在这里**，在宿主的 `searchTools` 实现里。原因：本工具对象在
 * bridge 初始化时创建一次、被所有实例共享（`createMtBotTool(config, toolContext)`），
 * 而「连续两次未命中」是**每实例**的状态。宿主有 `getCurrentToolExecutorInstanceId()`
 * 可定位实例，工具没有。硬塞进来会变成跨实例共享的计数器——静默算错。
 */

import { Type, type Static } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";
import type { MtBotToolResult } from "../../types/tool.js";

const MAX_DESC_CHARS = 150;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

const ToolSearchInput = Type.Object({
  query: Type.String({
    description:
      "Search query for tools that are registered but not currently loaded. " +
      "Multi-keyword: space-separated terms are AND ('file write' → both), comma-separated groups are OR " +
      "('file_write, write, 写入' → any). Search BOTH Chinese and English and try several OR synonyms " +
      "rather than one keyword — a single miss costs you a whole turn.",
  }),
});
type ToolSearchInputType = Static<typeof ToolSearchInput>;

export const toolSearchToolConfig: MtBotToolConfig<typeof ToolSearchInput> = { // @wiring-ignore 由 bridge 按 ENABLE_TOOL_LOADOUT_FOR 灰度名单运行时注册，不进静态清单
  name: "tool_search",
  label: "Search Tools",
  description:
    "Find and load a tool that is not in your current tool list. Folded tools (rarely used ones) are " +
    "still registered — pass a query and any match is loaded for your NEXT turn. " +
    "Call this whenever the task needs a capability you don't see in your tools; " +
    "do NOT conclude a capability is missing until you have searched. " +
    "Returns name + description only (not parameter schemas) — the real tool appears once loaded.",
  parameters: ToolSearchInput,
  category: "filesystem",
  isReadOnly: true,
  needsPermission: false,
  async execute(
    _toolCallId: string,
    params: ToolSearchInputType,
    context,
  ): Promise<MtBotToolResult<unknown>> {
    if (!context.searchTools) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "Tool folding is not enabled in this session.",
              hint: "All registered tools are already in your tool list; no search is needed.",
            }),
          },
        ],
        details: undefined,
      };
    }

    const query = params.query.trim();
    const matched = query ? context.searchTools(query) : [];

    if (matched.length === 0) {
      // **必须调 loadTools([])**：宿主的 fail-open（连续两次未命中 → 回落全量，C8）
      // 就是靠这个空数组计数的。不调的话那个计数器永远是 0，安全网是假的。
      // 顺带让宿主能补记一行 `reason='search'` 的空结果，用于算命中率。
      try {
        context.loadTools?.([]);
      } catch {
        /* 宿主负责 fail-open，抛错不影响本次返回 */
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              tools: [],
              total: 0,
              hint:
                "No folded tool matched. Try different terms (broader OR synonyms, both Chinese and English). " +
                "If you still find nothing after a second try, the capability likely does not exist here — " +
                "say so rather than improvising.",
            }),
          },
        ],
        details: undefined,
      };
    }

    const names = matched.map((t) => t.name);
    // 装载失败**不吞掉检索结果**：本轮模型仍能看到名字（有用），只是下一轮才拿得到真对象。
    try {
      context.loadTools?.(names);
    } catch {
      /* 装载由宿主负责，失败不影响本次检索结果返回 */
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            tools: matched.map((t) => ({ name: t.name, description: truncate(t.description, MAX_DESC_CHARS) })),
            total: matched.length,
            loaded: context.loadTools ? true : false,
            note: context.loadTools
              ? "Loaded — these tools are available from your next turn."
              : "Matched but not loaded (host did not provide a loader).",
          }),
        },
      ],
      details: undefined,
    };
  },
};
