"""抖音创作者中心编辑页 DOM 交互 JS 片段生成。"""
from __future__ import annotations

import json


def js_click_leaf_text(text: str, partial: bool = False) -> str:
    """生成点击叶子节点文字的 JS。"""
    t = json.dumps(text, ensure_ascii=False)
    return f"""
(function() {{
  const target = {t};
  const partial = {str(partial).lower()};
  const nodes = Array.from(document.querySelectorAll('*'));
  for (const el of nodes) {{
    if (el.children.length > 0) continue;
    const txt = (el.textContent || '').trim();
    if (!txt) continue;
    const hit = partial ? txt.includes(target) : txt === target;
    if (hit) {{ el.click(); return true; }}
  }}
  return false;
}})()
"""


def js_set_input_value(selectors: list[str], value: str) -> str:
    """向 input/textarea 写入并触发 input 事件。"""
    return f"""
(function() {{
  const selectors = {json.dumps(selectors, ensure_ascii=False)};
  const value = {json.dumps(value, ensure_ascii=False)};
  for (const sel of selectors) {{
    const el = document.querySelector(sel);
    if (!el) continue;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set || Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;
    el.focus();
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
    return true;
  }}
  return false;
}})()
"""


def js_set_contenteditable(selectors: list[str], value: str) -> str:
    """向 contenteditable 写入正文。"""
    return f"""
(function() {{
  const selectors = {json.dumps(selectors, ensure_ascii=False)};
  const value = {json.dumps(value, ensure_ascii=False)};
  for (const sel of selectors) {{
    const el = document.querySelector(sel);
    if (!el) continue;
    el.focus();
    el.textContent = value;
    el.dispatchEvent(new InputEvent('input', {{
      bubbles: true, inputType: 'insertText', data: value
    }}));
    return true;
  }}
  return false;
}})()
"""


def js_select_collection(name: str, pick_index: int = 0) -> str:
    """选择发布合集（semi-select 下拉）。"""
    opt = json.dumps(name, ensure_ascii=False)
    return f"""
(async () => {{
  const name = {opt};
  const pickIndex = {pick_index};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const selects = Array.from(document.querySelectorAll('.semi-select'));
  const target = selects.find(s => (s.textContent || '').includes('请选择合集'))
    || selects.find(s => (s.textContent || '').trim() === '合集')
    || selects.find(s => (s.textContent || '').includes('合集'));
  if (!target) return false;
  target.click();
  await sleep(700);
  const options = Array.from(document.querySelectorAll(
    '.semi-select-option, .semi-dropdown-item, [role="option"]'
  )).filter(o => (o.textContent || '').trim().length > 0);
  const matched = options.filter(o => (o.textContent || '').includes(name));
  const pool = matched.length ? matched : options.filter(o => !(o.textContent||'').includes('请选择'));
  if (!pool.length) return false;
  pool[Math.min(pickIndex, pool.length - 1)].click();
  return true;
}})()
"""


def js_select_declaration(text: str, pick_index: int = 0) -> str:
    """选择自主声明（点击「请选择声明内容」后选选项）。"""
    opt = json.dumps(text, ensure_ascii=False)
    return f"""
(async () => {{
  const text = {opt};
  const pickIndex = {pick_index};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let opened = false;
  for (const el of document.querySelectorAll('*')) {{
    const t = (el.textContent || '').trim();
    if (el.children.length === 0 && (t === '请选择声明内容' || t.includes('请选择声明'))) {{
      el.click();
      opened = true;
      await sleep(700);
      break;
    }}
  }}
  if (!opened) {{
    const ctrl = Array.from(document.querySelectorAll('[class*="controlWrapper"], .wrapper-MLZdnB'))
      .find(b => (b.textContent||'').includes('请选择声明') || (b.textContent||'').includes('自主声明'));
    if (ctrl) {{ ctrl.click(); await sleep(700); opened = true; }}
  }}
  if (!opened) {{
    const wrapper = Array.from(document.querySelectorAll('.wrapper-MLZdnB, section'))
      .find(b => (b.textContent||'').includes('自主声明'));
    const sel = wrapper?.querySelector('.semi-select');
    if (sel) {{ sel.click(); await sleep(700); opened = true; }}
  }}
  if (!opened) return false;
  const options = Array.from(document.querySelectorAll(
    '.semi-select-option, .semi-dropdown-item, [role="option"], .semi-list-item'
  )).filter(o => (o.textContent || '').trim().length > 0);
  const matched = options.filter(o => (o.textContent || '').includes(text));
  const pool = matched.length ? matched : options;
  if (!pool.length) return false;
  pool[Math.min(pickIndex, pool.length - 1)].click();
  return true;
}})()
"""


def js_set_schedule(datetime_str: str) -> str:
    """选择定时发布并填写日期时间（YYYY-MM-DD HH:MM）。"""
    dt = json.dumps(datetime_str, ensure_ascii=False)
    return f"""
(async () => {{
  const dt = {dt};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const labels = Array.from(document.querySelectorAll('label, span, div'));
  for (const el of labels) {{
    if ((el.textContent || '').trim() === '定时发布') {{
      el.click();
      await sleep(400);
      break;
    }}
  }}
  const inputs = Array.from(document.querySelectorAll(
    'input[type="text"], input.semi-input, .semi-datepicker input'
  ));
  for (const inp of inputs) {{
    const ph = inp.placeholder || '';
    if (ph.includes('时间') || ph.includes('日期') || inp.closest('.semi-datepicker')) {{
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set;
      inp.focus();
      if (setter) setter.call(inp, dt);
      else inp.value = dt;
      inp.dispatchEvent(new Event('input', {{ bubbles: true }}));
      inp.dispatchEvent(new Event('change', {{ bubbles: true }}));
      return true;
    }}
  }}
  return false;
}})()
"""


def js_select_music(keyword: str, pick_index: int = 0) -> str:
    """点击选择音乐并在曲库弹层中搜索、选中曲目（图文/视频页）。"""
    kw = json.dumps(keyword, ensure_ascii=False)
    return f"""
(async () => {{
  const keyword = {kw};
  const pickIndex = {pick_index};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const triggerTexts = ['选择音乐', '添加音乐', '选择背景音乐', '从曲库'];
  let clicked = false;
  for (const el of document.querySelectorAll('*')) {{
    if (el.children.length > 0) continue;
    const t = (el.textContent || '').trim();
    if (triggerTexts.some(x => t === x || t.includes(x))) {{
      el.click();
      clicked = true;
      break;
    }}
  }}
  if (!clicked) {{
    const block = Array.from(document.querySelectorAll('.content-obt4oA'))
      .find(b => (b.textContent||'').includes('选择音乐') || (b.textContent||'').includes('背景音乐'));
    block?.querySelector('button, [role=button], .semi-button')?.click();
    clicked = !!block;
  }}
  if (!clicked) return false;
  await sleep(1200);
  const searchInputs = Array.from(document.querySelectorAll(
    'input[placeholder*="搜索"], input[placeholder*="音乐"], input.semi-input'
  ));
  for (const inp of searchInputs) {{
    const ph = inp.placeholder || '';
    if (ph.includes('搜索') || ph.includes('音乐')) {{
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set;
      inp.focus();
      if (setter) setter.call(inp, keyword);
      else inp.value = keyword;
      inp.dispatchEvent(new Event('input', {{ bubbles: true }}));
      inp.dispatchEvent(new KeyboardEvent('keydown', {{ key: 'Enter', bubbles: true }}));
      await sleep(1500);
      break;
    }}
  }}
  const items = Array.from(document.querySelectorAll(
    '[class*="music"], [class*="Music"], .semi-list-item, [role="listitem"]'
  )).filter(el => (el.textContent || '').trim().length > 2);
  if (!items.length) return false;
  const idx = Math.min(pickIndex, items.length - 1);
  items[idx].click();
  return true;
}})()
"""


def js_upload_cover_via_input() -> str:
    """点击设置封面区域，便于后续 DOM.setFileInputFiles。"""
    return """
(function() {
  const nodes = Array.from(document.querySelectorAll('*'));
  for (const el of nodes) {
    const t = (el.textContent || '').trim();
    if (t.includes('选择一张图片作为封面') || t === '编辑封面' || t.includes('设置封面')) {
      el.click();
      return true;
    }
  }
  return false;
})()
"""
