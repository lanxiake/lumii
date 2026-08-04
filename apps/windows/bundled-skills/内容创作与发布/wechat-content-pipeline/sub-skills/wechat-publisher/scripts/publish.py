#!/usr/bin/env python3
"""轻量公众号发布:markdown -> 内联样式HTML -> 上传图片 -> draft/add 存草稿。
只调微信官方 API。凭证从技能包根目录的 .env 文件读(也兼容环境变量)。仅存草稿,不群发。

用法:
  python publish.py <publish.md>
凭证写在 wechat-makeup/.env(WECHAT_APP_ID / WECHAT_APP_SECRET),无需每次设环境变量。
publish.md 需含 frontmatter: title / author / summary / cover(相对图片路径)
"""
import os, sys, re, json, html as _html, urllib.request, mimetypes, time


def load_dotenv():
    """从当前脚本向上查找技能包根目录的 .env,把键值注入 os.environ(不覆盖已存在的)。"""
    d = os.path.dirname(os.path.abspath(__file__))
    for _ in range(6):  # 最多向上 6 级找到 wechat-makeup/.env
        envp = os.path.join(d, ".env")
        if os.path.isfile(envp):
            with open(envp, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    k, v = k.strip(), v.strip().strip('"').strip("'")
                    os.environ.setdefault(k, v)
            return envp
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return None


load_dotenv()
try:
    APPID = os.environ["WECHAT_APP_ID"]
    SECRET = os.environ["WECHAT_APP_SECRET"]
except KeyError as e:
    raise SystemExit(f"[FAIL] 缺少凭证 {e}: 请在 wechat-makeup/.env 配置 WECHAT_APP_ID / WECHAT_APP_SECRET(参考 .env.example)")
UA = {"User-Agent": "Mozilla/5.0"}
MD = sys.argv[1]
BASE = os.path.dirname(os.path.abspath(MD))

def http_get(url):
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30))

def http_post_json(url, payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={**UA, "Content-Type": "application/json"}, method="POST")
    return json.loads(urllib.request.urlopen(req, timeout=60).read().decode("utf-8"))

def http_post_file(url, field, filepath):
    boundary = "----wxpub" + str(int(time.time()*1000))
    fn = os.path.basename(filepath)
    ctype = mimetypes.guess_type(fn)[0] or "application/octet-stream"
    body = open(filepath, "rb").read()
    parts = []
    parts.append(("--"+boundary).encode())
    parts.append(f'Content-Disposition: form-data; name="{field}"; filename="{fn}"'.encode())
    parts.append(f"Content-Type: {ctype}".encode())
    parts.append(b"")
    parts.append(body)
    parts.append(("--"+boundary+"--").encode())
    data = b"\r\n".join(parts)
    req = urllib.request.Request(url, data=data, headers={**UA, "Content-Type": f"multipart/form-data; boundary={boundary}"}, method="POST")
    return json.loads(urllib.request.urlopen(req, timeout=120).read().decode("utf-8"))

def get_token():
    d = http_get(f"https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid={APPID}&secret={SECRET}")
    if "access_token" not in d:
        raise SystemExit(f"换 token 失败: {d}")
    return d["access_token"]

def upload_img(token, filepath):
    """正文图片:返回微信 URL"""
    d = http_post_file(f"https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token={token}", "media", filepath)
    if "url" not in d:
        raise SystemExit(f"传图失败 {filepath}: {d}")
    return d["url"]

def upload_thumb(token, filepath):
    """封面:永久素材,返回 media_id"""
    d = http_post_file(f"https://api.weixin.qq.com/cgi-bin/material/add_material?access_token={token}&type=image", "media", filepath)
    if "media_id" not in d:
        raise SystemExit(f"传封面失败: {d}")
    return d["media_id"]

# ---- markdown 解析 + HTML 渲染 + draft/add ----

# 公众号内联样式
S = {
  "h2": "font-size:20px;font-weight:bold;color:#1a3a5c;margin:28px 0 14px;padding-left:10px;border-left:4px solid #ff6b35;line-height:1.4;",
  "h3": "font-size:17px;font-weight:bold;color:#1a3a5c;margin:22px 0 12px;",
  "p": "font-size:16px;color:#3f3f3f;line-height:1.9;margin:16px 0;letter-spacing:0.3px;",
  "quote": "font-size:15px;color:#666;background:#f7f7f5;border-left:3px solid #ff6b35;padding:12px 16px;margin:16px 0;line-height:1.8;border-radius:0 6px 6px 0;",
  "li": "font-size:16px;color:#3f3f3f;line-height:1.8;margin:8px 0;",
  "code": "display:block;background:#1e1e2e;color:#cdd6f4;font-family:Consolas,Menlo,monospace;font-size:13px;padding:14px 16px;border-radius:8px;margin:16px 0;overflow-x:auto;white-space:pre-wrap;line-height:1.6;",
  "img": "max-width:100%;border-radius:8px;margin:18px auto;display:block;",
  "strong": "color:#1a3a5c;font-weight:bold;",
  "hr": "border:none;border-top:1px solid #e8e8e0;margin:28px 0;",
}

def inline(text):
    """行内:**加粗**,转义其余"""
    text = _html.escape(text)
    text = re.sub(r"\*\*(.+?)\*\*", lambda m: f'<strong style="{S["strong"]}">{m.group(1)}</strong>', text)
    return text

def parse_frontmatter(raw):
    fm = {}
    body = raw
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", raw, re.DOTALL)
    if m:
        for line in m.group(1).splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                fm[k.strip()] = v.strip()
        body = m.group(2)
    return fm, body

def render(body, token, base):
    """markdown -> 公众号HTML;遇图片即上传换微信URL。"""
    lines = body.splitlines()
    out = []
    i = 0
    in_code = False
    code_buf = []
    while i < len(lines):
        ln = lines[i]
        s = ln.strip()
        if s.startswith("```"):
            if not in_code:
                in_code = True; code_buf = []
            else:
                in_code = False
                esc = _html.escape("\n".join(code_buf))
                out.append(f'<pre style="{S["code"]}"><code>{esc}</code></pre>')
            i += 1; continue
        if in_code:
            code_buf.append(ln); i += 1; continue
        m = re.match(r"!\[(.*?)\]\((.+?)\)", s)
        if m:
            p = os.path.normpath(os.path.join(base, m.group(2)))
            if os.path.exists(p):
                url = upload_img(token, p)
                print(f"  img -> {os.path.basename(p)}", flush=True)
                out.append(f'<img src="{url}" style="{S["img"]}" alt="{_html.escape(m.group(1))}"/>')
            else:
                out.append(f'<p style="{S["p"]}">[缺图:{_html.escape(m.group(2))}]</p>')
            i += 1; continue
        if s.startswith("## "):
            out.append(f'<h2 style="{S["h2"]}">{inline(s[3:])}</h2>')
        elif s.startswith("### "):
            out.append(f'<h3 style="{S["h3"]}">{inline(s[4:])}</h3>')
        elif s.startswith("# "):
            out.append(f'<h2 style="{S["h2"]}">{inline(s[2:])}</h2>')
        elif s.startswith(">"):
            out.append(f'<blockquote style="{S["quote"]}">{inline(s.lstrip("> ").strip())}</blockquote>')
        elif s == "---":
            out.append(f'<hr style="{S["hr"]}"/>')
        elif re.match(r"^[-*] ", s):
            items = []
            while i < len(lines) and re.match(r"^[-*] ", lines[i].strip()):
                items.append(f'<li style="{S["li"]}">{inline(lines[i].strip()[2:])}</li>')
                i += 1
            out.append('<ul style="margin:14px 0;padding-left:22px;">'+"".join(items)+"</ul>")
            continue
        elif re.match(r"^\d+\. ", s):
            items = []
            while i < len(lines) and re.match(r"^\d+\. ", lines[i].strip()):
                items.append(f'<li style="{S["li"]}">{inline(re.sub(r"^\d+\.\s*","",lines[i].strip()))}</li>')
                i += 1
            out.append('<ol style="margin:14px 0;padding-left:22px;">'+"".join(items)+"</ol>")
            continue
        elif s.startswith("|"):
            # 表格:收集连续 | 行
            tbl = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                tbl.append(lines[i].strip()); i += 1
            rows = [r for r in tbl if not re.match(r"^\|[\s:|-]+\|?$", r)]
            html_rows = []
            for ri, r in enumerate(rows):
                cells = [c.strip() for c in r.strip("|").split("|")]
                tag = "th" if ri == 0 else "td"
                bg = "background:#1a3a5c;color:#fff;" if ri == 0 else ""
                tds = "".join(f'<{tag} style="border:1px solid #ddd;padding:8px 10px;font-size:14px;{bg}">{inline(c)}</{tag}>' for c in cells)
                html_rows.append(f"<tr>{tds}</tr>")
            out.append('<table style="border-collapse:collapse;width:100%;margin:16px 0;">'+"".join(html_rows)+"</table>")
            continue
        elif s == "":
            pass
        else:
            out.append(f'<p style="{S["p"]}">{inline(s)}</p>')
        i += 1
    return f'<div style="font-family:-apple-system,BlinkMacSystemFont,\'PingFang SC\',sans-serif;">{"".join(out)}</div>'

def main():
    raw = open(MD, encoding="utf-8").read()
    fm, body = parse_frontmatter(raw)
    title = fm.get("title", "未命名")
    author = fm.get("author", "")
    summary = fm.get("summary", "")[:120]
    cover_rel = fm.get("cover", "")

    print("换 access_token ...", flush=True)
    token = get_token()

    print("上传封面 ...", flush=True)
    cover_path = os.path.normpath(os.path.join(BASE, cover_rel))
    thumb_id = upload_thumb(token, cover_path)
    print(f"  thumb_media_id={thumb_id}", flush=True)

    print("渲染正文 + 上传正文图片 ...", flush=True)
    content_html = render(body, token, BASE)

    print("调 draft/add 存草稿 ...", flush=True)
    payload = {"articles": [{
        "title": title,
        "author": author,
        "digest": summary,
        "content": content_html,
        "thumb_media_id": thumb_id,
        "need_open_comment": 1,
        "only_fans_can_comment": 0,
    }]}
    d = http_post_json(f"https://api.weixin.qq.com/cgi-bin/draft/add?access_token={token}", payload)
    if "media_id" in d:
        print(f"\n[OK] 草稿已保存! media_id={d['media_id']}", flush=True)
        print("登录 mp.weixin.qq.com -> 内容管理 -> 草稿箱 审核", flush=True)
    else:
        print(f"\n[FAIL] draft/add 失败: {d}", flush=True)

if __name__ == "__main__":
    main()

