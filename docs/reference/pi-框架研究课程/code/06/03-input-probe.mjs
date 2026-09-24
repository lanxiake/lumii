// 03-input-probe.mjs
// 按键解析探针：镜像 pi-tui 输入侧两层结构
//   - stdin-buffer.ts 的完整性判定 isCompleteSequence（complete/incomplete/not-escape）
//   - keys.ts 的语义解析（legacy 序列 + Kitty CSI-u，协议见
//     https://sw.kovidgoyal.net/kitty/keyboard-protocol/）
// TTY：raw mode 实时打印解析结果，Ctrl+C 退出。
// 非 TTY：用内置样例（含被拆包的序列）跑同一套解析器，退出码 0。

// ---- 第一层：序列完整性（stdin-buffer.ts 思路） ---------------------------
function isCompleteSequence(data) {
	if (!data.startsWith("\x1b")) return "not-escape";
	if (data.length === 1) return "incomplete";
	const a = data.slice(1);
	if (a.startsWith("[M")) return data.length >= 6 ? "complete" : "incomplete"; // 旧式鼠标
	if (a.startsWith("[")) {
		const last = a.charCodeAt(a.length - 1);
		return last >= 0x40 && last <= 0x7e ? "complete" : "incomplete"; // CSI 终结字节 @-~
	}
	if (a.startsWith("]")) return data.includes("\x07") || data.endsWith("\x1b\\") ? "complete" : "incomplete";
	if (a.startsWith("P")) return data.endsWith("\x1b\\") ? "complete" : "incomplete";
	if (a.startsWith("O")) return a.length >= 2 ? "complete" : "incomplete";
	return "complete"; // ESC + 单字符（alt+key）
}

function firstSequenceLength(data) {
	const a = data.slice(1);
	if (a.startsWith("[M")) return Math.min(6, data.length);
	if (a.startsWith("[")) {
		for (let i = 2; i < data.length; i++) {
			const c = data.charCodeAt(i);
			if (c >= 0x40 && c <= 0x7e) return i + 1;
		}
		return data.length;
	}
	if (a.startsWith("]")) {
		const bel = data.indexOf("\x07");
		const st = data.indexOf("\x1b\\");
		if (bel !== -1) return bel + 1;
		if (st !== -1) return st + 2;
		return data.length;
	}
	if (a.startsWith("O")) return Math.min(3, data.length);
	return 2;
}

class SeqAssembler {
	constructor(onSeq) { this.pending = ""; this.onSeq = onSeq; }
	feed(chunk) { this.pending += chunk; this.pump(false); }
	flush() { this.pump(true); } // 超时兜底：裸 ESC 判成 Esc 键（对应 10ms escape timeout）
	pump(force) {
		while (this.pending.length) {
			if (!this.pending.startsWith("\x1b")) {
				const idx = this.pending.indexOf("\x1b");
				const text = idx === -1 ? this.pending : this.pending.slice(0, idx);
				this.pending = idx === -1 ? "" : this.pending.slice(idx);
				this.onSeq(text);
				continue;
			}
			const st = isCompleteSequence(this.pending);
			if (st === "incomplete") {
				if (!force) return;
				this.onSeq("\x1b");
				this.pending = this.pending.slice(1);
				continue;
			}
			const len = firstSequenceLength(this.pending);
			this.onSeq(this.pending.slice(0, len));
			this.pending = this.pending.slice(len);
		}
	}
}

// ---- 第二层：语义解析（keys.ts 思路） -------------------------------------
const MOD_BITS = ["", "shift", "alt", "alt+shift", "ctrl", "ctrl+shift", "ctrl+alt", "ctrl+alt+shift"];
const modOf = (p) => (p ? MOD_BITS[(Number(p) - 1) & 7] : "");
const withMod = (m, name) => (m ? `${m}+${name}` : name);

function parseSequence(seq) {
	if (seq === "\x1b") return "escape";
	if (!seq.startsWith("\x1b")) {
		if (seq.length === 1 && seq.charCodeAt(0) < 32) {
			const c = seq.charCodeAt(0);
			if (c === 13) return "enter";
			if (c === 9) return "tab";
			if (c === 32) return "space";
			return "ctrl+" + String.fromCharCode(c + 96);
		}
		if (seq.length === 1 && seq.charCodeAt(0) === 127) return "backspace";
		return `text ${JSON.stringify(seq)}`;
	}
	if (seq === "\x1b[200~") return "bracketed paste START";
	if (seq === "\x1b[201~") return "bracketed paste END";
	let m;
	if ((m = /^\x1b\[<(\d+);(\d+);(\d+)([mM])$/.exec(seq)))
		return `mouse sgr btn=${m[1]} @(${m[2]},${m[3]}) ${m[4] === "M" ? "press" : "release"}`;
	if ((m = /^\x1bO([A-D])$/.exec(seq)))
		return { A: "up", B: "down", C: "right", D: "left" }[m[1]];
	if ((m = /^\x1b\[(\d*)(?:;(\d*))?([A-Za-z~])$/.exec(seq))) {
		const [, p1, p2, final] = m;
		const mod = modOf(p2);
		if (final === "A") return withMod(mod, "up");
		if (final === "B") return withMod(mod, "down");
		if (final === "C") return withMod(mod, "right");
		if (final === "D") return withMod(mod, "left");
		if (final === "H") return withMod(mod, "home");
		if (final === "F") return withMod(mod, "end");
		if (final === "Z") return "shift+tab";
		if (final === "~") {
			const names = { 1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageUp", 6: "pageDown", 7: "home", 8: "end" };
			return names[p1] ? withMod(mod, names[p1]) : `unknown ${show(seq)}`;
		}
		if (final === "u") {
			// Kitty CSI-u：码点 + 修饰位
			const code = Number(p1);
			const base = code === 13 ? "enter" : code === 9 ? "tab" : code === 27 ? "escape" : code === 127 ? "backspace" : code === 32 ? "space" : String.fromCodePoint(code);
			return withMod(mod, base);
		}
	}
	return `unknown ${show(seq)}`;
}

const show = (s) => s.replace(/\x1b/g, "\\e");

const esc = (s) =>
	'"' + s.replace(/\x1b/g, "\\e").replace(/\x03/g, "\\x03").replace(/\x7f/g, "\\x7f") + '"';

// ---- 主入口 ---------------------------------------------------------------
if (process.stdin.isTTY) {
	console.log("raw mode 探测中（Ctrl+C 退出）：");
	process.stdin.setRawMode(true);
	process.stdin.resume();
	const asm = new SeqAssembler((seq) => {
		console.log(`${esc(seq).padEnd(28)} → ${parseSequence(seq)}`);
		if (seq === "\x03") {
			process.stdin.setRawMode(false);
			process.exit(0);
		}
	});
	process.stdin.on("data", (d) => asm.feed(d.toString()));
} else {
	console.log("非 TTY 环境 → 用内置样例跑同一套解析器：\n");
	console.log("输入(转义)                        | 完整性            | 解析结果");
	console.log("-".repeat(78));
	const samples = [
		{ chunks: ["A"], note: "普通字符" },
		{ chunks: ["\x1b[A"], note: "方向键(PPA)" },
		{ chunks: ["\x1bOB"], note: "方向键(SS3)" },
		{ chunks: ["\x1b[3~"], note: "Delete" },
		{ chunks: ["\x1b[5~"], note: "PageUp" },
		{ chunks: ["\x1b[1;5C"], note: "Ctrl+Right" },
		{ chunks: ["\x1b[13;2u"], note: "Kitty shift+enter" },
		{ chunks: ["\x1b[200~"], note: "bracketed paste" },
		{ chunks: ["\x03"], note: "Ctrl+C(控制字符)" },
		{ chunks: ["\x7f"], note: "Backspace(DEL)" },
		{ chunks: ["\x1b[<35", ";20;5m"], note: "鼠标SGR被拆包" },
		{ chunks: ["\x1b[999Q"], note: "未知CSI" },
		{ chunks: ["\x1b"], note: "裸ESC→超时判Esc" },
	];
	for (const s of samples) {
		const events = [];
		const asm = new SeqAssembler((seq) => events.push(seq));
		for (const c of s.chunks) asm.feed(c);
		asm.flush();
		const completeness = s.chunks.length > 1 ? "incomplete→complete" : isCompleteSequence(s.chunks[0]);
		for (const seq of events) {
			console.log(`${esc(seq).padEnd(34)}| ${completeness.padEnd(17)} | ${parseSequence(seq)}   ← ${s.note}`);
		}
	}
	console.log("\n关键点：\\x1b[<35;20;5m 分两个 chunk 到达时，第一层判定 incomplete 并缓冲，");
	console.log("拼完整后才交给第二层——半个序列永远不会被误读成按键。");
}
