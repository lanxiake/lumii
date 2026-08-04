#!/usr/bin/env python3
"""通过 LLM-Link 的 chat completions 接口调用 gpt-image-2 生成单张图片。

LLM-Link 把 gpt-image-2 包装成 chat completions 风格：
请求 messages，响应 choices[0].message.content 中含 markdown ![image](url) 链接。
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time


UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


def _curl_bin() -> str:
    """返回 curl 可执行路径，找不到则报错。

    必须用 curl 而非 Python urllib：llm-link.top 前置 CDN/WAF 通过 TLS 指纹
    (JA3) 拦截 Python 客户端，urllib 会被 403 或直接断连，curl 指纹可放行。
    """
    exe = shutil.which("curl")
    if not exe:
        raise RuntimeError("未找到 curl，请确保系统已安装 curl 并在 PATH 中")
    return exe


CONFIG_NAMES = ("config.json", ".llmlink.json")


def load_config() -> dict:
    """从脚本目录向上查找 config.json，返回配置字典。

    完全不使用环境变量，避免系统中残留的失效变量干扰。
    兼容 newapi_channel_conn 格式：识别 key/url 字段。
    """
    d = os.path.dirname(os.path.abspath(__file__))
    for _ in range(6):
        for name in CONFIG_NAMES:
            cfgp = os.path.join(d, name)
            if os.path.isfile(cfgp):
                with open(cfgp, encoding="utf-8") as f:
                    raw = json.load(f)
                return {
                    "api_key": raw.get("api_key") or raw.get("key") or "",
                    "base_url": (raw.get("base_url") or raw.get("url")
                                 or "https://www.llm-link.top"),
                    "model": raw.get("model") or "gpt-image-2",
                    "_path": cfgp,
                }
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return {"api_key": "", "base_url": "https://www.llm-link.top",
            "model": "gpt-image-2", "_path": None}


def extract_prompt(file_path: str, section: str) -> str:
    """从 prompts.md 提取指定分节的完整提示词。"""
    with open(file_path, "r", encoding="utf-8") as f:
        text = f.read()
    pattern = rf"##\s*#{re.escape(section)}\b.*?完整提示词[:：]\s*\n+```\n(.*?)\n```"
    m = re.search(pattern, text, re.DOTALL)
    if not m:
        raise ValueError(f"未能从 {file_path} 提取 #{section} 的提示词")
    return m.group(1).strip()


def call_chat_image(base_url: str, api_key: str, model: str, prompt: str,
                    retries: int = 3, interval: int = 5) -> str:
    """返回图片 URL。通过 curl 发请求以绕过 WAF 的 TLS 指纹拦截。"""
    url = base_url.rstrip("/") + "/v1/chat/completions"
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
    })
    curl = _curl_bin()
    cmd = [
        curl, "-sS", "--max-time", "600", "-X", "POST", url,
        "-H", f"Authorization: Bearer {api_key}",
        "-H", "Content-Type: application/json",
        "-A", UA,
        "-H", "Accept: application/json",
        "--data-binary", "@-",
        "-w", "\n__HTTP_CODE__%{http_code}",
    ]

    for attempt in range(1, retries + 1):
        print(f"[INFO] 第 {attempt}/{retries} 次请求 {model} (chat, via curl)...", file=sys.stderr)
        try:
            proc = subprocess.run(
                cmd, input=payload.encode("utf-8"),
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=620,
            )
            out = proc.stdout.decode("utf-8", errors="replace")
            code = ""
            mcode = re.search(r"__HTTP_CODE__(\d{3})\s*$", out)
            if mcode:
                code = mcode.group(1)
                out = out[:mcode.start()]
            if proc.returncode != 0:
                err = proc.stderr.decode("utf-8", errors="replace")
                raise RuntimeError(f"curl 退出码 {proc.returncode}: {err[:300]}")
            if code and code != "200":
                raise RuntimeError(f"HTTP {code}: {out[:300]}")
            data = json.loads(out)
            content = data["choices"][0]["message"]["content"]
            m = re.search(r"!\[[^\]]*\]\((https?://[^)\s]+)\)", content)
            if m:
                return m.group(1)
            m2 = re.search(r"https?://\S+\.(?:png|jpg|jpeg|webp)", content)
            if m2:
                return m2.group(0)
            raise RuntimeError(f"响应中未找到图片 URL，原文: {content[:300]}")
        except Exception as e:
            print(f"[WARN] {type(e).__name__}: {e}", file=sys.stderr)
        if attempt < retries:
            time.sleep(interval)
    raise RuntimeError(f"已重试 {retries} 次仍失败")


def download(img_url: str, output: str) -> int:
    """下载图片到本地，返回字节数。"""
    curl = _curl_bin()
    os.makedirs(os.path.dirname(output) or ".", exist_ok=True)
    cmd = [curl, "-sS", "--max-time", "120", "-A", UA, "-o", output, img_url]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=140)
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", errors="replace")
        raise RuntimeError(f"下载失败 curl 退出码 {proc.returncode}: {err[:300]}")
    return os.path.getsize(output)


def main():
    """命令行入口：按 prompts.md 分节生成单张图片。"""
    p = argparse.ArgumentParser()
    p.add_argument("--prompt-file", required=True)
    p.add_argument("--section", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--size", default="")
    p.add_argument("--quality", default="")
    args = p.parse_args()

    cfg = load_config()
    api_key = cfg["api_key"]
    if not api_key:
        print("未找到 api_key: 请在 douyin-images/config.json 配置(参考 config.example.json)",
              file=sys.stderr)
        sys.exit(3)
    base_url = cfg["base_url"]
    model = cfg["model"]
    if cfg.get("_path"):
        print(f"[INFO] 已加载配置: {cfg['_path']}", file=sys.stderr)

    prompt = extract_prompt(args.prompt_file, args.section)
    if args.size:
        prompt += f"\n\n输出尺寸：{args.size}"
    print(f"[INFO] 提示词长度: {len(prompt)} 字节", file=sys.stderr)

    img_url = call_chat_image(base_url, api_key, model, prompt)
    print(f"[INFO] 图片 URL: {img_url}", file=sys.stderr)
    n = download(img_url, args.output)
    print(f"[OK] 已写入 {args.output} ({n} bytes)", file=sys.stderr)


if __name__ == "__main__":
    main()
