"""
CDP-based Douyin draft filler.

Fills creator-center drafts (image/video) including title, description,
collection, declaration, schedule, cover, and platform music.
Stops before final publish — user must review manually.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import requests
import urllib.parse
import websockets.sync.client as ws_client

from douyin_ui import (
    js_click_leaf_text,
    js_select_collection,
    js_select_declaration,
    js_select_music,
    js_set_contenteditable,
    js_set_input_value,
    js_set_schedule,
    js_upload_cover_via_input,
)
from publish_options import PublishOptions

if sys.platform == "win32":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


CDP_HOST = "127.0.0.1"
CDP_PORT = 9222
DOUYIN_CREATOR_URL = "https://creator.douyin.com/creator-micro/content/upload"
DOUYIN_LOGIN_URL = "https://creator.douyin.com"
PAGE_WAIT = 4
TAB_CLICK_WAIT = 3
UPLOAD_WAIT = 10
EDIT_PAGE_WAIT = 3
ACTION_WAIT = 1
IMAGE_TEXT_TAB_TEXT = "发布图文"

TITLE_SELECTORS = [
    'input[placeholder*="作品标题"]',
    'input[placeholder*="标题"]',
    'input.semi-input',
]
CONTENT_SELECTORS = [
    'div.zone-container[contenteditable="true"]',
    'div.editor-kit-container[contenteditable="true"]',
    'div[contenteditable="true"]',
]


class CDPError(Exception):
    pass


class DouyinPublisher:
    def __init__(self, host: str = CDP_HOST, port: int = CDP_PORT):
        self.host = host
        self.port = port
        self.ws = None
        self._msg_id = 0

    def _get_targets(self) -> list[dict[str, Any]]:
        try:
            resp = requests.get(f"http://{self.host}:{self.port}/json", timeout=5)
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:
            raise CDPError(f"Cannot reach Chrome on {self.host}:{self.port}: {exc}") from exc

    def _find_or_create_tab(self, url: str) -> str:
        pages = [t for t in self._get_targets() if t.get("type") == "page"]
        for target in pages:
            if target.get("url", "").startswith("https://creator.douyin.com"):
                return target["webSocketDebuggerUrl"]
        resp = requests.put(
            f"http://{self.host}:{self.port}/json/new?{urllib.parse.quote(url, safe='')}",
            timeout=5,
        )
        if resp.ok:
            return resp.json().get("webSocketDebuggerUrl", "")
        if pages:
            return pages[0]["webSocketDebuggerUrl"]
        raise CDPError("No browser tabs available.")

    def connect(self, url: str = DOUYIN_CREATOR_URL) -> None:
        ws_url = self._find_or_create_tab(url)
        if not ws_url:
            raise CDPError("Could not obtain WebSocket URL.")
        self.ws = ws_client.connect(ws_url)
        print("[douyin_cdp] Connected to Chrome tab.")

    def disconnect(self) -> None:
        if self.ws:
            self.ws.close()
            self.ws = None

    def _send(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if not self.ws:
            raise CDPError("Not connected. Call connect() first.")
        self._msg_id += 1
        msg: dict[str, Any] = {"id": self._msg_id, "method": method}
        if params:
            msg["params"] = params
        self.ws.send(json.dumps(msg))
        while True:
            data = json.loads(self.ws.recv())
            if data.get("id") == self._msg_id:
                if "error" in data:
                    raise CDPError(f"CDP error: {data['error']}")
                return data.get("result", {})

    def _evaluate(self, expression: str) -> Any:
        result = self._send("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": True,
        })
        value = result.get("result", {})
        if "value" in value:
            return value["value"]
        return None

    def _navigate(self, url: str) -> None:
        self._send("Page.enable")
        self._send("Page.navigate", {"url": url})
        time.sleep(PAGE_WAIT)

    def check_login(self) -> bool:
        """检查是否已登录创作者中心。"""
        self._navigate(DOUYIN_LOGIN_URL)
        url = self._evaluate("window.location.href") or ""
        text = self._evaluate("document.body ? document.body.innerText : ''") or ""
        logged_in = "login" not in url.lower() and "扫码登录" not in text and "登录" not in text[:200]
        print("LOGIN_STATUS: LOGGED_IN" if logged_in else "LOGIN_STATUS: NOT_LOGGED_IN")
        return bool(logged_in)

    def open_login_page(self) -> None:
        """打开登录页供扫码。"""
        self._navigate(DOUYIN_LOGIN_URL)
        print("LOGIN_READY")

    def _click_image_text_tab(self) -> bool:
        """点击「发布图文」标签。"""
        clicked = bool(self._evaluate(js_click_leaf_text(IMAGE_TEXT_TAB_TEXT)))
        if clicked:
            print(f"[douyin_cdp] Clicked tab: {IMAGE_TEXT_TAB_TEXT}")
            time.sleep(TAB_CLICK_WAIT)
        else:
            print(f"[douyin_cdp] WARN: tab not found: {IMAGE_TEXT_TAB_TEXT}")
        return clicked

    def _wait_for_edit_page(self, kind: str, timeout: int = 45) -> bool:
        """等待跳转到 /content/post/{image|video} 编辑页。"""
        needle = f"/content/post/{kind}"
        for i in range(timeout):
            url = self._evaluate("window.location.href") or ""
            if needle in url:
                print(f"[douyin_cdp] Edit page ready: {url}")
                time.sleep(EDIT_PAGE_WAIT)
                return True
            if i and i % 5 == 0:
                print(f"[douyin_cdp] Waiting for edit page ({i}s)...")
            time.sleep(1)
        print(f"[douyin_cdp] WARN: edit page not detected, current={url}")
        return False

    def _upload_files(self, paths: list[Path], accept_hint: str) -> None:
        """通过 DOM.setFileInputFiles 上传媒体文件。"""
        normalized = [str(p.resolve()).replace("\\", "/") for p in paths]
        self._send("DOM.enable")
        doc = self._send("DOM.getDocument")
        root_id = doc["root"]["nodeId"]
        candidates = self._send("DOM.querySelectorAll", {
            "nodeId": root_id,
            "selector": "input[type=file]",
        }).get("nodeIds", [])
        if not candidates:
            raise CDPError("Cannot find file input on Douyin upload page.")
        file_input_id = candidates[0]
        for node_id in candidates:
            attrs = self._send("DOM.getAttributes", {"nodeId": node_id}).get("attributes", [])
            attr_map = dict(zip(attrs[::2], attrs[1::2]))
            accept = attr_map.get("accept", "")
            if accept_hint and accept_hint in accept:
                file_input_id = node_id
                break
        self._send("DOM.setFileInputFiles", {
            "nodeId": file_input_id,
            "files": normalized,
        })
        print(f"[douyin_cdp] Uploaded {len(normalized)} file(s).")
        time.sleep(UPLOAD_WAIT)

    def _upload_cover_file(self, cover: Path) -> bool:
        """在编辑页上传自定义封面图。"""
        self._evaluate(js_upload_cover_via_input())
        time.sleep(1)
        self._send("DOM.enable")
        doc = self._send("DOM.getDocument")
        root_id = doc["root"]["nodeId"]
        candidates = self._send("DOM.querySelectorAll", {
            "nodeId": root_id,
            "selector": "input[type=file]",
        }).get("nodeIds", [])
        if not candidates:
            return False
        image_inputs = []
        for node_id in candidates:
            attrs = self._send("DOM.getAttributes", {"nodeId": node_id}).get("attributes", [])
            attr_map = dict(zip(attrs[::2], attrs[1::2]))
            if "image" in attr_map.get("accept", ""):
                image_inputs.append(node_id)
        target = image_inputs[-1] if image_inputs else candidates[-1]
        self._send("DOM.setFileInputFiles", {
            "nodeId": target,
            "files": [str(cover.resolve()).replace("\\", "/")],
        })
        time.sleep(2)
        return True

    def _fill_title(self, title: str) -> bool:
        """填写作品标题。"""
        return bool(self._evaluate(js_set_input_value(TITLE_SELECTORS, title)))

    def _fill_content(self, content: str) -> bool:
        """填写作品简介/描述。"""
        if self._evaluate(js_set_contenteditable(CONTENT_SELECTORS, content)):
            return True
        return bool(self._evaluate(js_set_input_value([
            'textarea[placeholder*="简介"]',
            'textarea[placeholder*="描述"]',
        ], content)))

    def _select_collection(self, name: str, pick_index: int = 0) -> bool:
        """选择发布合集。"""
        return bool(self._evaluate(js_select_collection(name, pick_index)))

    def _select_declaration(self, text: str, pick_index: int = 0) -> bool:
        """选择自主声明类型。"""
        return bool(self._evaluate(js_select_declaration(text, pick_index)))

    def _set_schedule(self, when: str) -> bool:
        """设置定时发布时间。"""
        return bool(self._evaluate(js_set_schedule(when)))

    def _select_platform_music(self, keyword: str, pick_index: int = 0) -> bool:
        """在发布页选择平台背景音乐。"""
        return bool(self._evaluate(js_select_music(keyword, pick_index)))

    def apply_publish_options(self, opts: PublishOptions, post_type: str) -> dict[str, bool]:
        """在编辑页应用合集、声明、定时、封面、音乐等选项。"""
        status: dict[str, bool] = {
            "title": False,
            "content": False,
            "collection": False,
            "declaration": False,
            "schedule": False,
            "cover": False,
            "music": False,
        }
        if opts.title:
            status["title"] = self._fill_title(opts.title)
        if opts.content:
            status["content"] = self._fill_content(opts.content)
        if opts.collection:
            status["collection"] = self._select_collection(opts.collection)
            time.sleep(ACTION_WAIT)
        if opts.declaration:
            status["declaration"] = self._select_declaration(opts.declaration)
            time.sleep(ACTION_WAIT)
        if opts.schedule:
            status["schedule"] = self._set_schedule(opts.schedule)
            time.sleep(ACTION_WAIT)
        if opts.cover and Path(opts.cover).exists():
            status["cover"] = self._upload_cover_file(Path(opts.cover))
            time.sleep(ACTION_WAIT)
        if opts.music and opts.music.keyword:
            status["music"] = self._select_platform_music(
                opts.music.keyword, opts.music.pick_index,
            )
        unused = "music" if post_type == "video" and not opts.music else None
        if unused and opts.music and not opts.music.keyword:
            status.pop("music", None)
        return status

    def fill_image_post(self, opts: PublishOptions, images: list[Path]) -> None:
        """填充图文草稿（含扩展发布选项）。"""
        self._navigate(DOUYIN_CREATOR_URL)
        self._click_image_text_tab()
        self._upload_files(images, "image")
        self._wait_for_edit_page("image")
        status = self.apply_publish_options(opts, "image")
        print(f"FIELD_STATUS: {json.dumps(status, ensure_ascii=False)}")
        print("DRAFT_STATUS: READY_TO_REVIEW")

    def fill_video_post(self, opts: PublishOptions, video: Path) -> None:
        """填充视频草稿（含扩展发布选项）。"""
        self._navigate(DOUYIN_CREATOR_URL)
        self._upload_files([video], "video")
        self._wait_for_edit_page("video")
        status = self.apply_publish_options(opts, "video")
        print(f"FIELD_STATUS: {json.dumps(status, ensure_ascii=False)}")
        print("DRAFT_STATUS: READY_TO_REVIEW")


def read_required_text(value: str | None, file_path: str | None, label: str) -> str:
    if file_path:
        return Path(file_path).read_text(encoding="utf-8").strip()
    if value:
        return value.strip()
    raise SystemExit(f"[ERROR] --{label} or --{label}-file is required")


def resolve_paths(paths: list[str]) -> list[Path]:
    resolved = [Path(p).resolve() for p in paths]
    for path in resolved:
        if not path.exists():
            raise SystemExit(f"[ERROR] file not found: {path}")
    return resolved


def build_options_from_args(args: argparse.Namespace, base_dir: Path | None) -> PublishOptions:
    """合并 publish-options.json 与 CLI 参数。"""
    opts_path = Path(args.options) if getattr(args, "options", None) else None
    if opts_path and opts_path.exists():
        opts = PublishOptions.load(
            opts_path,
            Path(args.title_file) if getattr(args, "title_file", None) else None,
            Path(args.content_file) if getattr(args, "content_file", None) else None,
        )
    else:
        opts = PublishOptions()
        base = base_dir or Path.cwd()
        if getattr(args, "title_file", None):
            opts.title = Path(args.title_file).read_text(encoding="utf-8").strip()
        elif getattr(args, "title", None):
            opts.title = args.title.strip()
        if getattr(args, "content_file", None):
            opts.content = Path(args.content_file).read_text(encoding="utf-8").strip()
        elif getattr(args, "content", None):
            opts.content = args.content.strip()

    if getattr(args, "collection", None):
        opts.collection = args.collection
    if getattr(args, "declaration", None):
        opts.declaration = args.declaration
    if getattr(args, "schedule", None):
        opts.schedule = args.schedule
    if getattr(args, "cover", None):
        p = Path(args.cover)
        opts.cover = str(p.resolve() if p.is_absolute() else (base_dir or Path.cwd()) / p)
    if getattr(args, "music_keyword", None):
        from publish_options import MusicOptions
        opts.music = MusicOptions(
            keyword=args.music_keyword,
            pick_index=int(getattr(args, "music_index", 0) or 0),
        )
    if getattr(args, "title", None) and not getattr(args, "title_file", None):
        opts.title = args.title
    if getattr(args, "content", None) and not getattr(args, "content_file", None):
        opts.content = args.content
    return opts


def add_publish_option_args(parser: argparse.ArgumentParser) -> None:
    """为子命令添加统一发布选项参数。"""
    parser.add_argument("--options", help="publish-options.json 路径")
    parser.add_argument("--title")
    parser.add_argument("--title-file")
    parser.add_argument("--content")
    parser.add_argument("--content-file")
    parser.add_argument("--collection", help="合集名称")
    parser.add_argument("--declaration", help="自主声明，如：个人观点，仅供参考")
    parser.add_argument("--schedule", help="定时发布 YYYY-MM-DD HH:MM")
    parser.add_argument("--cover", help="封面图路径")
    parser.add_argument("--music-keyword", help="平台曲库搜索关键词（图文/视频）")
    parser.add_argument("--music-index", type=int, default=0, help="曲库搜索结果序号")


def main() -> None:
    from chrome_launcher import ensure_chrome, restart_chrome

    parser = argparse.ArgumentParser(description="Douyin CDP draft filler")
    parser.add_argument("--headless", action="store_true", help="Use headless Chrome")
    parser.add_argument("--account", help="Chrome profile account name")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("check-login", help="Check login status")
    sub.add_parser("login", help="Open Douyin creator login page")

    image_post = sub.add_parser("fill-image", help="Fill image-text draft")
    add_publish_option_args(image_post)
    image_post.add_argument("--images", nargs="+", required=True)

    video_post = sub.add_parser("fill-video", help="Fill video draft")
    add_publish_option_args(video_post)
    video_post.add_argument("--video", required=True)

    args = parser.parse_args()

    if args.command == "login":
        restart_chrome(headless=False, account=args.account)
    elif not ensure_chrome(headless=args.headless, account=args.account):
        raise SystemExit("[ERROR] failed to start Chrome")

    publisher = DouyinPublisher()
    try:
        publisher.connect()
        if args.command == "check-login":
            raise SystemExit(0 if publisher.check_login() else 1)
        if args.command == "login":
            publisher.open_login_page()
        elif args.command in ("fill-image", "fill-video"):
            if getattr(args, "options", None):
                base_dir = Path(args.options).parent
            elif args.command == "fill-image":
                base_dir = Path(args.images[0]).parent.parent
            else:
                base_dir = Path(args.video).parent.parent
            opts = build_options_from_args(args, base_dir)
            if not opts.title:
                opts.title = read_required_text(
                    getattr(args, "title", None),
                    getattr(args, "title_file", None),
                    "title",
                )
            if args.command == "fill-image":
                publisher.fill_image_post(opts, resolve_paths(args.images))
            else:
                publisher.fill_video_post(opts, resolve_paths([args.video])[0])
    finally:
        publisher.disconnect()


if __name__ == "__main__":
    main()
