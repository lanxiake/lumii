// 01-mini-agent-loop.mjs
// 零依赖手写迷你 agent loop：逐项镜像 pi-agent-core 的事件协议、双层循环、
// 并行工具执行与 abort 传播（概念对应 packages/agent/src/agent-loop.ts）。
// 运行：node 01-mini-agent-loop.mjs   (Node >= 20)

// ---------- 1. 迷你事件流（对应 pi-ai 的 EventStream<T,R>，utils/event-stream.ts） ----------
class MiniStream {
	#queue = []; #waiters = []; #done = false;
	#isComplete; #extract; #resolveFinal; #final = new Promise((r) => (this.#resolveFinal = r));
	constructor(isComplete = () => false, extract = () => undefined) {
		this.#isComplete = isComplete; this.#extract = extract;
	}
	push(v) {
		if (this.#done) return;
		if (this.#isComplete(v)) { this.#done = true; this.#resolveFinal(this.#extract(v)); }
		const w = this.#waiters.shift();
		if (w) w({ value: v, done: false }); else this.#queue.push(v);
	}
	end() {
		this.#done = true; this.#resolveFinal(undefined);
		while (this.#waiters.length) this.#waiters.shift()({ value: undefined, done: true });
	}
	async *[Symbol.asyncIterator]() {
		while (true) {
			if (this.#queue.length) { yield this.#queue.shift(); continue; }
			if (this.#done) return;
			const r = await new Promise((res) => this.#waiters.push(res));
			if (r.done) return;
			yield r.value;
		}
	}
	result() { return this.#final; }
}

const sleep = (ms, signal) =>
	new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("Operation aborted")); }, { once: true });
	});

// ---------- 2. faux provider：脚本化响应，按 pi-ai 事件协议发事件 ----------
// 契约（packages/agent/src/types.ts StreamFn 注释）：不 throw，失败编码进流：
// 最终 AssistantMessage 带 stopReason "error"|"aborted" 与 errorMessage。
function fauxProvider(script) {
	let i = 0;
	return async function fauxStream(messages, options = {}) {
		const stream = new MiniStream(
			(ev) => ev.type === "done" || ev.type === "error",
			(ev) => (ev.type === "done" ? ev.message : ev.error),
		);
		const turn = script[i++ % script.length];
		const msg = {
			role: "assistant", content: [], api: "faux", provider: "faux", model: "mini",
			usage: { input: 0, output: 0, totalTokens: 0 }, stopReason: "stop", errorMessage: "", timestamp: Date.now(),
		};
		(async () => {
			if (options.signal?.aborted) { // abort 已发生：部分结果=空，直接 aborted
				msg.stopReason = "aborted"; msg.errorMessage = "Request was aborted";
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "error", reason: "aborted", error: msg });
				stream.end(); return;
			}
			stream.push({ type: "start", partial: msg });
			for (const item of await turn.respond(messages)) {
				if (options.signal?.aborted) {
					msg.stopReason = "aborted"; msg.errorMessage = "Request was aborted";
					stream.push({ type: "error", reason: "aborted", error: msg });
					stream.end(); return;
				}
				if (item.text !== undefined) {
					const block = { type: "text", text: "" };
					msg.content.push(block);
					for (const d of item.text.match(/.{1,4}/gs) ?? []) {
						block.text += d; // 活 partial：原地改写（pi-ai 契约第 1 条）
						stream.push({ type: "text_delta", contentIndex: msg.content.length - 1, delta: d, partial: msg });
						await sleep(2);
					}
				} else if (item.toolCall) {
					const block = { type: "toolCall", ...item.toolCall };
					msg.content.push(block);
					stream.push({ type: "toolcall_end", contentIndex: msg.content.length - 1, toolCall: block, partial: msg });
				}
			}
			msg.stopReason = msg.content.some((c) => c.type === "toolCall") ? "toolUse" : "stop";
			stream.push({ type: "done", reason: msg.stopReason, message: msg });
			stream.end();
		})();
		return stream;
	};
}

// ---------- 3. 工具（对应 AgentTool：execute(toolCallId, params, signal, onUpdate)） ----------
const errResult = (text) => ({ content: [{ type: "text", text }], details: {} });
const tools = [
	{
		name: "read", label: "Read",
		execute: async (id, args, signal, onUpdate) => {
			await sleep(10, signal);
			onUpdate?.({ content: [{ type: "text", text: "reading…" }], details: {} });
			await sleep(10, signal);
			return { content: [{ type: "text", text: `# ${args.path}\nmodel=faux` }], details: { bytes: 24 } };
		},
	},
	{
		name: "bash", label: "Bash",
		execute: async (id, args, signal, onUpdate) => {
			onUpdate?.({ content: [{ type: "text", text: "$ " + args.command }], details: {} });
			await sleep(args.slowMs ?? 40, signal); // abort 时 reject "Operation aborted"
			onUpdate?.({ content: [{ type: "text", text: "done" }], details: {} });
			return { content: [{ type: "text", text: "42" }], details: { exitCode: 0 } };
		},
	},
];

// ---------- 4. 事件流转换：AgentMessage[] → LLM Message[]（对应 convertToLlm 默认实现） ----------
const convertToLlm = (messages) =>
	messages.filter((m) => ["system", "user", "assistant", "toolResult"].includes(m.role));

// ---------- 5. assistant 响应流：这里消费 pi-ai 事件并再广播 agent 事件 ----------
async function streamAssistantResponse(context, signal, emit, streamFn) {
	const response = await streamFn(convertToLlm(context.messages), { signal });
	let partial = null, added = false;
	for await (const ev of response) {
		if (ev.type === "start") {
			partial = ev.partial; context.messages.push(partial); added = true;
			await emit({ type: "message_start", message: { ...partial } });
		} else if (partial) {
			context.messages[context.messages.length - 1] = ev.partial;
			await emit({ type: "message_update", message: { ...ev.partial }, assistantMessageEvent: ev });
		}
	}
	const final = await response.result();
	if (added) context.messages[context.messages.length - 1] = final;
	else { context.messages.push(final); await emit({ type: "message_start", message: { ...final } }); }
	await emit({ type: "message_end", message: final });
	return final;
}

// ---------- 6. 工具执行：preflight 顺序、执行并发、tool_execution_end 按完成序、toolResult 按源序 ----------
async function executeToolCalls(context, assistantMessage, signal, emit) {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const thunks = [];
	for (const tc of toolCalls) {
		await emit({ type: "tool_execution_start", toolCallId: tc.id, toolName: tc.name, args: tc.arguments });
		const tool = context.tools.find((t) => t.name === tc.name);
		if (!tool) {
			const result = errResult(`Tool ${tc.name} not found`);
			await emit({ type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result, isError: true });
			thunks.push(async () => ({ tc, result, isError: true }));
			continue;
		}
		thunks.push(async () => {
			if (signal?.aborted) {
				const result = errResult("Operation aborted");
				await emit({ type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result, isError: true });
				return { tc, result, isError: true };
			}
			try {
				const result = await tool.execute(tc.id, tc.arguments, signal, (partialResult) => {
					void emit({ type: "tool_execution_update", toolCallId: tc.id, toolName: tc.name, args: tc.arguments, partialResult });
				});
				await emit({ type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result, isError: false });
				return { tc, result, isError: false };
			} catch (e) {
				const result = errResult(e.message);
				await emit({ type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result, isError: true });
				return { tc, result, isError: true };
			}
		});
	}
	const finalized = await Promise.all(thunks.map((f) => f())); // 并发：end 事件按完成先后
	const messages = [];
	for (const { tc, result, isError } of finalized) {          // 落盘消息按 assistant 源序
		const msg = { role: "toolResult", toolCallId: tc.id, toolName: tc.name,
			content: result.content, details: result.details, isError, timestamp: Date.now() };
		context.messages.push(msg);
		await emit({ type: "message_start", message: msg });
		await emit({ type: "message_end", message: msg });
		messages.push(msg);
	}
	return messages;
}

// ---------- 7. 双层循环骨架（对应 agent-loop.ts runLoop 的简化版） ----------
async function runAgentLoop(promptMessage, context, config, signal, emit, streamFn) {
	const newMessages = [];
	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const m of [promptMessage]) {
		context.messages.push(m); newMessages.push(m);
		await emit({ type: "message_start", message: m });
		await emit({ type: "message_end", message: m });
	}
	let hasMoreToolCalls = true, pending = [], firstTurn = true;
	while (hasMoreToolCalls || pending.length) {
		if (!firstTurn) await emit({ type: "turn_start" });
		firstTurn = false;
		for (const m of pending) {
			context.messages.push(m); newMessages.push(m);
			await emit({ type: "message_start", message: m });
			await emit({ type: "message_end", message: m });
		}
		pending = [];
		const message = await streamAssistantResponse(context, signal, emit, streamFn);
		newMessages.push(message);
		if (message.stopReason === "error" || message.stopReason === "aborted") { // 硬退出
			await emit({ type: "turn_end", message, toolResults: [] });
			await emit({ type: "agent_end", messages: newMessages });
			return newMessages;
		}
		const toolResults = message.content.some((c) => c.type === "toolCall")
			? await executeToolCalls(context, message, signal, emit) : [];
		for (const r of toolResults) newMessages.push(r);
		hasMoreToolCalls = toolResults.length > 0;
		await emit({ type: "turn_end", message, toolResults });
		pending = (await config.getSteeringMessages?.()) ?? [];
	}
	await emit({ type: "agent_end", messages: newMessages });
	return newMessages;
}

// ---------- 8. 事件打印 ----------
let t0 = Date.now();
function printer(label) {
	return async (ev) => {
		const d = Date.now() - t0;
		const at = (n = 44) => " ".repeat(Math.max(0, n - ev.type.length));
		let detail = "";
		if (ev.type === "message_start" || ev.type === "message_end") {
			detail = ev.message.role + (ev.message.role === "assistant" ? `(${ev.message.stopReason})` : "") +
				(ev.message.role === "toolResult" ? ` ${ev.message.toolName}#${ev.message.toolCallId}` : "") +
				(ev.message.isError === undefined ? "" : ` isError=${ev.message.isError}`);
		} else if (ev.type.startsWith("tool_execution")) {
			detail = `${ev.toolName}#${ev.toolCallId}` + (ev.isError === undefined ? "" : ` isError=${ev.isError}`);
		} else if (ev.type === "agent_end") {
			detail = `transcript=${ev.messages.length} new msgs`;
		} else if (ev.type === "turn_end") {
			detail = `toolResults=${ev.toolResults.length}`;
		}
		console.log(`  ${label}[${String(d).padStart(4)}ms] ${ev.type}${at()}${detail}`);
	};
}

// ---------- 场景 A：一轮文本 + 两个并行工具（bash 在源序第 1、但完成更晚） ----------
console.log("=== 场景 A：文本 + 并行双工具（注意 tool_execution_end 与 toolResult 消息的顺序差异） ===");
t0 = Date.now();
{
	const context = { messages: [{ role: "system", content: "You are helpful.", timestamp: Date.now() }], tools };
	const streamFn = fauxProvider([
		{ respond: () => [
			{ text: "先看目录再读文件" },
			{ toolCall: { id: "tc_bash", name: "bash", arguments: { command: "ls | wc -l", slowMs: 60 } } },
			{ toolCall: { id: "tc_read", name: "read", arguments: { path: "config.json" } } },
		] },
		{ respond: () => [{ text: "共 42 个文件，config 里 model=faux。" }] },
	]);
	await runAgentLoop({ role: "user", content: [{ type: "text", text: "统计文件数并读配置" }], timestamp: Date.now() },
		context, {}, undefined, printer("A "), streamFn);
}

// ---------- 场景 B：abort 传播——bash 运行中调 abort() ----------
console.log("\n=== 场景 B：bash 执行中 abort（工具 reject + 下一轮 provider 直接 aborted） ===");
t0 = Date.now();
{
	const controller = new AbortController();
	const context = { messages: [{ role: "system", content: "You are helpful.", timestamp: Date.now() }], tools };
	const streamFn = fauxProvider([
		{ respond: () => [{ text: "开始跑长命令" }, { toolCall: { id: "tc_long", name: "bash", arguments: { command: "sleep 1", slowMs: 400 } } }] },
	]);
	const run = runAgentLoop({ role: "user", content: [{ type: "text", text: "跑个慢命令" }], timestamp: Date.now() },
		context, {}, controller.signal, printer("B "), streamFn);
	setTimeout(() => { console.log("  >>> 用户按下 abort()"); controller.abort(); }, 150);
	const newMessages = await run;
	const tail = newMessages[newMessages.length - 1];
	const kept = newMessages.filter((m) => m.role === "assistant")
		.map((m) => m.content.filter((c) => c.type === "text").map((c) => c.text).join(""))
		.filter(Boolean).join(" / ");
	console.log(`  结束：最后一条 assistant stopReason=${tail.stopReason} errorMessage="${tail.errorMessage ?? ""}"`);
	console.log(`  transcript 保留的部分文本: [${kept}]`);
}
