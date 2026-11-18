#!/usr/bin/env node
/**
 * sing-play.mjs —— 按 song.json 的时间轴把「唱段-*」一段段推给桌宠（长歌也能播完）
 *
 * 为什么不合成一个大 motion3：4 分钟 × 60fps × 30 条曲线会变成 20~40MB 的单文件，
 * airi 加载和 OBS 抓都会卡；切成 5~9 秒的唱段，每段都带自己的口型切片，接缝处口型连续。
 *
 * 用法：
 *   node scripts/sing-play.mjs --song .songs/song-a/song.json \
 *        [--audio "file:///D:/path/mix.mp3"] [--port 9222] [--lead 0.15] [--dry] [--seconds N]
 *
 * 前置：
 *   1) `node scripts/gen-song.mjs ...` 生成唱段
 *   2) 把 `<out>/*.motion3.json` 推到桌宠 OPFS 的 Custom 组（任选 push-dir / 插件 /dafei/act 用的推法），
 *      再 `Page.reload{ignoreCache:true}` 让注册表刷新
 *   3) `POST /dafei/pause {on:true}`（脚本会自动发），否则 pending 轮询会用 Think 顶掉动作
 */
import fs from 'node:fs'

const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 ? argv[i + 1] : d
}
const has = (n) => argv.includes('--' + n)
const CDP = `http://127.0.0.1:${Number(opt('port', 9222))}`
const DAFEI = opt('dafei', 'http://127.0.0.1:18100')
const SONG = opt('song', '')
const AUDIO = opt('audio', '')
const LEAD = Number(opt('lead', 0.15))
const DRY = has('dry')
const SECONDS = Number(opt('seconds', 0))

if (!SONG) throw new Error('需要 --song <song.json>')
const manifest = JSON.parse(fs.readFileSync(SONG, 'utf8'))

async function page() {
  const list = await (await fetch(`${CDP}/json`)).json()
  const t = list.find((x) => x.type === 'page' && /index\.html/.test(x.url))
  if (!t) throw new Error('找不到桌宠页面，先带 --remote-debugging-port=9222 重启 airi')
  return t
}

const target = await page()
const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
}
await new Promise((r) => (ws.onopen = r))
const send = (method, params = {}) =>
  new Promise((res) => {
    const mid = ++id
    pending.set(mid, res)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
await send('Runtime.enable')

// 注册表：唱段-XX.motion3.json → Custom index
const reg = await send('Runtime.evaluate', {
  expression: `(()=>{const m=window.__dafeiMotions||[];return m.filter(x=>x.group==='Custom').map(x=>({i:x.index,f:x.fileName.replace('Animation/','')}))})()`,
  returnByValue: true,
})
const custom = reg.result?.result?.value || []
const byName = new Map(custom.map((c) => [c.f, c.i]))

const timeline = []
let missing = []
for (const s of manifest.segments) {
  const idx = byName.get(`${s.name}.motion3.json`)
  if (idx === undefined) {
    missing.push(s.name)
    continue
  }
  timeline.push({ name: s.name, at: s.at, index: idx, duration: s.duration })
}
timeline.sort((a, b) => a.at - b.at)

if (!timeline.length) throw new Error(`注册表里一个唱段都没有（缺 ${missing.slice(0, 3).join(',')}…），先把唱段推到 Custom 组并 reload`)
if (missing.length) console.error(`⚠ 有 ${missing.length} 段不在注册表里，会被跳过：${missing.slice(0, 5).join(', ')}`)

const schedule = timeline.map((t) => `${t.at.toFixed(2)}s → ${t.name} (Custom#${t.index})`)
if (DRY) {
  console.log(JSON.stringify({ ok: true, dry: true, duration: manifest.duration, segments: timeline.length, schedule }, null, 1))
  process.exit(0)
}

// 暂停推送，避免 Think 顶掉
await fetch(`${DAFEI}/dafei/pause`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ on: true }),
}).catch(() => {})

const pageCode = `
(async () => {
  const list = ${JSON.stringify(timeline)};
  const audioUrl = ${JSON.stringify(AUDIO)};
  const lead = ${LEAD};
  const stopAfter = ${SECONDS};
  const workerCode = "const bc=new BroadcastChannel('dafei-motion-preview');onmessage=e=>{if(e.data&&e.data.kind==='post'){bc.postMessage({group:'Custom',index:e.data.index})}else if(e.data&&e.data.kind==='done'){postMessage('done')}}";
  const w = new Worker(URL.createObjectURL(new Blob([workerCode], {type:'text/javascript'})));
  let audio = null;
  if (audioUrl) { audio = new Audio(audioUrl); audio.volume = 0; await audio.play().catch(()=>{}); }
  const t0 = performance.now();
  let fired = 0;
  const post = (seg) => { w.postMessage({ kind: 'post', index: seg.index }); fired++; };
  // 用单基准 + 定时器排期（不依赖 rAF：后台标签页会节流，定时器更稳）
  const base = audio && !audio.paused ? audio.currentTime : 0;
  const wait = (seg) => Math.max(0, (seg.at - base - lead) * 1000);
  list.forEach((seg) => setTimeout(() => { if (stopAfter && seg.at > stopAfter) return; post(seg); }, wait(seg)));
  if (stopAfter) setTimeout(() => w.postMessage({ kind: 'done' }), stopAfter * 1000);
  setTimeout(() => w.postMessage({ kind: 'done' }), (list[list.length - 1].at + 12) * 1000);

  return 'started';
})()
`

const r = await send('Runtime.evaluate', { expression: pageCode, awaitPromise: true, returnByValue: true })
ws.close()
console.log(
  JSON.stringify(
    {
      ok: true,
      started: r.result?.result?.value,
      duration: manifest.duration,
      segments: timeline.length,
      audio: AUDIO || null,
      schedule: SECONDS ? schedule.slice(0, 6) : schedule,
    },
    null,
    1,
  ),
)
