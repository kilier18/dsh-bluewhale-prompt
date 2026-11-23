// 极简 obs-websocket v5 客户端：node obs.mjs <RequestType> '<json data>' [--raw]
import crypto from 'node:crypto'
const URL = 'ws://127.0.0.1:4455'
const PASS = '8dg1PgfZomrkjvs5'
const type = process.argv[2] || 'GetVersion'
const data = process.argv[3] ? JSON.parse(process.argv[3]) : {}

const ws = new WebSocket(URL)
let id = 0; const pend = new Map()
const call = (requestType, requestData = {}) => new Promise((res, rej) => {
  const i = ++id
  pend.set(i, m => m.requestStatus.result ? res(m.responseData) : rej(new Error(JSON.stringify(m.requestStatus))))
  ws.send(JSON.stringify({ op: 6, d: { requestType, requestData, requestId: String(i) } }))
})
ws.addEventListener('message', async e => {
  const m = JSON.parse(e.data)
  if (m.op === 0) {
    const hello = m.d
    let auth = ''
    if (hello.authentication) {
      const a = crypto.createHash('sha256').update(PASS + hello.authentication.salt).digest('base64')
      auth = crypto.createHash('sha256').update(a + hello.authentication.challenge).digest('base64')
    }
    ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, authentication: auth } }))
  } else if (m.op === 2) {
    try {
      const r = await call(type, data)
      console.log(JSON.stringify(r, null, 1))
    } catch (err) { console.log('ERR', err.message) }
    ws.close(); process.exit(0)
  } else if (m.op === 7 && m.d?.requestId) {
    const f = pend.get(Number(m.d.requestId)); if (f) { f(m.d); pend.delete(Number(m.d.requestId)) }
  } else if (m.op === 9) { console.log('ERR op9', JSON.stringify(m.d).slice(0, 300)); process.exit(1) }
})
ws.addEventListener('error', e => { console.log('WS ERR', e.message || ''); process.exit(1) })
