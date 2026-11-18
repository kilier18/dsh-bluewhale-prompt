#!/usr/bin/env node
/**
 * push-custom.mjs —— 把目录里的 motion3 推进桌宠 OPFS 并登记到 Custom 组
 *
 *   node scripts/push-custom.mjs --dir <只含目标 motion3 的目录> [--port 9222] [--no-reload]
 *
 * 行为：
 *   1. 逐个文件 base64 分块送进页面，写入 preset-live2d-1/Animation/<同名>（大小核对）
 *   2. 改写 preset-live2d-1/大肥鱼.model3.json 的 Motions.Custom（同名去重后追加到末尾）
 *   3. 默认 Page.reload {ignoreCache:true}，等模型重新加载
 *   4. 回读 window.__dafeiMotions，打印每个文件在 Custom 组里的 index
 *
 * 注意：目录里只放你要用的那一条，Custom 会按「文件夹内全部 motion3」登记；
 *       想清库用 .tmp/sing/keep-only.mjs 那类脚本（见手册 11）。
 */
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const get = (k, d = '') => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const DIR = path.resolve(get('--dir', '.'))
const PORT = Number(get('--port', 9222))
const RELOAD = !argv.includes('--no-reload')

if (!fs.existsSync(DIR)) { console.error(`目录不存在：${DIR}`); process.exit(1) }
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.motion3.json'))
if (!files.length) { console.error(`目录里没有 motion3：${DIR}`); process.exit(1) }

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = targets.find((t) => t.type === 'page' && /fullscreen-host=main-window/.test(t.title || ''))
if (!page) { console.error('找不到桌宠页面（title 应含 fullscreen-host=main-window）；确认 airi 带 --remote-debugging-port 启动'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
await new Promise((r) => ws.addEventListener('open', r))
const send = (method, params) => { const id = ++seq; return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })) }) }
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
  return r.result?.result?.value
}

for (const f of files) {
  const buf = fs.readFileSync(path.join(DIR, f))
  const b64 = buf.toString('base64')
  const CH = 400000
  await ev('window.__chunks = []')
  for (let i = 0; i < b64.length; i += CH) await ev(`window.__chunks.push(${JSON.stringify(b64.slice(i, i + CH))}), 1`)
  const code = `(async () => {
    const bin = atob(window.__chunks.join('')); window.__chunks = [];
    const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const root = await navigator.storage.getDirectory();
    const model = await root.getDirectoryHandle('preset-live2d-1');
    const anim = await model.getDirectoryHandle('Animation', { create: true });
    const fh = await anim.getFileHandle(${JSON.stringify(f)}, { create: true });
    const w = await fh.createWritable(); await w.write(new Blob([u8])); await w.close();
    return (await (await fh.getFile()).size);
  })()`
  const got = await ev(code)
  console.log(`${f}  写入 ${got}B  ${got === buf.length ? 'OK' : 'SIZE-MISMATCH!'}`)
}

const reg = `(async () => {
  const root = await navigator.storage.getDirectory();
  const model = await root.getDirectoryHandle('preset-live2d-1');
  const fh = await model.getFileHandle('大肥鱼.model3.json');
  const j = JSON.parse(await (await fh.getFile()).text());
  const want = ${JSON.stringify(files.map((f) => `Animation/${f}`))};
  const g = j.FileReferences.Motions;
  g.Custom = (g.Custom || []).filter((m) => !want.includes(m.File));
  for (const w of want) g.Custom.push({ File: w });
  const wr = await fh.createWritable(); await wr.write(new Blob([JSON.stringify(j)], { type: 'application/json' })); await wr.close();
  return JSON.stringify(Object.fromEntries(Object.entries(j.FileReferences.Motions).map(([k, v]) => [k, v.length])));
})()`
console.log('登记:', await ev(reg))

if (RELOAD) {
  await send('Page.enable', {})
  await send('Page.reload', { ignoreCache: true })
  await new Promise((r) => setTimeout(r, 8000))
  const idx = await ev(`JSON.stringify((window.__dafeiMotions||[]).filter(m=>m.group==='Custom').map(m=>({i:m.index,f:m.fileName})))`)
  console.log('Custom 索引:', idx)
}
ws.close()
