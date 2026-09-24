// 03-steering.mjs
// 演示运行中向队列注入消息：steering（当前轮工具跑完后插入）与 follow-up（agent 本来要停时才消费），
// 以及 one-at-a-time 队列模式如何把两条排队消息拆到两个 drain 点。
// 概念对应 packages/agent/src/agent.ts 的 PendingMessageQueue 与 agent-loop.ts runLoop 的 drain 点。
// 运行：node 03-steering.mjs   (Node >= 20)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- PendingMessageQueue（对应 agent.ts 同名类：mode 决定一次 drain 几条） ----------
class PendingMessageQueue {
	messages = [];
	constructor(mode) { this.mode = mode; }
	enqueue(m) { this.messages.push(m); }
	hasItems() { return this.messages.length > 0; }
	drain() {
		const taken = this.mode === "all" ? this.messages.slice() : this.messages.slice(0, 1);
		this.messages = this.messages.slice(taken.length);
		return taken;
	}
}

// ---------- faux provider：脚本化 4 轮 ----------
function fauxProvider(script) {
	let i = 0;
	return async (messages) => {
		const msg = {
			role: "assistant", content: [], api: "faux", provider: "faux", model: "mini",
			usage: { input: 0, output: 0, totalTokens: 0 }, stopReason: "stop", errorMessage: "", timestamp: Date.now(),
		};
		for (const item of script[i++] ?? [{ text: "…" }]) {
			if (item.text !== undefined) msg.content.push({ type: "text", text: item.text });
			else msg.content.push({ type: "toolCall", ...item.toolCall });
		}
		msg.stopReason = msg.content.some((c) => c.type === "toolCall") ? "toolUse" : "stop";
		return msg;
	};
}

// ---------- 迷你 Agent：队列 + 双层循环 + drain 点日志 ----------
class MiniAgent {
	constructor({ streamFn, tools, steeringMode, followUpMode }) {
		this.context = { messages: [], tools };
		this.streamFn = streamFn;
		this.steeringQueue = new PendingMessageQueue(steeringMode ?? "one-at-a-time");
		this.followUpQueue = new PendingMessageQueue(followUpMode ?? "one-at-a-time");
		this.log = [];
	}
	steer(m) { this.steeringQueue.enqueue(m); this.note(`steer() 入队 "${textOf(m)}"（steering 队列=${this.steeringQueue.messages.length}）`); }
	followUp(m) { this.followUpQueue.enqueue(m); this.note(`followUp() 入队 "${textOf(m)}"（follow-up 队列=${this.followUpQueue.messages.length}）`); }
	note(s) { this.log.push("      " + s); console.log("      " + s); }

	async prompt(text) {
		const user = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
		this.log = []; console.log("  [loop] agent_start");
		// drain 点 0：循环启动时先捞一次 steering（“排队时用户又打字了”）
		let pending = this.steeringQueue.drain();
		console.log(`  [drain] 启动时 polling steering → ${pending.length} 条`);
		let hasMoreToolCalls = true;
		let firstTurn = true;
		while (true) {
			while (hasMoreToolCalls || pending.length > 0) {
				console.log("  [loop] turn_start");
				const toEmit = firstTurn ? [user, ...pending] : pending;
				firstTurn = false;
				for (const m of toEmit) {
					this.context.messages.push(m);
					console.log(`  [loop] message_start/end ${m.role}: "${textOf(m)}"`);
				}
				pending = [];
				const message = await this.streamFn(this.context.messages);
				this.context.messages.push(message);
				console.log(`  [loop] assistant(${message.stopReason}): "${textOf(message)}"`);
				const toolCalls = message.content.filter((c) => c.type === "toolCall");
				const toolResults = [];
				for (const tc of toolCalls) {
					console.log(`  [loop] tool_execution_start ${tc.name}#${tc.id}`);
					const tool = this.context.tools.find((t) => t.name === tc.name);
					const result = await tool.execute(tc.id, tc.arguments); // 迷你版不演示 abort
					console.log(`  [loop] tool_execution_end ${tc.name}#${tc.id}`);
					const msg = { role: "toolResult", toolCallId: tc.id, toolName: tc.name,
						content: [{ type: "text", text: result }], details: {}, isError: false, timestamp: Date.now() };
					this.context.messages.push(msg);
					toolResults.push(msg);
				}
				console.log(`  [loop] turn_end toolResults=${toolResults.length}`);
				hasMoreToolCalls = toolResults.length > 0;
				// drain 点 1：本轮工具全部落地后，先看 steering
				pending = this.steeringQueue.drain();
				console.log(`  [drain] turn_end 后 polling steering(${this.steeringQueue.mode}) → 注入 ${pending.length} 条${pending.length ? ` "${pending.map(textOf).join(",")}"` : ""}，队列剩 ${this.steeringQueue.messages.length}`);
			}
			// drain 点 2：没有工具、没有 steering——agent 本来要停，才看 follow-up
			const followUps = this.followUpQueue.drain();
			console.log(`  [drain] 自然停止点 polling follow-up(${this.followUpQueue.mode}) → 注入 ${followUps.length} 条${followUps.length ? ` "${followUps.map(textOf).join(",")}"` : ""}`);
			if (followUps.length === 0) break;
			pending = followUps;
		}
		console.log("  [loop] agent_end");
	}
}

const textOf = (m) => (typeof m.content === "string" ? m.content
	: m.content.map((c) => c.text ?? `[toolCall ${c.name}]`).join(" "));

const tools = [{ name: "bash", execute: async () => { await sleep(60); return "42 files"; } }];

console.log("=== steering + follow-up：队列在三个 drain 点被消费（one-at-a-time） ===");
const agent = new MiniAgent({
	tools,
	streamFn: fauxProvider([
		[{ text: "开始统计文件" }, { toolCall: { id: "b1", name: "bash", arguments: { command: "ls | wc -l" } } }],
		[{ text: "收到，改按后缀统计" }],
		[{ text: "顺手把结果排序" }],
		[{ text: "最终总结：共 42 个文件，已排序输出。" }],
	]),
});

// 不等 prompt 完成：模拟用户看到 bash 在跑，边看边打字
const run = agent.prompt("统计项目文件数");
await sleep(20); // bash 正在执行中
agent.steer({ role: "user", content: [{ type: "text", text: "改用 *.ts 统计" }], timestamp: Date.now() });
await sleep(5);
agent.steer({ role: "user", content: [{ type: "text", text: "结果按数量排序" }], timestamp: Date.now() });
agent.followUp({ role: "user", content: [{ type: "text", text: "最后给我一段总结" }], timestamp: Date.now() });
await run;

console.log("\n=== transcript（模型看到的完整序列） ===");
for (const m of agent.context.messages) console.log(`  ${m.role.padEnd(10)} "${textOf(m)}"`);
console.log("\n说明：两条 steering 因 one-at-a-time 被拆到两个 turn_end 后注入；");
console.log("follow-up 直到没有工具、也没有 steering 时才消费——若改成 steeringMode:'all'，两条会同一轮注入。");
