// 02-tool-validation.mjs
// 演示 pi-agent-core 工具调用的"失败三态"：参数校验失败 / 未知工具 / 执行抛错，
// 全部变成 isError:true 的 toolResult 回到 transcript，模型在下一轮看到错误文本自我修正。
// 校验消息形状复刻 pi-ai 的 validateToolArguments（packages/ai/src/utils/validation.ts）。
// 运行：node 02-tool-validation.mjs   (Node >= 20)

// ---------- 迷你校验器（形状复刻 validateToolArguments：先 prepareArguments，再校验） ----------
function validateArguments(tool, toolCall) {
	let args = structuredClone(toolCall.arguments ?? {});
	if (tool.prepareArguments) args = tool.prepareArguments(args); // 兼容垫片：校验之前跑
	const errors = [];
	const schema = tool.parameters;
	for (const req of schema.required ?? []) {
		if (args[req] === undefined) errors.push(`  - ${req}: must have required property '${req}'`);
	}
	for (const [key, prop] of Object.entries(schema.properties ?? {})) {
		if (args[key] === undefined) continue;
		const got = Array.isArray(args[key]) ? "array" : typeof args[key];
		if (prop.type === "string" && got !== "string") errors.push(`  - ${key}: must be string`);
	}
	if (errors.length) {
		throw new Error(
			`Validation failed for tool "${toolCall.name}":\n${errors.join("\n")}\n\n` +
			`Received arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`,
		);
	}
	return args;
}

// ---------- fake FS + 工具（对应 AgentTool） ----------
const fakeFs = new Map();
const errResult = (text) => ({ content: [{ type: "text", text }], details: {} });
const tools = [
	{
		name: "write_file",
		label: "Write",
		// prepareArguments：老扩展用 file_path 字段，进校验前归一化成 path
		prepareArguments: (a) => ("file_path" in a && !("path" in a) ? { ...a, path: a.file_path } : a),
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, content: { type: "string" } },
			required: ["path", "content"],
		},
		execute: async (id, args) => {
			if (args.path === "/protected") throw new Error("EACCES: permission denied, open '/protected'"); // 执行抛错 → isError
			fakeFs.set(args.path, args.content);
			return { content: [{ type: "text", text: `wrote ${args.content.length} bytes` }], details: { path: args.path } };
		},
	},
];

// ---------- faux provider：每轮"看见"上一轮 toolResult 的错误文本再作答（脚本化，但可检查输入） ----------
function fauxProvider(script) {
	let i = 0;
	return async (messages) => {
		const seen = messages.filter((m) => m.role === "toolResult");
		console.log(`  [faux] 第 ${i + 1} 次请求，模型可见 ${seen.length} 条 toolResult：`);
		for (const m of seen) {
			console.log(`    - ${m.toolName} isError=${m.isError} → "${m.content[0].text.split("\n")[0]}"`);
		}
		const turn = script[i++];
		const msg = {
			role: "assistant", content: [], api: "faux", provider: "faux", model: "mini",
			usage: { input: 0, output: 0, totalTokens: 0 }, stopReason: "stop", errorMessage: "", timestamp: Date.now(),
		};
		for (const item of turn) {
			if (item.text !== undefined) msg.content.push({ type: "text", text: item.text });
			else msg.content.push({ type: "toolCall", ...item.toolCall });
		}
		msg.stopReason = msg.content.some((c) => c.type === "toolCall") ? "toolUse" : "stop";
		return msg;
	};
}

// ---------- 迷你 loop：只保留工具路径，重点打事件 ----------
const t0 = Date.now();
async function emit(ev) {
	const d = Date.now() - t0;
	const pad = (n) => " ".repeat(Math.max(0, n - ev.type.length));
	let detail = "";
	if (ev.type.startsWith("tool_execution")) detail = `${ev.toolName}#${ev.toolCallId}` + (ev.isError === undefined ? "" : ` isError=${ev.isError}`);
	if (ev.type === "message_start" || ev.type === "message_end") {
		detail = ev.message.role === "assistant"
			? `assistant(${ev.message.stopReason})`
			: ev.message.role === "toolResult"
				? `toolResult ${ev.message.toolName} isError=${ev.message.isError}`
				: ev.message.role;
	}
	console.log(`  [${String(d).padStart(3)}ms] ${ev.type}${pad(42)}${detail}`);
}

async function run(promptText, script) {
	const context = { messages: [{ role: "system", content: "You are helpful.", timestamp: Date.now() }], tools };
	const streamFn = fauxProvider(script);
	context.messages.push({ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() });
	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	while (true) {
		const message = await streamFn(context.messages);
		await emit({ type: "message_start", message });
		await emit({ type: "message_end", message });
		context.messages.push(message);
		const toolCalls = message.content.filter((c) => c.type === "toolCall");
		const toolResults = [];
		for (const tc of toolCalls) {
			// pi 的顺序：先 tool_execution_start，再进 prepare（工具查找 + prepareArguments + 校验）
			await emit({ type: "tool_execution_start", toolCallId: tc.id, toolName: tc.name, args: tc.arguments });
			let result, isError;
			const tool = context.tools.find((t) => t.name === tc.name);
			if (!tool) {
				result = errResult(`Tool ${tc.name} not found`); isError = true;
			} else {
				try {
					const args = validateArguments(tool, tc);           // 校验失败 = throw
					result = await tool.execute(tc.id, args);           // 执行抛错 = throw
					isError = false;
				} catch (e) {
					result = errResult(e.message); isError = true;
				}
			}
			await emit({ type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result, isError });
			const msg = { role: "toolResult", toolCallId: tc.id, toolName: tc.name,
				content: result.content, details: result.details, isError, timestamp: Date.now() };
			context.messages.push(msg);
			await emit({ type: "message_start", message: msg });
			await emit({ type: "message_end", message: msg });
			toolResults.push(msg);
		}
		await emit({ type: "turn_end", message, toolResults });
		if (toolResults.length === 0) break;
		await emit({ type: "turn_start" });
	}
	await emit({ type: "agent_end", messages: context.messages.slice(2) });
	return context;
}

console.log("=== 校验失败 / 未知工具 / 执行抛错：三种 isError，模型逐轮修正 ===");
const context = await run("把 hello pi 写入 notes.txt，然后写到 /protected，再删掉 notes.txt", [
	// 轮 1：缺 required 参数 content（并且用了老字段 file_path，靠 prepareArguments 救回）
	[{ toolCall: { id: "t1", name: "write_file", arguments: { file_path: "notes.txt" } } }],
	// 轮 2：参数补齐，但撞上一个会抛错的执行（/protected）
	[{ text: "补上 content 重试" }, { toolCall: { id: "t2", name: "write_file", arguments: { path: "notes.txt", content: "hello pi" } } },
	 { toolCall: { id: "t3", name: "write_file", arguments: { path: "/protected", content: "x" } } }],
	// 轮 3：模型尝试调用一个不存在的工具来"删除"
	[{ toolCall: { id: "t4", name: "delete_file", arguments: { path: "notes.txt" } } }],
	// 轮 4：读到了各自的错误文本，老实收尾
	[{ text: "notes.txt 已写入(8 bytes)；/protected 无权限；delete_file 工具不存在，删除操作放弃。" }],
]);

console.log("\n=== 落盘结果 ===");
console.log("  fakeFs:", Object.fromEntries(fakeFs));
console.log("  transcript roles:", context.messages.map((m) => m.role + (m.isError === true ? "(err)" : "")).join(" → "));
