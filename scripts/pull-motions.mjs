#!/usr/bin/env node
// 从桌宠（airi）的 OPFS 里把官方动作原件拉到本地，供 scripts/l2d-dict.py 生成字典。
//
// 前置条件：airi 必须带调试端口启动（否则没有 CDP，读不到 OPFS）
//   powershell -NoProfile -Command "$env:ELECTRON_RUN_AS_NODE=$null; Start-Process -FilePath '<airi.exe>' -ArgumentList '--remote-debugging-port=9222' -WorkingDirectory '<桌宠目录>'"
//
// 用法：
//   node scripts/pull-motions.mjs                     # 默认拉到 ./.motions-lib
//   node scripts/pull-motions.mjs --out D:/tmp/lib    # 指定目录
//   node scripts/pull-motions.mjs --port 9222 --all   # --all 连非官方组一起拉（默认只要官方 5 组）
//
// 拉完：
//   python scripts/l2d-dict.py --lib ./.motions-lib \
//       --out dict/l2d-motion-dict.json --mapping dict/l2d-motion-mapping.json
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const PORT = opt('port', '9222')
const OUT = path.resolve(opt('out', '.motions-lib'))
const ALL = argv.includes('--all')
const PAGE_TITLE = 'fullscreen-host=main-window'

// 官方组的文件名前缀：动作库重置后只剩这五组 + 待机
const OFFICIAL = /^(待机|正常说话-|情绪-|表演-|换装-|脱捕)/

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = targets.find((t) => t.type === 'page' && (t.title || '').includes(PAGE_TITLE))
if (!page) {
  console.error(`✗ 没找到桌宠页面（title 含 ${PAGE_TITLE}）。airi 是不是没带 --remote-debugging-port=${PORT} 启动？`)
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
await new Promise((r) => ws.addEventListener('open', r))
const send = (method, params) => {
  const id = ++seq
  return new Promise((res) => {
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
  return r.result?.result?.value
}

const IN_DIR = `(async()=>{const root=await navigator.storage.getDirectory();const d=await root.getDirectoryHandle('preset-live2d-1');return await d.getDirectoryHandle('Animation')})()`
const names = JSON.parse(
  await ev(`(async()=>{const an=await ${IN_DIR};const out=[];for await (const [n] of an.entries())out.push(n);return JSON.stringify(out)})()`),
)
const pick = names.filter((n) => (ALL ? true : OFFICIAL.test(n)))
console.log(`OPFS 里 ${names.length} 个动作文件，本次拉 ${pick.length} 个${ALL ? '' : '（只官方组）'}`)

mkdirSync(OUT, { recursive: true })
let ok = 0
let bytes = 0
for (const name of pick) {
  const b64 = await ev(
    `(async()=>{const an=await ${IN_DIR};const f=await (await an.getFileHandle(${JSON.stringify(name)})).getFile();` +
      `const buf=new Uint8Array(await f.arrayBuffer());let s='';for(let i=0;i<buf.length;i+=8192)s+=String.fromCharCode.apply(null,buf.subarray(i,i+8192));return btoa(s)})()`,
  )
  if (!b64) {
    console.warn('  MISS', name)
    continue
  }
  const data = Buffer.from(b64, 'base64')
  writeFileSync(path.join(OUT, name), data)
  ok++
  bytes += data.length
  process.stdout.write(`\r  已拉 ${ok}/${pick.length}`)
}
ws.close()
console.log(`\n✓ ${ok} 个文件，${(bytes / 1048576).toFixed(2)} MB → ${OUT}`)
console.log(`  下一步：python scripts/l2d-dict.py --lib "${OUT}" --out dict/l2d-motion-dict.json --mapping dict/l2d-motion-mapping.json`)
