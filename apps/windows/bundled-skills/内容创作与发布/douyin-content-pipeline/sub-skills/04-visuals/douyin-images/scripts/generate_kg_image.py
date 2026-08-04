#!/usr/bin/env python3
"""知识图解 · 批量生图脚本。

通过 LLM-Link images/generations 接口调用 gpt-image-2，生成 3:4 竖版博物图鉴风科普图。
解析 prompts.md 中 ## #<slug> 分节格式（完整Prompt: 缩进正文）。

用法：
  # 单张（先测封面）
  python generate_kg_image.py --prompt-file prompts.md --section 01-cover --output 01-cover.png

  # 批量（跳过已存在文件，可中断续跑）
  python generate_kg_image.py --prompt-file prompts.md --batch --output-dir ./images/
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

CONFIG_NAMES = ("config.json", ".llmlink.json")

# Midjourney 参数正则（gpt-image-2 不需要）
_MJ_PARAM_RE = re.compile(
    r",?\s*--(?:ar|v|q|s|seed)\s+[\d.:]+",
    re.IGNORECASE,
)


def _curl_bin() -> str:
    """返回 curl 可执行路径。"""
    exe = shutil.which("curl")
    if not exe:
        raise RuntimeError("未找到 curl，请确保系统已安装 curl 并在 PATH 中")
    return exe


def load_config() -> dict:
    """从脚本目录向上查找 config.json，返回 api_key / base_url / model。"""
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


def strip_midjourney_params(prompt: str) -> str:
    """移除 Midjourney 参数，gpt-image-2 接口不需要。"""
    return _MJ_PARAM_RE.sub("", prompt).strip()


def parse_prompts_file(path: str) -> list[tuple[str, str, str]]:
    """解析 prompts.md，返回 [(slug, size, prompt), ...]。"""
    text = open(path, "r", encoding="utf-8").read()
    sections: list[tuple[str, str, str]] = []
    pattern = re.compile(
        r"^## #([\w\-]+)[^\n]*\n(.*?)(?=^## #|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    for m in pattern.finditer(text):
        slug = m.group(1)
        body = m.group(2)
        size_m = re.search(r"-\s*尺寸[：:]\s*(\d+x\d+)", body)
        size = size_m.group(1).strip() if size_m else "1024x1365"
        prompt_m = re.search(r"完整Prompt[：:]\s*\n([\s\S]+)", body)
        if prompt_m:
            raw = prompt_m.group(1)
            lines = raw.splitlines()
            indents = [len(l) - len(l.lstrip()) for l in lines if l.strip()]
            min_indent = min(indents) if indents else 0
            prompt = "\n".join(
                l[min_indent:] if len(l) >= min_indent else l
                for l in lines
            ).strip()
        else:
            prompt = body.strip()
        sections.append((slug, size, strip_midjourney_params(prompt)))
    return sections


def call_image_api(base_url: str, api_key: str, model: str, prompt: str,
                   size: str, retries: int = 4, interval: int = 6) -> str:
    """调用 images/generations，通过 curl 绕过 WAF，返回图片 URL。"""
    url = base_url.rstrip("/") + "/v1/images/generations"
    payload = json.dumps({
        "model": model,
        "prompt": prompt,
        "n": 1,
        "size": size,
        "response_format": "url",
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
        print(f"  [attempt {attempt}/{retries}] requesting {model}...", file=sys.stderr)
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
            return data["data"][0]["url"]
        except Exception as e:
            print(f"  [warn] {type(e).__name__}: {e}", file=sys.stderr)
        if attempt < retries:
            time.sleep(interval)
    raise RuntimeError(f"all {retries} retries failed")


def download(img_url: str, output: str) -> int:
    """下载图片到本地，返回字节数。"""
    curl = _curl_bin()
    out_dir = os.path.dirname(os.path.abspath(output))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    cmd = [curl, "-sS", "--max-time", "120", "-A", UA, "-o", output, img_url]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=140)
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", errors="replace")
        raise RuntimeError(f"下载失败: {err[:300]}")
    return os.path.getsize(output)


def main() -> None:
    """命令行入口：单张或批量生成知识图解风格图片。"""
    p = argparse.ArgumentParser(description="知识图解: batch image generation via LLM-Link")
    p.add_argument("--prompt-file", required=True, help="path to prompts.md")
    p.add_argument("--section", help="single mode: section slug, e.g. 01-cover")
    p.add_argument("--output", help="single mode: output file path")
    p.add_argument("--batch", action="store_true", help="batch mode: generate all sections")
    p.add_argument("--output-dir", help="batch mode: output directory")
    p.add_argument("--retries", type=int, default=4, help="max retries per image (default 4)")
    args = p.parse_args()

    cfg = load_config()
    api_key = os.environ.get("LLM_LINK_API_KEY") or cfg.get("api_key", "")
    base_url = os.environ.get("LLM_LINK_BASE_URL") or cfg.get("base_url", "https://www.llm-link.top")
    model = os.environ.get("LLM_LINK_MODEL") or cfg.get("model", "gpt-image-2")

    if not api_key:
        print("[ERROR] 未找到 api_key，请在 douyin-images/config.json 配置", file=sys.stderr)
        sys.exit(3)

    if cfg.get("_path"):
        print(f"[config] loaded {cfg['_path']}", file=sys.stderr)
    print(f"[config] base={base_url} model={model} key={api_key[:8]}...", file=sys.stderr)

    sections = parse_prompts_file(args.prompt_file)
    if not sections:
        print("[ERROR] prompts.md 中未找到 ## #xxx 分节", file=sys.stderr)
        sys.exit(1)

    if args.batch:
        out_dir = args.output_dir or "images"
        print(f"[batch] {len(sections)} sections -> {out_dir}", file=sys.stderr)
        for slug, size, prompt in sections:
            out_path = os.path.join(out_dir, f"{slug}.png")
            if os.path.exists(out_path):
                print(f"  [skip] {slug} already exists", file=sys.stderr)
                continue
            print(f"  [gen]  {slug} ({size}) prompt={len(prompt)} chars", file=sys.stderr)
            try:
                img_url = call_image_api(base_url, api_key, model, prompt, size, args.retries)
                n = download(img_url, out_path)
                print(f"  [done] {out_path} ({n // 1024} KB)", file=sys.stderr)
            except Exception as e:
                print(f"  [FAIL] {slug}: {e}", file=sys.stderr)
            time.sleep(3)
        print("[batch complete]", file=sys.stderr)
    else:
        if not args.section:
            print("[ERROR] 单张模式需要 --section", file=sys.stderr)
            sys.exit(1)
        hit = [(sl, sz, pr) for sl, sz, pr in sections if sl == args.section]
        if not hit:
            slugs = [sl for sl, _, _ in sections]
            print(f"[ERROR] section '{args.section}' not found. available: {slugs}", file=sys.stderr)
            sys.exit(1)
        slug, size, prompt = hit[0]
        out_path = args.output or f"{slug}.png"
        print(f"[gen] {slug} ({size}) -> {out_path}", file=sys.stderr)
        img_url = call_image_api(base_url, api_key, model, prompt, size, args.retries)
        n = download(img_url, out_path)
        print(f"[OK]  {out_path} ({n // 1024} KB)", file=sys.stderr)


if __name__ == "__main__":
    main()
