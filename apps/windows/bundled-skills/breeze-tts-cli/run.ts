import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { resolve } from "path";

// ─── 本机路径 ────────────────────────────────────────────────
const BREEZE_ROOT = "E:\\ai\\breeze-tts";
const BREEZE_MODEL = "E:\\ai\\breeze-tts-2";
const PYTHON = `${BREEZE_ROOT}\\.venv\\Scripts\\python.exe`;
const INFER_SCRIPT = `${BREEZE_ROOT}\\infer.py`;

// ─── 参数类型 ────────────────────────────────────────────────
interface BreezeParams {
  text?: string;
  instruction?: string;
  refAudio?: string;
  refText?: string;
  output?: string;
  cfgScale?: number;
  seed?: number;
  batch?: string;
  outputDir?: string;
  mode?: "design" | "clone";
}

// ─── 解析 CLI 参数 ───────────────────────────────────────────
function parseArgs(argv: string[]): BreezeParams {
  const p: BreezeParams = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--text")        p.text       = argv[++i];
    else if (a === "--instruction") p.instruction = argv[++i];
    else if (a === "--ref-audio")   p.refAudio   = argv[++i];
    else if (a === "--ref-text")    p.refText    = argv[++i];
    else if (a === "--output")      p.output     = argv[++i];
    else if (a === "--cfg-scale")   p.cfgScale   = parseFloat(argv[++i]);
    else if (a === "--seed")        p.seed       = parseInt(argv[++i]);
    else if (a === "--batch")       p.batch      = argv[++i];
    else if (a === "--output-dir")  p.outputDir  = argv[++i];
    else if (a === "--mode")        p.mode       = argv[++i] as any;
  }
  return p;
}

// ─── 环境检查 ────────────────────────────────────────────────
function checkEnv(): void {
  if (!existsSync(PYTHON))
    throw new Error(`Python venv 未找到: ${PYTHON}`);
  if (!existsSync(BREEZE_MODEL))
    throw new Error(`模型权重未找到: ${BREEZE_MODEL}\n请先运行 E:\\ai\\dl-breeze-model.sh`);
  if (!existsSync(INFER_SCRIPT))
    throw new Error(`infer.py 未找到: ${INFER_SCRIPT}`);
}

// ─── 核心：用参数数组调 infer.py，彻底避免 shell 引号/中文乱码 ──
function runInfer(args: string[]): void {
  const result = spawnSync(
    PYTHON,
    [INFER_SCRIPT, BREEZE_MODEL, ...args],
    {
      cwd: BREEZE_ROOT,
      stdio: "inherit",
      encoding: "utf-8",
      windowsHide: true,
    }
  );

  if (result.status !== 0) {
    throw new Error(`infer.py 退出码 ${result.status}`);
  }
}

// ─── 单条生成（Voice Design / Direction）───────────────────
function generateSingle(p: BreezeParams): void {
  if (!p.text)   throw new Error("--text 必需");
  if (!p.output) throw new Error("--output 必需");

  const args = ["--text", p.text, "--output", p.output];
  if (p.instruction) args.push("--instruction", p.instruction);
  if (p.cfgScale !== undefined) args.push("--cfg-scale", String(p.cfgScale));
  if (p.seed     !== undefined) args.push("--seed",      String(p.seed));

  console.log(`[Breeze] 生成: "${p.text.slice(0, 60)}"`);
  if (p.instruction) console.log(`[指令]  "${p.instruction}"`);
  console.log(`[输出]  ${p.output}`);

  runInfer(args);
  console.log(`✅ 已保存: ${p.output}`);
}

// ─── 克隆模式 ────────────────────────────────────────────────
function generateClone(p: BreezeParams): void {
  if (!p.text)     throw new Error("--text 必需");
  if (!p.output)   throw new Error("--output 必需");
  if (!p.refAudio) throw new Error("克隆模式需要 --ref-audio");
  if (!p.refText)  throw new Error("克隆模式需要 --ref-text");

  const args = [
    "--ref-audio", resolve(p.refAudio),
    "--ref-text",  p.refText,
    "--text",      p.text,
    "--output",    p.output,
  ];
  if (p.instruction) args.push("--instruction", p.instruction);
  if (p.cfgScale !== undefined) args.push("--cfg-scale", String(p.cfgScale));
  if (p.seed     !== undefined) args.push("--seed",      String(p.seed));

  console.log(`[Breeze] 克隆模式: "${p.text.slice(0, 60)}"`);
  runInfer(args);
  console.log(`✅ 已保存: ${p.output}`);
}

// ─── 批量模式 ────────────────────────────────────────────────
function generateBatch(p: BreezeParams): void {
  if (!p.batch)     throw new Error("--batch 必需");
  if (!p.outputDir) throw new Error("--output-dir 必需");
  if (!existsSync(p.batch)) throw new Error(`批量文件不存在: ${p.batch}`);

  mkdirSync(p.outputDir, { recursive: true });

  const lines = readFileSync(p.batch, "utf-8")
    .split(/\r?\n/)
    .filter(l => l.trim() && !l.startsWith("#"));

  console.log(`[Breeze] 批量生成 ${lines.length} 条`);

  let idx = 1;
  for (const line of lines) {
    const [text, instruction] = line.split("|").map(s => s.trim());
    if (!text || !instruction) {
      console.warn(`⚠️  跳过: ${line}`);
      continue;
    }
    const output = resolve(p.outputDir, `batch_${String(idx).padStart(3, "0")}.wav`);
    console.log(`  [${idx}/${lines.length}] ${text.slice(0, 40)}`);
    try {
      generateSingle({ text, instruction, output, cfgScale: p.cfgScale, seed: p.seed });
      idx++;
    } catch (e) {
      console.error(`  ❌ 失败: ${e}`);
    }
  }
  console.log(`✅ 批量完成: ${p.outputDir}`);
}

// ─── 入口 ────────────────────────────────────────────────────
function main() {
  try {
    checkEnv();
    const p = parseArgs(process.argv.slice(2));

    if (p.batch) {
      generateBatch(p);
    } else if (p.mode === "clone" || p.refAudio) {
      generateClone(p);
    } else {
      generateSingle(p);
    }
  } catch (e) {
    console.error(`❌ ${e}`);
    process.exit(1);
  }
}

main();
