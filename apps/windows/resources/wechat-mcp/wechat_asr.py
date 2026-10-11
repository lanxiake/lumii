# -*- coding: utf-8 -*-
"""本地语音转写：微信 SILK → PCM → Paraformer → 文字（**全本地，不外传**）。

给 MCP 的 `transcribe_voice` 用。基础版没有这个工具，高级版才有。

管线与参数都是**实测定下来的**（2026-10-11，本机）：
- 解码用 `pilk`（SILK_V3 → PCM s16le）；
- 识别用 `sherpa-onnx` 的离线 Paraformer，模型与 App 侧**同一个**
  （sherpa 注入过 metadata 的那版，FunASR 原版会原生 abort）；
- **按原生率解码、再按同一率声明喂进去**：`pilk` 的 `pcm_rate` 会重采样，
  实测「解 16k 喂 16k」与「解 24k 喂 24k」结果几乎一致，
  但「解 24k 却声明成 16k」会因时间轴错位而**明显变差**
  （同一句真话，正确喂法 `该系统的默认设定你觉得你可以有自己的名字吗`，
  错喂法给出 `而系统的目能思地你觉得你可以用自己的名字吗`）。
  选 24k 那条：少一次重采样，交给 sherpa 的重采样器。

实测质量（本机 6 条真语音）：`使用生成绘本技能再生成一个绘本先和我讨论一下故事`、
`你使用录屏功能将你上面制作这个绘本的过程录制下来作为一个教学课程` —— 连贯可用。
每条 3 秒语音约 0.5 秒转完。
"""
import os
import sys
import threading

# pilk 解码的原生率；喂给识别器时声明的也是它（见模块头注释，**别改成 16k**）
SAMPLE_RATE = 24000
# 模型文件名（与 App 侧 model-manager 的清单一致）
MODEL_FILES = ("model.int8.onnx", "tokens.txt")
# 模型下载源：国内镜像优先，GitHub 兜底（两条都在 App 侧验证过可用）
MODEL_BASE = {
    "https://hf-mirror.com/csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09/resolve/main/":
        MODEL_FILES,
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"
    "sherpa-onnx-paraformer-zh-small-2024-03-09/": MODEL_FILES,
}

_lock = threading.Lock()
_recognizer = None


def model_dir():
    """模型目录。

    默认复用**灵栖已经下好的那份**（装了灵栖的机器上它就在那儿，不必再下一遍 78MB）；
    独立用户可用 `LUMII_WECHAT_ASR_MODEL` 指向别处，或跑 `--download-asr-model` 下到这里。
    """
    env = os.environ.get("LUMII_WECHAT_ASR_MODEL")
    if env:
        return env
    return os.path.join(os.path.expanduser("~"), ".lumii", "models", "voice", "asr", "paraformer-zh-small")


def _missing_files(d):
    return [f for f in MODEL_FILES if not os.path.exists(os.path.join(d, f))]


def deps():
    """依赖自检（不导入，避免副作用）。`check_env` 里会带上。"""
    import importlib.util as iu
    found = {m: iu.find_spec(m) is not None for m in ("pilk", "sherpa_onnx", "numpy")}
    return {**found, "ok": all(found.values())}


def available():
    """能不能转写。返回 `(True, "")` 或 `(False, 给用户看的原因)`。"""
    d = deps()
    if not d["ok"]:
        miss = [k for k, v in d.items() if k != "ok" and not v]
        return False, f"缺少依赖 {miss}（装法见 requirements.txt）"
    d_ = model_dir()
    miss = _missing_files(d_)
    if miss:
        return False, (f"ASR 模型不完整：{d_} 缺 {miss}。"
                       f"跑 `wechat-mcp.exe --download-asr-model` 下载（约 78MB），"
                       f"或用 LUMII_WECHAT_ASR_MODEL 指向已有模型目录")
    return True, ""


def _load():
    """惰性加载识别器（首次约 1 秒，之后常驻）。"""
    global _recognizer
    with _lock:
        if _recognizer is not None:
            return _recognizer
        import sherpa_onnx
        d = model_dir()
        _recognizer = sherpa_onnx.OfflineRecognizer.from_paraformer(
            paraformer=os.path.join(d, "model.int8.onnx"),
            tokens=os.path.join(d, "tokens.txt"),
            # 与 App 侧 `asr-engine.ts` 的 numThreads 对齐。
            # （实测 2 与 4 给出**完全相同**的结果，所以这里纯属对齐，不影响正确性；
            #  别被"换个线程数结果就变了"带偏——那种差异多半是**喂法**不对，见模块头注释。）
            num_threads=4,
            sample_rate=16000,        # 识别器内部工作率；输入端由 accept_waveform 声明实际率
            feature_dim=80,
            decoding_method="greedy_search",
            debug=False,
        )
        return _recognizer


def transcribe(silk_path):
    """SILK 文件 → 文字。失败抛异常（调用方转成结构化错误，**不要吞**）。"""
    import numpy as np
    import pilk
    rec = _load()
    pcm_path = silk_path + f".{SAMPLE_RATE}.pcm"
    try:
        pilk.decode(silk_path, pcm_path, pcm_rate=SAMPLE_RATE)
        with open(pcm_path, "rb") as f:
            raw = f.read()
    finally:
        try:
            os.remove(pcm_path)
        except OSError:
            pass
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    stream = rec.create_stream()
    stream.accept_waveform(SAMPLE_RATE, samples)
    rec.decode_stream(stream)
    return (stream.result.text or "").strip()


def download_model(progress=None):
    """把模型下到 `model_dir()`。已存在的不重复下（断点重来只补缺的）。

    没有做成"首次调用自动下载"：78MB 悄悄下会让人以为卡了，且离线环境会白等。
    显式跑 `--download-asr-model`。
    """
    import urllib.request
    d = model_dir()
    os.makedirs(d, exist_ok=True)
    say = progress or (lambda m: print(m, file=sys.stderr, flush=True))
    for name in MODEL_FILES:
        dest = os.path.join(d, name)
        if os.path.exists(dest):
            say(f"已存在，跳过：{name}")
            continue
        last_err = None
        for base in MODEL_BASE:
            url = base + name
            try:
                say(f"下载 {name} ← {base.split('/')[2]}")
                tmp = dest + ".part"
                with urllib.request.urlopen(url, timeout=30) as r, open(tmp, "wb") as f:
                    total = int(r.headers.get("Content-Length") or 0)
                    done = 0
                    while True:
                        chunk = r.read(1 << 20)
                        if not chunk:
                            break
                        f.write(chunk)
                        done += len(chunk)
                        if total:
                            say(f"  {name}: {done * 100 // total}%")
                os.replace(tmp, dest)
                break
            except Exception as e:       # 换下一个源
                last_err = e
                say(f"  失败：{type(e).__name__}: {e}")
        else:
            raise RuntimeError(f"下载 {name} 失败：{last_err}")
    say(f"模型就绪：{d}")
    return d


if __name__ == "__main__":
    print("依赖:", deps())
    print("模型目录:", model_dir(), "缺:", _missing_files(model_dir()) or "无")
    ok, why = available()
    print("可用:", ok, why)
    if len(sys.argv) > 1:
        print("转写:", transcribe(sys.argv[1]))
