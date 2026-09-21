#!/usr/bin/env node
/**
 * make-viewer.mjs — 把**打包好的宠物包**渲染成能直接看的动画页
 *
 * ## 为什么重写
 *
 * 旧版把切好的帧平铺成一行、靠改透明度指示"当前帧"——那是**帧检视器**，不是动画预览：
 * 看不出动作连不连贯，更看不出「从待机进挥手、挥手完回待机」会不会跳。
 * 而这两件事恰恰只能靠眼睛判——出图闸门判的是几何风险，判不了"读起来像不像挥手"。
 *
 * 新版**直接读打包产物**（manifest.json + atlas.json + atlas.png），按清单里的
 * `slots` / `frames` / `durationMs` 合成播放。看到的就是运行时会发生的事：
 * 图层叠加、逐帧时长、once 播完接 next。
 *
 * ## 最上面那一格是重点
 *
 * 「串播」框连着播 **待机 → 动作 → 待机**。Idle Pin 有没有生效就看这里：
 * 端点与待机首帧是同一张图时，接缝处看不出任何变化；没钉住时会有明显一顿。
 *
 * ## 图层用 CSS 精灵图拼，不切中间文件
 *
 * 图集里每个条目都是「整张画布大小」的矩形，槽位 `at` 都是 [0,0]，
 * 所以一层就是一个 div、`background-position` 取条目的 (x, y)。
 * 不落中间文件，像素也不会在二次编码里被改。
 *
 * 用法：node make-viewer.mjs <宠物包目录> [...]
 *   省略参数时默认看三只示范宠物。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../..')

const args = process.argv.slice(2)
const dirs =
  args.length > 0
    ? args
    : ['demo_anime_girl', 'demo_cartoon_cat', 'demo_mecha_gundam'].map((id) =>
        path.join(REPO, 'apps/windows/resources/pet-models', id),
      )

const outDir = path.join(os.homedir(), '.lumii/workspace/outputs/pet-review')
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

/** 读一个宠物包，图集拷进输出目录，返回给页面用的紧凑描述 */
function loadPackage(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'))
  const atlas = JSON.parse(fs.readFileSync(path.join(dir, 'atlas.json'), 'utf-8'))
  const image = atlas.meta?.image ?? manifest.atlas
  const imageName = `${manifest.id}.png`
  fs.copyFileSync(path.join(dir, image), path.join(outDir, imageName))

  const frames = {}
  for (const [name, e] of Object.entries(atlas.frames ?? {})) {
    const b = e.frame ?? e
    frames[name] = { x: b.x, y: b.y, w: b.w, h: b.h }
  }

  return {
    id: manifest.id,
    image: imageName,
    canvas: manifest.canvas,
    frames,
    slots: manifest.slots ?? {},
    hitAreas: manifest.hitAreas ?? [],
    animations: (manifest.animations ?? []).map((a) => ({
      group: a.group,
      kind: a.kind,
      next: a.next ?? null,
      fps: a.fps ?? 6,
      frames: (a.frames ?? []).map((f) => {
        const out = { base: f.base ?? null, durationMs: f.durationMs ?? null, slots: {} }
        for (const [k, v] of Object.entries(f)) {
          if (k === 'base' || k === 'durationMs') continue
          if (v && typeof v === 'object') out.slots[k] = v
        }
        return out
      }),
    })),
  }
}

const packs = []
for (const d of dirs) {
  const abs = path.resolve(d)
  if (!fs.existsSync(path.join(abs, 'manifest.json'))) {
    console.error(`✗ 跳过 ${d}：不是宠物包（没有 manifest.json）`)
    continue
  }
  const p = loadPackage(abs)
  packs.push(p)
  console.log(
    `✓ ${p.id}：${p.animations.length} 组动画 · ${Object.keys(p.frames).length} 帧 · ` +
      `${p.hitAreas.length} 个命中区`,
  )
}
if (packs.length === 0) throw new Error('没有可预览的宠物包')

const html = `<!doctype html><meta charset="utf-8"><title>宠物动画预览</title>
<style>
 body{background:#1b1b1f;color:#e8e8ea;font:14px/1.6 system-ui,"Microsoft YaHei";margin:0;padding:24px}
 h1{font-size:17px;margin:30px 0 12px;padding-bottom:6px;border-bottom:1px solid #333}
 h2{font-size:13px;margin:0 0 8px;color:#9aa;font-weight:600}
 .wrap{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start}
 .card{background:#26262c;border-radius:8px;padding:12px}
 .card.chain{outline:1px solid #4a5f4a;background:#242a24}
 .box{position:relative;background:#3a3a42;border-radius:6px;overflow:hidden}
 .pet{position:relative}
 .layer{position:absolute;top:0;left:0;background-repeat:no-repeat}
 .hits{position:absolute;top:0;left:0;pointer-events:none}
 .hits polygon{fill:rgba(255,80,120,.20);stroke:rgba(255,80,120,.85);stroke-width:1.5}
 .meta{color:#8b8b96;font-size:12px;margin-top:9px;max-width:420px;word-break:break-all}
 .meta b{color:#cfd2d8;font-weight:600}
 .strip{display:flex;gap:5px;flex-wrap:wrap;margin-top:11px;max-width:420px}
 .cell{background:#31313a;border-radius:5px;padding:3px;text-align:center}
 .cell .vp{overflow:hidden;border-radius:3px}
 .cell .lbl{font-size:10px;color:#8b8b96;margin-top:2px;line-height:1.3}
 .ctl{display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin:14px 0 4px;
   background:#26262c;padding:10px 14px;border-radius:8px;position:sticky;top:0;z-index:9}
 .ctl label{color:#9aa}
 select,button{font:inherit;background:#33333b;color:#e8e8ea;border:1px solid #45454f;
   border-radius:5px;padding:3px 10px}
 .badge{font-size:11px;padding:1px 7px;border-radius:9px;background:#3d4d3d;color:#a8d8a8;margin-left:6px}
 .badge.once{background:#4d3d3d;color:#e0a898}
 .note{color:#8b8b96;font-size:12px;background:#22222a;border-left:3px solid #444;
   padding:8px 12px;border-radius:0 5px 5px 0;margin:10px 0;max-width:760px}
</style>
<body>
<h1 style="margin-top:0">宠物动画预览</h1>
<p class="note">这一页读的是<b>打包产物</b>（manifest + atlas），按清单里的图层、逐帧时长、
   once 播完接 next 合成播放——看到的就是运行时会发生的事。<br>
   第一格「串播」连着播 <b>待机 → 动作 → 待机</b>：接缝处跳不跳，就是 Idle Pin 有没有生效。</p>
<div class="ctl">
  <label>缩放 <input id="zoom" type="range" min="0.3" max="2" step="0.1" value="1"></label>
  <span id="zoomv" style="color:#9aa">1.0×</span>
  <label>表情覆盖 <select id="expr"></select></label>
  <label><input id="showhit" type="checkbox"> 命中区</label>
</div>
<div id="root"></div>
<script>
const PACKS = ${JSON.stringify(packs)};
const root = document.getElementById('root');
const state = { zoom: 1, override: null, showHit: false };

/** 帧 → 要画的每一层：帧自带的槽位声明，再被 override 盖上（与渲染器同序） */
function layersOf(pack, frame){
  const layered = {};
  for (const [slot, cats] of Object.entries(frame.slots)) layered[slot] = { ...cats };
  if (state.override){
    const o = state.override;
    if (pack.slots[o.slot]?.parts?.[o.cat]) layered[o.slot] = { ...(layered[o.slot]||{}), [o.cat]: o.part };
  }
  const out = [];
  if (frame.base) out.push({ part: frame.base, at: [0,0] });
  for (const [slotName, def] of Object.entries(pack.slots)){
    for (const cat of Object.keys(def.parts || {})){
      const part = layered[slotName]?.[cat];
      if (part) out.push({ part, at: def.at || [0,0] });
    }
  }
  return out;
}

/** 画一帧。withHits 给 false 用于帧条——几十个小格子上叠命中区只会糊成一团 */
function draw(pack, pet, frame, withHits){
  pet.innerHTML = '';
  for (const L of layersOf(pack, frame)){
    const f = pack.frames[L.part];
    if (!f) continue;
    const d = document.createElement('div');
    d.className = 'layer';
    d.style.backgroundImage = 'url("' + pack.image + '")';
    d.style.backgroundPosition = (-(f.x - L.at[0])) + 'px ' + (-(f.y - L.at[1])) + 'px';
    d.style.width = f.w + 'px';
    d.style.height = f.h + 'px';
    pet.appendChild(d);
  }
  if (withHits !== false && state.showHit){
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('class','hits');
    svg.setAttribute('viewBox','0 0 ' + pack.canvas.w + ' ' + pack.canvas.h);
    svg.setAttribute('width', pack.canvas.w);
    svg.setAttribute('height', pack.canvas.h);
    for (const a of pack.hitAreas){
      const p = document.createElementNS('http://www.w3.org/2000/svg','polygon');
      p.setAttribute('points', a.points.map((q) => q.join(',')).join(' '));
      svg.appendChild(p);
    }
    pet.appendChild(svg);
  }
}

/**
 * 造一个画框。
 *
 * 三层是为了缩放：viewport（按缩放后的尺寸占位，撑开父容器）→
 * box（画布原始尺寸，被 transform 缩放）→ pet（画布坐标系，图层按图集坐标摆）。
 * 不这么分的话，缩放要么挤坏卡片排版，要么让图层坐标跟着变。
 */
function makeBox(pack){
  const viewport = document.createElement('div')
  const box = document.createElement('div')
  box.className = 'box'
  const pet = document.createElement('div')
  pet.className = 'pet'
  pet.style.width = pack.canvas.w + 'px'
  pet.style.height = pack.canvas.h + 'px'
  box.style.width = pack.canvas.w + 'px'
  box.style.height = pack.canvas.h + 'px'
  box.appendChild(pet)
  viewport.appendChild(box)
  return { viewport, box, pet }
}

const boxes = []

/**
 * 帧条：把一个动作组的所有帧静态排开。
 *
 * 播放框能告诉你"动起来顺不顺"，但看不出"哪一帧画坏了"——帧条能一眼扫出来，
 * 旧版预览器的这个能力不该因为重写而丢掉。
 *
 * **帧条也要走图层合成**，不能只画 frame.base：分层模型的身体帧里是**没有眼睛的**
 * （表情被差分成了独立图层），只画 base 会看到一排没脸的帧。
 */
const stripCells = []
function buildStrip(pack, anim, host){
  const strip = document.createElement('div')
  strip.className = 'strip'
  const k = 74 / pack.canvas.h
  for (const f of anim.frames){
    const cell = document.createElement('div')
    cell.className = 'cell'
    const vp = document.createElement('div')
    vp.className = 'vp'
    const box = document.createElement('div')
    box.className = 'box'
    box.style.width = pack.canvas.w + 'px'
    box.style.height = pack.canvas.h + 'px'
    box.style.transformOrigin = 'top left'
    box.style.transform = 'scale(' + k + ')'
    const pet = document.createElement('div')
    pet.className = 'pet'
    pet.style.width = pack.canvas.w + 'px'
    pet.style.height = pack.canvas.h + 'px'
    box.appendChild(pet)
    vp.style.width = pack.canvas.w * k + 'px'
    vp.style.height = pack.canvas.h * k + 'px'
    vp.appendChild(box)
    const lbl = document.createElement('div')
    lbl.className = 'lbl'
    lbl.textContent = f.base || '?'
    lbl.title = Math.round(f.durationMs ?? 1000 / Math.max(1, anim.fps)) + ' ms'
    cell.appendChild(vp)
    cell.appendChild(lbl)
    strip.appendChild(cell)
    stripCells.push({ pack, frame: f, pet })
  }
  host.appendChild(strip)
}

/** 表情覆盖换了要重画所有帧条格子（播放框靠 drawnKey 自己会跟） */
function redrawStrips(){
  for (const c of stripCells) draw(c.pack, c.pet, c.frame, false)
}
function applyZoom(){
  document.getElementById('zoomv').textContent = state.zoom.toFixed(1) + '×'
  for (const b of boxes){
    b.box.style.transformOrigin = 'top left'
    b.box.style.transform = 'scale(' + state.zoom + ')'
    b.viewport.style.width = b.pack.canvas.w * state.zoom + 'px'
    b.viewport.style.height = b.pack.canvas.h * state.zoom + 'px'
  }
}

/**
 * 按清单里的逐帧时长推进一条序列。序列是 [{anim, from, to}]——串播框就是
 * 三条接在一起，单个动作组就是一条。
 *
 * @param holdMs 整条序列播完后停多久再从头来（once 动作用；循环动作给 0）
 */
function player(pack, pet, steps, opts = {}){
  const durOf = (s, i) => {
    const d = s.anim.frames[i]?.durationMs
    return typeof d === 'number' && d > 0 ? d : 1000 / Math.max(1, s.anim.fps)
  }
  let si = 0
  let fi = steps[0].from
  let acc = 0
  let holdUntil = 0
  let pendingRestart = false
  let last = performance.now()
  let drawnKey = ''

  function tick(now){
    const dt = now - last
    last = now
    if (now >= holdUntil){
      // 停够了才从头来。**不能一播完就重置**——那样 once 动作是"跳回开头再停"，
      // 看着像卡了一下，而它该停在**末帧**上（钉住之后末帧就是待机，停在那里才对）。
      if (pendingRestart){
        pendingRestart = false
        si = 0
        fi = steps[0].from
        acc = 0
      }
      acc += dt
      let guard = 64
      while (acc >= durOf(steps[si], fi) && guard-- > 0){
        acc -= durOf(steps[si], fi)
        if (fi < steps[si].to){
          fi++
          continue
        }
        if (si < steps.length - 1){
          si++
          fi = steps[si].from
          continue
        }
        // 整条序列播完
        if (opts.holdMs){
          holdUntil = now + opts.holdMs
          pendingRestart = true
        } else {
          si = 0
          fi = steps[0].from
        }
        break
      }
    }
    // 只在**画面真的会变**时重画：帧变了、命中区开关动了、或表情覆盖换了。
    // 少了最后一项的话，切表情要等下一次翻帧才显示出来。
    const ov = state.override
    const key = si + ':' + fi + ':' + (state.showHit ? 1 : 0) + ':' +
      (ov ? ov.slot + '/' + ov.cat + '/' + ov.part : '')
    if (key !== drawnKey){
      drawnKey = key
      draw(pack, pet, steps[si].anim.frames[fi])
    }
    if (opts.onFrame) opts.onFrame(steps[si], fi)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

function card(className, titleHtml){
  const c = document.createElement('div');
  c.className = 'card' + (className ? ' ' + className : '');
  c.innerHTML = '<h2>' + titleHtml + '</h2>';
  return c;
}

for (const pack of PACKS){
  const h = document.createElement('h1');
  h.textContent = pack.id + ' — 画布 ' + pack.canvas.w + '×' + pack.canvas.h +
    ' · 图集 ' + Object.keys(pack.frames).length + ' 帧 · 命中区 ' + pack.hitAreas.length + ' 个';
  root.appendChild(h);

  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  root.appendChild(wrap);

  const idle = pack.animations.find((a) => a.group === 'Idle') ?? pack.animations[0];
  const once = pack.animations.find((a) => a.kind === 'once');
  const full = (a) => ({ anim: a, from: 0, to: a.frames.length - 1 });

  // ---- 串播：待机 → 动作 → 待机 ----
  const steps = once ? [full(idle), full(once), full(idle)] : [full(idle)];
  const chain = card('chain', '串播：' + steps.map((s) => s.anim.group).join(' → '));
  const cb = makeBox(pack);
  chain.appendChild(cb.viewport);
  const meta = document.createElement('div');
  meta.className = 'meta';
  chain.appendChild(meta);
  player(pack, cb.pet, steps, {
    onFrame: (s, i) => {
      meta.innerHTML = '当前：<b>' + s.anim.group + '</b> 第 ' + (i + 1) + '/' + s.anim.frames.length +
        ' 帧 · <b>' + (s.anim.frames[i].base || '?') + '</b> · ' + Math.round(
          s.anim.frames[i].durationMs ?? 1000 / Math.max(1, s.anim.fps)) + ' ms';
    },
  });
  boxes.push({ viewport: cb.viewport, box: cb.box, pack });
  wrap.appendChild(chain);

  // ---- 每个动作组一个框 ----
  for (const anim of pack.animations){
    const isOnce = anim.kind === 'once';
    const badge = isOnce
      ? '<span class="badge once">once → ' + (anim.next ?? '?') + '</span>'
      : '<span class="badge">loop</span>';
    const c = card('', anim.group + badge);
    const b = makeBox(pack);
    c.appendChild(b.viewport);
    player(pack, b.pet, [full(anim)], { holdMs: isOnce ? 500 : 0 });
    const durs = anim.frames.map((f) => Math.round(f.durationMs ?? 1000 / Math.max(1, anim.fps)));
    const info = document.createElement('div');
    info.className = 'meta';
    info.innerHTML = '<b>' + anim.frames.length + '</b> 帧 · ' + (anim.fps ?? 6) + ' fps · 逐帧 ' +
      durs.join(' / ') + ' ms<br>' + anim.frames.map((f) => f.base || '?').join(' → ');
    c.appendChild(info);
    buildStrip(pack, anim, c);
    boxes.push({ viewport: b.viewport, box: b.box, pack });
    wrap.appendChild(c);
  }
}

// 表情覆盖：列出所有包里的 (槽, 类别, 部件)，选中后对**所有**包生效
const sel = document.getElementById('expr');
sel.appendChild(new Option('默认（按帧里的声明）', ''));
const seen = new Set();
for (const p of PACKS){
  for (const [slot, def] of Object.entries(p.slots)){
    for (const [cat, parts] of Object.entries(def.parts || {})){
      for (const part of parts){
        const key = slot + '/' + cat + '/' + part;
        if (seen.has(key)) continue;
        seen.add(key);
        sel.appendChild(new Option(cat + ' → ' + part, JSON.stringify({ slot, cat, part })));
      }
    }
  }
}
sel.onchange = () => {
  state.override = sel.value ? JSON.parse(sel.value) : null;
  redrawStrips();
};

document.getElementById('zoom').oninput = (e) => { state.zoom = +e.target.value; applyZoom() };
document.getElementById('showhit').onchange = (e) => { state.showHit = e.target.checked };
applyZoom();
redrawStrips();
</script>`

fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf-8')
console.log(`\n打开：${path.join(outDir, 'index.html')}`)
