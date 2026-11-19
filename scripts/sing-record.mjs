#!/usr/bin/env node
/**
 * sing-record.mjs —— 唱歌录制（OBS + 页面同 tick 起歌起动作）
 *
 * 用法：
 *   MOTION_INDEX=<Custom索引> DUR=<歌曲秒数> SONG=<file:///…mp3>  *     node scripts/sing-record.mjs
 *
 * 环境变量：MOTION_INDEX(必填) DUR(必填) SONG(必填) OUTDIR(默认 .tmp/sing/rec2)
 *
 * 铁律（都是踩出来的）：
 *   1. 起录前页面里的 <audio> 必须清零，否则上一首还在放 → 两首叠音，嘴跟着另一首走；
 *   2. 一首歌只投一次动作（整首一条 motion3），不要分段投递，分段会漂；
 *   3. 录完再 pause 一次，别把歌留在页面里。
 */
// 一次完整录制：pause插件 → StartRecord → 同步播歌+唱歌动作 → StopRecord
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const SONG = process.env.SONG || 'file:///D:/AI/RVCover/work/final/vocals__m鲸鱼娘__f5b877+instrumental.mp3'
const OUTDIR = process.env.OUTDIR || 'D:/DSH/workspace/default-workspace/.tmp/sing/rec2'
const MOTION_INDEX = Number(process.env.MOTION_INDEX || 59)
// 场景名 / 默认 MV 源名都在 obs-defaults.json 里
const OBS_DEFAULTS = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'obs-defaults.json'), 'utf8')) } catch { return {} }
})()
// 直播 UI 里那条「歌词 MV」媒体源名字；给了就保证每次录制都从 0 开始
const MV = process.env.MV_SOURCE || (OBS_DEFAULTS.mvSource || '')
const TAIL = 2.0
fs.mkdirSync(OUTDIR, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const t0 = Date.now()
const log = (...a) => console.log(`[${((Date.now()-t0)/1000).toFixed(2)}s]`, ...a)

// ---- OBS ----
const obs = new WebSocket('ws://127.0.0.1:4455')
let oid = 0; const opend = new Map()
const ocall = (t, d = {}) => new Promise((res, rej) => { const i = ++oid; opend.set(i, m => m.requestStatus.result ? res(m.responseData) : rej(new Error(JSON.stringify(m.requestStatus)))); obs.send(JSON.stringify({ op: 6, d: { requestType: t, requestData: d, requestId: String(i) } })) })
obs.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.op === 0) {
    let auth = ''
    if (m.d.authentication) {
      const a = crypto.createHash('sha256').update('8dg1PgfZomrkjvs5' + m.d.authentication.salt).digest('base64')
      auth = crypto.createHash('sha256').update(a + m.d.authentication.challenge).digest('base64')
    }
    obs.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, authentication: auth } }))
  } else if (m.op === 2) { obs._ready = true }
  else if (m.op === 7 && m.d?.requestId) { const f = opend.get(Number(m.d.requestId)); if (f) { f(m.d); opend.delete(Number(m.d.requestId)) } }
})
await new Promise(r => { const iv = setInterval(() => { if (obs._ready) { clearInterval(iv); r() } }, 50) })
log('OBS 已连')

// ---- 插件 pause（插件没起来也不该挡住录制）----
const plug = async (path, body) => {
  try {
    const r = await fetch('http://127.0.0.1:18100' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return r.text()
  } catch (e) { return '（插件没响应：' + e.message.slice(0, 60) + '）' }
}
log('pause:', await plug('/dafei/pause', { on: true }))

// ---- 录前准备 ----
// 场景名从 obs-defaults.json 读（用户现在的直播 UI 叫「肥鱼直播ui」，别再写死旧场景）
await ocall('SetInputMute', { inputName: '音频输入采集', inputMuted: true })
await ocall('SetRecordDirectory', { recordDirectory: OUTDIR })
if (OBS_DEFAULTS.sceneName) {
  try { await ocall('SetCurrentProgramScene', { sceneName: OBS_DEFAULTS.sceneName }); log('场景:', OBS_DEFAULTS.sceneName) }
  catch (e) { log('切场景失败（用当前场景）:', e.message.slice(0, 80)) }
}
log('录制目录:', OUTDIR)

// ---- CDP ----
const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const t = targets.find(x => x.type === 'page' && x.title.includes('fullscreen-host=main-window'))
const ws = new WebSocket(t.webSocketDebuggerUrl)
let id = 0; const pend = new Map()
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
await new Promise(r => ws.addEventListener('open', r))
const send = (m, p) => { const i = ++id; return new Promise(res => { pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) }) }
const ev = async (expr, awaitP = true) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: awaitP, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
  return r.result?.result?.value
}

// ---- 开录 ----
// 预卷：先把 MV 停住（预卷这 1.5s 画面停在首帧），等触发那一刻再 RESTART 从头播
const MV_RESTART_ACTION = 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART'
const MV_STOP_ACTION = 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP'
if (MV) {
  try {
    // 别让 OBS 自己的「激活即重播」掺一脚，改由我们在触发点精确控制
    await ocall('SetInputSettings', { inputName: MV, inputSettings: { restart_on_activate: false, close_when_inactive: false }, overlay: true })
    await ocall('TriggerMediaInputAction', { inputName: MV, mediaAction: MV_STOP_ACTION })
    log('MV 已停在首帧:', MV)
  } catch (e) { log('MV 预处理失败（不影响录制）:', e.message.slice(0, 120)) }
}

await ocall('StartRecord')
const recStartWall = Date.now()
log('开始录制')
await sleep(1500)

// ---- 与起歌同一刻从头播 MV ----
// 注意：不要用 STOP→光标归零→PLAY，实测 OBS 会卡在 33ms 不动；RESTART 才可靠重启解码
let mvWall = 0
if (MV) {
  try { await ocall('TriggerMediaInputAction', { inputName: MV, mediaAction: MV_RESTART_ACTION }); mvWall = Date.now() }
  catch (e) { log('MV 起播失败:', e.message.slice(0, 120)) }
}
if (MV) log(`MV 起播于录制时间轴 ${((mvWall - recStartWall) / 1000).toFixed(3)}s`)

// ---- 同一 tick 起歌 + 起动作 ----
const fire = await ev(`(async () => {
  const t = performance.now();
  // 先掐掉上一次残留的播放（不然两首歌会叠在一起）
  document.querySelectorAll('audio').forEach(x => { try { x.pause(); } catch (e) {} });
  if (window.__song) { try { window.__song.pause(); } catch (e) {} }
  const a = new Audio(${JSON.stringify(SONG)});
  a.volume = 1; window.__song = a;
  const p = a.play().catch(e => 'reject:' + e.message);
  const code = "const bc=new BroadcastChannel('dafei-motion-preview');bc.postMessage({group:'Custom',index:${MOTION_INDEX}});setTimeout(()=>postMessage('ok'),40)";
  const w = new Worker(URL.createObjectURL(new Blob([code], {type:'text/javascript'})));
  const posted = await new Promise(res => { w.onmessage = e => res(e.data); setTimeout(() => res('timeout'), 800) });
  await p;
  return JSON.stringify({ tPerf: t, posted, ct: a.currentTime, dur: a.duration, paused: a.paused })
})()`)
const fireWall = Date.now()
log('触发:', fire)

// ---- 等唱完 ----
const durSec = Number(process.env.DUR || 36.758413)
await sleep(durSec * 1000 + TAIL * 1000)
const tail = await ev(`JSON.stringify({ ct: window.__song ? window.__song.currentTime : -1, ended: window.__song ? window.__song.ended : null })`)
log('尾部状态:', tail)

// ---- 停录 ----
await ev(`(() => { try { window.__song && window.__song.pause(); } catch (e) {} document.querySelectorAll('audio').forEach(x => { try { x.pause(); } catch (e) {} }); return 'stopped' })()`)
const stop = await ocall('StopRecord')
log('停止录制 →', JSON.stringify(stop))
// 收工把 MV 停住，下一轮从干净状态开始（不停会一直播到底，下次预卷画面就不可控了）
if (MV) { try { await ocall('TriggerMediaInputAction', { inputName: MV, mediaAction: MV_STOP_ACTION }) } catch (e) {} }
log('pause 解除:', await plug('/dafei/pause', { on: false }))
fs.writeFileSync(path.join(OUTDIR, 'timing.json'), JSON.stringify({ recStartWall, fireWall, fire, outPath: stop.outputPath, durationMs: stop.outputDuration }, null, 1))
ws.close(); obs.close()
