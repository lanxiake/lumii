"""
CDP-based Xiaohongshu publisher.

Connects to a Chrome instance via Chrome DevTools Protocol to automate
publishing articles on Xiaohongshu (RED) creator center.

CLI usage:
    # Basic commands (image-text mode)
    python cdp_publish.py check-login [--headless] [--account NAME]
    python cdp_publish.py fill --title "标题" --content "正文" --images img1.jpg [--headless] [--account NAME]
    python cdp_publish.py publish --title "标题" --content "正文" --images img1.jpg [--headless] [--account NAME]
    python cdp_publish.py click-publish [--headless] [--account NAME]

    # Long article mode
    python cdp_publish.py long-article --title "标题" --content "正文" [--images img1.jpg] [--account NAME]
    python cdp_publish.py click-next-step [--account NAME]

    # Account management
    python cdp_publish.py login [--account NAME]           # open browser for QR login
    python cdp_publish.py re-login [--account NAME]        # clear cookies and re-login same account
    python cdp_publish.py switch-account [--account NAME]  # clear cookies + open login for new account
    python cdp_publish.py list-accounts                    # list all configured accounts
    python cdp_publish.py add-account NAME [--alias ALIAS] # add a new account
    python cdp_publish.py remove-account NAME              # remove an account

Library usage:
    from cdp_publish import XiaohongshuPublisher

    publisher = XiaohongshuPublisher()
    publisher.connect()
    publisher.check_login()
    publisher.publish(
        title="Article title",
        content="Article body text",
        image_paths=["/path/to/img1.jpg", "/path/to/img2.jpg"],
    )
"""

import json
import os
import time
import sys
from typing import Any

# Ensure UTF-8 output on Windows consoles
if sys.platform == "win32":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import requests
import websockets.sync.client as ws_client

# ---------------------------------------------------------------------------
# Configuration - centralised selectors and URLs for easy maintenance
# ---------------------------------------------------------------------------

CDP_HOST = "127.0.0.1"
CDP_PORT = 9222

# Xiaohongshu URLs
XHS_CREATOR_URL = "https://creator.xiaohongshu.com/publish/publish"
XHS_HOME_URL = "https://www.xiaohongshu.com"
XHS_LOGIN_CHECK_URL = "https://creator.xiaohongshu.com"

# DOM selectors (update these when Xiaohongshu changes their page structure)
# Last verified: 2026-02
SELECTORS = {
    # "上传图文" tab - must click before uploading images
    "image_text_tab": "div.creator-tab",
    "image_text_tab_text": "上传图文",
    # Upload area - the file input element for images (visible after clicking tab)
    "upload_input": "input.upload-input",
    "upload_input_alt": 'input[type="file"]',
    # Title input field (visible after image upload)
    "title_input": 'input[placeholder*="填写标题"]',
    "title_input_alt": "input.d-text",
    # Content editor area - TipTap/ProseMirror contenteditable div
    "content_editor": "div.tiptap.ProseMirror",
    "content_editor_alt": 'div.ProseMirror[contenteditable="true"]',
    # Publish button
    "publish_button_text": "发布",
    # Login indicator - URL-based check (redirect to /login if not logged in)
    "login_indicator": '.user-info, .creator-header, [class*="user"]',
    # Long article mode
    "long_article_tab_text": "写长文",
    "new_creation_btn_text": "新的创作",
    "long_title_input": 'textarea.d-text[placeholder="输入标题"]',
    "auto_format_btn_text": "一键排版",
    "next_step_btn_text": "下一步",
    "template_card": ".template-card",
    "save_draft_btn_text": "暂存离开",
    # Long article editor toolbar: icon-only buttons. The image-insert button is
    # identified by its SVG path signature (robust to toolbar reordering), with a
    # positional index fallback (9th button = index 8).
    "long_toolbar_item": ".menu-item",
    "long_image_icon_path": "M6.91635 8.25017",
    "long_image_btn_index": 8,
}

# Timing
PAGE_LOAD_WAIT = 3  # seconds to wait after navigation
TAB_CLICK_WAIT = 2  # seconds to wait after clicking tab
UPLOAD_WAIT = 6  # seconds to wait after image upload for editor to appear
ACTION_INTERVAL = 1  # seconds between actions
AUTO_FORMAT_WAIT = 5  # seconds to wait after clicking auto-format
TEMPLATE_WAIT = 10  # seconds max to wait for template cards to appear
IMAGE_UPLOAD_WAIT = 6  # seconds to wait after each long-article image upload
FILE_CHOOSER_TIMEOUT = 8  # seconds max to wait for the file chooser dialog event


class CDPError(Exception):
    """Error communicating with Chrome via CDP."""


class XiaohongshuPublisher:
    """Automates publishing to Xiaohongshu via CDP."""

    def __init__(self, host: str = CDP_HOST, port: int = CDP_PORT):
        self.host = host
        self.port = port
        self.ws = None
        self._msg_id = 0

    # ------------------------------------------------------------------
    # CDP connection management
    # ------------------------------------------------------------------

    def _get_targets(self) -> list[dict]:
        """Get list of available browser targets (tabs). Retries once on failure."""
        url = f"http://{self.host}:{self.port}/json"
        for attempt in range(2):
            try:
                resp = requests.get(url, timeout=5)
                resp.raise_for_status()
                return resp.json()
            except Exception as e:
                if attempt == 0:
                    print(f"[cdp_publish] CDP connection failed ({e}), restarting Chrome...")
                    from chrome_launcher import ensure_chrome
                    ensure_chrome(self.port)
                    time.sleep(2)
                else:
                    raise CDPError(f"Cannot reach Chrome on {self.host}:{self.port}: {e}")

    def _find_or_create_tab(self, target_url_prefix: str = "") -> str:
        """Find an existing tab matching the URL prefix, or return the first page tab."""
        targets = self._get_targets()
        pages = [t for t in targets if t.get("type") == "page"]

        if target_url_prefix:
            for t in pages:
                if t.get("url", "").startswith(target_url_prefix):
                    return t["webSocketDebuggerUrl"]

        # Create a new tab
        resp = requests.put(
            f"http://{self.host}:{self.port}/json/new?{XHS_CREATOR_URL}",
            timeout=5,
        )
        if resp.ok:
            return resp.json().get("webSocketDebuggerUrl", "")

        # Fallback: use first available page
        if pages:
            return pages[0]["webSocketDebuggerUrl"]

        raise CDPError("No browser tabs available.")

    def connect(self, target_url_prefix: str = ""):
        """Connect to a Chrome tab via WebSocket."""
        ws_url = self._find_or_create_tab(target_url_prefix)
        if not ws_url:
            raise CDPError("Could not obtain WebSocket URL for any tab.")

        print(f"[cdp_publish] Connecting to {ws_url}")
        self.ws = ws_client.connect(ws_url)
        print("[cdp_publish] Connected to Chrome tab.")

    def disconnect(self):
        """Close the WebSocket connection."""
        if self.ws:
            self.ws.close()
            self.ws = None

    # ------------------------------------------------------------------
    # CDP command helpers
    # ------------------------------------------------------------------

    def _send(self, method: str, params: dict | None = None) -> dict:
        """Send a CDP command and return the result."""
        if not self.ws:
            raise CDPError("Not connected. Call connect() first.")

        self._msg_id += 1
        msg = {"id": self._msg_id, "method": method}
        if params:
            msg["params"] = params

        self.ws.send(json.dumps(msg))

        # Wait for the matching response
        while True:
            raw = self.ws.recv()
            data = json.loads(raw)
            if data.get("id") == self._msg_id:
                if "error" in data:
                    raise CDPError(f"CDP error: {data['error']}")
                return data.get("result", {})
            # else: it's an event, skip it

    def _evaluate(self, expression: str) -> Any:
        """Execute JavaScript in the page and return the result value."""
        result = self._send("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": True,
        })
        remote_obj = result.get("result", {})
        if remote_obj.get("subtype") == "error":
            raise CDPError(f"JS error: {remote_obj.get('description', remote_obj)}")
        return remote_obj.get("value")

    def _navigate(self, url: str):
        """Navigate the current tab to the given URL and wait for load."""
        print(f"[cdp_publish] Navigating to {url}")
        self._send("Page.enable")
        self._send("Page.navigate", {"url": url})
        time.sleep(PAGE_LOAD_WAIT)

    # ------------------------------------------------------------------
    # Login check
    # ------------------------------------------------------------------

    def check_login(self) -> bool:
        """
        Navigate to Xiaohongshu creator center and check if the user is logged in.

        Returns True if logged in. If not logged in, prints instructions
        and returns False.
        """
        self._navigate(XHS_LOGIN_CHECK_URL)
        time.sleep(2)

        # Check if we got redirected to a login page
        current_url = self._evaluate("window.location.href")
        print(f"[cdp_publish] Current URL: {current_url}")

        if "login" in current_url.lower():
            print(
                "\n[cdp_publish] NOT LOGGED IN.\n"
                "  Please scan the QR code in the Chrome window to log in,\n"
                "  then run this script again.\n"
            )
            return False

        print("[cdp_publish] Login confirmed.")
        return True

    def clear_cookies(self, domain: str = ".xiaohongshu.com"):
        """
        Clear all cookies for the given domain to force re-login.

        Used when switching accounts.
        """
        print(f"[cdp_publish] Clearing cookies for {domain}...")
        self._send("Network.enable")
        self._send("Network.clearBrowserCookies")
        # Also clear storage
        self._send("Storage.clearDataForOrigin", {
            "origin": "https://www.xiaohongshu.com",
            "storageTypes": "cookies,local_storage,session_storage",
        })
        self._send("Storage.clearDataForOrigin", {
            "origin": "https://creator.xiaohongshu.com",
            "storageTypes": "cookies,local_storage,session_storage",
        })
        print("[cdp_publish] Cookies and storage cleared.")

    def open_login_page(self):
        """
        Navigate to the Xiaohongshu login page for QR code scanning.

        Used for initial login or after clearing cookies for account switch.
        """
        self._navigate(XHS_LOGIN_CHECK_URL)
        time.sleep(2)
        current_url = self._evaluate("window.location.href")
        if "login" not in current_url.lower():
            # Already logged in, navigate to login page explicitly
            self._navigate("https://creator.xiaohongshu.com/login")
            time.sleep(2)
        print(
            "\n[cdp_publish] Login page is open.\n"
            "  Please scan the QR code in the Chrome window to log in.\n"
        )

    # ------------------------------------------------------------------
    # Publishing actions
    # ------------------------------------------------------------------

    def _click_image_text_tab(self):
        """Click the '上传图文' tab to switch to image+text publish mode."""
        print("[cdp_publish] Clicking '上传图文' tab...")
        tab_text = SELECTORS["image_text_tab_text"]
        selector = SELECTORS["image_text_tab"]

        clicked = self._evaluate(f"""
            (function() {{
                var tabs = document.querySelectorAll('{selector}');
                for (var i = 0; i < tabs.length; i++) {{
                    if (tabs[i].textContent.trim() === '{tab_text}') {{
                        tabs[i].click();
                        return true;
                    }}
                }}
                return false;
            }})();
        """)

        if not clicked:
            raise CDPError(
                f"Could not find '{tab_text}' tab. "
                "The page structure may have changed."
            )

        print("[cdp_publish] Tab clicked, waiting for upload area...")
        time.sleep(TAB_CLICK_WAIT)

    def _upload_images(self, image_paths: list[str]):
        """Upload images via the file input element."""
        if not image_paths:
            print("[cdp_publish] No images to upload, skipping.")
            return

        # Normalize paths (forward slashes for CDP)
        normalized = [p.replace("\\", "/") for p in image_paths]

        print(f"[cdp_publish] Uploading {len(image_paths)} image(s)...")

        # Enable DOM domain
        self._send("DOM.enable")

        # Get the document root
        doc = self._send("DOM.getDocument")
        root_id = doc["root"]["nodeId"]

        # Try primary selector, then fallback
        node_id = 0
        for selector in (SELECTORS["upload_input"], SELECTORS["upload_input_alt"]):
            result = self._send("DOM.querySelector", {
                "nodeId": root_id,
                "selector": selector,
            })
            node_id = result.get("nodeId", 0)
            if node_id:
                break

        if not node_id:
            raise CDPError(
                "Could not find file input element.\n"
                "The page structure may have changed. Check references/publish-workflow.md."
            )

        # Use DOM.setFileInputFiles to set the files
        self._send("DOM.setFileInputFiles", {
            "nodeId": node_id,
            "files": normalized,
        })

        print("[cdp_publish] Images uploaded. Waiting for editor to appear...")
        time.sleep(UPLOAD_WAIT)

    def _fill_title(self, title: str):
        """Fill in the article title."""
        print(f"[cdp_publish] Setting title: {title[:40]}...")
        time.sleep(ACTION_INTERVAL)

        for selector in (SELECTORS["title_input"], SELECTORS["title_input_alt"]):
            found = self._evaluate(f"!!document.querySelector('{selector}')")
            if found:
                escaped_title = json.dumps(title)
                self._evaluate(f"""
                    (function() {{
                        var el = document.querySelector('{selector}');
                        var nativeSetter = Object.getOwnPropertyDescriptor(
                            window.HTMLInputElement.prototype, 'value'
                        ).set;
                        el.focus();
                        nativeSetter.call(el, {escaped_title});
                        el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                        el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                    }})();
                """)
                print("[cdp_publish] Title set.")
                return

        raise CDPError("Could not find title input element.")

    def _fill_content(self, content: str):
        """Fill in the article body content using the TipTap/ProseMirror editor."""
        print(f"[cdp_publish] Setting content ({len(content)} chars)...")
        time.sleep(ACTION_INTERVAL)

        for selector in (SELECTORS["content_editor"], SELECTORS["content_editor_alt"]):
            found = self._evaluate(f"!!document.querySelector('{selector}')")
            if found:
                escaped = json.dumps(content)
                self._evaluate(f"""
                    (function() {{
                        var el = document.querySelector('{selector}');
                        el.focus();
                        var text = {escaped};
                        var paragraphs = text.split('\\n').filter(function(p) {{ return p.trim(); }});
                        var html = [];
                        for (var i = 0; i < paragraphs.length; i++) {{
                            html.push('<p>' + paragraphs[i] + '</p>');
                            if (i < paragraphs.length - 1) {{
                                html.push('<p><br></p>');
                            }}
                        }}
                        el.innerHTML = html.join('');
                        el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                    }})();
                """)
                print("[cdp_publish] Content set.")
                return

        raise CDPError("Could not find content editor element.")

    def _set_schedule(self, when: str) -> bool:
        """设置定时发布时间（YYYY-MM-DD HH:MM），在点击发布前调用。"""
        from xhs_ui import js_set_schedule

        print(f"[cdp_publish] Setting scheduled publish time: {when}")
        time.sleep(ACTION_INTERVAL)
        ok = bool(self._evaluate(js_set_schedule(when)))
        if ok:
            print("[cdp_publish] Schedule set.")
        else:
            print(
                "[cdp_publish] Warning: could not set schedule automatically. "
                "Please set it manually in the browser.",
                file=sys.stderr,
            )
        return ok

    def _click_publish(self, schedule: str | None = None):
        """Click the publish button (found by text content)."""
        if schedule:
            self._set_schedule(schedule)
        print("[cdp_publish] Clicking publish button...")
        time.sleep(ACTION_INTERVAL)

        btn_text = SELECTORS["publish_button_text"]
        clicked = self._evaluate(f"""
            (function() {{
                // Strategy 1: search <button> elements by text
                var buttons = document.querySelectorAll('button');
                for (var i = 0; i < buttons.length; i++) {{
                    var t = buttons[i].textContent.trim();
                    if (t === '{btn_text}') {{
                        buttons[i].click();
                        return true;
                    }}
                }}
                // Strategy 2: search d-button-content / d-text spans
                var spans = document.querySelectorAll('.d-button-content .d-text, .d-button-content span');
                for (var i = 0; i < spans.length; i++) {{
                    if (spans[i].textContent.trim() === '{btn_text}') {{
                        var el = spans[i].closest('button, [role="button"], .d-button, [class*="btn"], [class*="button"]');
                        if (!el) el = spans[i].closest('.d-button-content');
                        if (!el) el = spans[i];
                        el.click();
                        return true;
                    }}
                }}
                return false;
            }})();
        """)

        if clicked:
            print("[cdp_publish] Publish button clicked.")
        else:
            raise CDPError(
                "Could not find publish button. "
                "Please click it manually in the browser."
            )

    # ------------------------------------------------------------------
    # Long article actions
    # ------------------------------------------------------------------

    def _click_long_article_tab(self):
        """Click the '写长文' tab to switch to long article mode."""
        print("[cdp_publish] Clicking '写长文' tab...")
        tab_text = SELECTORS["long_article_tab_text"]
        selector = SELECTORS["image_text_tab"]  # same container: div.creator-tab

        clicked = self._evaluate(f"""
            (function() {{
                var tabs = document.querySelectorAll('{selector}');
                for (var i = 0; i < tabs.length; i++) {{
                    if (tabs[i].textContent.trim() === '{tab_text}') {{
                        tabs[i].click();
                        return true;
                    }}
                }}
                return false;
            }})();
        """)

        if not clicked:
            raise CDPError(
                f"Could not find '{tab_text}' tab. "
                "The page structure may have changed."
            )

        print("[cdp_publish] '写长文' tab clicked.")
        time.sleep(TAB_CLICK_WAIT)

    def _click_new_creation(self):
        """Click the '新的创作' button to start a new long article."""
        print("[cdp_publish] Clicking '新的创作' button...")
        btn_text = SELECTORS["new_creation_btn_text"]

        clicked = self._evaluate(f"""
            (function() {{
                // Search all elements for text match
                var candidates = document.querySelectorAll(
                    '.center span, .center div, .center button, .center a, '
                    + 'button, [role="button"], [class*="btn"], [class*="creation"]'
                );
                for (var i = 0; i < candidates.length; i++) {{
                    if (candidates[i].textContent.trim() === '{btn_text}') {{
                        candidates[i].click();
                        return true;
                    }}
                }}
                return false;
            }})();
        """)

        if not clicked:
            raise CDPError(
                f"Could not find '{btn_text}' button. "
                "The page structure may have changed."
            )

        print("[cdp_publish] '新的创作' button clicked.")
        time.sleep(PAGE_LOAD_WAIT)

    def _fill_long_title(self, title: str):
        """Fill in the long article title (textarea element)."""
        print(f"[cdp_publish] Setting long article title: {title[:40]}...")
        time.sleep(ACTION_INTERVAL)

        selector = SELECTORS["long_title_input"]
        found = self._evaluate(f"!!document.querySelector('{selector}')")
        if not found:
            raise CDPError(
                f"Could not find long title textarea ('{selector}'). "
                "The page structure may have changed."
            )

        escaped_title = json.dumps(title)
        self._evaluate(f"""
            (function() {{
                var el = document.querySelector('{selector}');
                var nativeSetter = Object.getOwnPropertyDescriptor(
                    window.HTMLTextAreaElement.prototype, 'value'
                ).set;
                el.focus();
                nativeSetter.call(el, {escaped_title});
                el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                el.dispatchEvent(new Event('change', {{ bubbles: true }}));
            }})();
        """)
        print("[cdp_publish] Long article title set.")

    def _click_auto_format(self):
        """Click the '一键排版' button."""
        print("[cdp_publish] Clicking '一键排版' button...")
        btn_text = SELECTORS["auto_format_btn_text"]

        clicked = self._evaluate(f"""
            (function() {{
                var elems = document.querySelectorAll(
                    'button, [role="button"], span, div, a, [class*="btn"]'
                );
                for (var i = 0; i < elems.length; i++) {{
                    if (elems[i].textContent.trim() === '{btn_text}') {{
                        elems[i].click();
                        return true;
                    }}
                }}
                return false;
            }})();
        """)

        if not clicked:
            raise CDPError(
                f"Could not find '{btn_text}' button. "
                "The page structure may have changed."
            )

        print("[cdp_publish] '一键排版' button clicked. Waiting for templates...")
        time.sleep(AUTO_FORMAT_WAIT)

    def _wait_for_templates(self) -> bool:
        """Wait for template cards to appear after clicking auto-format."""
        print("[cdp_publish] Waiting for template cards to load...")
        selector = SELECTORS["template_card"]

        for attempt in range(TEMPLATE_WAIT):
            found = self._evaluate(
                f"document.querySelectorAll('{selector}').length"
            )
            if found and found > 0:
                print(f"[cdp_publish] Found {found} template card(s).")
                return True
            time.sleep(1)

        print("[cdp_publish] Warning: No template cards found within timeout.")
        return False

    def get_template_names(self) -> list[str]:
        """Get the list of available template names from the page."""
        selector = SELECTORS["template_card"]
        names = self._evaluate(f"""
            (function() {{
                var cards = document.querySelectorAll('{selector}');
                var names = [];
                for (var i = 0; i < cards.length; i++) {{
                    var title = cards[i].querySelector('.template-title');
                    names.push(title ? title.textContent.trim() : 'Template ' + i);
                }}
                return names;
            }})();
        """)
        return names or []

    def select_template(self, name: str) -> bool:
        """Select a template by clicking the card with the matching name."""
        print(f"[cdp_publish] Selecting template: {name}...")
        selector = SELECTORS["template_card"]

        clicked = self._evaluate(f"""
            (function() {{
                var cards = document.querySelectorAll('{selector}');
                for (var i = 0; i < cards.length; i++) {{
                    var title = cards[i].querySelector('.template-title');
                    if (title && title.textContent.trim() === {json.dumps(name)}) {{
                        cards[i].click();
                        return true;
                    }}
                }}
                return false;
            }})();
        """)

        if clicked:
            print(f"[cdp_publish] Template '{name}' selected.")
            time.sleep(ACTION_INTERVAL)
        else:
            print(f"[cdp_publish] Warning: Template '{name}' not found.")

        return bool(clicked)

    def _click_next_step(self):
        """Click the '下一步' button."""
        print("[cdp_publish] Clicking '下一步' button...")
        btn_text = SELECTORS["next_step_btn_text"]

        clicked = self._evaluate(f"""
            (function() {{
                var elems = document.querySelectorAll(
                    'button, [role="button"], span, div, a, [class*="btn"]'
                );
                for (var i = 0; i < elems.length; i++) {{
                    if (elems[i].textContent.trim() === '{btn_text}') {{
                        elems[i].click();
                        return true;
                    }}
                }}
                return false;
            }})();
        """)

        if not clicked:
            raise CDPError(
                f"Could not find '{btn_text}' button. "
                "The page structure may have changed."
            )

        print("[cdp_publish] '下一步' button clicked.")
        time.sleep(PAGE_LOAD_WAIT)

    # ------------------------------------------------------------------
    # Long article image insertion
    # ------------------------------------------------------------------

    def _find_long_image_button(self) -> dict | None:
        """
        Locate the image-insert button in the long-article editor toolbar.

        The toolbar buttons are icon-only (no text), so we match the image
        button by its SVG path signature, falling back to a positional index.
        Returns {"x", "y", "by"} center coordinates, or None if not found.
        """
        sig = SELECTORS["long_image_icon_path"]
        idx = SELECTORS["long_image_btn_index"]
        item_sel = SELECTORS["long_toolbar_item"]
        return self._evaluate(f"""
            (function() {{
                var items = document.querySelectorAll({json.dumps(item_sel)});
                if (!items.length) return null;
                function center(el) {{
                    var r = el.getBoundingClientRect();
                    return {{x: r.x + r.width / 2, y: r.y + r.height / 2}};
                }}
                // Primary: match by SVG path signature (robust to reordering)
                for (var i = 0; i < items.length; i++) {{
                    var p = items[i].querySelector('path');
                    if (p && (p.getAttribute('d') || '').indexOf({json.dumps(sig)}) !== -1) {{
                        var c = center(items[i]); c.by = 'signature'; return c;
                    }}
                }}
                // Fallback: positional index
                if (items.length > {idx}) {{
                    var c2 = center(items[{idx}]); c2.by = 'index'; return c2;
                }}
                return null;
            }})();
        """)

    def _real_click_and_catch_filechooser(
        self, cx: float, cy: float, timeout: int = FILE_CHOOSER_TIMEOUT
    ) -> int | None:
        """
        Dispatch a real (trusted) mouse click and capture the file chooser it opens.

        A synthetic element.click() does NOT carry user activation, so the browser
        blocks the file dialog the button's handler tries to open. Real CDP input
        events are trusted, so the dialog opens and (with interception enabled)
        fires Page.fileChooserOpened instead of showing the native OS dialog.

        Returns the backendNodeId of the file input, or None on timeout.
        Requires Page.setInterceptFileChooserDialog to be enabled by the caller.
        """
        # Send move + press + release as raw frames, then read the unified stream
        # so we never lose the async fileChooserOpened event to a _send() drain.
        events = [
            ("mouseMoved", {}),
            ("mousePressed", {"button": "left", "clickCount": 1}),
            ("mouseReleased", {"button": "left", "clickCount": 1}),
        ]
        for typ, extra in events:
            self._msg_id += 1
            params = {"type": typ, "x": cx, "y": cy}
            params.update(extra)
            self.ws.send(json.dumps({
                "id": self._msg_id,
                "method": "Input.dispatchMouseEvent",
                "params": params,
            }))

        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                raw = self.ws.recv(timeout=max(0.1, deadline - time.time()))
            except Exception:
                break
            data = json.loads(raw)
            if data.get("method") == "Page.fileChooserOpened":
                return data.get("params", {}).get("backendNodeId")
        return None

    def _insert_long_images(self, image_paths: list[str]):
        """
        Insert images into the long-article editor via the toolbar image button.

        For each image: locate the button, real-click it to open the (intercepted)
        file chooser, then set the file via DOM.setFileInputFiles. The chooser is
        single-select, so images are inserted one at a time, in order.
        """
        if not image_paths:
            return

        normalized = [p.replace("\\", "/") for p in image_paths]
        print(f"[cdp_publish] Inserting {len(normalized)} image(s) into long article...")

        self._send("Page.enable")
        self._send("DOM.enable")
        self._send("Page.setInterceptFileChooserDialog", {"enabled": True})
        try:
            for i, img in enumerate(normalized, 1):
                coords = self._find_long_image_button()
                if not coords:
                    raise CDPError(
                        "Could not locate the long-article image toolbar button. "
                        "The editor toolbar structure may have changed."
                    )
                backend_node_id = self._real_click_and_catch_filechooser(
                    coords["x"], coords["y"]
                )
                if backend_node_id is None:
                    print(f"[cdp_publish] WARNING: image {i} - file chooser did not open, skipping.")
                    continue
                self._send("DOM.setFileInputFiles", {
                    "backendNodeId": backend_node_id,
                    "files": [img],
                })
                print(f"[cdp_publish] image {i}/{len(normalized)} uploaded (via {coords.get('by')}).")
                time.sleep(IMAGE_UPLOAD_WAIT)
        finally:
            self._send("Page.setInterceptFileChooserDialog", {"enabled": False})

    def _place_cursor_at_anchor(self, anchor: str, where: str = "after") -> bool:
        """
        Move the editor caret to a block identified by its text, so the next
        image insert lands there.

        where:
          - "top":    start of the first block (image goes above everything)
          - "before": start of the block containing `anchor`
          - "after":  end of the block containing `anchor`  (default)
        Returns True if the anchor block was found and the caret was placed.
        """
        return bool(self._evaluate(f"""
            (function() {{
                var ed = document.querySelector('div.tiptap.ProseMirror');
                if (!ed) return false;
                ed.focus();
                var where = {json.dumps(where)};
                var target = null, toEnd = true;
                if (where === 'top') {{
                    target = ed.firstElementChild; toEnd = false;
                }} else {{
                    var anchor = {json.dumps(anchor)};
                    var blocks = ed.querySelectorAll('p, h1, h2, h3, li, blockquote');
                    for (var i = 0; i < blocks.length; i++) {{
                        if (blocks[i].textContent.indexOf(anchor) !== -1) {{ target = blocks[i]; break; }}
                    }}
                    toEnd = (where !== 'before');
                }}
                if (!target) return false;
                var range = document.createRange();
                range.selectNodeContents(target);
                range.collapse(!toEnd);  // collapse(true)=start, collapse(false)=end
                var sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
                return true;
            }})();
        """))

    def insert_images_at_anchors(self, placements: list[dict]):
        """
        Insert images at specific positions in the long-article editor.

        Each placement is a dict: {"path": <file>, "anchor": <text snippet>,
        "where": "top"|"before"|"after"}. The caret is moved to the anchor block
        before each insert, so images land in-flow instead of all at the end.
        """
        if not placements:
            return

        print(f"[cdp_publish] Inserting {len(placements)} image(s) at anchors...")
        self._send("Page.enable")
        self._send("DOM.enable")
        self._send("Page.setInterceptFileChooserDialog", {"enabled": True})
        try:
            for i, pl in enumerate(placements, 1):
                img = pl["path"].replace("\\", "/")
                anchor = pl.get("anchor", "")
                where = pl.get("where", "after")
                placed = self._place_cursor_at_anchor(anchor, where)
                if not placed:
                    print(f"[cdp_publish] WARNING: anchor not found for image {i} "
                          f"({anchor[:20]!r}); inserting at current caret.")
                coords = self._find_long_image_button()
                if not coords:
                    raise CDPError("Could not locate the long-article image toolbar button.")
                backend_node_id = self._real_click_and_catch_filechooser(coords["x"], coords["y"])
                if backend_node_id is None:
                    print(f"[cdp_publish] WARNING: image {i} - file chooser did not open, skipping.")
                    continue
                self._send("DOM.setFileInputFiles", {
                    "backendNodeId": backend_node_id,
                    "files": [img],
                })
                print(f"[cdp_publish] image {i}/{len(placements)} inserted "
                      f"@ {where}:{anchor[:16]!r} ({'placed' if placed else 'fallback'}).")
                time.sleep(IMAGE_UPLOAD_WAIT)
        finally:
            self._send("Page.setInterceptFileChooserDialog", {"enabled": False})

    def upload_cover(self, cover_path: str) -> bool:
        """
        Upload a custom cover image on the '一键排版' page.

        XHS reveals two buttons when hovering the FIRST preview page:
        'AI换配图' and '从本地上传'. We dispatch a trusted mouse hover to surface
        them, then real-click '从本地上传' and feed the file via the intercepted
        file chooser (synthetic clicks can't open file dialogs).

        Returns True if the cover file was submitted.
        """
        cover = cover_path.replace("\\", "/")
        print(f"[cdp_publish] Uploading custom cover: {cover}")

        # Find the FIRST preview page (leftmost portrait card). XHS reveals the
        # cover buttons just below the page when it is hovered.
        page0 = self._evaluate(r"""
            (function(){
                function c(el){var r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),left:Math.round(r.x),top:Math.round(r.y)};}
                var nodes=document.querySelectorAll('div, section, li');
                var pages=[];
                for (var i=0;i<nodes.length;i++){
                    var r=nodes[i].getBoundingClientRect();
                    if (r.width>140 && r.width<420 && r.height>180 && r.height<620 && r.x<800 && r.y>60){
                        pages.push(c(nodes[i]));
                    }
                }
                pages.sort(function(a,b){return a.left-b.left || a.top-b.top;});
                return pages.length ? pages[0] : null;
            })();
        """)
        if not page0:
            raise CDPError("Could not locate the first preview page to hover for cover upload.")

        # Hover the page center (trusted move) to reveal 'Ai换配图' + '从本地上传'.
        self._send("Input.dispatchMouseEvent", {
            "type": "mouseMoved", "x": page0["x"], "y": page0["y"],
        })
        time.sleep(1.5)

        # Locate '从本地上传' button center.
        btn = self._evaluate(r"""
            (function(){
                function c(el){var r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};}
                var all=document.querySelectorAll('*');
                for (var i=0;i<all.length;i++){
                    var t=(all[i].textContent||'').trim();
                    if ((t==='从本地上传' || t==='本地上传') && all[i].children.length<=2){
                        return c(all[i]);
                    }
                }
                return null;
            })();
        """)
        if not btn:
            raise CDPError("'从本地上传' button not found after hovering first preview page.")

        self._send("Page.enable")
        self._send("DOM.enable")
        self._send("Page.setInterceptFileChooserDialog", {"enabled": True})
        try:
            backend_node_id = self._real_click_and_catch_filechooser(btn["x"], btn["y"])
            if backend_node_id is None:
                print("[cdp_publish] WARNING: cover file chooser did not open.")
                return False
            self._send("DOM.setFileInputFiles", {
                "backendNodeId": backend_node_id,
                "files": [cover],
            })
        finally:
            self._send("Page.setInterceptFileChooserDialog", {"enabled": False})

        print("[cdp_publish] Custom cover uploaded.")
        time.sleep(IMAGE_UPLOAD_WAIT)
        return True

    def save_draft(self):
        """Click '暂存离开' to save the current long article as a draft and exit."""
        print("[cdp_publish] Saving draft ('暂存离开')...")
        btn_text = SELECTORS["save_draft_btn_text"]
        clicked = self._evaluate(f"""
            (function() {{
                var elems = document.querySelectorAll('button, [role="button"], span, div, a, [class*="btn"]');
                for (var i = 0; i < elems.length; i++) {{
                    if (elems[i].textContent.trim() === {json.dumps(btn_text)}) {{
                        var el = elems[i].closest('button, [role="button"], [class*="btn"]') || elems[i];
                        el.click();
                        return true;
                    }}
                }}
                return false;
            }})();
        """)
        if not clicked:
            raise CDPError(f"Could not find '{btn_text}' button to save draft.")
        print("[cdp_publish] Draft save clicked.")
        time.sleep(PAGE_LOAD_WAIT)

    def _fill_long_article(
        self,
        title: str,
        content: str,
        image_paths: list[str] | None = None,
        placements: list[dict] | None = None,
    ):
        """
        Open the long-article editor and fill it in:
        1. Navigate to creator publish page
        2. Click '写长文' tab
        3. Click '新的创作' button
        4. Fill title (textarea)
        5. Fill content (TipTap editor)
        6. Insert images into editor (if provided)

        If `placements` is given, images are inserted at their text anchors
        (in-flow). Otherwise `image_paths` are grouped at the end.
        """
        if not self.ws:
            raise CDPError("Not connected. Call connect() first.")

        self._navigate(XHS_CREATOR_URL)
        time.sleep(2)
        self._click_long_article_tab()
        self._click_new_creation()
        self._fill_long_title(title)
        self._fill_content(content)
        if placements:
            self.insert_images_at_anchors(placements)
        elif image_paths:
            self._insert_long_images(image_paths)

    def publish_long_article(
        self,
        title: str,
        content: str,
        image_paths: list[str] | None = None,
        placements: list[dict] | None = None,
    ) -> list[str]:
        """
        Execute the full long article publish workflow: fill the editor
        (title / content / images), then click '一键排版' and wait for the
        formatting templates to load.

        Returns list of available template names for the caller to
        present to the user for selection.

        Args:
            title: Article title
            content: Article body text (paragraphs separated by newlines)
            image_paths: Optional list of local file paths to images
            placements: Optional in-flow image placements (text anchors)
        """
        # Steps 1-6: open editor and fill title / content / images
        self._fill_long_article(title, content, image_paths, placements)

        # Step 7: Click '一键排版'
        self._click_auto_format()

        # Step 8: Wait for templates and return names
        self._wait_for_templates()
        template_names = self.get_template_names()

        print(
            "\n[cdp_publish] Templates loaded.\n"
            "  Available templates: " + ", ".join(template_names) + "\n"
        )
        return template_names

    def fill_long_article_to_draft(
        self,
        title: str,
        content: str,
        image_paths: list[str] | None = None,
        placements: list[dict] | None = None,
        save: bool = True,
    ):
        """
        Fill the long-article editor (title / content / images) and save it as a
        draft via '暂存离开' — without going through formatting/publishing.

        This is the 'publish to draft box' (发布到草稿箱) flow: it never publishes.
        If save is False, the editor is left open (content is auto-saved) so the
        user can review before saving manually.

        If `placements` is given, images land at their text anchors (in-flow).
        """
        self._fill_long_article(title, content, image_paths, placements)
        if save:
            self.save_draft()
            print("\n[cdp_publish] Long article saved to draft box.\n")
        else:
            print(
                "\n[cdp_publish] Long article filled (auto-saved as draft).\n"
                "  Review in the browser; click '暂存离开' to commit the draft.\n"
            )

    def click_next_and_prepare_publish(self, content: str = ""):
        """After user selects a template, click '下一步' and fill the publish page description."""
        self._click_next_step()

        # The publish page has a separate content editor for the post description
        if content:
            time.sleep(ACTION_INTERVAL)
            self._fill_content(content)

        print(
            "\n[cdp_publish] Ready to publish.\n"
            "  Please review in the browser before confirming publish.\n"
        )

    # ------------------------------------------------------------------
    # Main publish workflow (image-text mode)
    # ------------------------------------------------------------------

    def publish(
        self,
        title: str,
        content: str,
        image_paths: list[str] | None = None,
    ):
        """
        Execute the full publish workflow:
        1. Navigate to creator publish page
        2. Click '上传图文' tab
        3. Upload images (this triggers the editor to appear)
        4. Fill title
        5. Fill content

        Args:
            title: Article title
            content: Article body text (paragraphs separated by newlines)
            image_paths: List of local file paths to images to upload
        """
        if not self.ws:
            raise CDPError("Not connected. Call connect() first.")

        if not image_paths:
            raise CDPError("At least one image is required to publish on Xiaohongshu.")

        # Step 1: Navigate to publish page
        self._navigate(XHS_CREATOR_URL)
        time.sleep(2)

        # Step 2: Click '上传图文' tab
        self._click_image_text_tab()

        # Step 3: Upload images (editor appears after upload)
        self._upload_images(image_paths)

        # Step 4: Fill title
        self._fill_title(title)

        # Step 5: Fill content
        self._fill_content(content)

        print(
            "\n[cdp_publish] Content has been filled in.\n"
            "  Please review in the browser before publishing.\n"
        )



# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main():
    import argparse
    from chrome_launcher import ensure_chrome, restart_chrome

    parser = argparse.ArgumentParser(description="Xiaohongshu CDP Publisher")
    parser.add_argument("--headless", action="store_true",
                        help="Use headless Chrome (no GUI window)")
    parser.add_argument("--account", help="Account name to use (default: default account)")
    sub = parser.add_subparsers(dest="command", required=True)

    # check-login
    sub.add_parser("check-login", help="Check login status (exit 0=logged in, 1=not)")

    # fill - fill form without clicking publish
    p_fill = sub.add_parser("fill", help="Fill title/content/images without publishing")
    p_fill.add_argument("--title", required=True)
    p_fill.add_argument("--content", default=None)
    p_fill.add_argument("--content-file", default=None, help="Read content from file")
    p_fill.add_argument("--images", nargs="+", required=True)

    # publish - fill form and click publish
    p_pub = sub.add_parser("publish", help="Fill form and click publish")
    p_pub.add_argument("--title", required=True)
    p_pub.add_argument("--content", default=None)
    p_pub.add_argument("--content-file", default=None, help="Read content from file")
    p_pub.add_argument("--images", nargs="+", required=True)

    for p in (p_fill, p_pub):
        p.add_argument("--schedule", default=None, help="Scheduled time YYYY-MM-DD HH:MM")

    # long-article - long article mode
    p_long = sub.add_parser("long-article", help="Fill long article content with auto-format and template selection")
    p_long.add_argument("--title", default=None)
    p_long.add_argument("--title-file", default=None, help="Read title from file")
    p_long.add_argument("--content", default=None)
    p_long.add_argument("--content-file", default=None, help="Read content from file")
    p_long.add_argument("--images", nargs="+", default=None, help="Optional image file paths")
    p_long.add_argument("--placements", default=None,
                        help="JSON file with [{path, anchor, where}] for in-flow image placement "
                             "(overrides --images positioning). 'where' is top|before|after.")
    p_long.add_argument("--save-draft", action="store_true",
                        help="Fill title/content/images and save as a draft (暂存离开), skipping auto-format/publish")
    p_long.add_argument("--no-save", action="store_true",
                        help="With --save-draft: fill only, leave editor open (auto-saved) without clicking 暂存离开")

    # select-template - select a template by name
    p_tpl = sub.add_parser("select-template", help="Select a long article template by name")
    p_tpl.add_argument("--name", required=True, help="Template name to select")

    # upload-cover - upload a custom cover on the 一键排版 page
    p_cov = sub.add_parser("upload-cover",
                           help="Upload a custom cover image on the auto-format page "
                                "(hover first preview page → 从本地上传)")
    p_cov.add_argument("--cover", required=True, help="Cover image file path")

    # click-next-step - click next step button (for long article after template selection)
    p_next = sub.add_parser("click-next-step", help="Click '下一步' button after template selection")
    p_next.add_argument("--content", default=None, help="Post description text")
    p_next.add_argument("--content-file", default=None, help="Read post description from file")

    # set-schedule - set scheduled publish time on current page
    p_sched = sub.add_parser("set-schedule", help="Set scheduled publish time on current page")
    p_sched.add_argument("--schedule", required=True, help="YYYY-MM-DD HH:MM")

    # click-publish - just click the publish button on current page
    p_click = sub.add_parser("click-publish", help="Click publish button on already-filled page")
    p_click.add_argument("--schedule", default=None, help="Optional scheduled time YYYY-MM-DD HH:MM")

    # login - open browser for QR code login (always headed)
    sub.add_parser("login", help="Open browser for QR code login (always headed mode)")

    # re-login - clear cookies and re-login the same account (always headed)
    sub.add_parser("re-login", help="Clear cookies and re-login same account (always headed)")

    # switch-account - clear cookies and open login page (always headed)
    sub.add_parser("switch-account",
                   help="Clear cookies and open login page for new account (always headed)")

    # list-accounts - list all configured accounts
    sub.add_parser("list-accounts", help="List all configured accounts")

    # add-account - add a new account
    p_add = sub.add_parser("add-account", help="Add a new account")
    p_add.add_argument("name", help="Account name (unique identifier)")
    p_add.add_argument("--alias", help="Display name / description")

    # remove-account - remove an account
    p_rm = sub.add_parser("remove-account", help="Remove an account")
    p_rm.add_argument("name", help="Account name to remove")
    p_rm.add_argument("--delete-profile", action="store_true",
                      help="Also delete the Chrome profile directory")

    # set-default-account - set default account
    p_def = sub.add_parser("set-default-account", help="Set the default account")
    p_def.add_argument("name", help="Account name to set as default")

    args = parser.parse_args()
    headless = args.headless
    account = args.account

    # Account management commands that don't need Chrome
    if args.command == "list-accounts":
        from account_manager import list_accounts
        accounts = list_accounts()
        if not accounts:
            print("No accounts configured.")
            return
        print(f"{'Name':<20} {'Alias':<25} {'Default':<10}")
        print("-" * 55)
        for acc in accounts:
            default_mark = "*" if acc["is_default"] else ""
            print(f"{acc['name']:<20} {acc['alias']:<25} {default_mark:<10}")
        return

    elif args.command == "add-account":
        from account_manager import add_account, get_profile_dir
        if add_account(args.name, args.alias):
            print(f"Account '{args.name}' added.")
            print(f"Profile dir: {get_profile_dir(args.name)}")
            print("\nTo log in to this account, run:")
            print(f"  python cdp_publish.py --account {args.name} login")
        else:
            print(f"Error: Account '{args.name}' already exists.", file=sys.stderr)
            sys.exit(1)
        return

    elif args.command == "remove-account":
        from account_manager import remove_account
        if remove_account(args.name, args.delete_profile):
            print(f"Account '{args.name}' removed.")
        else:
            print(f"Error: Cannot remove account '{args.name}'.", file=sys.stderr)
            sys.exit(1)
        return

    elif args.command == "set-default-account":
        from account_manager import set_default_account
        if set_default_account(args.name):
            print(f"Default account set to '{args.name}'.")
        else:
            print(f"Error: Account '{args.name}' not found.", file=sys.stderr)
            sys.exit(1)
        return

    # Commands that require Chrome - login/re-login/switch-account always headed
    if args.command in ("login", "re-login", "switch-account"):
        headless = False

    if not ensure_chrome(headless=headless, account=account):
        print("Failed to start Chrome. Exiting.")
        sys.exit(1)

    publisher = XiaohongshuPublisher()
    try:
        if args.command == "check-login":
            publisher.connect()
            logged_in = publisher.check_login()
            if not logged_in and headless:
                print(
                    "[cdp_publish] Headless mode: cannot scan QR code.\n"
                    "  Run with 'login' command or without --headless to log in."
                )
            sys.exit(0 if logged_in else 1)

        elif args.command in ("fill", "publish"):
            content = args.content
            if args.content_file:
                with open(args.content_file, encoding="utf-8") as f:
                    content = f.read().strip()
            if not content:
                print("Error: --content or --content-file required.", file=sys.stderr)
                sys.exit(1)

            publisher.connect()
            publisher.publish(title=args.title, content=content, image_paths=args.images)
            print("FILL_STATUS: READY_TO_PUBLISH")

            if args.command == "publish":
                publisher._click_publish(schedule=getattr(args, "schedule", None))
                if getattr(args, "schedule", None):
                    print(f"SCHEDULE_STATUS: {args.schedule}")
                print("PUBLISH_STATUS: PUBLISHED")

        elif args.command == "long-article":
            title = args.title
            if args.title_file:
                with open(args.title_file, encoding="utf-8") as f:
                    title = f.read().strip()
            if not title:
                print("Error: --title or --title-file required.", file=sys.stderr)
                sys.exit(1)

            content = args.content
            if args.content_file:
                with open(args.content_file, encoding="utf-8") as f:
                    content = f.read().strip()
            if not content:
                print("Error: --content or --content-file required.", file=sys.stderr)
                sys.exit(1)

            placements = None
            if getattr(args, "placements", None):
                with open(args.placements, encoding="utf-8") as f:
                    placements = json.load(f)

            publisher.connect()
            if getattr(args, "save_draft", False):
                publisher.fill_long_article_to_draft(
                    title=title, content=content, image_paths=args.images,
                    placements=placements,
                    save=not getattr(args, "no_save", False),
                )
                print("LONG_ARTICLE_STATUS: DRAFT_SAVED" if not getattr(args, "no_save", False)
                      else "LONG_ARTICLE_STATUS: DRAFT_FILLED")
            else:
                template_names = publisher.publish_long_article(
                    title=title, content=content, image_paths=args.images,
                    placements=placements,
                )
                # Print template names as JSON for programmatic consumption
                print("TEMPLATES: " + json.dumps(template_names, ensure_ascii=False))
                print("LONG_ARTICLE_STATUS: TEMPLATE_SELECTION")

        elif args.command == "select-template":
            publisher.connect(target_url_prefix="https://creator.xiaohongshu.com/publish")
            if publisher.select_template(args.name):
                print(f"TEMPLATE_SELECTED: {args.name}")
            else:
                print(f"Error: Template '{args.name}' not found.", file=sys.stderr)
                sys.exit(1)

        elif args.command == "upload-cover":
            publisher.connect(target_url_prefix="https://creator.xiaohongshu.com/publish")
            if publisher.upload_cover(args.cover):
                print("COVER_UPLOADED")
            else:
                print("Error: Cover upload failed.", file=sys.stderr)
                sys.exit(1)

        elif args.command == "click-next-step":
            content = getattr(args, 'content', None)
            if getattr(args, 'content_file', None):
                with open(args.content_file, encoding="utf-8") as f:
                    content = f.read().strip()
            publisher.connect(target_url_prefix="https://creator.xiaohongshu.com/publish")
            publisher.click_next_and_prepare_publish(content=content or "")
            print("LONG_ARTICLE_STATUS: READY_TO_PUBLISH")

        elif args.command == "set-schedule":
            publisher.connect(target_url_prefix="https://creator.xiaohongshu.com/publish")
            if publisher._set_schedule(args.schedule):
                print(f"SCHEDULE_STATUS: {args.schedule}")
            else:
                sys.exit(1)

        elif args.command == "click-publish":
            publisher.connect(target_url_prefix="https://creator.xiaohongshu.com/publish")
            publisher._click_publish(schedule=getattr(args, "schedule", None))
            if getattr(args, "schedule", None):
                print(f"SCHEDULE_STATUS: {args.schedule}")
            print("PUBLISH_STATUS: PUBLISHED")

        elif args.command == "login":
            # Ensure headed mode for QR scanning
            restart_chrome(headless=False, account=account)
            publisher.connect()
            publisher.open_login_page()
            print("LOGIN_READY")

        elif args.command == "re-login":
            # Ensure headed mode, clear cookies, re-open login page for same account
            restart_chrome(headless=False, account=account)
            publisher.connect()
            publisher.clear_cookies()
            time.sleep(1)
            publisher.open_login_page()
            print("RE_LOGIN_READY")

        elif args.command == "switch-account":
            # Ensure headed mode, clear cookies, open login page
            restart_chrome(headless=False, account=account)
            publisher.connect()
            publisher.clear_cookies()
            time.sleep(1)
            publisher.open_login_page()
            print("SWITCH_ACCOUNT_READY")

    finally:
        publisher.disconnect()


if __name__ == "__main__":
    main()
