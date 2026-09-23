/**
 * webview 划词取词链路探针 —— 问三件事，全部要实测答案：
 *
 *   1. `<webview preload>` 指向 **http://** 时会不会加载？（dev 下渲染层由 vite 托管，
 *      现行 resolveWebviewSelectionPreload() 算出来就是 http URL）
 *   2. `ipc-message` 这个 DOM 事件**冒泡不冒泡**？挂在 document 上（冒泡阶段）收得到吗？
 *      捕获阶段呢？—— SelectionLayer 现在正是挂在 document 冒泡阶段。
 *   3. `src` 是宿主建的 `blob:` URL 时，guest 能不能正常加载、preload 还跑不跑？
 *      （FilePreviewModal 的 html-active 路由就是这么喂内容的）
 *
 * 为什么要写它：这三条都只能问 Electron 本身，看源码与文档得出的结论必须落成实测。
 *
 * 跑法：
 *   cd apps/windows && npx electron ../../verify/selection/probe-webview-preload.cjs
 *
 * 只读本地文件与一个 127.0.0.1 的临时 http 服务，不联网、不碰用户数据。
 */

const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const CHANNEL = 'probe-channel'
const CASE_TIMEOUT_MS = 3500

/** guest 侧 preload：证明自己跑过（改 title）+ 发一条 sendToHost */
const GUEST_PRELOAD_JS = `
const { ipcRenderer } = require('electron')
function report(why) {
  try { document.title = 'PRELOAD-RAN:' + why } catch (e) {}
  try { ipcRenderer.sendToHost(${JSON.stringify(CHANNEL)}, { why: why, hasSendToHost: typeof ipcRenderer.sendToHost }) } catch (e) {}
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { report('DOMContentLoaded') })
else report('immediate')
`

const GUEST_HTML = `<!doctype html><meta charset="utf-8"><body style="font:14px sans-serif">
<p>guest 页面，可以选中这段文字。</p>
</body>`

function pathToFileUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/')
}

/** 宿主页：依次跑三个用例，每个都挂三种 ipc-message 监听（元素 / document 冒泡 / document 捕获） */
function buildHostHtml(dir, httpPort) {
  const guestFile = pathToFileUrl(path.join(dir, 'guest.html'))
  const preloadFile = pathToFileUrl(path.join(dir, 'guest-preload.js'))
  const preloadHttp = `http://127.0.0.1:${httpPort}/guest-preload.js`
  return `<!doctype html><meta charset="utf-8"><body>
<script>
const CH = ${JSON.stringify(CHANNEL)};
function emit(k, v) { console.log('PROBE ' + k + '=' + JSON.stringify(v)); }
function attach(wv, tag) {
  const hits = { element: false, docBubble: false, docCapture: false };
  wv.addEventListener('ipc-message', function (e) {
    if (e.channel !== CH) return;
    hits.element = true;
    emit(tag + '.ipc-message.element', { channel: e.channel, frameId: e.frameId, args: e.args });
  });
  document.addEventListener('ipc-message', function (e) {
    if (e.channel !== CH) return;
    hits.docBubble = true;
    emit(tag + '.ipc-message.docBubble', true);
  });
  document.addEventListener('ipc-message', function (e) {
    if (e.channel !== CH) return;
    hits.docCapture = true;
    emit(tag + '.ipc-message.docCapture', true);
  }, true);
  wv.addEventListener('dom-ready', function () {
    let id = null; try { id = wv.getWebContentsId(); } catch (err) { id = 'ERR:' + err.message }
    let t = null; try { t = wv.getTitle() } catch (e) {}
    emit(tag + '.dom-ready', { webContentsId: id, titleAtDomReady: t });
  });
  wv.addEventListener('did-finish-load', function () {
    let t = null; try { t = wv.getTitle() } catch (e) {}
    emit(tag + '.did-finish-load', { title: t });
  });
  wv.addEventListener('did-fail-load', function (e) { emit(tag + '.did-fail-load', { code: e.errorCode, desc: e.errorDescription }) });
  return hits;
}
window.__iframeHits = {};
window.addEventListener('message', function (e) {
  const d = e.data;
  if (!d || d.marker !== 'probe-iframe') return;
  window.__iframeHits[d.tag] = true;
  emit('iframemsg.' + d.tag, { origin: e.origin });
});
function mkBlobOnly(tag, preload, done) {
  mk(tag, blobUrl(), preload, done);
}
/** iframe 用例：srcDoc 里的内联脚本在给定 sandbox 下跑不跑、能不能 postMessage 回宿主 */
function mkIframe(tag, sandbox, done) {
  const f = document.createElement('iframe');
  f.style.cssText = 'width:320px;height:60px;border:1px solid #999';
  if (sandbox !== null) f.setAttribute('sandbox', sandbox);
  const src = '<p>static preview</p><scr' + 'ipt>parent.postMessage({ marker: "probe-iframe", tag: ' + JSON.stringify(tag) + ' }, "*")</scr' + 'ipt>';
  f.setAttribute('srcdoc', src);
  document.body.appendChild(f);
  setTimeout(function () { emit(tag + '.RESULT', { sandbox: sandbox === null ? '(no attr)' : sandbox, gotPostMessage: !!window.__iframeHits[tag] }); done(); }, 1500);
}
function mk(tag, src, preload, done) {
  const wv = document.createElement('webview');
  wv.setAttribute('id', tag);
  wv.style.cssText = 'width:320px;height:100px;border:1px solid #999';
  if (preload) wv.setAttribute('preload', preload);
  wv.setAttribute('src', src);
  const hits = attach(wv, tag);
  document.body.appendChild(wv);
  setTimeout(function () {
    emit(tag + '.RESULT', { hits: hits, srcScheme: src.split(':')[0], preloadScheme: (preload || '').split(':')[0] });
    done();
  }, ${CASE_TIMEOUT_MS});
}
function blobUrl() {
  return URL.createObjectURL(new Blob([${JSON.stringify(GUEST_HTML)}], { type: 'text/html' }));
}
const preloadFile = ${JSON.stringify(preloadFile)};
const preloadHttp = ${JSON.stringify(preloadHttp)};
emit('start', { href: location.href, preloadFile: preloadFile, preloadHttp: preloadHttp });
mk('A_file_preload', ${JSON.stringify(guestFile)}, preloadFile, function () {
  mk('B_http_preload', ${JSON.stringify(guestFile)}, preloadHttp, function () {
    mk('C_blob_src', blobUrl(), preloadFile, function () {
      mkIframe('E_iframe_sandbox_empty', '', function () {
        mkIframe('F_iframe_allow_scripts', 'allow-scripts', function () {
          emit('done', true);
        });
      });
    });
  });
});
</script>
</body>`
}

const results = []
const preloadErrors = []

/**
 * 第二个宿主页：**由 http 服务提供**（复刻 dev 下 vite 托管宿主的情形），
 * 只跑一个用例 —— 宿主源是 http 时，宿主建的 blob: 还能不能喂给 webview。
 * guest 的 preload 仍是 file://（正确的那个），以隔离出「blob 跨源」这一个变量。
 */
function buildHttpHostHtml(dir) {
  const preloadFile = pathToFileUrl(path.join(dir, 'guest-preload.js'))
  return `<!doctype html><meta charset="utf-8"><body>
<script>
const CH = ${JSON.stringify(CHANNEL)};
function emit(k, v) { console.log('PROBE ' + k + '=' + JSON.stringify(v)); }
function attach(wv, tag) {
  const hits = { element: false, docBubble: false, docCapture: false };
  wv.addEventListener('ipc-message', function (e) {
    if (e.channel !== CH) return;
    hits.element = true;
    emit(tag + '.ipc-message.element', { channel: e.channel, frameId: e.frameId });
  });
  document.addEventListener('ipc-message', function (e) {
    if (e.channel !== CH) return;
    hits.docBubble = true;
  });
  document.addEventListener('ipc-message', function (e) {
    if (e.channel !== CH) return;
    hits.docCapture = true;
    // 归属判定：事件是派发在 <webview> 元素上的，e.target 应当就是它
    emit(tag + '.docCapture-attribution', {
      targetTag: e.target && e.target.tagName,
      targetIsThisWebview: e.target === wv,
      currentTargetIsDocument: e.currentTarget === document,
      frameId: e.frameId
    });
  }, true);
  wv.addEventListener('dom-ready', function () { emit(tag + '.dom-ready', { title: wv.getTitle() }) });
  wv.addEventListener('did-finish-load', function () { emit(tag + '.did-finish-load', { title: wv.getTitle() }) });
  wv.addEventListener('did-fail-load', function (e) { emit(tag + '.did-fail-load', { code: e.errorCode, desc: e.errorDescription }) });
  return hits;
}
const preloadFile = ${JSON.stringify(preloadFile)};
const wv = document.createElement('webview');
wv.style.cssText = 'width:320px;height:100px;border:1px solid #999';
wv.setAttribute('preload', preloadFile);
wv.setAttribute('src', URL.createObjectURL(new Blob([${JSON.stringify(GUEST_HTML)}], { type: 'text/html' })));
const hits = attach(wv, 'D_blob_from_http_host');
document.body.appendChild(wv);
emit('D_blob_from_http_host.start', { hostHref: location.href });
setTimeout(function () {
  emit('D_blob_from_http_host.RESULT', { hits: hits });
  emit('done', true);
}, ${CASE_TIMEOUT_MS});
</script>
</body>`
}

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return
  contents.on('preload-error', (_ev, preloadPath, error) => {
    const msg = `[guest preload-error] path=${preloadPath} error=${error && error.message}`
    preloadErrors.push(msg)
    console.log('PROBE ' + JSON.stringify({ guestPreloadError: msg }))
  })
})

app.whenReady().then(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-wv-probe-'))
  fs.writeFileSync(path.join(dir, 'guest-preload.js'), GUEST_PRELOAD_JS)
  fs.writeFileSync(path.join(dir, 'guest.html'), GUEST_HTML)

  let server = null
  let win = null
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    console.log('\n================ 探针汇总 ================')
    for (const line of results) console.log(line)
    console.log('--- preload 错误 ---')
    console.log(preloadErrors.length ? preloadErrors.join('\n') : '(无 preload-error 事件)')
    try { server && server.close() } catch {}
    setTimeout(() => app.exit(0), 200)
  }

  const onConsole = (_e, _level, message) => {
    if (!message.startsWith('PROBE ')) return
    const payload = message.slice(6)
    results.push(payload)
    if (!payload.startsWith('done')) return
    if (phase === 1) {
      // 第一个宿主页（file:// 源）跑完 → 起第二个宿主页（http:// 源，复刻 dev）
      phase = 2
      win.loadURL(`http://127.0.0.1:${port}/host-http.html`)
    } else {
      finish()
    }
  }

  let phase = 1
  let port = 0

  // http 用例：preload 用 text/html 供出去，复刻 dev 下 vite 的 SPA 兜底；另供一个宿主页
  server = http.createServer((req, res) => {
    if (req.url && req.url.startsWith('/host-http.html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(buildHttpHostHtml(dir))
      return
    }
    res.setHeader('Content-Type', 'text/html')
    res.end('<!doctype html><html><body>not a script</body></html>')
  })

  server.listen(0, '127.0.0.1', () => {
    port = server.address().port
    const hostPath = path.join(dir, 'host.html')
    fs.writeFileSync(hostPath, buildHostHtml(dir, port))

    win = new BrowserWindow({
      width: 900,
      height: 700,
      show: true,
      webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false },
    })
    win.webContents.on('console-message', onConsole)
    win.loadURL(pathToFileUrl(hostPath))
    setTimeout(finish, (CASE_TIMEOUT_MS + 2000) * 4 + 5000)
  })
})
