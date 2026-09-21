/**
 * make-viewer.mjs — 把出图做成能直接看的动画页
 *
 * 「帧连不连续」是**眼睛的判断**，不是数字的判断。S6 只证明「帧之间有稳定变化且首尾闭合」，
 * 证明不了「这段变化读起来像挥手」——这条盲区在计划 §5.1 就记着。
 * 这里把抠底+切格后的帧写成网页，用 JS 按不同速度循环播放，人一眼就能判断。
 *
 * 用法：node make-viewer.mjs <角色前缀> <批名:网格> ...
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { op } from '../lib/control.mjs'

const W = path.join(os.homedir(), '.lumii/workspace/outputs')
const outDir = path.join(W, 'pet-review')
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

const [prefix, ...specs] = process.argv.slice(2)
const groups = []
for (const spec of specs) {
  const [name, grid] = spec.split(':')
  const [cols, rows] = grid.split('x').map(Number)
  const raw = path.join(W, `pet-raw/${prefix}-${name}.png`)
  const cut = path.join(outDir, `${name}-cut.png`)
  const c = await op('cutout', { input: raw, output: cut })
  if (!c.ok) throw new Error(`${name} cutout: ${c.error}`)
  const s = await op('slice', { input: cut, outDir: path.join(outDir, name), cols, rows, prefix: name })
  if (!s.ok) throw new Error(`${name} slice: ${s.error}`)
  const files = s.result.cells.map((cell) => path.join(name, path.basename(cell.file)))
  groups.push({ name, files, cols, rows })
  console.log(`${name}: ${cols}×${rows} → ${files.length} 帧`)
}

const html = `<!doctype html><meta charset="utf-8"><title>${prefix} 动作检查</title>
<style>body{background:#222;color:#eee;font:14px/1.6 system-ui;margin:24px}
h2{margin:24px 0 8px}.row{display:flex;gap:8px;align-items:flex-end;background:#2c2c2c;padding:8px;border-radius:6px}
.row img{width:150px;image-rendering:auto}
button{font:inherit;padding:4px 12px;margin-right:8px}
.bg{background:#00ffff;padding:8px;border-radius:6px;display:inline-block}
</style>
<body><h1>${prefix}</h1>
<p>每一格都是抠底后的原帧。用下面的按钮换速度看这段动作连不连贯。</p>
<p id="ctl"></p><div id="out"></div>
<script>
const G = ${JSON.stringify(groups)};
let fps = 6, timer = null;
const out = document.getElementById('out');
out.innerHTML = G.map((g,i)=>'<h2>'+g.name+'（'+g.files.length+' 帧）</h2><div class="row" id="r'+i+'">'+
  g.files.map(f=>'<div class="bg"><img src="'+f+'" data-g="'+i+'" data-f="'+f+'"></div>').join('')+'</div>').join('');
const frames = G.map((g,i)=>[...out.querySelectorAll('img[data-g="'+i+'"]')]);
let idx = G.map(()=>0);
function tick(){ for(let i=0;i<frames.length;i++){ idx[i]=(idx[i]+1)%frames[i].length;
  frames[i].forEach((img,k)=>img.style.opacity = k===idx[i]?1:0.12); } }
function start(){ clearInterval(timer); timer=setInterval(tick, 1000/fps); }
document.getElementById('ctl').innerHTML = '<button data-v="2">2 帧/秒</button><button data-v="4">4</button>'+
  '<button data-v="6">6</button><button data-v="10">10</button><button data-v="1">逐帧（1）</button>';
document.querySelectorAll('#ctl button').forEach(b=>b.onclick=()=>{fps=+b.dataset.v;start();});
start();
</script>`

fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf-8')
console.log(`\n打开：${path.join(outDir, 'index.html')}`)
