// rpc-server-sim.mjs
// 一个按 packages/coding-agent/docs/rpc.md、rpc-commands.md、json.md 记录形状
// 实现的迷你"RPC 服务端"。字段取自 docs，非真实 pi 进程：
//   - 无模型、无 agent loop，prompt 触发的是脚本化事件序列
//   - 但帧语义严格照文档：LF-only 分帧、id 关联、accepted≠completed、
//     malformed JSON → 无 id 的 parse response、流式中 prompt 必须带
//     streamingBehavior、bash 的 bash_execution_update 复用命令 id、
//     关闭 stdin = 有序关闭
import { spawn } from "node:child_process";

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

let buffer = "";
let streaming = null; // { aborted: boolean } —— 当前是否有 run 在流式进行
const pending = []; // { message, behavior: "steer" | "followUp" }
let messageCount = 0;
let accText = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (;;) {
		const i = buffer.indexOf("\n"); // rpc.md：只按 LF 分帧；不要用 readline
		if (i === -1) break;
		const line = buffer.slice(0, i).replace(/\r$/, "");
		buffer = buffer.slice(i + 1);
		if (line) handleLine(line);
	}
});
process.stdin.on("end", () => process.exit(0)); // 关闭 stdin → 有序关闭（rpc.md §Shutdown）

function queueSnapshot() {
	return {
		steering: pending.filter((p) => p.behavior === "steer").map((p) => p.message),
		followUp: pending.filter((p) => p.behavior === "followUp").map((p) => p.message),
	};
}

function handleLine(line) {
	let cmd;
	try {
		cmd = JSON.parse(line);
	} catch {
		// malformed JSON → parse response，不带请求 id（rpc.md §Errors）
		return send({ type: "response", command: "parse", success: false, error: "Failed to parse command: invalid JSON" });
	}
	const { id, type } = cmd;
	switch (type) {
		case "get_state":
			// data 字段形状取自 rpc-commands.md get_state 示例（model 省略 cost 细节）
			return send({ id, type: "response", command: "get_state", success: true, data: {
				model: { provider: "faux", id: "faux-1", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
				thinkingLevel: "medium", isStreaming: Boolean(streaming), isCompacting: false,
				steeringMode: "all", followUpMode: "one-at-a-time",
				sessionId: "sim-session", autoCompactionEnabled: true,
				messageCount, pendingMessageCount: pending.length,
			} });
		case "prompt": {
			if (streaming) {
				// 流式中的 prompt 必须显式 streamingBehavior（rpc-commands.md §prompt）
				if (!cmd.streamingBehavior) {
					return send({ id, type: "response", command: "prompt", success: false, error: "Agent is streaming; specify streamingBehavior \"steer\" or \"followUp\"" });
				}
				pending.push({ message: cmd.message, behavior: cmd.streamingBehavior });
				send({ id, type: "response", command: "prompt", success: true });
				return send({ type: "queue_update", ...queueSnapshot() });
			}
			streaming = { aborted: false };
			send({ id, type: "response", command: "prompt", success: true }); // accepted ≠ completed
			startRun(cmd.message);
			return;
		}
		case "steer":
			pending.push({ message: cmd.message, behavior: "steer" });
			send({ id, type: "response", command: "steer", success: true });
			return send({ type: "queue_update", ...queueSnapshot() });
		case "bash": {
			// 真实执行命令；输出以 bash_execution_update 流式发出并复用命令 id（rpc.md 关联规则）
			const child = spawn(cmd.command, { shell: true });
			let out = "";
			const emit = (d) => { out += d.toString(); send({ id, type: "bash_execution_update", delta: d.toString() }); };
			child.stdout.on("data", emit);
			child.stderr.on("data", emit);
			child.on("close", (code) => send({ id, type: "response", command: "bash", success: true,
				data: { output: out, exitCode: code ?? 0, cancelled: false, truncated: false } }));
			return;
		}
		case "abort":
			if (streaming) streaming.aborted = true;
			return send({ id, type: "response", command: "abort", success: true });
		default:
			return send({ id, type: "response", command: type, success: false, error: `Unknown command: ${type}` });
	}
}

function startRun(messageText) {
	messageCount++;
	const ts = Date.now();
	send({ type: "agent_start" });
	send({ type: "turn_start" });
	const userMsg = { role: "user", content: messageText, timestamp: ts };
	send({ type: "message_start", message: userMsg });
	send({ type: "message_end", message: userMsg });
	const reply = `已收到「${messageText.slice(0, 20)}」；这是按 docs/json.md 编排的事件序列，不是模型输出。`;
	send({ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending", timestamp: ts } });
	accText = "";
	const words = reply.split(/(?<= )/);
	let i = 0;
	const tick = () => {
		if (streaming?.aborted) return finishRun(true, ts);
		if (i < words.length) {
			const delta = words[i++];
			accText += delta;
			// wire message_update 为 delta-only（json.md）：无累计 message、无 partial
			send({ type: "message_update", usage: { input: 12, output: i, cacheRead: 0, cacheWrite: 0, totalTokens: 12 + i, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
			return setTimeout(tick, 40);
		}
		finishRun(false, ts);
	};
	setTimeout(tick, 30);
}

function finishRun(aborted, userTs) {
	const assistantMsg = { role: "assistant", content: [{ type: "text", text: accText }],
		stopReason: aborted ? "aborted" : "stop", timestamp: Date.now() };
	send({ type: "message_end", message: assistantMsg });
	send({ type: "turn_end", message: assistantMsg, toolResults: [] });
	send({ type: "agent_end", messages: [{ role: "user", content: "(见 message_start)", timestamp: userTs }, assistantMsg], willRetry: false });
	send({ type: "agent_settled" }); // settled 才是"不会再自己继续"（json.md）
	streaming = null;
	const next = pending.shift();
	if (next) startRun(next.message);
}
