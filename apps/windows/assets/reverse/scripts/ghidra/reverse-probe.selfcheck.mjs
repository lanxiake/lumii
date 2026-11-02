#!/usr/bin/env node
/**
 * 自检：Ghidra 探针的输出形态与「找不到 Ghidra」的降级行为。
 *
 * 跑法：`node assets/reverse/scripts/ghidra/reverse-probe.selfcheck.mjs`
 *
 * 为什么需要它：这个脚本的失败模式全是**静默的**——
 * - 能力标签匹配写松了（`connect$` 把 `SCardDisconnect` 归成 network），输出看着正常、结论全错；
 * - analyzeHeadless 的「conflicting program file」是 ERROR 行但不影响退出码；
 * - 找不到 Ghidra 时若直接崩，技能会以为「目标文件有问题」。
 * 所以这里断言的是**输出结构**与**降级文案**，不依赖具体样本文件。
 *
 * 不需要真装 Ghidra：没有就只跑降级用例（并明确打印跳过），有则额外跑一次真实分析。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DRIVER = path.join(HERE, 'reverse-probe.mjs')
const PROBE = path.join(HERE, 'ReverseProbe.java')

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [DRIVER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  })
}

console.log('ReverseProbe.java 源码形态')
const src = fs.readFileSync(PROBE, 'utf8')
// 松匹配是本模块踩过的真坑：`connect$` 让 SCardDisconnect 进了 network
check(
  '能力模式锚定全名（不出现裸 connect$ / send$ 这类松散后缀）',
  !/\{\s*"(network|socket)"\s*,\s*"[^"]*connect\$[^"]*"\s*\}/.test(src),
)
check('反编译排除 CRT 样板（isCompilerHelper 存在）', src.includes('isCompilerHelper'))
check('字符串段排除导入符号名（否则 GetLastError 会被当成线索）', src.includes('importNames.contains'))

console.log('参数与降级')
{
  const r = run([])
  check('缺目标 → 退出码 2 且打印用法', r.status === 2 && /用法/.test(r.stdout + r.stderr), r.stderr.trim())
}
{
  const r = run(['C:/definitely/not/here.exe'])
  check('目标不存在 → 退出码 2', r.status === 2)
}
{
  // 显式指到不存在的 Ghidra 目录，必须走「找不到 Ghidra」而不是崩在 spawn 上
  const r = run(['C:/Windows/System32/notepad.exe', '--ghidra', 'C:/no/such/ghidra'])
  const out = r.stdout + r.stderr
  check('找不到 Ghidra → 退出码 3', r.status === 3, out.slice(0, 200))
  check('降级提示写明「不会自动安装」并给出三条出路', /不会自动安装/.test(out) && /LUMII_GHIDRA_DIR/.test(out))
  check('降级提示说明没有 Ghidra 也能继续做 Triage', /Triage/.test(out))
}

// 真机用例：只在找到 Ghidra 且目标存在时跑
const ghidraEnv = process.env.LUMII_GHIDRA_DIR
const probeTarget =
  process.platform === 'win32' ? 'C:/Windows/System32/notepad.exe' : '/bin/ls'
if (!ghidraEnv) {
  console.log('真实分析：跳过（未设置 LUMII_GHIDRA_DIR——本用例每次约 3 分钟）')
} else if (!fs.existsSync(probeTarget)) {
  console.log(`真实分析：跳过（样本不存在 ${probeTarget}）`)
} else {
  console.log('真实分析（约 3 分钟）')
  const r = run([probeTarget, '--decompile', '1'])
  const out = r.stdout
  check('退出码 0', r.status === 0, r.stderr.slice(-400))
  check('含 FORMAT / ARCH / FUNCTIONS', /FORMAT=/.test(out) && /ARCH=/.test(out) && /FUNCTIONS=\d+/.test(out))
  check('能力标签有数（不是 0 项）', /^CAPABILITY\.[a-z]+=\d+/m.test(out))
  check('有反编译产出', /^FUNCTION=/m.test(out) && /DECOMPILED_COUNT=[1-9]/.test(out))
  check(
    '反编译目标不是 CRT 样板函数',
    !/^FUNCTION=__(security_check_cookie|GSHandlerCheck)/m.test(out),
  )
}

console.log(failures === 0 ? '\nSELFCHECK PASS' : `\nSELFCHECK FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
