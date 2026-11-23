#!/usr/bin/env node
// 蓝鲸桌宠 · 说话工具
// 文字 → Edge-TTS(0显存) → RVC(鲸鱼娘音色) → 播放 + 桌宠张嘴动作
//
//   node dafei-voice.mjs "主人，我回来啦。"
//   node scripts/dafei-voice.mjs "..." --voice zh-CN-XiaoyiNeural --model "鲸鱼娘"
//   node scripts/dafei-voice.mjs "..." --no-play          # 只合成不播放
//   node scripts/dafei-voice.mjs "..." --no-motion        # 只播声音不做动作
//
// 依赖（都可改）：Edge-TTS 所在的 python（含 edge_tts 模块）、RVCover 服务(默认 127.0.0.1:8765)、
//   dsh-bluewhale-prompt 服务(默认 127.0.0.1:18100)。
//   环境变量：RVCOVER_DIR（RVCover 安装目录，默认 D:/AI/RVCover）
//             EDGE_TTS_PYTHON（跑 edge_tts 的 python，默认 <RVCOVER_DIR>/py311/python.exe）
//             FFMPEG（默认 <RVCOVER_DIR>/bin/ffmpeg.exe，不存在就用 PATH 里的 ffmpeg）
//             DAFEI_API（桌宠插件地址，默认 http://127.0.0.1:18100）

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const RVC_DIR = process.env.RVCOVER_DIR || 'D:/AI/RVCover'
const PY = process.env.EDGE_TTS_PYTHON || (fs.existsSync(path.join(RVC_DIR, 'py311/python.exe'))
  ? path.join(RVC_DIR, 'py311/python.exe')
  : (process.platform === 'win32' ? 'python' : 'python3'))
const FFMPEG = process.env.FFMPEG || (fs.existsSync(path.join(RVC_DIR, 'bin/ffmpeg.exe'))
  ? path.join(RVC_DIR, 'bin/ffmpeg.exe')
  : 'ffmpeg')
const RVC_API = process.env.RVC_API || 'http://127.0.0.1:8765'
const DAFEI_API = process.env.DAFEI_API || 'http://127.0.0.1:18100'
const OUT_DIR = path.join(RVC_DIR, 'tmp/voice-out')

// 动作名 → 与 OPFS 里的文件名一致
const MOTION_TALK = 'Animation/正常说话-抚胸.motion3.json' // 原子-说话 已随动作库重置删除（2026-11-18）

function log(...a) { console.log('[voice]', ...a) }

// ---------- 中断兜底 ----------
// 这个脚本是被插件 spawn 出来的：DSH 重启、任务被取消、Ctrl-C 都会在播放中途把它掐掉。
// 掐掉时第 ④ 步（清场）根本跑不到，临时文件就留在盘上了 —— 所以先把这一轮要删的文件
// 登记起来，收到信号 / 抛异常时先删再走。
const temps = new Set()
const track = (f) => { if (f) temps.add(f) }
let cleaned = false
function cleanTemps(why) {
  if (cleaned) return
  try { if (keep) return } catch { }
  cleaned = true
  let freed = 0
  let n = 0
  for (const f of temps) {
    try {
      const s = fs.statSync(f).size
      fs.unlinkSync(f)
      freed += s
      n += 1
    } catch { }
  }
  if (n) log(`⚠ ${why}：清场删 ${n} 个 / ${(freed / 1024).toFixed(0)} KB`)
}

let stage = '启动'
const T0 = Date.now()
// die 直接写日志文件：--log 的 patch 在后面才装，参数错 / RVC 没起时 die 更早触发，
// 那时 stderr 正被调用方的 stdio:'ignore' 丢掉 —— voice.log 里会一个字都没有
const die = (msg, code = 1) => {
  const line = `[voice] ✗ [${stage} / +${((Date.now() - T0) / 1000).toFixed(1)}s] ${msg}`
  console.error(line)
  try { if (logPath) fs.appendFileSync(logPath, line + '\n') } catch { }
  cleanTemps('出错退出')
  process.exit(code)
}

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(sig, () => { log('⚠ 被中断（' + sig + '）'); cleanTemps(sig); process.exit(143) }) } catch { }
}
process.on('uncaughtException', (e) => { log('✗ 未捕获异常：', e && e.stack || e); cleanTemps('异常'); process.exit(1) })
process.on('unhandledRejection', (e) => { log('✗ 未处理的 Promise 拒绝：', e && e.stack || e); cleanTemps('拒绝'); process.exit(1) })

// ---------- 参数 ----------
const argv = process.argv.slice(2)
let text = ''
let voice = 'zh-CN-XiaoyiNeural'   // 晓伊：Cartoon/Lively，最贴桌宠气质
let modelId = process.env.RVC_MODEL || '鲸鱼娘'
let doPlay = true
let doMotion = true
let keep = false
let logPath = ''                    // --log <file>：插件用隐藏窗口启动，stdout 看不见，改成追加进文件
let pitch = 2                        // 女声往高一点，避免 RVC 出来后偏沉
let indexRate = 0.75
const positional = []

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--voice') voice = argv[++i]
  else if (a === '--model') modelId = argv[++i]
  else if (a === '--pitch') pitch = Number(argv[++i])
  else if (a === '--index-rate') indexRate = Number(argv[++i])
  else if (a === '--no-play') doPlay = false
  else if (a === '--no-motion') doMotion = false
  else if (a === '--keep') keep = true
  else if (a === '--log') logPath = argv[++i]
  else if (a === '-h' || a === '--help') {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 16).join('\n'))
    process.exit(0)
  } else if (!a.startsWith('--')) positional.push(a)   // 以 - 开头的正文（"-18 度"）不能被丢掉
  else console.log('[voice] ⚠ 未知参数已忽略：', a)
}
text = positional.join(' ').trim()
if (!text) die('用法: node dafei-voice.mjs "要说的话" [--voice X] [--model Y] [--no-play] [--no-motion] [--keep] [--log 文件]')

// ---------- 日志：给了 --log 就把控制台输出追加进文件 ----------
if (logPath) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    const fmt = (x) => (typeof x === 'string' ? x : x instanceof Error ? x.stack || x.message : JSON.stringify(x))
    // 两句重叠时靠 pid 区分；靠时间看"卡在哪一步多久"
    const tag = () => `[${new Date().toLocaleTimeString()}][${process.pid}] `
    const write = (...a) => fs.appendFileSync(logPath, tag() + a.map(fmt).join(' ') + '\n')
    const out = console.log.bind(console)
    const err = console.error.bind(console)
    console.log = (...a) => { try { write(...a) } catch { } ; out(...a) }
    console.error = (...a) => { try { write('✗', ...a) } catch { } ; err(...a) }
  } catch { }
}

// ---------- 探活 ----------
async function ping(url, name) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) })
    return r.ok
  } catch { return false }
}

const rvcUp = await ping(`${RVC_API}/api/models`, 'RVCover')
if (!rvcUp) die('RVCover 没起。先跑:  cd /d/AI/RVCover && ./py311/python.exe tools/webui/app.py --port 8765')

const dafeiUp = await ping(`${DAFEI_API}/dafei/health`, 'dafei')
if (doMotion && !dafeiUp) log('⚠ dafei 服务没起（18100），跳过动作')

fs.mkdirSync(OUT_DIR, { recursive: true })
// 启动先扫一遍：上次被杀掉留下的 say-* （10 分钟以前的才算残留，别动同时还在跑的）
try { const s0 = sweep(10 * 60 * 1000); if (s0.n) log(`④ 启动清场：历史残留 ${s0.n} 个 / ${(s0.freed / 1024).toFixed(0)} KB`) } catch { }
const stamp = Date.now()
const base = `say-${process.pid.toString(36)}-${stamp}-${Math.random().toString(36).slice(2, 6)}`

// ---------- 1. Edge-TTS ----------
log('① Edge-TTS …', voice)
const mp3 = path.join(OUT_DIR, `${base}.mp3`)
{
  // 正文写进文件再喂：命令行有 32k 上限，引号 / 反斜杠结尾 / 以 - 开头都会被 CRT 或 argparse 吃坏
  const txtPath = path.join(OUT_DIR, `${base}.txt`)
  track(txtPath)
  fs.writeFileSync(txtPath, text, 'utf8')
  let last = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = spawnSync(PY, ['-m', 'edge_tts', '--voice', voice, '--file', txtPath, '--write-media', mp3, '--no-progress'],
      { encoding: 'utf8', timeout: 60000, windowsHide: true })  // windowsHide：否则 python.exe 会新开一个黑框
    const size = fs.existsSync(mp3) ? fs.statSync(mp3).size : 0
    if (r.status === 0 && size > 1024) { last = null; break }
    last = `exit=${r.status} size=${size} ${r.error ? r.error.code + ' ' : ''}${(r.stderr || r.stdout || '').slice(0, 300)}`
    if (attempt === 1) log('   ⚠ edge-tts 重试一次：' + last.trim())
  }
  if (last !== null) die('edge-tts 失败: ' + last)
}
track(mp3);
const mp3Size = fs.statSync(mp3).size
log(`   → ${mp3} (${(mp3Size / 1024).toFixed(0)} KB)`)

// ---------- 2. 上传 + RVC 转换 ----------
log('② RVC 转换 …', modelId)

async function upload(file) {
  const fd = new FormData()
  const buf = fs.readFileSync(file)
  fd.append('file', new Blob([buf]), path.basename(file))
  const r = await fetch(`${RVC_API}/api/upload`, { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) })
  if (!r.ok) die('upload 失败 ' + r.status + ' ' + (await r.text()).slice(0, 200))
  return await r.json()
}

const up = await upload(mp3)
track(path.join(RVC_DIR, up.rel));
log(`   upload → ${up.rel} (${up.duration}s)`)

const convRes = await fetch(`${RVC_API}/api/convert`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model_id: modelId,
    vocal: up.rel,
    pitch,
    index_rate: indexRate,
    rms_mix_rate: 0.25,
    protect: 0.33,
    filter_radius: 3,
  }),
  signal: AbortSignal.timeout(30000),
})
if (!convRes.ok) die('convert 失败 ' + convRes.status + ' ' + (await convRes.text()).slice(0, 300))
const conv = await convRes.json()
const jid = conv.job
log(`   job ${jid}`)

const cancelJob = async (reason) => {
  try {
    await fetch(`${RVC_API}/api/job/${jid}/cancel`, { method: 'POST', signal: AbortSignal.timeout(3000) })
    log('   ✂ 已请求取消 job（' + reason + '）')
  } catch { }
}

let wavPath = conv.out
const t0 = Date.now()
let lastState = ''
let poll = 0
while (true) {
  // 前 10 次 300ms（RVC 实测 3~7 秒就完），之后放慢
  await new Promise(r => setTimeout(r, poll++ < 10 ? 300 : 1000))
  let jr
  try {
    jr = await fetch(`${RVC_API}/api/job/${jid}`, { signal: AbortSignal.timeout(10000) })
  } catch (e) {
    if (Date.now() - t0 > 60000) die('job 查询一直失败: ' + (e && e.message))
    continue
  }
  if (!jr.ok) die('job 查询失败 ' + jr.status + '（RVC 可能重启过，这个 job 已经不认识了）')
  const j = await jr.json()
  const st = j.status || j.state || '?'
  if (st !== lastState) { lastState = st; log(`   [${((Date.now() - t0) / 1000).toFixed(1)}s] ${st}`) }
  if (st === 'done') break
  if (st === 'error' || st === 'failed' || st === 'canceled' || st === 'cancelled') {
    die('RVC 失败(' + st + '): ' + JSON.stringify(j).slice(0, 400))
  }
  if (Date.now() - t0 > 240000) {
    await cancelJob('超时 240s')
    die('RVC 超时 240s')
  }
}

if (!fs.existsSync(wavPath)) die('转换产物不存在: ' + wavPath)
track(wavPath)
const wavSize = fs.statSync(wavPath).size
// 探测失败就退回服务端算好的时长，否则播放会在第 dur+8 秒被误杀
const dur = (await probeDuration(wavPath)) || (typeof up.duration === 'number' ? up.duration : 0)
log(`   → ${path.basename(wavPath)} (${(wavSize / 1024).toFixed(0)} KB / ${dur.toFixed(2)}s)`)

async function probeDuration(f) {
  try {
    const r = spawnSync(FFMPEG, ['-i', f, '-f', 'null', '-'], { encoding: 'utf8', timeout: 20000, windowsHide: true })
    const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(r.stderr || '')
    if (!m) return 0
    return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3])
  } catch { return 0 }
}

// ---------- 3. 动作 + 播放 ----------
let motionStop = false
async function fireMotion() {
  if (!doMotion || !dafeiUp) return
  // 原子-说话 时长 4.2s，音频更长就补发几次，让嘴一直动
  const times = Math.max(1, Math.ceil(dur / 4.2))
  for (let i = 0; i < times; i++) {
    if (motionStop) return
    try {
      await fetch(`${DAFEI_API}/dafei/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ motion: MOTION_TALK }),
      })
    } catch { /* 静默 */ }
    if (i < times - 1) await new Promise(r => setTimeout(r, 4200))
  }
}

if (doPlay) {
  log('③ 播放 + 张嘴 …')
  const motionP = fireMotion()
  // 用 .NET SoundPlayer（只吃 WAV PCM，我们的产物正好是 pcm_s16le）
  // PlaySync 会阻塞到播完，因此放到子进程里跑，超时兜底 dur+8s
  const psScript = `
$ErrorActionPreference = 'Stop'
$sp = New-Object System.Media.SoundPlayer '${wavPath.replace(/'/g, "''")}'
$sp.Load()
$sp.PlaySync()
`
  const play = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  let errBuf = ''
  play.stderr.on('data', d => { errBuf += d.toString() })

  const playDone = new Promise((resolve) => {
    const timer = setTimeout(() => { try { play.kill() } catch { } ; resolve('timeout') }, (dur + 8) * 1000)
    play.on('exit', (code) => { clearTimeout(timer); resolve(code === 0 ? 'ok' : 'exit-' + code) })
    play.on('error', (e) => { clearTimeout(timer); resolve('spawn-error: ' + e.message) })
  })

  const playResult = await playDone
  if (playResult !== 'ok') {
    log('   ⚠ 播放失败:', playResult, errBuf.slice(0, 200))
    process.exitCode = 2   // 上层能看出"合成成功但没出声"
  } else log('   播放完成')

  motionStop = true
  await Promise.race([motionP, new Promise(res => setTimeout(res, 6000))])
  log('④ 说完')
} else {
  log('③ 只合成（--no-play），文件：', wavPath, '（要留档加 --keep，否则结束就删）')
}

// ---------- 4. 清场：合成产物不留盘 ----------
//   默认把这一轮的 mp3、上传副本、转换后的 wav 全删掉；要留档加 --keep。
//   另外每次顺手扫掉 2 小时前的残留（上次崩溃 / 上次 --keep 忘了清的）。
const sizeOf = (f) => { try { return fs.statSync(f).size } catch { return 0 } }

function sweep(cutMs = 2 * 3600 * 1000) {
  const now = Date.now()
  // _gain 是 RVC 的 pre-gain 中间件产物（tools/rvc_convert.py），_jobs 是 job 日志 —— 同样是 say-* 前缀，一样要清
  const dirs = [
    OUT_DIR,
    path.join(RVC_DIR, 'work/converted'),
    path.join(RVC_DIR, 'work/_uploads'),
    path.join(RVC_DIR, 'work/_gain'),
    path.join(RVC_DIR, 'work/_jobs'),
  ]
  let freed = 0
  let n = 0
  for (const dir of dirs) {
    let names = []
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const name of names) {
      if (!name.startsWith('say-')) continue // 只碰自己产出的，不动 RVC 界面里别人的文件
      const f = path.join(dir, name)
      try {
        const st = fs.statSync(f)
        if (!st.isFile() || now - st.mtimeMs < cutMs) continue
        fs.unlinkSync(f)
        freed += st.size
        n += 1
      } catch { }
    }
  }
  // _jobs 是 RVC 的 job 日志（<jobid>.log，不带头 say-），6 小时前的顺手清掉
  try {
    const jdir = path.join(RVC_DIR, 'work/_jobs')
    for (const name of fs.readdirSync(jdir)) {
      const f = path.join(jdir, name)
      try {
        const st = fs.statSync(f)
        if (!st.isFile() || now - st.mtimeMs < 6 * 3600 * 1000) continue
        fs.unlinkSync(f)
        freed += st.size
        n += 1
      } catch { }
    }
  } catch { }

  return { freed, n }
}

if (!keep) {
  let freed = 0
  const kill = (f) => {
    const s = sizeOf(f)
    try { fs.unlinkSync(f); freed += s } catch { }
  }
  kill(mp3) // TTS 的 mp3
  kill(path.join(RVC_DIR, up.rel)) // RVC 的输入副本
  kill(wavPath) // 转换后的 wav
  const old = sweep()
  log(`④ 清场：本次删 ${(freed / 1024).toFixed(0)} KB，历史残留 ${old.n} 个 / ${(old.freed / 1024).toFixed(0)} KB`)
} else {
  const old = sweep()
  log(`④ --keep 留档，顺手清历史残留 ${old.n} 个 / ${(old.freed / 1024).toFixed(0)} KB`)
}

console.log(JSON.stringify({
  ok: process.exitCode !== 2,
  play: process.exitCode !== 2,
  wav: keep ? wavPath : null,
  duration: +dur.toFixed(2),
  voice,
  model: modelId,
}, null, 1))