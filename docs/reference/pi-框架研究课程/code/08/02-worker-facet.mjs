// 02-worker-facet.mjs — 子进程里的"agent-worker facet"：持有权威 replicated state，
// 按 JSONL 行协议应答 subscribe / invoke，变更即发布 seq 递增的完整不可变快照。
// 语义对照 packages/chord/README.md（Replicated state）与 packages/protocol/README.md（帧），
// 真实系统用 CBOR 帧 + 路径化 delta 批；此处为行协议 + 全值快照的教学迷你版。

import { createInterface } from "node:readline";

let seq = 0;
let state = { transcript: [], status: "idle" }; // 权威值：strict JSON
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

// change(): 原子 copy-on-write —— 回调抛出则原值与原 seq 不变（README 语义）
function change(mutator) {
  const draft = structuredClone(state);
  mutator(draft);
  state = Object.freeze(draft);
  return { seq: ++seq, value: state };
}

const services = {
  agent: {
    prompt: (text) => {
      const rev = change((d) => { d.transcript.push({ role: "user", text }); d.status = "running"; });
      send({ type: "event", kind: "state-update", ...rev });
      const reply = `worker(echo): ${text.toUpperCase()}`;
      const rev2 = change((d) => { d.transcript.push({ role: "assistant", text: reply }); d.status = "idle"; });
      send({ type: "event", kind: "state-update", ...rev2 });
      return reply;
    },
  },
};

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  try {
    if (msg.type === "subscribe") {
      send({ type: "event", kind: "state-snapshot", seq, value: state }); // 完整基线
    } else if (msg.type === "invoke") {
      const result = services[msg.service][msg.member](...msg.args);
      send({ type: "response", id: msg.id, ok: true, result });
    } else {
      send({ type: "response", id: msg.id, ok: false, error: `unknown: ${msg.type}` });
    }
  } catch (e) {
    send({ type: "response", id: msg.id, ok: false, error: String(e) });
  }
});
