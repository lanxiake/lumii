#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Qwen3-TTS sidecar：stdin/stdout JSON-RPC（每行一条）。

请求: {"id":1,"method":"ping|load|synthesize|synthesize_stream|shutdown","params":{...}}
响应: {"id":1,"ok":true,"result":{...}} 或 {"id":1,"ok":false,"error":"..."}
流式: 同 id 多行 partial=true，最后一行 partial=false 表示结束。

CUDA 优先使用 faster-qwen3-tts（CUDA Graph），显著降低 RTF / 首包延迟；
不可用时回退官方 qwen_tts。
"""

from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
import traceback
from typing import Any, Callable, List, Optional

# 禁止运行时联网拉模
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

_model = None
_model_dir: str | None = None
_tokenizer_dir: str | None = None
_device: str = "cpu"
# "faster" = faster_qwen3_tts；"stock" = 官方 qwen_tts
_backend: str = "stock"


def reply(
    req_id: Any,
    ok: bool,
    result: Any = None,
    error: str | None = None,
    *,
    partial: bool | None = None,
) -> None:
    """写一行 JSON 响应到 stdout"""
    payload: dict[str, Any] = {"id": req_id, "ok": ok}
    if partial is not None:
        payload["partial"] = partial
    if ok:
        payload["result"] = result if result is not None else {}
    else:
        payload["error"] = error or "unknown error"
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def handle_ping(_params: dict[str, Any]) -> dict[str, Any]:
    """健康检查"""
    has_qwen = False
    has_faster = False
    try:
        import qwen_tts  # noqa: F401

        has_qwen = True
    except Exception:
        has_qwen = False
    try:
        import faster_qwen3_tts  # noqa: F401

        has_faster = True
    except Exception:
        has_faster = False
    return {
        "alive": True,
        "qwen_tts": has_qwen,
        "faster_qwen3_tts": has_faster,
        "loaded": _model is not None,
        "backend": _backend if _model is not None else None,
    }


def _configure_cuda_speedups() -> None:
    """开启 TF32 / cudnn benchmark，降低 matmul 开销"""
    try:
        import torch

        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        torch.backends.cudnn.benchmark = True
        torch.set_float32_matmul_precision("high")
    except Exception as e:
        print(f"[qwen3_tts_sidecar] CUDA speedup 配置跳过: {e}", file=sys.stderr, flush=True)


def _pick_attn_implementation() -> str:
    """官方路径：优先 FlashAttention-2，否则 eager（Windows 上 sdpa 未见收益）"""
    try:
        import flash_attn  # noqa: F401

        return "flash_attention_2"
    except Exception:
        return "eager"


def _try_load_faster(model_dir: str, device: str, dtype: Any) -> Any:
    """尝试加载 faster-qwen3-tts（CUDA Graph）"""
    from faster_qwen3_tts import FasterQwen3TTS

    # faster API: device='cuda' / 'cpu'，不要传 cuda:0
    faster_device = "cuda" if device.startswith("cuda") else "cpu"
    model = FasterQwen3TTS.from_pretrained(
        model_dir,
        device=faster_device,
        dtype=dtype,
        local_files_only=True,
    )
    # 捕获 CUDA Graph，避免首请求承担 warm-up 成本
    try:
        model.warmup(prefill_len=64)
    except Exception as e:
        print(f"[qwen3_tts_sidecar] faster warmup 警告: {e}", file=sys.stderr, flush=True)
    return model


def _try_load_stock(model_dir: str, device: str, dtype: Any, attn_implementation: str) -> tuple[Any, str]:
    """加载官方 qwen_tts，返回 (model, 实际 attn)"""
    from qwen_tts import Qwen3TTSModel

    load_kwargs: dict[str, Any] = {
        "device_map": device,
        "dtype": dtype,
        "attn_implementation": attn_implementation,
        "local_files_only": True,
    }
    try:
        model = Qwen3TTSModel.from_pretrained(model_dir, **load_kwargs)
        return model, attn_implementation
    except Exception as e:
        if attn_implementation == "flash_attention_2":
            print(
                f"[qwen3_tts_sidecar] flash_attn 加载失败，回退 eager: {e}",
                file=sys.stderr,
                flush=True,
            )
            load_kwargs["attn_implementation"] = "eager"
            model = Qwen3TTSModel.from_pretrained(model_dir, **load_kwargs)
            return model, "eager"
        if "attn_implementation" in str(e) or isinstance(e, TypeError):
            load_kwargs.pop("attn_implementation", None)
            model = Qwen3TTSModel.from_pretrained(model_dir, **load_kwargs)
            return model, "default"
        raise


def handle_load(params: dict[str, Any]) -> dict[str, Any]:
    """加载本地 Base/CustomVoice 模型 + Tokenizer"""
    global _model, _model_dir, _tokenizer_dir, _device, _backend
    model_dir = params.get("modelDir") or ""
    tokenizer_dir = params.get("tokenizerDir") or ""
    device = params.get("device") or "auto"

    if not model_dir or not os.path.isdir(model_dir):
        raise RuntimeError(f"modelDir 无效: {model_dir}")
    if not tokenizer_dir or not os.path.isdir(tokenizer_dir):
        raise RuntimeError(f"tokenizerDir 无效: {tokenizer_dir}")

    import torch

    if device == "auto":
        _device = "cuda:0" if torch.cuda.is_available() else "cpu"
    else:
        _device = device

    if _device.startswith("cuda"):
        _configure_cuda_speedups()
        dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
        attn_implementation = _pick_attn_implementation()
    else:
        dtype = torch.float32
        attn_implementation = "eager"

    prefer_faster = _device.startswith("cuda") and params.get("preferFaster", True) is not False
    backend = "stock"
    attn_used = attn_implementation

    if prefer_faster:
        try:
            print(
                f"[qwen3_tts_sidecar] 尝试 faster-qwen3-tts device={_device} dtype={dtype}",
                file=sys.stderr,
                flush=True,
            )
            _model = _try_load_faster(model_dir, _device, dtype)
            backend = "faster"
            attn_used = "cuda_graph"
        except Exception as e:
            print(
                f"[qwen3_tts_sidecar] faster 加载失败，回退官方 qwen_tts: {e}",
                file=sys.stderr,
                flush=True,
            )
            _model = None

    if _model is None:
        print(
            f"[qwen3_tts_sidecar] load stock device={_device} dtype={dtype} attn={attn_implementation}",
            file=sys.stderr,
            flush=True,
        )
        _model, attn_used = _try_load_stock(model_dir, _device, dtype, attn_implementation)
        backend = "stock"
        # 官方路径短句预热，摊掉首次 CUDA kernel 编译
        if _device.startswith("cuda"):
            try:
                _warmup_stock_model(_model)
            except Exception as e:
                print(f"[qwen3_tts_sidecar] stock warmup 警告: {e}", file=sys.stderr, flush=True)

    _backend = backend
    _model_dir = model_dir
    _tokenizer_dir = tokenizer_dir
    print(
        f"[qwen3_tts_sidecar] ready backend={_backend} device={_device} attn={attn_used}",
        file=sys.stderr,
        flush=True,
    )
    return {
        "device": _device,
        "dtype": str(dtype).replace("torch.", ""),
        "attn": attn_used,
        "backend": _backend,
        "modelDir": model_dir,
    }


def _warmup_stock_model(model: Any) -> None:
    """官方模型短句预热"""
    import torch

    try:
        model.generate_custom_voice(text="测", language="Chinese", speaker="Vivian")
    except Exception:
        # Base/克隆模型可能没有 custom voice
        pass
    if torch.cuda.is_available():
        torch.cuda.synchronize()


def _is_cuda_poison_error(exc: BaseException) -> bool:
    """判断是否为会污染 CUDA context 的设备端错误（需重启 sidecar）"""
    msg = str(exc).lower()
    return "device-side assert" in msg or "cuda error" in msg


def _split_text_for_stream(text: str) -> List[str]:
    """
    为官方路径句级流式切分：优先在靠前软/硬标点切开，缩短首包等待。
    faster 路径使用帧级流式，一般不走此函数。
    """
    text = (text or "").strip()
    if not text:
        return []

    hard_chars = set("。！？…\n")
    soft_chars = set("，；、,;")
    min_soft = 2
    max_len = 36

    parts: List[str] = []
    buf = text
    guard = 0
    while buf and guard < 200:
        guard += 1

        hard_idx = -1
        soft_idx = -1
        for i, ch in enumerate(buf):
            if hard_idx < 0 and (
                ch in hard_chars or (ch in ".!?" and (i + 1 >= len(buf) or buf[i + 1].isspace()))
            ):
                if ch == "." and i > 0 and buf[i - 1].isdigit() and i + 1 < len(buf) and buf[i + 1].isdigit():
                    pass
                else:
                    hard_idx = i
            if soft_idx < 0 and ch in soft_chars and i + 1 >= min_soft:
                soft_idx = i

        if soft_idx >= 0 and (hard_idx < 0 or soft_idx < hard_idx):
            cut = soft_idx + 1
            seg = buf[:cut].strip()
            buf = buf[cut:]
            if seg:
                parts.append(seg)
            continue

        if hard_idx >= 0:
            cut = hard_idx + 1
            seg = buf[:cut].strip()
            buf = buf[cut:]
            if seg:
                parts.append(seg)
            continue

        if len(buf) >= max_len:
            window = buf[:max_len]
            cut2 = max_len
            for i in range(len(window) - 1, max(0, int(max_len * 0.5)) - 1, -1):
                if window[i] in " \t，；。！？、,;":
                    cut2 = i + 1
                    break
            seg = buf[:cut2].strip()
            buf = buf[cut2:]
            if seg:
                parts.append(seg)
            continue
        break

    rest = buf.strip()
    if rest:
        parts.append(rest)
    return parts if parts else [text]


def _wav_to_int16_bytes(wav: Any) -> bytes:
    """float/tensor 波形 → int16 little-endian PCM bytes（不做峰值拉满，避免放大底噪）"""
    import numpy as np

    if hasattr(wav, "cpu"):
        wav = wav.cpu().numpy()
    arr = np.asarray(wav, dtype=np.float32).reshape(-1)
    arr = np.clip(arr, -1.0, 1.0)
    return (arr * 32767.0).astype(np.int16).tobytes()


def _clear_model_on_cuda_poison() -> None:
    """CUDA 损坏后清空模型引用"""
    global _model
    _model = None
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def _generate_one_stock(params: dict[str, Any], text: str) -> tuple[Any, int]:
    """官方 qwen_tts 合成单段"""
    global _model
    if _model is None:
        raise RuntimeError("模型未加载，请先 load")

    language = params.get("language") or "Auto"
    mode = params.get("mode") or "clone"

    try:
        if mode == "custom":
            speaker = params.get("speaker") or "Vivian"
            instruct = params.get("instruct") or ""
            kwargs: dict[str, Any] = {
                "text": text,
                "language": language,
                "speaker": speaker,
            }
            if instruct:
                kwargs["instruct"] = instruct
            return _model.generate_custom_voice(**kwargs)
        ref_audio = params.get("refAudio")
        ref_text = params.get("refText") or ""
        x_vector_only = bool(params.get("xVectorOnly"))
        if not ref_audio or not os.path.isfile(ref_audio):
            raise RuntimeError(f"参考音频无效: {ref_audio}")
        if not x_vector_only and not ref_text.strip():
            raise RuntimeError("ICL 模式需要 refText")
        return _model.generate_voice_clone(
            text=text,
            language=language,
            ref_audio=ref_audio,
            ref_text=ref_text if not x_vector_only else None,
            x_vector_only_mode=x_vector_only,
        )
    except Exception as e:
        if _is_cuda_poison_error(e):
            _clear_model_on_cuda_poison()
            raise RuntimeError(
                "GPU 合成失败（CUDA device-side assert）。请重启预览或改用 CPU。"
                f" 原始错误: {e}"
            ) from e
        raise


def _generate_one_faster(params: dict[str, Any], text: str) -> tuple[Any, int]:
    """faster-qwen3-tts 整段合成"""
    global _model
    if _model is None:
        raise RuntimeError("模型未加载，请先 load")

    language = params.get("language") or "Auto"
    mode = params.get("mode") or "clone"

    try:
        if mode == "custom":
            speaker = params.get("speaker") or "Vivian"
            instruct = params.get("instruct") or None
            kwargs: dict[str, Any] = {
                "text": text,
                "language": language,
                "speaker": speaker,
            }
            if instruct:
                kwargs["instruct"] = instruct
            return _model.generate_custom_voice(**kwargs)
        ref_audio = params.get("refAudio")
        ref_text = params.get("refText") or ""
        x_vector_only = bool(params.get("xVectorOnly"))
        if not ref_audio or not os.path.isfile(ref_audio):
            raise RuntimeError(f"参考音频无效: {ref_audio}")
        if not x_vector_only and not ref_text.strip():
            raise RuntimeError("ICL 模式需要 refText")
        return _model.generate_voice_clone(
            text=text,
            language=language,
            ref_audio=ref_audio,
            ref_text=ref_text,
            xvec_only=x_vector_only,
        )
    except Exception as e:
        if _is_cuda_poison_error(e):
            _clear_model_on_cuda_poison()
            raise RuntimeError(
                "GPU 合成失败（CUDA device-side assert）。请重启预览或改用 CPU。"
                f" 原始错误: {e}"
            ) from e
        raise


def _resolve_language(language: str, text: str) -> str:
    """
    Auto + 中文为主 → Chinese，降低多语种模型中途漂语种概率。
    """
    lang = (language or "Auto").strip() or "Auto"
    if lang.lower() != "auto":
        return lang
    cjk = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff" or "\u3400" <= ch <= "\u4dbf")
    latin = sum(1 for ch in text if ("a" <= ch.lower() <= "z"))
    kana = sum(1 for ch in text if "\u3040" <= ch <= "\u30ff")
    hangul = sum(1 for ch in text if "\uac00" <= ch <= "\ud7af")
    if hangul > cjk * 0.3 and hangul >= 2:
        return "Korean"
    if kana >= 2 and kana >= cjk * 0.15:
        return "Japanese"
    if cjk >= 2 and cjk >= latin:
        return "Chinese"
    if latin >= 4 and latin > cjk * 2:
        return "English"
    return "Chinese"


def _sanitize_tts_text(text: str) -> str:
    """剥离 Markdown 等标记，避免 ** 等符号触发异常发音/换语种"""
    import re

    t = (text or "").strip()
    t = re.sub(r"\*{1,3}([^*]*)\*{1,3}", r"\1", t)
    t = re.sub(r"~~([^~]*)~~", r"\1", t)
    t = re.sub(r"`([^`]*)`", r"\1", t)
    t = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", t)
    t = re.sub(r"\*+", "", t)
    t = re.sub(r"[—–]", "，", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _prepare_synth_text_and_lang(params: dict[str, Any]) -> tuple[str, str]:
    """统一清洗文本并解析 language"""
    text = _sanitize_tts_text(params.get("text") or "")
    if not text:
        raise RuntimeError("text 为空")
    language = _resolve_language(params.get("language") or "Auto", text)
    if language != (params.get("language") or "Auto"):
        print(
            f"[qwen3_tts_sidecar] language {(params.get('language') or 'Auto')} → {language}",
            file=sys.stderr,
            flush=True,
        )
    return text, language


def handle_synthesize(params: dict[str, Any]) -> dict[str, Any]:
    """整段合成（兼容旧路径）：返回临时 wav"""
    text, language = _prepare_synth_text_and_lang(params)
    params = {**params, "text": text, "language": language}

    import soundfile as sf
    import numpy as np

    if _backend == "faster":
        wavs, sr = _generate_one_faster(params, text)
    else:
        wavs, sr = _generate_one_stock(params, text)
    wav = wavs[0]
    if hasattr(wav, "cpu"):
        wav = wav.cpu().numpy()
    wav = np.asarray(wav, dtype=np.float32)
    fd, out_path = tempfile.mkstemp(prefix="lumii-qwen3-", suffix=".wav")
    os.close(fd)
    sf.write(out_path, wav, int(sr))
    return {"wavPath": out_path, "sampleRate": int(sr), "backend": _backend}


def _emit_pcm_chunk(
    emit: Callable[..., None],
    req_id: Any,
    wav: Any,
    sample_rate: int,
    chunk_index: int,
    text: Optional[str] = None,
) -> None:
    """推送一段 int16 PCM partial"""
    pcm = _wav_to_int16_bytes(wav)
    result: dict[str, Any] = {
        "pcmInt16Base64": base64.b64encode(pcm).decode("ascii"),
        "sampleRate": sample_rate,
        "chunkIndex": chunk_index,
    }
    if text is not None:
        result["text"] = text
    emit(req_id, True, result=result, partial=True)


def _stream_faster(
    params: dict[str, Any],
    text: str,
    req_id: Any,
    emit: Callable[..., None],
) -> dict[str, Any]:
    """
    faster 帧级流式：边生成边推 PCM。
    chunk_size 越小首包越快（代价是更多 decode 调用）；8 ≈ 667ms 音频。
    """
    global _model
    if _model is None:
        raise RuntimeError("模型未加载，请先 load")

    language = params.get("language") or "Auto"
    mode = params.get("mode") or "clone"
    # 首包优先：4 帧 ≈ 333ms 音频
    chunk_size = int(params.get("chunkSize") or 4)
    chunk_size = max(2, min(chunk_size, 24))

    try:
        if mode == "custom":
            speaker = params.get("speaker") or "Vivian"
            instruct = params.get("instruct") or None
            gen = _model.generate_custom_voice_streaming(
                text=text,
                language=language,
                speaker=speaker,
                instruct=instruct,
                chunk_size=chunk_size,
            )
        else:
            ref_audio = params.get("refAudio")
            ref_text = params.get("refText") or ""
            x_vector_only = bool(params.get("xVectorOnly"))
            if not ref_audio or not os.path.isfile(ref_audio):
                raise RuntimeError(f"参考音频无效: {ref_audio}")
            if not x_vector_only and not ref_text.strip():
                raise RuntimeError("ICL 模式需要 refText")
            gen = _model.generate_voice_clone_streaming(
                text=text,
                language=language,
                ref_audio=ref_audio,
                ref_text=ref_text,
                xvec_only=x_vector_only,
                chunk_size=chunk_size,
            )

        sample_rate = 24000
        n = 0
        for item in gen:
            audio, sr = item[0], int(item[1])
            sample_rate = sr
            _emit_pcm_chunk(emit, req_id, audio, sample_rate, n)
            n += 1
        return {"done": True, "chunks": n, "sampleRate": sample_rate, "backend": "faster"}
    except Exception as e:
        if _is_cuda_poison_error(e):
            _clear_model_on_cuda_poison()
            raise RuntimeError(
                "GPU 合成失败（CUDA device-side assert）。请重启预览或改用 CPU。"
                f" 原始错误: {e}"
            ) from e
        raise


def _stream_stock(
    params: dict[str, Any],
    text: str,
    req_id: Any,
    emit: Callable[..., None],
) -> dict[str, Any]:
    """官方路径：句级切分后逐段合成推送"""
    segments = _split_text_for_stream(text)
    print(
        f"[qwen3_tts_sidecar] stock stream segments={len(segments)} "
        f"preview={[s[:20] for s in segments[:4]]}",
        file=sys.stderr,
        flush=True,
    )
    sample_rate = 24000
    for i, seg in enumerate(segments):
        wavs, sr = _generate_one_stock(params, seg)
        sample_rate = int(sr)
        _emit_pcm_chunk(emit, req_id, wavs[0], sample_rate, i, text=seg)
    return {"done": True, "chunks": len(segments), "sampleRate": sample_rate, "backend": "stock"}


def handle_synthesize_stream(
    params: dict[str, Any],
    req_id: Any,
    emit: Callable[..., None],
) -> dict[str, Any]:
    """流式合成：faster 用帧级推送；stock 用句级推送"""
    text, language = _prepare_synth_text_and_lang(params)
    params = {**params, "text": text, "language": language}

    print(
        f"[qwen3_tts_sidecar] synthesize_stream backend={_backend} "
        f"lang={language} text_len={len(text)}",
        file=sys.stderr,
        flush=True,
    )
    if _backend == "faster":
        return _stream_faster(params, text, req_id, emit)
    return _stream_stock(params, text, req_id, emit)


def handle_shutdown(_params: dict[str, Any]) -> dict[str, Any]:
    """释放模型"""
    global _model, _model_dir, _tokenizer_dir, _backend
    _model = None
    _model_dir = None
    _tokenizer_dir = None
    _backend = "stock"
    return {"shutdown": True}


HANDLERS = {
    "ping": handle_ping,
    "load": handle_load,
    "synthesize": handle_synthesize,
    "shutdown": handle_shutdown,
}


def main() -> int:
    """主循环：逐行读 JSON-RPC"""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id: Any = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            method = req.get("method")
            params = req.get("params") or {}

            if method == "synthesize_stream":
                result = handle_synthesize_stream(params, req_id, reply)
                reply(req_id, True, result=result, partial=False)
                continue

            handler = HANDLERS.get(method)
            if not handler:
                reply(req_id, False, error=f"未知 method: {method}")
                continue
            result = handler(params)
            reply(req_id, True, result=result)
            if method == "shutdown":
                return 0
        except Exception as e:
            reply(req_id, False, error=f"{e}\n{traceback.format_exc()[-800:]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
