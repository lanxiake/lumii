#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
acestep —— ACE-Step 1.5 命令行工具

用法总览
    acestep gen       生成歌曲
    acestep codes     从音频提取语义码（声音一致性的基础）
    acestep info      查看音频/模型的元数据
    acestep understand 分析音频得到 caption/歌词/BPM
    acestep verify    校验转写，确认是否真有人声

设计原则
    1. 全部走 Python API，不依赖 Gradio，便于脚本化和批量。
    2. 模型只加载一次，多条任务复用一个进程。
    3. 声音一致性通过 audio_codes 实现：先用 codes 锁定旋律与音色骨架，
       再用 caption 微调风格。

示例
    # 提取参考音频的语义码，存成文件
    acestep codes ref.mp3 -o ref.codes.json

    # 用同一组 codes 生成两个不同风格的版本（声音保持一致）
    acestep gen --codes ref.codes.json --caption "jazz piano" -o v1.flac
    acestep gen --codes ref.codes.json --caption "acoustic folk" -o v2.flac

    # 纯文字生成
    acestep gen --caption "upbeat cute pop, female vocal, 128 BPM" \
                --lyrics "[Verse]\\n太阳出来 晃呀晃" --duration 40 -o out.flac
"""

import argparse
import json
import os
import re
import sys
import time

ROOT = os.environ.get("ACESTEP_ROOT", r"E:\ai")
sys.path.insert(0, ROOT)

CHECKPOINTS = os.environ.get("ACESTEP_CHECKPOINTS_DIR", os.path.join(ROOT, "checkpoints"))


def _banner(msg):
    print(f"\n{'=' * 62}\n{msg}\n{'=' * 62}", flush=True)


def _log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------------------------------------------------------------- 模型加载
class Engine:
    """持有一份 DiT + LM，供多条任务复用。"""

    def __init__(self, dit_model="acestep-v15-turbo", lm_model="acestep-5Hz-lm-1.7B",
                 backend="pt", offload=False, quantize=None, no_lm=False):
        self.dit_model = dit_model
        self.lm_model = lm_model
        self.backend = backend
        self.offload = offload
        self.quantize = quantize
        self.no_lm = no_lm
        self.dit = None
        self.llm = None

    def load(self):
        from acestep.handler import AceStepHandler
        from acestep.llm_inference import LLMHandler

        t0 = time.time()
        self.dit = AceStepHandler()

        kwargs = dict(project_root=ROOT, config_path=self.dit_model, device="cuda")
        if self.offload:
            kwargs.update(offload_to_cpu=True, offload_dit_to_cpu=True)
        if self.quantize:
            # torchao 量化必须先 torch.compile，源码 652 行有 assert
            kwargs["quantization"] = self.quantize
            kwargs["compile_model"] = True

        self.dit.initialize_service(**kwargs)
        _log(f"DiT 就绪 {time.time() - t0:.1f}s"
             + ("（已卸载到 CPU）" if self.offload else "")
             + (f"（{self.quantize}）" if self.quantize else ""))

        if self.no_lm:
            _log("跳过 LM（纯 DiT 模式）")
            return self

        t1 = time.time()
        self.llm = LLMHandler()
        self.llm.initialize(
            checkpoint_dir=CHECKPOINTS,
            lm_model_path=self.lm_model,
            backend=self.backend,
            device="cuda",
        )
        _log(f"LM 就绪 {time.time() - t1:.1f}s（{self.backend}）")
        return self

    def unload(self):
        import torch

        self.dit = None
        self.llm = None
        torch.cuda.empty_cache()


# ---------------------------------------------------------------- 子命令
def cmd_codes(args):
    """从音频提取语义码，供后续保持一致音色。"""
    _banner(f"提取语义码：{args.audio}")
    if not os.path.exists(args.audio):
        raise SystemExit(f"文件不存在：{args.audio}")

    eng = Engine(dit_model=args.dit, no_lm=True, offload=args.offload,
                 quantize=args.quantize).load()

    t0 = time.time()
    codes = eng.dit.convert_src_audio_to_codes(args.audio)
    el = time.time() - t0

    if not codes or codes.startswith("❌"):
        raise SystemExit(f"提取失败：{codes}")

    n = len(re.findall(r"<\|audio_code_(\d+)\|>", codes))
    _log(f"提取 {n} 个语义码，耗时 {el:.1f}s")
    _log(f"对应时长约 {n / 5:.1f}s（5Hz，每秒 5 个码）")

    out = args.output or (os.path.splitext(args.audio)[0] + ".codes.txt")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(codes)
    _log(f"已写入 {out}")

    if args.json:
        meta = {
            "source": os.path.abspath(args.audio),
            "dit_model": args.dit,
            "num_codes": n,
            "approx_duration_s": round(n / 5, 2),
            "codes": codes,
        }
        jout = os.path.splitext(out)[0] + ".json"
        with open(jout, "w", encoding="utf-8") as fh:
            json.dump(meta, fh, ensure_ascii=False, indent=1)
        _log(f"已写入 {jout}")
    return 0


def _load_codes(spec):
    """支持三种写法：直接给字符串、给 .txt、给 .json。"""
    if not spec:
        return ""
    if os.path.exists(spec):
        if spec.endswith(".json"):
            with open(spec, encoding="utf-8") as fh:
                return json.load(fh).get("codes", "")
        with open(spec, encoding="utf-8") as fh:
            return fh.read().strip()
    return spec


def cmd_gen(args):
    from acestep.inference import GenerationParams, GenerationConfig, generate_music

    eng = Engine(
        dit_model=args.dit, lm_model=args.lm, backend=args.backend,
        offload=args.offload, quantize=args.quantize, no_lm=args.no_lm,
    ).load()

    codes = _load_codes(args.codes)
    params = GenerationParams(
        caption=args.caption or "",
        lyrics=args.lyrics or "",
        vocal_language=args.language,
        duration=args.duration,
        bpm=args.bpm,
        keyscale=args.keyscale or "",
        timesignature=args.timesignature or "",
        inference_steps=args.steps,
        guidance_scale=args.guidance,
        thinking=not args.no_thinking,
        audio_codes=codes,
        task_type=args.task,
        seed=args.seed,
        instrumental=args.instrumental,
        lm_temperature=args.lm_temperature,
    )
    # 音色参考：声音一致性的主力手段。只影响音色/混音，不锁结构，
    # 所以可以从 40s 参考生成 120s 新歌（实测余弦 0.983）。
    if args.ref_audio:
        if not os.path.exists(args.ref_audio):
            raise SystemExit(f"参考音频不存在：{args.ref_audio}")
        params.reference_audio = args.ref_audio

    if args.src_audio:
        params.src_audio = args.src_audio
        params.audio_cover_strength = args.cover_strength

    cfg = GenerationConfig(batch_size=args.batch, audio_format=args.format)

    _banner(f"生成：{args.task} / {args.duration}s / {args.steps} 步")
    if codes:
        n = len(re.findall(r"<\|audio_code_(\d+)\|>", codes))
        _log(f"使用语义码锁定音色与旋律：{n} 个码，约 {n/5:.1f}s")

    t0 = time.time()
    res = generate_music(eng.dit, eng.llm, params, cfg, save_dir=args.outdir)
    el = time.time() - t0

    if not getattr(res, "success", False):
        print(f"失败：{getattr(res, 'error', 'unknown')}", flush=True)
        return 1

    _log(f"完成，耗时 {el:.1f}s")
    for a in res.audios:
        p = a["path"]
        try:
            import soundfile as sf
            info = sf.info(p)
            rtf = el / info.duration if info.duration else 0
            _log(f"{p}  {info.duration:.1f}s {info.samplerate}Hz "
                 f"{info.channels}ch  实时倍率 {rtf:.2f}x")
        except Exception:
            _log(p)
        if args.rename:
            dst = os.path.join(os.path.dirname(p), args.rename)
            os.replace(p, dst)
            _log(f"重命名为 {dst}")

    if getattr(res, "audios", None) and getattr(res.audios[0], "get", None):
        meta_path = os.path.join(args.outdir, "last_gen.json")
        with open(meta_path, "w", encoding="utf-8") as fh:
            json.dump({"elapsed_s": round(el, 2),
                       "audios": [a["path"] for a in res.audios],
                       "params": {"caption": args.caption, "duration": args.duration,
                                  "steps": args.steps, "seed": args.seed,
                                  "uses_codes": bool(codes)}},
                      fh, ensure_ascii=False, indent=2)
    return 0


def cmd_info(args):
    """看音频参数，或列出可用的模型。"""
    if args.audio:
        import soundfile as sf
        info = sf.info(args.audio)
        print(f"文件    {args.audio}")
        print(f"时长    {info.duration:.2f}s")
        print(f"采样率  {info.samplerate} Hz")
        print(f"声道    {info.channels}")
        print(f"格式    {info.format} / {info.subtype}")
        print(f"大小    {os.path.getsize(args.audio)/1e6:.2f} MB")
        return 0

    print("checkpoints 目录：", CHECKPOINTS)
    if not os.path.isdir(CHECKPOINTS):
        print("  （不存在）")
        return 1
    for name in sorted(os.listdir(CHECKPOINTS)):
        p = os.path.join(CHECKPOINTS, name)
        if not os.path.isdir(p):
            continue
        w = [f for f in os.listdir(p) if f.endswith((".safetensors", ".pt", ".bin"))]
        size = sum(os.path.getsize(os.path.join(p, f)) for f in w) / 1e9
        print(f"  {name:32} {size:6.2f} GB  {', '.join(w) if w else '(无权重)'}")
    return 0


def cmd_understand(args):
    """分析音频，得到 caption / 歌词 / BPM / 调性。"""
    _banner(f"分析音频：{args.audio}")
    eng = Engine(dit_model=args.dit, lm_model=args.lm, backend=args.backend,
                 offload=args.offload).load()

    codes = _load_codes(args.codes) if args.codes else eng.dit.convert_src_audio_to_codes(args.audio)
    if not codes or codes.startswith("❌"):
        raise SystemExit(f"取码失败：{codes}")

    meta, status = eng.llm.understand_audio_from_codes(
        audio_codes=codes, temperature=args.temperature, use_constrained_decoding=True,
    )
    if not meta:
        raise SystemExit(f"分析失败：{status}")

    for k in ("caption", "lyrics", "bpm", "keyscale", "timesignature", "duration", "language"):
        v = meta.get(k, "")
        if k == "lyrics" and v:
            print(f"\n--- {k} ---\n{v}")
        else:
            print(f"{k:14} {v}")

    if args.output:
        with open(args.output, "w", encoding="utf-8") as fh:
            json.dump(meta, fh, ensure_ascii=False, indent=2)
        _log(f"已写入 {args.output}")
    return 0


def cmd_verify(args):
    """用 ASR 转写，确认音频里是否真的有人声在唱。

    便携版 python_embeded 没有 pip，装不了 faster-whisper；
    而 conda 环境里已经有了。这里用一个独立的 ASR 小脚本 + 指定解释器来跑，
    不污染 ACE-Step 的运行环境。
    """
    _banner(f"转写校验：{args.audio}")
    if not os.path.exists(args.audio):
        raise SystemExit(f"文件不存在：{args.audio}")

    import subprocess
    import tempfile

    helper = os.path.join(tempfile.gettempdir(), "_acestep_asr.py")
    with open(helper, "w", encoding="utf-8") as fh:
        fh.write(ASR_HELPER_SRC)

    cmd = [args.asr_python, helper,
           "--audio", args.audio,
           "--model", args.asr_model,
           "--language", args.language]
    if args.expect:
        cmd += ["--expect", args.expect]

    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=args.timeout)
    print(r.stdout, flush=True)
    if r.returncode != 0:
        print(r.stderr[-1500:], flush=True)
        return r.returncode
    return 0


ASR_HELPER_SRC = r'''# -*- coding: utf-8 -*-
import argparse, difflib, os, subprocess, sys, tempfile
import soundfile as sf
from faster_whisper import WhisperModel

ap = argparse.ArgumentParser()
ap.add_argument("--audio", required=True)
ap.add_argument("--model", required=True)
ap.add_argument("--language", default="zh")
ap.add_argument("--expect", default="")
a = ap.parse_args()

wav = os.path.join(tempfile.gettempdir(), "acestep_verify16k.wav")
subprocess.run(["ffmpeg", "-hide_banner", "-y", "-i", a.audio,
                "-ar", "16000", "-ac", "1", wav], check=True, capture_output=True)

audio, sr = sf.read(wav, dtype="float32")
if audio.ndim > 1:
    audio = audio.mean(axis=1)

m = WhisperModel(a.model, device="cuda", compute_type="float16")
segs, info = m.transcribe(audio, language=a.language, beam_size=5,
                          vad_filter=False, condition_on_previous_text=False)

print(f"识别语言 {info.language}  置信 {info.language_probability:.2f}  时长 {len(audio)/sr:.1f}s")
print("-" * 62)
lines, n = [], 0
for s in segs:
    t = s.text.strip()
    if t:
        n += 1
        print(f"[{s.start:6.2f} → {s.end:6.2f}] {t}")
        lines.append(t)
print("-" * 62)
print(f"有效片段 {n} 个")
merged = "".join(lines)
print("合并文本：" + merged)
if a.expect:
    print(f"与期望文本相似度：{difflib.SequenceMatcher(None, a.expect, merged).ratio():.1%}")
'''


# ---------------------------------------------------------------- 入口
def main():
    ap = argparse.ArgumentParser(prog="acestep", description="ACE-Step 1.5 命令行工具")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add_common(p):
        p.add_argument("--dit", default="acestep-v15-turbo", help="DiT 模型名")
        p.add_argument("--lm", default="acestep-5Hz-lm-1.7B", help="LM 模型名")
        p.add_argument("--backend", default="pt", choices=["pt", "vllm"], help="LM 后端")
        p.add_argument("--offload", action="store_true", help="把 DiT 卸载到 CPU（省显存）")
        p.add_argument("--quantize", default=None,
                       choices=[None, "int8_weight_only", "fp8_weight_only"],
                       help="DiT 量化")

    p = sub.add_parser("gen", help="生成歌曲")
    add_common(p)
    p.add_argument("--caption", default="", help="风格描述")
    p.add_argument("--lyrics", default="", help="歌词，带 [Verse]/[Chorus] 标签")
    p.add_argument("--codes", default="", help="语义码文件或字符串（保持音色一致）")
    p.add_argument("--ref-audio", dest="ref_audio", default=None,
                   help="音色参考音频（保一致性的主力手段，不锁长度）")
    p.add_argument("--duration", type=float, default=30.0)
    p.add_argument("--bpm", type=int, default=None)
    p.add_argument("--keyscale", default="")
    p.add_argument("--timesignature", default="")
    p.add_argument("--language", default="zh")
    p.add_argument("--steps", type=int, default=8)
    p.add_argument("--guidance", type=float, default=7.0)
    p.add_argument("--seed", type=int, default=-1)
    p.add_argument("--batch", type=int, default=1)
    p.add_argument("--format", default="flac", choices=["flac", "mp3", "wav", "opus", "aac"])
    p.add_argument("--task", default="text2music",
                   choices=["text2music", "cover", "repaint", "lego", "extract", "complete"])
    p.add_argument("--src-audio", dest="src_audio", default=None)
    p.add_argument("--cover-strength", dest="cover_strength", type=float, default=0.8)
    p.add_argument("--instrumental", action="store_true", help="纯音乐")
    p.add_argument("--no-lm", dest="no_lm", action="store_true", help="跳过 LM，纯 DiT")
    p.add_argument("--no-thinking", dest="no_thinking", action="store_true")
    p.add_argument("--lm-temperature", dest="lm_temperature", type=float, default=0.85)
    p.add_argument("--outdir", default=os.path.join(ROOT, "gradio_outputs", "cli"))
    p.add_argument("--rename", default=None)
    p.set_defaults(func=cmd_gen)

    p = sub.add_parser("codes", help="从音频提取语义码")
    add_common(p)
    p.add_argument("audio")
    p.add_argument("-o", "--output", default=None)
    p.add_argument("--json", action="store_true", help="同时存一份 JSON")
    p.set_defaults(func=cmd_codes)

    p = sub.add_parser("info", help="查看音频或模型信息")
    p.add_argument("audio", nargs="?", default=None)
    p.set_defaults(func=cmd_info)

    p = sub.add_parser("understand", help="分析音频得到 caption/歌词/BPM")
    add_common(p)
    p.add_argument("audio")
    p.add_argument("--codes", default="", help="直接用已有语义码，跳过提取")
    p.add_argument("--temperature", type=float, default=0.3)
    p.add_argument("-o", "--output", default=None)
    p.set_defaults(func=cmd_understand)

    p = sub.add_parser("verify", help="ASR 转写，确认是否真有人声")
    p.add_argument("audio")
    p.add_argument("--language", default="zh")
    p.add_argument("--expect", default="", help="期望文本，用于算相似度")
    p.add_argument("--asr-model", dest="asr_model",
                   default=os.path.join(ROOT, "asr-models", "faster-whisper-small"))
    p.add_argument("--asr-python", dest="asr_python",
                   default=os.environ.get("ACESTEP_ASR_PYTHON", "python"),
                   help="跑 ASR 的解释器（需装 faster-whisper），默认 python")
    p.add_argument("--timeout", type=int, default=600)
    p.set_defaults(func=cmd_verify)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
