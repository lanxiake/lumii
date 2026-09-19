/**
 * 验证第二步：驱动一个真实 agent 回合，确认工作区快照走新路径（全真 git）正常。
 *
 * 断言链：
 *   1. 回合正常完成（没有 VCS 异常刷屏）
 *   2. 工作区仓库多出一条提交（快照真的落下了）
 *   3. 那条提交能被真 git 读出来（tree/author/message trailer 都对）
 *   4. 没有 index 损坏 / 自愈告警
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createSession, sendAndWait, sleep } from '../../lumii-cli/lib/cli-harness.mjs'

const WORK = process.env.HOME
  ? `${process.env.HOME}/.lumii/workspace`
  : 'C:/Users/75791/.lumii/workspace'
const GITDIR = `${WORK}/.mtbot-vcs`
const EXCL = `${GITDIR}/mtbot-vcs-exclude`
const LOG = 'C:/myself/projects/my/open-source/lumii/.lumii-dev.log'

const git = (args) =>
  execFileSync('git', ['--git-dir', GITDIR, '--work-tree', WORK,
    '-c', `core.excludesFile=${EXCL}`, ...args],
    { cwd: WORK, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim()

let failed = 0
const check = (name, cond, detail = '') => {
  if (!cond) failed++
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

const before = git(['rev-parse', 'HEAD'])
const beforeCount = Number(git(['rev-list', '--count', 'HEAD']))
console.log(`回合前 HEAD=${before.slice(0, 8)} 提交数=${beforeCount}`)

const sk = await createSession('vcs-step2-verify')
console.log(`会话 ${sk}，发送回合...`)

// 让模型真的动一下工作区，否则没有变更就不会产生快照提交（这是正确行为，但验不到路径）
const reply = await sendAndWait(
  sk,
  '请在工作区根目录创建一个文件 vcs-step2-probe.txt，内容为 "step2 ok"，然后回复一句话确认。',
  { timeoutMs: 240000 },
)
// sendAndWait 返回 { assistant, text, elapsedMs }
console.log(`回复（${Math.round(reply.elapsedMs / 1000)}s）：${String(reply.text ?? '').slice(0, 120)}`)

// 快照是异步排在队列里的，给它时间落地。
// ⚠️ 实测要 ~26s 而不是几秒：**cloud-sync 与应用重启后的首轮同步共用同一条
//    串行队列**（enqueueWorkspace），那轮同步含一次对 sync 仓库的 `git gc`，
//    可能占住队列好几分钟。别把等待调小 —— 会得到「快照没跑」的假阴性
//    （本脚本第一版用 8s，就报了 2 项假失败）。
await sleep(45000)

const after = git(['rev-parse', 'HEAD'])
const afterCount = Number(git(['rev-list', '--count', 'HEAD']))
console.log(`回合后 HEAD=${after.slice(0, 8)} 提交数=${afterCount}`)

check('回合后产生了新提交', afterCount > beforeCount, `${beforeCount} → ${afterCount}`)
check('HEAD 已前进', after !== before, `${before.slice(0, 8)} → ${after.slice(0, 8)}`)

if (after !== before) {
  const msg = git(['log', '-n1', '--format=%B', after])
  check('提交信息带 Mtbot-Author trailer', /Mtbot-Author:\s*\w+/.test(msg), msg.split('\n')[0])
  const tree = git(['ls-tree', '-r', '--name-only', after])
  check('新提交里没有 .mtbot-vcs 自我索引', !tree.split('\n').some((f) => f.startsWith('.mtbot-vcs/')))
  check('新提交里有探针文件或至少非空', tree.length > 0, `${tree.split('\n').length} 个文件`)
}

// 日志侧：不该出现自愈/损坏/不可用告警
const logText = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf-8') : ''
const tail = logText.slice(-200_000)
check('无 index 损坏自愈告警', !/index 文件已损坏/.test(tail))
check('无「真 git 不可用」告警', !/真 git 不可用/.test(tail))
check('无 stageAndCommit 抛错', !/stageAndCommit.*退出码/.test(tail))

console.log(`\n${failed === 0 ? '验证通过' : failed + ' 项未通过'}`)
process.exit(failed ? 1 : 0)
