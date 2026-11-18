#!/usr/bin/env node
// 打印桌宠 Custom 组动作 [{i:index,f:fileName}]（JSON）
const port = Number(process.env.CDP_PORT || 9222)
const t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json())
  .find((x) => x.type === 'page' && /fullscreen-host=main-window/.test(x.title || ''))
if (!t) { console.error('找不到桌宠页面'); process.exit(1) }
const ws = new WebSocket(t.webSocketDebuggerUrl)
let seq = 0; const pend = new Map()
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
await new Promise((r) => ws.addEventListener('open', r))
const r = await new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: `JSON.stringify((window.__dafeiMotions||[]).filter(m=>m.group==='Custom').map(m=>({i:m.index,f:m.fileName})))`, returnByValue: true } })) })
console.log(r.result?.result?.value || '[]')
ws.close()
