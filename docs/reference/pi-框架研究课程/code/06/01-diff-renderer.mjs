// 01-diff-renderer.mjs
// 迷你 retained-mode 终端渲染器：镜像 pi-tui TuiMainScreen 的核心差分语义
// （见 packages/tui/src/tui-main-screen.ts doRender）：
//   - 上一帧行数组作基线，逐行比较 firstChanged/lastChanged
//   - 只重写变化行带，每行 \x1b[2K；整帧用 CSI ?2026 包裹
//   - 退化路径：宽度变化 → 全量；firstChanged 高于视口 → 全量
//   - 用独立 MiniTerminal 仿真器逐帧校验落屏一致性
// 零依赖，node 01-diff-renderer.mjs 直接跑。

const BEGIN = "\x1b[?2026h";
const END = "\x1b[?2026l";

// ---------------------------------------------------------------------------
// MiniTerminal: 只会解释本脚本生成的那几种序列，用于校验差分结果
// ---------------------------------------------------------------------------
class MiniTerminal {
	constructor(cols, rows) {
		this.cols = cols;
		this.rows = rows;
		this.screen = Array.from({ length: rows }, () => "");
		this.scrollbackLines = 0;
		this.cursorRow = 0; // 屏幕内行号 (0..rows-1)
		this.col = 0;
	}
	newline() {
		this.cursorRow++;
		if (this.cursorRow >= this.rows) {
			this.screen.shift();
			this.screen.push("");
			this.scrollbackLines++;
			this.cursorRow = this.rows - 1;
		}
		this.col = 0;
	}
	write(data) {
		let i = 0;
		while (i < data.length) {
			if (data.startsWith(BEGIN, i) || data.startsWith(END, i)) { i += 8; continue; }
			const mv = /^\x1b\[(\d+)([AB])/.exec(data.slice(i));
			if (mv) {
				const n = Number(mv[1]);
				this.cursorRow = Math.max(0, Math.min(this.rows - 1, this.cursorRow + (mv[2] === "B" ? n : -n)));
				this.col = 0;
				i += mv[0].length;
				continue;
			}
			if (data.startsWith("\x1b[2J\x1b[H", i)) {
				this.screen = Array.from({ length: this.rows }, () => "");
				this.cursorRow = 0; this.col = 0; i += 7; continue;
			}
			if (data.startsWith("\x1b[2K", i)) { this.screen[this.cursorRow] = ""; i += 4; continue; }
			if (data.startsWith("\r\n", i)) { this.newline(); i += 2; continue; }
			if (data[i] === "\r") { this.col = 0; i += 1; continue; }
			// 普通文本
			let text = "";
			while (i < data.length && data[i] !== "\x1b" && data[i] !== "\r" && data[i] !== "\n") {
				text += data[i++];
			}
			const row = this.screen[this.cursorRow];
			this.screen[this.cursorRow] = row.slice(0, this.col) + text + row.slice(this.col + text.length);
			this.col += text.length;
		}
	}
	visible() {
		return this.screen.map((l) => l.replace(/\s+$/, ""));
	}
}

// ---------------------------------------------------------------------------
// 渲染器状态（对应 TuiMainScreen 字段）
// ---------------------------------------------------------------------------
function createState(width) {
	return { previousLines: [], hardwareCursorRow: 0, previousViewportTop: 0, previousWidth: width };
}

function diffRender(state, nextLines, width, termRows) {
	const stats = { mode: "noop", firstChanged: -1, lastChanged: -1, rewroteLines: 0, bytes: "", ops: 0 };
	const widthChanged = state.previousWidth !== width && state.previousLines.length > 0;
	const prevViewportTop = Math.max(0, state.previousLines.length - termRows);

	const full = (reason) => {
		let buf = BEGIN + "\x1b[2J\x1b[H";
		for (let i = 0; i < nextLines.length; i++) {
			if (i > 0) buf += "\r\n";
			buf += nextLines[i];
		}
		buf += END;
		stats.mode = `full (${reason})`;
		stats.bytes = buf;
		stats.firstChanged = 0;
		stats.lastChanged = Math.max(0, nextLines.length - 1);
		stats.rewroteLines = nextLines.length;
		state.previousLines = [...nextLines];
		state.hardwareCursorRow = Math.max(0, nextLines.length - 1);
		state.previousViewportTop = Math.max(0, nextLines.length - termRows);
		state.previousWidth = width;
		return stats;
	};

	if (state.previousLines.length === 0) return full("first render");
	if (widthChanged) return full("width changed");
	if (nextLines.length < state.previousLines.length) return full("content shrunk");

	// 逐行比较
	let firstChanged = -1, lastChanged = -1;
	for (let i = 0; i < nextLines.length; i++) {
		if ((state.previousLines[i] ?? "") !== nextLines[i]) {
			if (firstChanged === -1) firstChanged = i;
			lastChanged = i;
		}
	}
	if (firstChanged === -1) return stats; // noop
	if (firstChanged < prevViewportTop) return full("firstChanged above viewport");

	// 差分路径
	let buf = BEGIN;
	let viewportTop = prevViewportTop;
	let cursorRow = state.hardwareCursorRow; // 文档行坐标
	const targetScreen = firstChanged - viewportTop;
	const currentScreen = cursorRow - viewportTop;
	if (targetScreen > termRows - 1) {
		const scroll = targetScreen - (termRows - 1);
		buf += "\r\n".repeat(scroll);
		viewportTop += scroll;
		cursorRow += scroll;
	}
	const diff = cursorRow - firstChanged;
	if (diff > 0) { buf += `\x1b[${diff}A`; stats.ops++; }
	else if (diff < 0) { buf += `\x1b[${-diff}B`; stats.ops++; }
	buf += "\r"; stats.ops++;
	for (let i = firstChanged; i <= lastChanged; i++) {
		if (i > firstChanged) { buf += "\r\n"; stats.ops++; }
		buf += "\x1b[2K"; stats.ops++;
		buf += nextLines[i]; stats.ops++;
	}
	buf += END;
	stats.mode = "diff";
	stats.firstChanged = firstChanged;
	stats.lastChanged = lastChanged;
	stats.rewroteLines = lastChanged - firstChanged + 1;
	stats.bytes = buf;
	state.previousLines = [...nextLines];
	state.hardwareCursorRow = lastChanged;
	state.previousViewportTop = viewportTop;
	state.previousWidth = width;
	return stats;
}

// ---------------------------------------------------------------------------
// 场景 1：流式输出——最后一行逐帧追加 token
// ---------------------------------------------------------------------------
const COLS = 58, ROWS = 24;
let doc = ["pi> 研究笔记：pi-tui 差分渲染", "", "user: 流式回答时一帧到底要写多少字节？"];
for (const t of ["assistant: 差分渲染器只重写", "firstChanged..lastChanged", "行带，spinner 动画时", "每帧只写一行；", "而全量重绘每帧都要", "重写整个文档。", "写盘量正比于变化行宽，", "而不是会话长度。"]) doc.push(doc.at(-1).includes("assistant") ? doc.at(-1) + " " + t : t);
doc[doc.length - 1] = "assistant: 差分渲染器只重写 firstChanged..lastChanged 行带，spinner 动画时 每帧只写一行； 而全量重绘每帧都要 重写整个文档。 写盘量正比于变化行宽， 而不是会话长度。";

let term = new MiniTerminal(COLS, ROWS);
let state = createState(COLS);
let tokens = "这就是 pi 敢把整屏历史留在内存里的底气 — diff 让流式输出的边际成本恒定。".split(" ");
console.log("=== 场景 1：流式追加（终端 24 行 × 58 列）===");
console.log("frame  mode  firstChanged  rewroteLines  diffBytes  fullRedrawBytes  diff/full");
let allOk = true;
for (let f = 1; f <= tokens.length + 4; f++) {
	const next = [...doc];
	if (f <= tokens.length) {
		next[next.length - 1] = next.at(-1) + (f === 1 ? tokens[0] : " " + tokens[f - 1]);
	} else if (f === tokens.length + 2) {
		next.push("(下一帧换行追加新行)");
	} else if (f === tokens.length + 4) {
		next[next.length - 1] += " 新行也继续增长...";
	} else continue;
	doc = next;
	const st = diffRender(state, next, COLS, ROWS);
	term.write(st.bytes);
	const top = Math.max(0, next.length - ROWS);
	const expect = next.slice(top);
	// 内容短于屏幕时行贴在屏幕顶部；滚动后屏底对齐最后一行（expect 长即整屏）
	const got = term.visible().slice(0, expect.length);
	const ok = got.every((l, i) => l === expect[i]);
	allOk &&= ok;
	const fullBytes = BEGIN.length + next.join("\r\n").length + END.length + 7;
	if (f % 3 === 1 || f > tokens.length) {
		console.log(
			`${String(f).padStart(3)}   ${st.mode.padEnd(28)} ${String(st.firstChanged).padStart(4)}  ${String(st.rewroteLines).padStart(6)}  ${String(st.bytes.length).padStart(7)}  ${String(fullBytes).padStart(9)}  ${(st.bytes.length / fullBytes).toFixed(2)}`,
		);
	}
}
console.log(`逐帧落屏一致性校验: ${allOk ? "PASS" : "FAIL"}`);

// ---------------------------------------------------------------------------
// 场景 2：退化路径 A——终端宽度变化
// ---------------------------------------------------------------------------
console.log("\n=== 场景 2：cols 58 -> 48（折行全变）===");
{
	const st = diffRender(state, [...doc, "> 用户新输入一行"], 48, ROWS);
	console.log(`mode = ${st.mode}, rewroteLines = ${st.rewroteLines}, bytes = ${st.bytes.length}`);
}

// ---------------------------------------------------------------------------
// 场景 3：退化路径 B——修改一个已滚出视口的旧行
// ---------------------------------------------------------------------------
console.log("\n=== 场景 3：内容远超视口后，改动第 0 行（视口之上）===");
{
	state = createState(COLS);
	const long = Array.from({ length: 60 }, (_, i) => `line ${String(i).padStart(2)}: ${"x".repeat(20)}`);
	diffRender(state, long, COLS, ROWS); // 首帧
	console.log(`首帧: mode 应为 first render（上面已建新基线），viewportTop = ${state.previousViewportTop}`);
	long[0] = "line 00: !! 这行被改动，但它在视口之上";
	const st = diffRender(state, long, COLS, ROWS);
	console.log(`改动视口之上: mode = ${st.mode}, firstChanged = ${st.firstChanged}`);
	long[59] = "line 59: 改动视口内的行";
	const st2 = diffRender(state, long, COLS, ROWS);
	console.log(`改动视口之内: mode = ${st2.mode}, firstChanged = ${st2.firstChanged}, bytes = ${st2.bytes.length}`);
}
