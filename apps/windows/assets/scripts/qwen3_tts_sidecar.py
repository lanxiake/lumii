#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Qwen3-TTS sidecar：stdin/stdout JSON-RPC（每行一条）。

请求: {"id":1,"method":"ping|load|synthesize|shutdown","params":{...}}
响应: {"id":1,"ok":true,"result":{...}} 或 {"id":1,"ok":false,"error":"..."}
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import traceback
from typing import Any

# 禁止运行时联网拉模
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

_model = None
_model_dir: str | None = None
_tokenizer_dir: str | None = None
_device: str = "cpu"


def reply(req_id: Any, ok: bool, result: Any = None, error: str | None = None) -> None:
    """写一行 JSON 响应到 stdout"""
    payload: dict[str, Any] = {"id": req_id, "ok": ok}
    if ok:
        payload["result"] = result if result is not None else {}
    else:
        payload["error"] = error or "unknown error"
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def handle_ping(_params: dict[str, Any]) -> dict[str, Any]:
    """健康检查"""
    has_qwen = False
    try:
        import qwen_tts  # noqa: F401

        has_qwen = True
    except Exception:
        has_qwen = False
    return {"alive": True, "qwen_tts": has_qwen, "loaded": _model is not None}


def handle_load(params: dict[str, Any]) -> dict[str, Any]:
    """加载本地 Base 模型 + Tokenizer"""
    global _model, _model_dir, _tokenizer_dir, _device
    model_dir = params.get("modelDir") or ""
    tokenizer_dir = params.get("tokenizerDir") or ""
    device = params.get("device") or "auto"

    if not model_dir or not os.path.isdir(model_dir):
        raise RuntimeError(f"modelDir 无效: {model_dir}")
    if not tokenizer_dir or not os.path.isdir(tokenizer_dir):
        raise RuntimeError(f"tokenizerDir 无效: {tokenizer_dir}")

    import torch
    from qwen_tts import Qwen3TTSModel

    if device == "auto":
        _device = "cuda:0" if torch.cuda.is_available() else "cpu"
    else:
        _device = device

    dtype = torch.float16 if _device.startswith("cuda") else torch.float32
    # 部分版本支持 speech_tokenizer / tokenizer 路径参数；失败则仅用 model_dir
    try:
        _model = Qwen3TTSModel.from_pretrained(
            model_dir,
            device_map=_device,
            dtype=dtype,
            speech_tokenizer_pretrained=tokenizer_dir,
        )
    except TypeError:
        _model = Qwen3TTSModel.from_pretrained(
            model_dir,
            device_map=_device,
            dtype=dtype,
        )

    _model_dir = model_dir
    _tokenizer_dir = tokenizer_dir
    return {"device": _device, "modelDir": model_dir}


def handle_synthesize(params: dict[str, Any]) -> dict[str, Any]:
    """合成：custom_voice（内置音色）或 voice_clone（克隆）"""
    global _model
    if _model is None:
        raise RuntimeError("模型未加载，请先 load")

    text = (params.get("text") or "").strip()
    if not text:
        raise RuntimeError("text 为空")

    language = params.get("language") or "Auto"
    mode = params.get("mode") or "clone"

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
        wavs, sr = _model.generate_custom_voice(**kwargs)
    else:
        ref_audio = params.get("refAudio")
        ref_text = params.get("refText") or ""
        x_vector_only = bool(params.get("xVectorOnly"))
        if not ref_audio or not os.path.isfile(ref_audio):
            raise RuntimeError(f"参考音频无效: {ref_audio}")
        if not x_vector_only and not ref_text.strip():
            raise RuntimeError("ICL 模式需要 refText")
        wavs, sr = _model.generate_voice_clone(
            text=text,
            language=language,
            ref_audio=ref_audio,
            ref_text=ref_text if not x_vector_only else None,
            x_vector_only_mode=x_vector_only,
        )

    import numpy as np
    import soundfile as sf

    wav = wavs[0]
    if hasattr(wav, "cpu"):
        wav = wav.cpu().numpy()
    wav = np.asarray(wav, dtype=np.float32)

    fd, out_path = tempfile.mkstemp(prefix="lumii-qwen3-", suffix=".wav")
    os.close(fd)
    sf.write(out_path, wav, int(sr))
    return {"wavPath": out_path, "sampleRate": int(sr)}


def handle_shutdown(_params: dict[str, Any]) -> dict[str, Any]:
    """释放模型"""
    global _model, _model_dir, _tokenizer_dir
    _model = None
    _model_dir = None
    _tokenizer_dir = None
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
