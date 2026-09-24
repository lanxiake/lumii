// client-sim.mjs
// 拉起 rpc-server-sim.mjs 子进程，扮演一个"任意语言"客户端，演示协议可被
// 纯 child_process + JSONL 实现（rpc.md 的卖点）。轨迹全程打印：→ 发出，← 收到。
// 场景覆盖正文 §5：get_state → prompt(事件流) → 流式中 steer → 流式中再 prompt
// 无 streamingBehavior 被拒 → 等两次 agent_settled → bash(输出流 + id 关联) →
// 二次 prompt 中途 abort → 故意发 malformed JSON → 关 stdin 有序退出。
// 全程事件驱动（等到什么才发什么），不靠 sleep 赌时序。
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("./rpc-server-sim.mjs", import.meta.url));
const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "inherit"] });

const waiters = [];
function waitFor(pred, what, ms = 5000) {
	return new Promise((resolve, reject) => {
		const w = { pred, resolve, what, timer: setTimeout(() => reject(new Error("timeout: " + what)), ms) };
		waiters.push(w);
	});
}

function write(obj) {
	console.log("→ " + JSON.stringify(obj));
	child.stdin.write(JSON.stringify(obj) + "\n");
}

let buf = "";
child.stdout.on("data", (d) => {
	buf += d.toString();
	for (;;) {
		const i = buf.indexOf("\n"); // 只按 LF 切（json.md：readline 不可用）
		if (i === -1) break;
		const line = buf.slice(0, i).replace(/\r$/, "");
		buf = buf.slice(i + 1);
		if (line) onRecord(JSON.parse(line));
	}
});
child.on("close", (code) => console.log(`[client] server exited code=${code}`));

function onRecord(r) {
	console.log("← " + JSON.stringify(r));
	for (let i = waiters.length - 1; i >= 0; i--) {
		if (waiters[i].pred(r)) {
			clearTimeout(waiters[i].timer);
			waiters[i].resolve(r);
			waiters.splice(i, 1);
		}
	}
}

// 1. 状态查询（response 按 id 关联）
write({ id: "req-1", type: "get_state" });
await waitFor((r) => r.type === "response" && r.id === "req-1", "get_state");

// 2. prompt：response 只代表 accepted（rpc.md §Run lifecycle）
write({ id: "req-2", type: "prompt", message: "Review this repository" });
await waitFor((r) => r.type === "response" && r.id === "req-2" && r.success === true, "prompt accepted");

// 3. 流式进行中：steer 入队 + queue_update（携带完整队列快照，json.md）
await waitFor((r) => r.type === "message_update", "first delta");
write({ id: "req-3", type: "steer", message: "重点看 packages/tui" });
await waitFor((r) => r.type === "queue_update", "queue_update");

// 4. 仍在流式：再 prompt 且不带 streamingBehavior → 单个错误 response
write({ id: "req-4", type: "prompt", message: "不带 streamingBehavior" });
await waitFor((r) => r.type === "response" && r.id === "req-4" && r.success === false, "prompt rejected");

// 5. 预注册"两次 settled"：run1 结束 + steer 交付的 run2 结束（agent_end≠settled）
let settles = 0;
await waitFor((r) => r.type === "agent_settled" && ++settles >= 2, "two settles");

// 6. bash：真实执行，输出以 bash_execution_update（复用命令 id）流式发出（rpc.md 关联规则）
write({ id: "req-5", type: "bash", command: "node --version" });
await waitFor((r) => r.type === "response" && r.id === "req-5" && r.success === true, "bash done");

// 7. 二次 prompt 中途 abort：事件流以 aborted 收尾，willRetry:false
//    注意：agent_end 与 agent_settled 可能落在同一个 stdout chunk 里同步到达，
//     waiter 必须在发 abort 之前预注册，否则第二个事件会被漏掉（真实客户端通病）
write({ id: "req-6", type: "prompt", message: "这轮会被中途 abort" });
await waitFor((r) => r.type === "message_update", "run2 first delta");
const endP = waitFor((r) => r.type === "agent_end" && r.willRetry === false, "agent_end");
const settledP = waitFor((r) => r.type === "agent_settled", "run2 settled");
write({ id: "req-7", type: "abort" });
await endP;
await settledP;

// 8. malformed JSON：无请求 id 的 parse response（rpc.md §Errors）
child.stdin.write("{not valid json\n");
await waitFor((r) => r.type === "response" && r.command === "parse" && r.success === false, "parse error");

// 9. 关闭 stdin = 请求有序关闭（rpc.md §Shutdown）
child.stdin.end();
await new Promise((r) => child.on("close", r));
console.log("[client] done");
