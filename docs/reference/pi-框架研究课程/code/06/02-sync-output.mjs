// 02-sync-output.mjs
// 演示 pi-tui 的 CSI ?2026 同步输出帧提交（对应 tui-alt-screen.ts 的
// BEGIN_SYNCHRONIZED_OUTPUT / END_SYNCHRONIZED_OUTPUT 与 tui-main-screen.ts 的
// output.append("\x1b[?2026h") ... ("\x1b[?2026l")）：
//   - 一帧 = BEGIN + 若干清行/重写序列 + END
//   - 支持的终端把 begin/end 之间的写入缓冲起来，end 时一次性原子上屏（无撕裂）
//   - 不支持的终端按惯例忽略未知私有模式序列，行为退化为"无同步输出"，正确性不受影响
// 非 TTY 环境自动降级：打印将要发出的转义序列本身，保证 node 直接跑退出码 0。

const BEGIN = "\x1b[?2026h";
const END = "\x1b[?2026l";

// 迷你"上一帧行数组"，模拟差分渲染器的帧生成
function buildFrame(prev, next, height) {
	let buf = BEGIN;
	buf += "\x1b[H"; // 帧首回到左上（真实渲染器用相对移动，见 tui-main-screen.ts）
	for (let row = 0; row < height; row++) {
		const oldLine = prev[row] ?? "";
		const newLine = next[row] ?? "";
		if (oldLine === newLine) continue; // 未变的行零字节
		buf += `\x1b[${row + 1};1H\x1b[2K${newLine}`; // 绝对定位 + 清行 + 重写
	}
	buf += END;
	return buf;
}

const escape = (s) =>
	s.replace(/\x1b/g, "ESC").replace(/\r/g, "CR").replace(/\n/g, "LF");

const stream = ["pi> 流式回答中...", "差分只重写变化的那一行", "同步输出保证整帧原子可见"];
const height = 4;

let prev = [];
const frames = [];
for (let i = 1; i <= stream.length; i++) {
	frames.push({ lines: stream.slice(0, i), bytes: buildFrame(prev, stream.slice(0, i), height) });
	prev = stream.slice(0, i);
}

const isTTY = Boolean(process.stdout.isTTY);

if (isTTY) {
	// 真终端：逐帧发出（同步睡 400ms），2026 让每帧一次性出现
	const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	for (const f of frames) {
		process.stdout.write(f.bytes);
		sleep(400);
	}
	console.log("\n(3 帧已提交)");
} else {
	console.log("非 TTY 环境 → 打印每帧将发出的原始序列（ESC=\\x1b）：\n");
	for (const [i, f] of frames.entries()) {
		const diffLines = f.bytes.split("\x1b[2K").length - 1;
		console.log(`--- frame ${i + 1}: ${f.bytes.length} 字节, 重写 ${diffLines} 行 ---`);
		console.log(escape(f.bytes));
		console.log();
	}
	console.log("说明：");
	console.log(`- 每帧以 ${escape(BEGIN)} 开始、${escape(END)} 结束。`);
	console.log("- Ghostty/iTerm2/Kitty 等终端在 end 之前缓冲写入，一次性重绘 → 看不到中间态（无撕裂）。");
	console.log("- 老终端不认识 ?2026 私有模式，直接忽略这对序列：帧仍然正确，");
	console.log("  只是失去原子性——这正是 pi-tui 博客里 (almost) flicker-free 的由来。");
}
