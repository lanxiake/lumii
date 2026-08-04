"""小红书创作者中心页面 DOM 操作 JS 片段（CDP evaluate 用）。"""
from __future__ import annotations

import json


def js_set_schedule(datetime_str: str) -> str:
    """选择定时发布并填写日期时间（YYYY-MM-DD HH:MM）。"""
    dt = json.dumps(datetime_str, ensure_ascii=False)
    return f"""
(async () => {{
  const dt = {dt};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const labels = Array.from(document.querySelectorAll('label, span, div, button'));
  for (const el of labels) {{
    const text = (el.textContent || '').trim();
    if (text === '定时发布' || text === '定时') {{
      el.click();
      await sleep(500);
      break;
    }}
  }}
  const inputs = Array.from(document.querySelectorAll(
    'input[type="text"], input.semi-input, .semi-datepicker input, input[placeholder*="时间"], input[placeholder*="日期"]'
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
