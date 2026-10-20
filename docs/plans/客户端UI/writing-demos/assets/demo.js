/* Lumii 创作工作台 · 静态视觉稿交互层（无依赖） */
(function () {
  'use strict';

  /* ---------- icons ---------- */
  var ICONS = {
    'file-text': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h8"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    'folder-open': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1"/><path d="M3 9h18l-2 9a2 2 0 0 1-2 1H5a2 2 0 0 1-2-1z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-up': '<path d="m18 15-6-6-6 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    sparkles: '<path d="m12 3 1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
    message: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    columns: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    alert: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1"/>',
    quote: '<path d="M10 11H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v8a4 4 0 0 1-4 4"/><path d="M20 11h-4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v8a4 4 0 0 1-4 4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    play: '<path d="m8 5 11 7-11 7z"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
    video: '<rect x="3" y="6" width="12" height="12" rx="2"/><path d="m15 10 6-3v10l-6-3"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    'panel-right': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
    'panel-left': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
    'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    'arrow-right': '<path d="m12 5 7 7-7 7"/><path d="M5 12h14"/>',
    send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
    paperclip: '<path d="m21.4 11.6-8.5 8.5a6 6 0 0 1-8.5-8.5l8.5-8.5a4 4 0 0 1 5.7 5.7l-8.5 8.5a2 2 0 0 1-2.8-2.8l7.8-7.8"/>',
    at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.9 7.9"/>',
    command: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.9-3M4 5v4h4"/><path d="M4 13a8 8 0 0 0 14.9 3M20 19v-4h-4"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>',
    tag: '<path d="M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
    'map-pin': '<path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
    lightbulb: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>',
    bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    filter: '<path d="M22 3H2l8 9.5V19l4 2v-8.5z"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 8 5-5 5 5"/><path d="M12 3v12"/>',
    terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
    bot: '<rect x="3" y="8" width="18" height="12" rx="3"/><path d="M12 8V4"/><circle cx="8" cy="14" r="1"/><circle cx="16" cy="14" r="1"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    pin: '<path d="M12 17v5"/><path d="M9 10.8V5l-2-3h10l-2 3v5.8l3 3.2H6z"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
    'git-branch': '<path d="M6 3v12"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    layers: '<path d="m12 2 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
    type: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M2 14h4M10 8h4M18 16h4"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>',
    minimize: '<path d="M8 3v3a2 2 0 0 1-2 2H3M16 3v3a2 2 0 0 0 2 2h3M8 21v-3a2 2 0 0 0-2-2H3M16 21v-3a2 2 0 0 1 2-2h3"/>',
    'chevrons-left': '<path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/>',
    'chevrons-right': '<path d="m13 17 5-5-5-5"/><path d="m6 17 5-5-5-5"/>',
    'more-horizontal': '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    circle: '<circle cx="12" cy="12" r="8"/>',
    disc: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/>',
    wand: '<path d="m15 4 5 5"/><path d="M3 21 17 7l4 4L7 25z" transform="translate(0 -2)"/><path d="M6 3v4M4 5h4M19 14v4M17 16h4"/>',
    scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>',
    crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
    'volume-2': '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>',
    captions: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 15h4M14 15h4M6 11h2M11 11h2M16 11h2"/>',
    'file-check': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="m9 15 2 2 4-4"/>',
    'file-x': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="m9 13 6 6M15 13l-6 6"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z"/>',
    'arrow-up-right': '<path d="M7 17 17 7"/><path d="M7 7h10v10"/>'
  };

  function icon(name, size) {
    var d = ICONS[name] || ICONS.circle;
    var s = size || 16;
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
  }
  window.lumiiIcon = icon;

  function hydrateIcons(root) {
    (root || document).querySelectorAll('[data-icon]').forEach(function (el) {
      var name = el.getAttribute('data-icon');
      if (!name) return;
      var size = parseInt(el.getAttribute('data-size') || '16', 10);
      el.innerHTML = icon(name, size);
    });
    (root || document).querySelectorAll('[data-icon-text]').forEach(function (el) {
      var name = el.getAttribute('data-icon-text');
      el.innerHTML = icon(name, 14) + '<span>' + (el.getAttribute('data-label') || '') + '</span>';
    });
  }
  window.hydrateIcons = hydrateIcons;

  /* ---------- toast ---------- */
  var toastEl = null;
  var toastTimer = null;
  function toast(message) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2200);
  }
  window.toast = toast;

  /* ---------- theme ---------- */
  var root = document.documentElement;
  var savedTheme = null;
  try { savedTheme = localStorage.getItem('lumii-demo-theme'); } catch (e) {}
  if (savedTheme === 'light' || savedTheme === 'dark') root.setAttribute('data-theme', savedTheme);
  function syncThemeButtons() {
    document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
      var light = root.getAttribute('data-theme') === 'light';
      btn.setAttribute('data-icon', light ? 'moon' : 'sun');
      btn.setAttribute('title', light ? '切换深色' : '切换浅色');
      hydrateIcons(btn);
    });
  }
  document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('lumii-demo-theme', next); } catch (e) {}
      syncThemeButtons();
    });
  });

  /* ---------- tabs ---------- */
  document.querySelectorAll('[data-tabs]').forEach(function (group) {
    var groupName = group.getAttribute('data-tabs');
    group.querySelectorAll('[data-tab]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var name = btn.getAttribute('data-tab');
        group.querySelectorAll('[data-tab]').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
        document.querySelectorAll('[data-panel-group="' + groupName + '"]').forEach(function (panel) {
          panel.classList.toggle('active', panel.getAttribute('data-panel') === name);
        });
      });
    });
  });

  /* ---------- tree ---------- */
  document.querySelectorAll('[data-tree-item]').forEach(function (item) {
    item.addEventListener('click', function () {
      var tree = item.closest('.tree') || document;
      tree.querySelectorAll('[data-tree-item]').forEach(function (i) { i.classList.remove('active'); });
      item.classList.add('active');
      var title = item.getAttribute('data-title');
      if (title) {
        document.querySelectorAll('[data-current-title]').forEach(function (el) { el.textContent = title; });
      }
      var msg = item.getAttribute('data-open-toast');
      if (msg) toast(msg);
    });
  });

  /* ---------- suggestions ---------- */
  document.querySelectorAll('[data-suggestion]').forEach(function (card) {
    card.querySelectorAll('[data-suggestion-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var action = btn.getAttribute('data-suggestion-action');
        card.classList.add(action === 'accept' ? 'accepted' : 'rejected');
        toast(action === 'accept' ? '已接受建议，正文已更新' : '已拒绝建议，保留原文');
      });
    });
  });

  /* ---------- checks ---------- */
  document.querySelectorAll('[data-resolve-check]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var item = btn.closest('.check-item');
      if (!item || item.classList.contains('resolved')) return;
      item.classList.add('resolved');
      var host = item.closest('[data-panel]') || item.parentElement;
      var sev = item.getAttribute('data-severity');
      var sevEl = host.querySelector('[data-check-count="' + sev + '"]');
      var okEl = host.querySelector('[data-check-count="ok"]');
      if (sevEl) sevEl.textContent = Math.max(0, (parseInt(sevEl.textContent, 10) || 0) - 1);
      if (okEl && sev !== 'ok') okEl.textContent = (parseInt(okEl.textContent, 10) || 0) + 1;
      toast('已修复并重新检查');
    });
  });

  /* ---------- title candidates ---------- */
  document.querySelectorAll('[data-title-candidate]').forEach(function (card) {
    card.addEventListener('click', function () {
      document.querySelectorAll('[data-title-candidate]').forEach(function (c) { c.classList.remove('selected'); });
      card.classList.add('selected');
      var title = card.getAttribute('data-title');
      if (title) document.querySelectorAll('[data-live-title]').forEach(function (el) { el.textContent = title; });
      toast('已采用这个标题，预览已同步');
    });
  });

  /* ---------- storyboard shots ---------- */
  document.querySelectorAll('[data-shot]').forEach(function (card) {
    card.addEventListener('click', function () {
      document.querySelectorAll('[data-shot]').forEach(function (c) { c.classList.remove('selected'); });
      card.classList.add('selected');
      var caption = card.getAttribute('data-caption');
      if (caption) document.querySelectorAll('[data-live-caption]').forEach(function (el) { el.innerHTML = '<span>' + caption + '</span>'; });
      var shotNo = card.getAttribute('data-shot-no');
      if (shotNo) document.querySelectorAll('[data-live-shot]').forEach(function (el) { el.textContent = '镜头 ' + shotNo; });
      var dur = card.getAttribute('data-duration');
      if (dur) document.querySelectorAll('[data-live-duration]').forEach(function (el) { el.textContent = dur; });
    });
  });

  /* ---------- reference modes ---------- */
  document.querySelectorAll('[data-ref-mode]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var mode = btn.getAttribute('data-ref-mode');
      document.querySelectorAll('.mode-switch [data-ref-mode]').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-ref-mode') === mode);
      });
      document.querySelectorAll('.tree [data-ref-mode]').forEach(function (n) {
        n.classList.toggle('active', n.getAttribute('data-ref-mode') === mode);
      });
      document.querySelectorAll('[data-mode-panel]').forEach(function (p) {
        p.classList.toggle('active', p.getAttribute('data-mode-panel') === mode);
      });
    });
  });

  /* ---------- material filter ---------- */
  document.querySelectorAll('[data-material-filter]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var type = btn.getAttribute('data-material-filter');
      var group = btn.closest('.segmented');
      if (group) group.querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b === btn); });
      document.querySelectorAll('[data-material-type]').forEach(function (tile) {
        var show = type === 'all' || tile.getAttribute('data-material-type') === type;
        tile.style.display = show ? '' : 'none';
      });
    });
  });

  /* ---------- modals ---------- */
  document.querySelectorAll('[data-open-modal]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var sel = btn.getAttribute('data-open-modal');
      var modal = document.querySelector(sel);
      if (modal) modal.classList.add('open');
    });
  });
  document.querySelectorAll('[data-close-modal]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var modal = btn.closest('.modal-overlay');
      if (modal) modal.classList.remove('open');
    });
  });
  document.querySelectorAll('.modal-overlay').forEach(function (overlay) {
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.classList.remove('open');
    });
  });

  /* ---------- generic toggles ---------- */
  document.querySelectorAll('[data-toggle-target]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var el = document.querySelector(btn.getAttribute('data-toggle-target'));
      if (!el) return;
      var open = el.classList.toggle('open');
      btn.classList.toggle('active', open);
      document.querySelectorAll('[data-toggle-target]').forEach(function (other) {
        if (other.getAttribute('data-toggle-target') !== btn.getAttribute('data-toggle-target')) return;
        if (!other.hasAttribute('data-toggle-icon')) return;
        other.setAttribute('data-icon', open ? 'chevron-down' : 'chevron-up');
        hydrateIcons(other);
      });
    });
  });

  /* ---------- misc buttons ---------- */
  document.querySelectorAll('[data-toast]').forEach(function (btn) {
    btn.addEventListener('click', function () { toast(btn.getAttribute('data-toast')); });
  });
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy') || '';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { toast('已复制到剪贴板'); }, function () { toast('复制失败，请手动选择'); });
      } else {
        toast('已复制：' + text);
      }
    });
  });
  document.querySelectorAll('[data-command]').forEach(function (btn) {
    btn.addEventListener('click', function () { runAction(btn.getAttribute('data-command')); });
  });

  /* ---------- command palette ---------- */
  var palette = document.querySelector('[data-palette]');
  var paletteInput = palette ? palette.querySelector('input') : null;
  var paletteList = palette ? palette.querySelector('[data-palette-list]') : null;
  var paletteMode = 'all';
  var filteredCommands = [];
  var activeIndex = 0;

  var defaultCommands = [
    { group: '文件', title: '第一章 渡口', sub: '小说/卷一/第一章 渡口.md', icon: 'file-text', toast: '已打开 第一章 渡口' },
    { group: '文件', title: '角色 · 沈砚', sub: '素材/角色/沈砚.md', icon: 'users', toast: '已打开 角色 · 沈砚' },
    { group: '文件', title: '素材 · 潮汐历', sub: '素材/设定/潮汐历.md', icon: 'book', toast: '已打开 素材 · 潮汐历' },
    { group: '操作', title: '新建场景', sub: '在当前卷下新建场景', icon: 'plus', toast: '已新建场景' },
    { group: '操作', title: '对比上一版', sub: '打开本轮的版本对比', icon: 'history', toast: '已打开版本对比' },
    { group: '操作', title: '打开引用中心', sub: '查看本文的引用与反链', icon: 'link', toast: '已打开引用中心' },
    { group: '操作', title: '运行发布检查', sub: '检查排版、图片与敏感词', icon: 'file-check', toast: '发布检查已运行' }
  ];

  function getCommands() {
    var cmds = window.DEMO_COMMANDS || defaultCommands;
    if (paletteMode === 'files') return cmds.filter(function (c) { return c.group === '文件'; });
    return cmds;
  }

  function renderPalette(query) {
    if (!paletteList) return;
    var q = (query || '').trim().toLowerCase();
    var cmds = getCommands().filter(function (c) {
      if (!q) return true;
      return (c.title + ' ' + (c.sub || '') + ' ' + (c.group || '')).toLowerCase().indexOf(q) >= 0;
    });
    filteredCommands = cmds;
    activeIndex = 0;
    if (!cmds.length) {
      paletteList.innerHTML = '<div class="empty-state"><span class="icon">' + icon('search', 22) + '</span><span>没有匹配的结果</span></div>';
      return;
    }
    var html = '';
    var lastGroup = '';
    cmds.forEach(function (cmd, idx) {
      if (cmd.group !== lastGroup) {
        html += '<div class="palette-group">' + cmd.group + '</div>';
        lastGroup = cmd.group;
      }
      html += '<div class="palette-item' + (idx === 0 ? ' active' : '') + '" data-palette-index="' + idx + '">' +
        '<span class="p-icon">' + icon(cmd.icon || 'file', 14) + '</span>' +
        '<span class="p-title"><b>' + cmd.title + '</b>' + (cmd.sub ? '<span>' + cmd.sub + '</span>' : '') + '</span>' +
        '<span class="p-right">' + (cmd.hint ? '<span class="kbd">' + cmd.hint + '</span>' : '') + '</span>' +
        '</div>';
    });
    paletteList.innerHTML = html;
    paletteList.querySelectorAll('[data-palette-index]').forEach(function (el) {
      el.addEventListener('click', function () {
        var idx = parseInt(el.getAttribute('data-palette-index'), 10);
        runCommand(filteredCommands[idx]);
      });
      el.addEventListener('mouseenter', function () {
        activeIndex = parseInt(el.getAttribute('data-palette-index'), 10);
        updateActive();
      });
    });
  }

  function updateActive() {
    if (!paletteList) return;
    var items = paletteList.querySelectorAll('.palette-item');
    items.forEach(function (el, i) {
      el.classList.toggle('active', i === activeIndex);
      if (i === activeIndex && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    });
  }

  function openPalette(mode) {
    if (!palette) return;
    paletteMode = mode || 'all';
    palette.classList.add('open');
    if (paletteInput) {
      paletteInput.value = '';
      paletteInput.placeholder = paletteMode === 'files' ? '搜索文件…' : '搜索文件、命令、素材…';
      paletteInput.focus();
    }
    renderPalette('');
  }
  function closePalette() {
    if (palette) palette.classList.remove('open');
  }
  window.openPalette = openPalette;

  document.querySelectorAll('[data-open-palette]').forEach(function (btn) {
    btn.addEventListener('click', function () { openPalette(btn.getAttribute('data-open-palette') || 'all'); });
  });
  document.querySelectorAll('[data-close-palette]').forEach(function (btn) {
    btn.addEventListener('click', closePalette);
  });
  if (palette) {
    palette.addEventListener('click', function (e) { if (e.target === palette) closePalette(); });
  }
  if (paletteInput) {
    paletteInput.addEventListener('input', function () { renderPalette(paletteInput.value); });
    paletteInput.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIndex = Math.min(activeIndex + 1, filteredCommands.length - 1);
        updateActive();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIndex = Math.max(activeIndex - 1, 0);
        updateActive();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filteredCommands[activeIndex]) runCommand(filteredCommands[activeIndex]);
      } else if (e.key === 'Escape') {
        closePalette();
      }
    });
  }

  function runAction(name) {
    if (window.DEMO_ACTIONS && typeof window.DEMO_ACTIONS[name] === 'function') {
      window.DEMO_ACTIONS[name]();
      return;
    }
    toast('已执行：' + name);
  }
  window.runDemoAction = runAction;

  function runCommand(cmd) {
    if (!cmd) return;
    closePalette();
    if (cmd.href) { location.href = cmd.href; return; }
    if (cmd.action) { runAction(cmd.action); return; }
    if (cmd.target) { var el = document.querySelector(cmd.target); if (el) { el.click(); return; } }
    toast(cmd.toast || '已执行');
  }

  document.addEventListener('keydown', function (e) {
    var mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      openPalette('all');
    } else if (mod && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      openPalette('files');
    } else if (e.key === 'Escape') {
      closePalette();
      document.querySelectorAll('.modal-overlay.open').forEach(function (m) { m.classList.remove('open'); });
    }
  });

  /* ---------- boot ---------- */
  hydrateIcons(document);
  syncThemeButtons();
})();
