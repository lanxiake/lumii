# -*- coding: utf-8 -*-
"""以参考音频为音色基准，生成一首完整结构的歌"""
import os, sys, time
ROOT = r"E:\ai"
sys.path.insert(0, ROOT)

from acestep.inference import GenerationParams, GenerationConfig, generate_music
from acestep.handler import AceStepHandler
from acestep.llm_inference import LLMHandler

REF = r"E:\testsoft\Lumii-data\outputs\ace-step-1.5\audio\欢乐可爱动感-中文女声-40s.flac"
OUTDIR = r"E:\ai\gradio_outputs\fullsong"
os.makedirs(OUTDIR, exist_ok=True)

CAPTION = (
    "Upbeat cheerful cute pop song, bright bubbly young female vocal, "
    "energetic dance beat with handclaps, playful synth plucks and ukulele, "
    "catchy singalong hook, happy feel-good energetic, 128 BPM"
)

LYRICS = """[Intro]
[Instrumental]
[Verse]
太阳出来 晃呀晃
踩着节拍 一起去流浪
口袋里装满彩虹糖
今天谁都不许不开心
[Pre-Chorus]
把烦恼 都丢掉
跟着心跳 一起摇
[Chorus]
啦啦啦 转个圈
开心就要大声喊
蹦蹦跳跳 不怕晚
快乐是我们的超能力
[Verse]
风把云朵 吹成棉花糖
影子也跟着 一起摇晃
路边的小花 都在鼓掌
说今天 就该这样
[Pre-Chorus]
把烦恼 都丢掉
跟着心跳 一起摇
[Chorus]
啦啦啦 转个圈
开心就要大声喊
蹦蹦跳跳 不怕晚
快乐是我们的超能力
[Bridge]
就算明天 会有雨
今天的阳光 也值得记住
[Chorus]
啦啦啦 转个圈
开心就要大声喊
蹦蹦跳跳 不怕晚
快乐是我们的超能力
[Outro]
啦啦啦 啦啦啦
快乐是我们的超能力"""

print("加载模型 ...", flush=True)
t0 = time.time()
dit = AceStepHandler()
dit.initialize_service(project_root=ROOT, config_path="acestep-v15-turbo", device="cuda")
print(f"  DiT {time.time()-t0:.1f}s", flush=True)

t1 = time.time()
llm = LLMHandler()
llm.initialize(checkpoint_dir=os.path.join(ROOT, "checkpoints"),
               lm_model_path="acestep-5Hz-lm-1.7B", backend="pt", device="cuda")
print(f"  LM  {time.time()-t1:.1f}s", flush=True)

params = GenerationParams(
    caption=CAPTION,
    lyrics=LYRICS,
    vocal_language="zh",
    duration=120,
    bpm=128,
    inference_steps=8,
    thinking=True,
    seed=20261112,
    task_type="text2music",
    reference_audio=REF,
)
cfg = GenerationConfig(batch_size=1, audio_format="flac")

print("生成完整歌曲（目标 120s）...", flush=True)
t2 = time.time()
res = generate_music(dit, llm, params, cfg, save_dir=OUTDIR)
el = time.time() - t2

print(f"\n完成 {el:.1f}s", flush=True)
if getattr(res, "success", False):
    for a in res.audios:
        p = a["path"]
        import soundfile as sf
        i = sf.info(p)
        dst = os.path.join(OUTDIR, "完整歌曲-ref音色-120s.flac")
        os.replace(p, dst)
        print(f"  {dst}", flush=True)
        print(f"  {i.duration:.1f}s {i.samplerate}Hz {i.channels}ch", flush=True)
        print(f"  实时倍率 {el/i.duration:.2f}x", flush=True)
else:
    print("失败：", getattr(res, "error", "unknown"), flush=True)
    sys.exit(1)
