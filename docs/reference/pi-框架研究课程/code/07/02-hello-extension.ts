// 02-hello-extension.ts
// 可直接放进 ~/.pi/agent/extensions/ 的迷你扩展（或 `pi --extension ./02-hello-extension.ts`
// 临时加载），风格照抄 examples/extensions/hello.ts（docs/extensions.md §Custom tools）。
//
// 用到的真实 API 与文档出处：
//   - defineTool / pi.registerTool  → docs/extensions.md §Custom tools（参数校验 TypeBox、
//     execute 内 throw Error 即失败 toolResult——对应第 3 篇 AgentTool 契约）
//   - pi.registerCommand            → docs/extensions.md §Slash commands（handler 收 args + ctx）
//   - ctx.hasUI / ctx.ui.notify     → docs/extensions.md §Context（headless 检测；notify 是
//     "fire-and-forget，不要 await"，docs/extensions.md §UI 区分层）
//   - pi.on("session_start")        → 生命周期规则：长生命周期资源在 session_start 启动，
//     不在工厂里（"Do not start processes... in the factory"）
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// 纯函数，工具与命令共用——"工具与命令常常共享同一函数"（正文 §3.2）
function countWords(text: string) {
	const words = text.trim().split(/\s+/).filter(Boolean);
	const lines = text.split("\n").length;
	return { words: words.length, chars: text.length, lines };
}

const wordCountTool = defineTool({
	name: "word_count",
	label: "Word count",
	description: "Count words, chars and lines of a text or file path",
	parameters: Type.Object({
		text: Type.Optional(Type.String({ description: "Literal text to count" })),
		file: Type.Optional(Type.String({ description: "File path to count instead of text" })),
	}),
	async execute(_toolCallId, params, signal) {
		// 真实 I/O 要自己检查取消（docs/extensions.md §Tools 执行约定）
		if (signal?.aborted) throw new Error("Operation aborted");
		let input = params.text ?? "";
		if (params.file) {
			const fs = await import("node:fs/promises");
			input = await fs.readFile(params.file, "utf8");
		}
		if (!input) throw new Error("Provide text or file: nothing to count"); // throw ⇒ isError toolResult
		const r = countWords(input);
		return {
			content: [{ type: "text", text: `words=${r.words} chars=${r.chars} lines=${r.lines}` }],
			details: r,
		};
	},
});

export default function extension(pi: ExtensionAPI) {
	pi.registerTool(wordCountTool);

	pi.registerCommand("wc", {
		description: "Count words of the given text (same engine as the word_count tool)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return; // RPC 下没有终端 UI（正文 §5.3）
			if (!args.trim()) return ctx.ui.notify("usage: /wc <text>", "error");
			const r = countWords(args);
			ctx.ui.notify(`words=${r.words} chars=${r.chars} lines=${r.lines}`, "info"); // 不 await
		},
	});

	pi.on("session_start", () => {
		// 演示生命周期：每次会话开始重置一个计数（真正长命的资源也放这里启动）
		void pi.appendEntry; // appendEntry 属自定义 entry（docs/extensions.md §Session & resources）
	});
}
