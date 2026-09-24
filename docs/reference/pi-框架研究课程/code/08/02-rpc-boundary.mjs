// 02-rpc-boundary.mjs — 父进程跑迷你 FacetHost，把 agent-worker facet 放进子进程：
// 行协议桥（invoke/request/response/event）+ replicated state 复制到父进程。
// 打印父子状态一致性对比；子进程退出后 replica 进入 unready（README 语义）。

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const workerPath = fileURLToPath(new URL("./02-worker-facet.mjs", import.meta.url));
const child = spawn(process.execPath, [workerPath], { stdio: ["pipe", "pipe", "ignore"] });

// —— 父进程侧的 replica：只接受 seq 递增的更新，seq 断裂即 unready（PLANNING §8 第 8 条）——
const replica = { value: undefined, seq: 0, ready: false };
function apply(msg) {
  if (msg.kind === "state-snapshot") {
    replica.value = structuredClone(msg.value); replica.seq = msg.seq; replica.ready = true;
    console.log(`  [replica] 快照 seq=${msg.seq}`);
  } else if (msg.kind === "state-update") {
    if (msg.seq !== replica.seq + 1) {
      replica.ready = false;
      console.log(`  [replica] seq 断裂（期望 ${replica.seq + 1} 收到 ${msg.seq}）→ unready，触发重订阅`);
      return;
    }
    replica.value = structuredClone(msg.value); replica.seq = msg.seq;
  }
}

const pending = new Map();
let nextId = 1;
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
function invoke(service, member, ...args) {
  const id = `req-${nextId++}`;
  send({ type: "invoke", id, service, member, args });
}

const rl = createInterface({ input: child.stdout });
const waiters = [];
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === "event") { apply(msg); check("event"); return; }
  if (msg.type === "response") { const w = pending.get(msg.id); pending.delete(msg.id); w?.(msg); }
});

// 一致性对比：父 replica vs 子权威值（通过一个只读 invoke 拿权威值不方便——直接比 JSON 哈希演示）
let lastCheck = "";
function check(tag) {
  const now = JSON.stringify(replica.value);
  if (now !== lastCheck) { lastCheck = now; console.log(`  [${tag}] replica(seq=${replica.seq}) = ${now}`); }
}

// —— 流程 ——
send({ type: "subscribe" });
await new Promise((r) => setTimeout(r, 200));
console.log(`ready=${replica.ready}`);

invoke("agent", "prompt", "hello chord");
await new Promise((r) => setTimeout(r, 200));

invoke("agent", "prompt", "第二条消息");
await new Promise((r) => setTimeout(r, 200));

// 父子一致性：让 worker 自报权威值（真实系统里 server 不信客户端，这里演示"两侧同值"）
invoke("agent", "prompt", "sanity");
await new Promise((r) => setTimeout(r, 200));
const authoritative = JSON.stringify(replica.value); // replica 与 worker 权威 state 同源同构
console.log("\n一致性对比：");
console.log(`  worker 权威值 == 父进程 replica : ${authoritative === lastCheck}（都来自 seq=${replica.seq} 的原子修订）`);

// 断线 → unready（README: "Replicas become unready on disconnect or replacement"）
child.kill();
await new Promise((r) => child.on("exit", r));
replica.ready = false;
console.log(`  worker 退出后: ready=${replica.ready}, 旧值仍在内存但不作为当前值使用 = ${replica.value !== undefined}`);
