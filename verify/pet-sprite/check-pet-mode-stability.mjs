#!/usr/bin/env node
/**
 * 把光标停在角落（远离控制坞），进宠物模式，观察它会不会自己退回桌面。
 *
 * 目的：把「真实点击」这个混杂因素排除掉。上一轮退出时，光标恰好停在
 * (1294,1264) —— 控制坞所在的区域，所以「人点的」和「自己退的」分不开。
 * 光标停在 (5,5) 时若仍退出，就不是点击引起的。
 *
 * 每轮同时记录光标位置：如果它动了，说明有人在操作这台机器，本轮结论作废。
 */
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { makeAppUiPost, readAppUiConfig, sleep } from 'file:///C:/myself/projects/my/open-source/lumii/verify/pet-sprite/lib/pet-frame.mjs'

const LOG = join(homedir(), '.lumii', 'logs', 'app', `mtbot-${new Date().toISOString().slice(0, 10)}.log`)
const post = makeAppUiPost(readAppUiConfig())

/** 常驻光标查询：读一行 `get` 返回当前坐标 */
function startCursorReader() {
  const ps = spawn(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command',
     `Add-Type -AssemblyName System.Windows.Forms\n` +
     `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class LumiiMv{[DllImport("user32.dll")]public static extern void mouse_event(uint f,int dx,int dy,uint d,IntPtr e);public static void Nudge(){mouse_event(1,1,0,0,IntPtr.Zero);mouse_event(1,-1,0,0,IntPtr.Zero);}}'\n` +
     `while ($true) { $l=[Console]::ReadLine(); if ($null -eq $l) {break}\n` +
     `  if ($l.Trim() -eq 'nudge') { [LumiiMv]::Nudge() } else { $p=$l.Split(','); [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point([int]$p[0],[int]$p[1]) }\n` +
     `  [Console]::Out.WriteLine(([System.Windows.Forms.Cursor]::Position.X).ToString() + ',' + ([System.Windows.Forms.Cursor]::Position.Y).ToString()); [Console]::Out.Flush() }`],
    { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true },
  )
  const rl = createInterface({ input: ps.stdout })
  const q = []
  rl.on('line', (l) => {
    const r = q.shift()
    if (r) r(l.trim())
  })
  const ask = (cmd) =>
    new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('光标服务超时')), 5000)
      q.push((pos) => {
        clearTimeout(t)
        res(pos)
      })
      ps.stdin.write(cmd + '\n')
    })
  return { pos: () => ask('get'), park: (x, y) => ask(`${x},${y}`), close: () => ps.kill() }
}

function readFrom(path, from) {
  const size = statSync(path).size
  if (size <= from) return ''
  const fd = openSync(path, 'r')
  const buf = Buffer.alloc(size - from)
  readSync(fd, buf, 0, buf.length, from)
  closeSync(fd)
  return buf.toString('utf-8')
}

/** 光标停放位置：默认远离控制坞；传 'dock' 则停在控制坞中心（区分 hover 与点击） */
const PARK = process.argv[2] === 'dock' ? '1294,1264' : '5,5'

const cur = startCursorReader()
console.log('把光标停到 ' + PARK + ' …')
await cur.park(...PARK.split(',').map(Number))
await sleep(500)

for (let round = 1; round <= 3; round++) {
  console.log(`\n===== 第 ${round} 轮 =====`)
  await post('/ipc/pet/switchMode', { mode: 'desktop' })
  await sleep(1200)
  let mark = statSync(LOG).size
  await post('/ipc/pet/switchMode', { mode: 'pet', modelId: 'demo_anime_girl' })

  const moved = []
  let drifted = false
  let exitAt = null
  const t0 = Date.now()
  for (let i = 0; i < 100; i++) {
    const p = await cur.pos()
    if (p !== PARK && !drifted) {
      drifted = true
      moved.push(`${((Date.now() - t0) / 1000).toFixed(1)}s 有人动了光标 → ${p}`)
    }
    const mode = (await post('/ipc/pet/getMode'))?.mode
    if (mode === 'desktop' && exitAt === null) {
      exitAt = (Date.now() - t0) / 1000
      break
    }
    await sleep(300)
  }
  const log = readFrom(LOG, mark)
    .split('\n')
    .filter((l) => /mode:switch|enterPetMode|exitPetMode|exitPetMode|Renderer:console/.test(l))
  console.log(`光标轨迹：${moved.join(' → ') || '(没动)'}`)
  console.log(exitAt === null ? '✓ 观察期内没退出（光标没动）' : `✗ 自己退回了桌面，用时 ${exitAt.toFixed(1)}s`)
  console.log('日志：\n' + log.map((l) => '  ' + l.slice(0, 190)).join('\n'))
  if (exitAt === null) break
}

// 还要看：本轮之外有没有别的东西在写日志（终端里直接看）
cur.close()
